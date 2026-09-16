// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

import {ArcaniumHook} from "./ArcaniumHook.sol";
import {ArcaniumLaunchToken} from "./ArcaniumLaunchToken.sol";

/**
 * @title Arcanium launchpad (Uniswap v4)
 * @notice Mints a token, opens its v4 pool, locks the whole supply into it and
 *         optionally makes the creator's first buy — in one transaction.
 *
 * One transaction is the point. The v3 path needed an ERC-20 approval before
 * the launch whenever the creator wanted an opening buy, because the factory
 * had to pull USDC. On Arc, USDC *is* the gas token — the contract at
 * 0x3600…0000 is a 6-decimal ERC-20 view of an 18-decimal native balance — so
 * the buy can simply be sent as value and there is nothing to approve. A
 * creator signs once.
 *
 * The transferFrom path is kept for a quote asset that is a normal ERC-20, so
 * this is not locked to Arc's arrangement, but native is the default because
 * it is the one that removes a signature.
 *
 * Liquidity is locked by construction rather than by custody. On v3 the launch
 * position was an NFT that had to be held somewhere that refused to give it
 * back, and that vault still carries a migrationAuthority that could pull it.
 * A v4 position belongs to whichever address called modifyLiquidity, which here
 * is this contract — and this contract has no function that removes liquidity,
 * no owner power that could add one, and no upgrade path. The liquidity cannot
 * be withdrawn because there is no code that withdraws it.
 *
 * Pools open with an LP fee of zero. The hook takes the 1% instead so it can
 * route it inside the swap; leaving the pool fee on as well would bill traders
 * twice and rebuild the very pot of uncollected fees the keeper existed for.
 */
contract ArcaniumLaunchpad is Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;

    uint256 public constant FIXED_SUPPLY = 1_000_000_000 ether;
    uint24 public constant LP_FEE = 0;
    int24 public constant TICK_SPACING = 200;
    int24 public constant MAX_USABLE_TICK = 887_200;
    int24 public constant MIN_USABLE_TICK = -887_200;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // A ~$3,000 opening market cap for a 1e27 supply against a 6-decimal
    // quote, identical to the v3 launches. Precomputed because deriving it on
    // chain costs gas to reach a number that never changes.
    uint160 public constant SQRT_PRICE_TOKEN0_6 = 137227202865029797602;
    uint160 public constant SQRT_PRICE_TOKEN1_6 = 45742400955009932534161870629490520388;
    int24 public constant LAUNCH_TICK_TOKEN0_6 = -403_400;
    int24 public constant LAUNCH_TICK_TOKEN1_6 = 403_400;

    IPoolManager public immutable poolManager;
    ArcaniumHook public immutable hook;
    /// @notice The quote asset every launch pairs with.
    address public immutable quote;
    /// @notice True when `quote` is a view of the chain's native balance, so a
    ///         creator buy can arrive as value instead of an approval.
    bool public immutable quoteIsNative;

    uint256 public launchFee;
    address public launchFeeTreasury;
    bool public launchesPaused;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataUri;
        /// Opening buy, in quote base units. Zero for none.
        uint256 creatorBuyAmount;
        uint256 minTokensOut;
        uint256 deadline;
        /// Who receives creator fees. Zero means the launching wallet.
        address feeRecipient;
        /// Extra trade tax in bps, on top of the hook's 1% base. Max 900.
        uint16 taxBps;
        /// 0 STANDARD, 1 DIVIUM, 2 ARCANE.
        uint8 mode;
    }

    struct LaunchInfo {
        address token;
        address creator;
        address feeRecipient;
        PoolId poolId;
        uint64 launchedAt;
    }

    mapping(address => LaunchInfo) public launches;
    address[] public allTokens;

    event Launched(
        address indexed token,
        address indexed creator,
        PoolId indexed poolId,
        address feeRecipient,
        uint16 taxBps,
        uint8 mode
    );
    event CreatorBought(address indexed token, address indexed creator, uint256 spent, uint256 received);
    event LaunchFeeUpdated(uint256 oldFee, uint256 newFee);
    event LaunchesPausedSet(bool paused);

    error ZeroAddress();
    error LaunchesPaused();
    error DeadlinePassed();
    error BadMode();
    error EmptyName();
    error NotPoolManager();
    error InsufficientPayment();
    error SlippageExceeded(uint256 received, uint256 minimum);
    error RefundFailed();

    constructor(
        IPoolManager poolManager_,
        ArcaniumHook hook_,
        address quote_,
        bool quoteIsNative_,
        address owner_,
        uint256 launchFee_,
        address launchFeeTreasury_
    ) Ownable(owner_) {
        if (
            address(poolManager_) == address(0) || address(hook_) == address(0) ||
            quote_ == address(0) || launchFeeTreasury_ == address(0)
        ) revert ZeroAddress();
        poolManager = poolManager_;
        hook = hook_;
        quote = quote_;
        quoteIsNative = quoteIsNative_;
        launchFee = launchFee_;
        launchFeeTreasury = launchFeeTreasury_;
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    // ----------------------------------------------------------------- launch

    struct Callback {
        PoolKey key;
        address token;
        bool tokenIsCurrency0;
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtPriceX96;
        uint256 creatorBuy;
        address creator;
    }

    function launch(LaunchParams calldata params)
        external
        payable
        nonReentrant
        returns (address token, PoolId poolId)
    {
        if (launchesPaused) revert LaunchesPaused();
        if (params.deadline < block.timestamp) revert DeadlinePassed();
        if (params.mode > 2) revert BadMode();
        if (bytes(params.name).length == 0 || bytes(params.symbol).length == 0) revert EmptyName();

        uint256 fee = launchFee;
        uint256 owed = fee + params.creatorBuyAmount;
        _collect(owed);

        address recipient = params.feeRecipient == address(0) ? msg.sender : params.feeRecipient;

        ArcaniumLaunchToken t = new ArcaniumLaunchToken(
            params.name, params.symbol, address(hook), params.mode == 1
        );
        token = address(t);

        bool tokenIsCurrency0 = token < quote;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : quote),
            currency1: Currency.wrap(tokenIsCurrency0 ? quote : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        // Terms first: beforeInitialize refuses a pool the hook has not been
        // told about, which is what stops anyone else opening one on our hook.
        hook.configurePool(
            key, token, quote, recipient, address(0), params.taxBps, ArcaniumHook.Mode(params.mode)
        );

        (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper) = _launchPrice(tokenIsCurrency0);
        poolManager.initialize(key, sqrtPriceX96);

        // The venue holds the supply; it is not a holder to pay rewards to.
        t.excludeFromRewards(address(poolManager));

        uint256 received = abi.decode(
            poolManager.unlock(
                abi.encode(
                    Callback({
                        key: key,
                        token: token,
                        tokenIsCurrency0: tokenIsCurrency0,
                        tickLower: tickLower,
                        tickUpper: tickUpper,
                        sqrtPriceX96: sqrtPriceX96,
                        creatorBuy: params.creatorBuyAmount,
                        creator: msg.sender
                    })
                )
            ),
            (uint256)
        );

        if (params.creatorBuyAmount > 0) {
            if (received < params.minTokensOut) revert SlippageExceeded(received, params.minTokensOut);
            emit CreatorBought(token, msg.sender, params.creatorBuyAmount, received);
        }

        if (fee > 0) IERC20(quote).safeTransfer(launchFeeTreasury, fee);

        poolId = key.toId();
        launches[token] = LaunchInfo({
            token: token,
            creator: msg.sender,
            feeRecipient: recipient,
            poolId: poolId,
            launchedAt: uint64(block.timestamp)
        });
        allTokens.push(token);

        emit Launched(token, msg.sender, poolId, recipient, params.taxBps, params.mode);
        _refundDust();
    }

    /**
     * @dev Take what the launch costs.
     *
     *      When the quote is the native gas token the creator simply sends it,
     *      which is the entire reason a launch with an opening buy is one
     *      signature rather than two. Otherwise it is pulled, and an approval
     *      was needed first.
     */
    function _collect(uint256 owed) private {
        if (owed == 0) return;
        if (quoteIsNative) {
            // msg.value is 18-decimal native; the ERC-20 view is 6-decimal, so
            // the balance is the thing to check rather than msg.value itself.
            if (IERC20(quote).balanceOf(address(this)) < owed) revert InsufficientPayment();
            return;
        }
        IERC20(quote).safeTransferFrom(msg.sender, address(this), owed);
    }

    /// @dev Return anything sent above the cost. Rounding between an
    ///      18-decimal native balance and its 6-decimal view means an exact
    ///      payment is not always possible, and keeping the remainder would be
    ///      a fee nobody agreed to.
    function _refundDust() private {
        if (!quoteIsNative) return;
        uint256 left = address(this).balance;
        if (left == 0) return;
        (bool ok, ) = payable(msg.sender).call{value: left}("");
        if (!ok) revert RefundFailed();
    }

    function _launchPrice(bool tokenIsCurrency0)
        private
        pure
        returns (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper)
    {
        // A range entirely on one side of spot takes only one asset, which is
        // what makes the launch single-sided: above spot when the token is
        // currency0, below it when the token is currency1.
        return tokenIsCurrency0
            ? (SQRT_PRICE_TOKEN0_6, LAUNCH_TICK_TOKEN0_6, MAX_USABLE_TICK)
            : (SQRT_PRICE_TOKEN1_6, MIN_USABLE_TICK, LAUNCH_TICK_TOKEN1_6);
    }

    /// @dev Everything that has to happen inside the PoolManager's lock.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Callback memory cb = abi.decode(data, (Callback));

        _addLaunchLiquidity(cb);

        uint256 received = 0;
        if (cb.creatorBuy > 0) received = _creatorBuy(cb);

        return abi.encode(received);
    }

    function _addLaunchLiquidity(Callback memory cb) private {
        uint160 lower = TickMath.getSqrtPriceAtTick(cb.tickLower);
        uint160 upper = TickMath.getSqrtPriceAtTick(cb.tickUpper);

        uint128 liquidity = cb.tokenIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount0(lower, upper, FIXED_SUPPLY)
            : LiquidityAmounts.getLiquidityForAmount1(lower, upper, FIXED_SUPPLY);

        (BalanceDelta delta, ) = poolManager.modifyLiquidity(
            cb.key,
            ModifyLiquidityParams({
                tickLower: cb.tickLower,
                tickUpper: cb.tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // Pay exactly what the position costs, from the delta rather than from
        // our balance. Converting a whole supply into a liquidity figure and
        // back does not round to the same number, and settling more than is
        // owed leaves a credit the lock will not close over.
        int128 owed = cb.tokenIsCurrency0 ? delta.amount0() : delta.amount1();
        Currency tokenCurrency = Currency.wrap(cb.token);
        poolManager.sync(tokenCurrency);
        IERC20(cb.token).safeTransfer(address(poolManager), uint256(uint128(-owed)));
        poolManager.settle();

        // Whatever rounding left behind is burned rather than kept. A supply
        // that is "one billion minus whatever the maths shed" sitting in the
        // launchpad is a balance nobody can account for.
        uint256 dust = IERC20(cb.token).balanceOf(address(this));
        if (dust > 0) IERC20(cb.token).safeTransfer(BURN_ADDRESS, dust);
    }

    function _creatorBuy(Callback memory cb) private returns (uint256 received) {
        bool quoteIsCurrency0 = !cb.tokenIsCurrency0;
        BalanceDelta delta = poolManager.swap(
            cb.key,
            SwapParams({
                zeroForOne: quoteIsCurrency0,
                amountSpecified: -int256(cb.creatorBuy),
                sqrtPriceLimitX96: quoteIsCurrency0
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        Currency quoteCurrency = Currency.wrap(quote);
        poolManager.sync(quoteCurrency);
        IERC20(quote).safeTransfer(address(poolManager), cb.creatorBuy);
        poolManager.settle();

        int128 out = quoteIsCurrency0 ? delta.amount1() : delta.amount0();
        if (out > 0) {
            received = uint128(out);
            poolManager.take(Currency.wrap(cb.token), cb.creator, received);
        }
    }

    // ------------------------------------------------------------------ admin

    function setLaunchFee(uint256 newFee) external onlyOwner {
        emit LaunchFeeUpdated(launchFee, newFee);
        launchFee = newFee;
    }

    function setLaunchFeeTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        launchFeeTreasury = newTreasury;
    }

    function setLaunchesPaused(bool paused) external onlyOwner {
        launchesPaused = paused;
        emit LaunchesPausedSet(paused);
    }

    /// @dev Needed so a native-quote creator buy can arrive as value. There is
    ///      deliberately no sweep: whatever is not spent is refunded in the
    ///      same call, and nothing else should ever sit here.
    receive() external payable {}
}
