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

interface IDiviumToken {
    function notifyRewardAmount(uint256 amount) external;
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
 * the token and sells pay in USDC. ARCANE therefore burns instantly on buys and
 * accumulates on sells, which `sweepQuote` hands to the distributor. That
 * asymmetry is real and is not smoothed over.
 *
 * The address of this contract is not arbitrary. v4 reads a hook's permissions
 * out of the low bits of its own address, so this must be deployed to an
 * address whose bits match `HOOK_FLAGS` or the PoolManager rejects every pool
 * that names it. See ArcaniumHookMiner.
 */
contract ArcaniumHook is IHooks, Ownable2Step {
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    /// Permissions this hook claims, and therefore the bits its address must
    /// carry: beforeInitialize (1<<13), afterSwap (1<<6), and afterSwap
    /// returning a delta (1<<2), which is what allows it to take a fee at all.
    uint160 public constant HOOK_FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// Matches ArchLaunchTokenV2: 9% tax plus the pool fee stays under 10%.
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

    event PoolConfigured(PoolId indexed poolId, address indexed token, uint16 taxBps, Mode mode);
    event TaxRouted(
        PoolId indexed poolId,
        address indexed currency,
        uint256 protocolAmount,
        uint256 creatorAmount,
        Mode mode
    );
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
        PoolId id = key.toId();
        PoolConfig memory cfg = _configs[id];
        if (!cfg.configured || cfg.taxBps == 0) return (IHooks.afterSwap.selector, 0);

        // The fee is charged in the swap's unspecified currency, which for an
        // exact-input trade is the output side.
        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;

        uint256 feeAmount = (uint256(uint128(swapAmount)) * cfg.taxBps) / BPS_DENOMINATOR;
        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);

        uint256 creatorAmount = (feeAmount * creatorShareBps) / BPS_DENOMINATOR;
        uint256 protocolAmount = feeAmount - creatorAmount;

        if (protocolAmount > 0) poolManager.take(feeCurrency, protocolTreasury, protocolAmount);
        if (creatorAmount > 0) {
            _routeCreatorShare(id, cfg, feeCurrency, creatorAmount);
        }

        emit TaxRouted(id, Currency.unwrap(feeCurrency), protocolAmount, creatorAmount, cfg.mode);
        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    /**
     * @dev Where the creator's share goes, settled inside the swap.
     *
     *      ARCANE burns outright when the fee arrived in the token, which is
     *      every buy. When it arrived in USDC — every sell — there is nothing
     *      to burn yet, so it is parked for sweepQuote. Paying it to the
     *      creator instead would quietly convert a burn token into a fee token.
     */
    function _routeCreatorShare(
        PoolId id,
        PoolConfig memory cfg,
        Currency feeCurrency,
        uint256 amount
    ) private {
        address currency = Currency.unwrap(feeCurrency);

        if (cfg.mode == Mode.ARCANE) {
            if (currency == cfg.token) {
                poolManager.take(feeCurrency, BURN_ADDRESS, amount);
            } else {
                poolManager.take(feeCurrency, address(this), amount);
                pendingBurnQuote[id] += amount;
            }
            return;
        }

        if (cfg.mode == Mode.DIVIUM) {
            // Holders are paid in the quote asset. A token-denominated fee is
            // not that, and inventing a conversion here would mean swapping
            // inside a swap, so it is burned — which is at least a real
            // benefit to the holders it was owed to.
            if (currency == cfg.quote && cfg.distributor != address(0)) {
                poolManager.take(feeCurrency, cfg.distributor, amount);
                IDiviumToken(cfg.token).notifyRewardAmount(amount);
            } else {
                poolManager.take(feeCurrency, BURN_ADDRESS, amount);
            }
            return;
        }

        poolManager.take(feeCurrency, cfg.creator, amount);
    }

    /**
     * @notice Hand an ARCANE pool's parked USDC to its distributor to be bought
     *         back and burned. Permissionless: it can only ever move funds to
     *         the address configured at launch, so there is nothing to steer.
     */
    function sweepQuote(PoolKey calldata key) external {
        PoolId id = key.toId();
        PoolConfig memory cfg = _configs[id];
        uint256 amount = pendingBurnQuote[id];
        if (amount == 0) revert NothingPending();
        if (cfg.distributor == address(0)) revert ZeroAddress();
        pendingBurnQuote[id] = 0;
        IERC20(cfg.quote).safeTransfer(cfg.distributor, amount);
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
