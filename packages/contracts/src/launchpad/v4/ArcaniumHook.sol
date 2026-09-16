// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

interface IDiviumToken {
    function notifyRewardAmount(uint256 amount) external;
    function consumeRewards(address account) external returns (uint256);
    function earned(address account) external view returns (uint256);
}

/**
 * @title Arcanium v4 hook
 * @notice Takes each launch's trade tax inside the swap and routes it in the
 *         same transaction.
 *
 * Why this exists at all. On v3 the pool holds fees until somebody calls
 * collect, so Arcanium runs a keeper on a timer and every mode is really
 * "happens within fifteen minutes of a trade". A hook is called during the
 * swap, so the split, the payout and the burn all settle in the block the
 * trade lands in, and nothing depends on a server staying alive.
 *
 * ARCANE gains the most. On v3 the creator share accrues in USDC, so burning
 * means market-buying the token first, and that swap sits in a try/catch which
 * silently strands the money when it fails. Here a buy already pays its fee in
 * the token itself, so the hook sends it straight to the burn address. No swap,
 * nothing to fail, nothing to catch.
 *
 * Which currency the fee lands in follows the swap, not a preference: for the
 * ordinary exact-input trade the fee is charged on the output, so buys pay in
 * the token and sells pay in USDC. A buy is burned directly; a sell is bought
 * back and burned in the same transaction, through a second swap this hook
 * makes while the manager is still unlocked. Both are automatic, and neither
 * waits for a keeper.
 *
 * The address of this contract is not arbitrary. v4 reads a hook's permissions
 * out of the low bits of its own address, so this must be deployed to an
 * address whose bits match `HOOK_FLAGS` or the PoolManager rejects every pool
 * that names it. See ArcaniumHookMiner.
 */
contract ArcaniumHook is IHooks, IUnlockCallback, Ownable2Step {
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    /// Permissions this hook claims, and therefore the bits its address must
    /// carry: beforeInitialize (1<<13), afterSwap (1<<6), and afterSwap
    /// returning a delta (1<<2), which is what allows it to take a fee at all.
    uint160 public constant HOOK_FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /**
     * The fee every launch charges, matching the 1% tier v3 launches use.
     *
     * v4 pools created by the launchpad set their own LP fee to zero and let
     * the hook take the whole thing instead. On v3 this 1% accrued to the
     * position and sat there until the keeper collected it; taken here it is
     * routed in the same transaction as the trade. Leaving the pool fee on as
     * well would charge traders twice.
     */
    uint256 public constant BASE_FEE_BPS = 100;
    /// Matches ArchLaunchTokenV2: 9% tax plus the 1% base stays at 10% total.
    uint256 public constant MAX_TAX_BPS = 900;
    uint256 public constant MIN_CREATOR_SHARE_BPS = 100;
    uint256 public constant MAX_CREATOR_SHARE_BPS = 5_000;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    enum Mode {
        STANDARD,
        DIVIUM,
        ARCANE
    }

    struct PoolConfig {
        address token;
        address quote;
        address creator;
        /// Where DIVIUM sends the quote so holders can claim it.
        address distributor;
        uint16 taxBps;
        Mode mode;
        bool configured;
    }

    IPoolManager public immutable poolManager;

    /// Only this address may open a pool that names this hook.
    address public factory;
    address public protocolTreasury;
    uint256 public creatorShareBps;

    mapping(PoolId => PoolConfig) private _configs;
    /// Quote-denominated ARCANE proceeds awaiting a buy-and-burn.
    mapping(PoolId => uint256) public pendingBurnQuote;
    /// Reward asset per launched token, so a payout needs only the token.
    mapping(address => address) public quoteOfToken;
    /// True while sweepAndBurn is swapping this very pool. Without it the
    /// buy-back would be taxed by afterSwap and park a fresh remainder,
    /// leaving a residue that can never be fully swept.
    bool private _sweeping;

    event PoolConfigured(PoolId indexed poolId, address indexed token, uint16 taxBps, Mode mode);
    event TaxRouted(
        PoolId indexed poolId,
        address indexed currency,
        uint256 protocolAmount,
        uint256 creatorAmount,
        Mode mode
    );
    event RewardsClaimed(address indexed token, address indexed holder, uint256 amount);
    /// A buy-back could not complete in the trade that funded it. The amount
    /// is parked and sweepAndBurn retries it; nothing is lost and nothing is
    /// hidden.
    event BurnDeferred(PoolId indexed poolId, uint256 amount);
    event FactoryUpdated(address oldFactory, address newFactory);
    event ProtocolTreasuryUpdated(address oldTreasury, address newTreasury);
    event CreatorShareUpdated(uint256 oldShareBps, uint256 newShareBps);

    error NotPoolManager();
    error NotFactory();
    error AlreadyConfigured();
    error ZeroAddress();
    error TaxAboveCap();
    error ShareOutOfBounds();
    error HookNotImplemented();
    error NothingPending();
    error NotSelf();
    error UnknownToken();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        address owner_,
        address protocolTreasury_,
        uint256 creatorShareBps_
    ) Ownable(owner_) {
        if (address(poolManager_) == address(0) || protocolTreasury_ == address(0)) revert ZeroAddress();
        if (creatorShareBps_ < MIN_CREATOR_SHARE_BPS || creatorShareBps_ > MAX_CREATOR_SHARE_BPS) {
            revert ShareOutOfBounds();
        }
        poolManager = poolManager_;
        protocolTreasury = protocolTreasury_;
        creatorShareBps = creatorShareBps_;
    }

    // ------------------------------------------------------------------ admin

    function setFactory(address newFactory) external onlyOwner {
        if (newFactory == address(0)) revert ZeroAddress();
        emit FactoryUpdated(factory, newFactory);
        factory = newFactory;
    }

    function setProtocolTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit ProtocolTreasuryUpdated(protocolTreasury, newTreasury);
        protocolTreasury = newTreasury;
    }

    function setCreatorShare(uint256 newShareBps) external onlyOwner {
        if (newShareBps < MIN_CREATOR_SHARE_BPS || newShareBps > MAX_CREATOR_SHARE_BPS) {
            revert ShareOutOfBounds();
        }
        emit CreatorShareUpdated(creatorShareBps, newShareBps);
        creatorShareBps = newShareBps;
    }

    function configOf(PoolId poolId) external view returns (PoolConfig memory) {
        return _configs[poolId];
    }

    /**
     * @notice Record a launch's terms. Factory-only and once per pool.
     * @dev Called before initialize so beforeInitialize can recognise the pool.
     *      Immutable afterwards for the same reason the v3 mode is: a tax or a
     *      payout route that can be edited after people have bought is not a
     *      term, it is a promise.
     */
    function configurePool(
        PoolKey calldata key,
        address token,
        address quote,
        address creator,
        address distributor,
        uint16 taxBps,
        Mode mode
    ) external {
        if (msg.sender != factory) revert NotFactory();
        if (taxBps > MAX_TAX_BPS) revert TaxAboveCap();
        if (token == address(0) || quote == address(0) || creator == address(0)) revert ZeroAddress();
        PoolId id = key.toId();
        if (_configs[id].configured) revert AlreadyConfigured();
        _configs[id] = PoolConfig({
            token: token,
            quote: quote,
            creator: creator,
            distributor: distributor,
            taxBps: taxBps,
            mode: mode,
            configured: true
        });
        quoteOfToken[token] = quote;
        emit PoolConfigured(id, token, taxBps, mode);
    }

    // ------------------------------------------------------------------ hooks

    /// @dev Anyone can name a hook in a PoolKey, so without this a stranger
    ///      could open a pool pointing at this contract and inherit whatever
    ///      routing a neighbouring launch had configured. Only pools the
    ///      factory has already described are allowed to exist.
    function beforeInitialize(address, PoolKey calldata key, uint160)
        external
        view
        override
        onlyPoolManager
        returns (bytes4)
    {
        if (!_configs[key.toId()].configured) revert NotFactory();
        return IHooks.beforeInitialize.selector;
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        if (_sweeping) return (IHooks.afterSwap.selector, 0);
        PoolId id = key.toId();
        PoolConfig memory cfg = _configs[id];
        if (!cfg.configured) return (IHooks.afterSwap.selector, 0);

        // The fee is charged in the swap's unspecified currency, which for an
        // exact-input trade is the output side.
        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;

        uint256 rate = BASE_FEE_BPS + cfg.taxBps;
        uint256 feeAmount = (uint256(uint128(swapAmount)) * rate) / BPS_DENOMINATOR;
        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);

        uint256 protocolAmount;
        uint256 creatorAmount;

        if (Currency.unwrap(feeCurrency) == cfg.token) {
            // Token-denominated fees are burned outright, in every mode. This
            // is what v3 does with the token side of its pool fees, and it is
            // the better mechanism anyway: paying a creator in the token they
            // launched hands them sell pressure on their own market, and
            // paying the protocol in it makes protocol revenue depend on the
            // price of whatever happened to trade.
            poolManager.take(feeCurrency, BURN_ADDRESS, feeAmount);
        } else {
            creatorAmount = (feeAmount * creatorShareBps) / BPS_DENOMINATOR;
            protocolAmount = feeAmount - creatorAmount;
            if (protocolAmount > 0) poolManager.take(feeCurrency, protocolTreasury, protocolAmount);
            if (creatorAmount > 0) _routeCreatorShare(key, id, cfg, feeCurrency, creatorAmount);
        }

        emit TaxRouted(id, Currency.unwrap(feeCurrency), protocolAmount, creatorAmount, cfg.mode);
        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    /**
     * @dev Where the creator's share of a quote-denominated fee goes, settled
     *      inside the swap. Only ever called with the quote asset — the token
     *      side is burned before it gets here.
     */
    function _routeCreatorShare(
        PoolKey calldata key,
        PoolId id,
        PoolConfig memory cfg,
        Currency feeCurrency,
        uint256 amount
    ) private {
        if (cfg.mode == Mode.ARCANE) {
            poolManager.take(feeCurrency, address(this), amount);
            // Buy back and burn now, in this same transaction. afterSwap runs
            // after the pool's state is already updated and while the manager
            // is still unlocked, so a second swap is legal here and needs no
            // unlock of its own.
            //
            // Routed through an external self-call purely so it can be caught.
            // A buy-back can legitimately fail — a price limit, a pool with
            // nothing left on the other side — and a failure inside afterSwap
            // would revert the trade that triggered it. Somebody's sell must
            // not fail because our burn did. What it must not do is fail
            // silently, which is the v3 behaviour this whole design exists to
            // end, so the amount is parked and the reason is announced.
            try this.buyBackAndBurn(key, amount) {
                // Burned.
            } catch {
                pendingBurnQuote[id] += amount;
                emit BurnDeferred(id, amount);
            }
            return;
        }

        if (cfg.mode == Mode.DIVIUM) {
            // Held here, not forwarded. The token only accepts
            // notifyRewardAmount and consumeRewards from a single address, so
            // whoever books the rewards must also be the one that pays them.
            poolManager.take(feeCurrency, address(this), amount);
            IDiviumToken(cfg.token).notifyRewardAmount(amount);
            return;
        }

        poolManager.take(feeCurrency, cfg.creator, amount);
    }

    /**
     * @notice Swap `amount` of the pool's quote for its token and burn it.
     * @dev External only so the caller can try/catch it; self-calls only.
     *      Assumes the manager is already unlocked, which is true both from
     *      afterSwap and from sweepAndBurn's unlock callback.
     */
    function buyBackAndBurn(PoolKey calldata key, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        _buyBackAndBurn(key, amount);
    }

    function _buyBackAndBurn(PoolKey memory key, uint256 amount) private {
        PoolConfig memory cfg = _configs[key.toId()];
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == cfg.quote;

        // Without this the buy-back would itself be taxed by afterSwap, which
        // would park a fresh remainder and leave a residue that can never be
        // fully burned.
        _sweeping = true;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: quoteIsCurrency0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: quoteIsCurrency0
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        _sweeping = false;

        // Pay the quote we owe the pool out of the balance just taken.
        Currency quoteCurrency = Currency.wrap(cfg.quote);
        poolManager.sync(quoteCurrency);
        IERC20(cfg.quote).safeTransfer(address(poolManager), amount);
        poolManager.settle();

        // Everything it bought goes straight to the sink.
        int128 bought = quoteIsCurrency0 ? delta.amount1() : delta.amount0();
        if (bought > 0) {
            poolManager.take(Currency.wrap(cfg.token), BURN_ADDRESS, uint128(bought));
        }
    }

    /**
     * @notice Buy the token back with an ARCANE pool's parked USDC and burn it.
     *
     * Permissionless. There is nothing to steer: the proceeds can only go to
     * the burn address, and the caller is never paid.
     *
     * The hook does the swap itself rather than handing the USDC to the v3
     * distributor. That distributor buys back through the v3 router and the v3
     * pool, neither of which exists for a v4 launch, and its buy-and-burn
     * swallows failures in a catch — so delegating here would strand the money
     * and report success, which is the exact behaviour v4 was meant to end.
     */
    function sweepAndBurn(PoolKey calldata key) external {
        PoolId id = key.toId();
        uint256 amount = pendingBurnQuote[id];
        if (amount == 0) revert NothingPending();
        pendingBurnQuote[id] = 0;
        poolManager.unlock(abi.encode(key, amount));
    }

    /**
     * @notice Pay a holder everything they have accrued for `token`.
     *
     * Called by the token itself whenever a holder moves their balance, which
     * is what makes Divium arrive rather than wait to be collected. Also
     * callable by anyone for anyone: it pays the holder named, never the
     * caller, so there is no way to point it at yourself.
     *
     * Rewards cannot be pushed to every holder at once — that is an unbounded
     * loop over an open-ended set, and it would get more expensive with every
     * new holder until it stopped fitting in a block. Paying on the holder's
     * own activity, plus letting anyone settle anyone, is as close to automatic
     * as the accounting can honestly get.
     */
    function payOut(address token, address holder) external returns (uint256 amount) {
        address quote = quoteOfToken[token];
        if (quote == address(0)) revert UnknownToken();
        amount = IDiviumToken(token).consumeRewards(holder);
        if (amount == 0) return 0;
        IERC20(quote).safeTransfer(holder, amount);
        emit RewardsClaimed(token, holder, amount);
    }

    /// @notice Settle several holders in one call.
    function payOutMany(address token, address[] calldata holders) external {
        for (uint256 i = 0; i < holders.length; i++) {
            // A holder with nothing owed must not fail the batch.
            try this.payOut(token, holders[i]) returns (uint256) {} catch {}
        }
    }

    /// @notice What a holder could be paid right now.
    function claimable(address token, address holder) external view returns (uint256) {
        return IDiviumToken(token).earned(holder);
    }

    /// @dev The retry path, inside a lock this contract opened.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint256 amount) = abi.decode(data, (PoolKey, uint256));
        _buyBackAndBurn(key, amount);
        return "";
    }

    // ------------------------------------------- unused callbacks

    // v4 checks a hook's address bits before calling it, so these are
    // unreachable for this deployment. They revert rather than returning a
    // selector so that a hook deployed to a wrong address fails loudly instead
    // of silently accepting calls it does not implement.

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
