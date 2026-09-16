// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapRouter, IUniswapV3PoolMinimal} from "../launchpad/interfaces/IUniswapV3.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// The slice of Uniswap v3's oracle this needs. Not in IUniswapV3PoolMinimal
/// because nothing else in the codebase has needed a price history before.
interface IUniswapV3Oracle {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/**
 * @title Arcanium buyback
 * @notice Takes a share of protocol fees, buys ARCANIUM with it, and burns it.
 *
 * This is a one-way valve and is deliberately built so that it cannot be
 * anything else. There is no owner, no withdraw, no rescue, no pause and no
 * upgrade path. USDC that arrives here has exactly one exit: through the pool
 * and into the burn address. Nobody — including whoever deployed it — can take
 * it back out, which is the entire reason for pointing fees at a contract
 * rather than at a wallet that promises to do the same thing.
 *
 * The cost of that is real and worth stating: if the pool ever became
 * untradeable, the USDC held here would be stuck forever. That risk is small
 * because the launch liquidity backing it is permanently locked, but it is not
 * zero, and it is the price of the guarantee above.
 *
 * Funded by being a recipient of the fee splitter, so the flow needs nobody to
 * remember it: fees land, a share arrives here, and anyone at all can trigger
 * the burn. `buyAndBurn` never pays its caller, so there is nothing to steer
 * and no reason to gate who may call it.
 *
 * ── On being sandwiched ─────────────────────────────────────────────────────
 * A permissionless swap with no floor is an invitation: move the price up, let
 * this buy high, sell back. The floor is therefore computed here rather than
 * accepted from the caller, since a caller who supplies their own floor can
 * supply zero.
 *
 * It is computed from the pool's TWAP, not its spot price, and that
 * distinction is the whole protection. A spot-derived floor is no defence at
 * all: the attacker moves spot first, so the floor obligingly moves up with
 * it and the swap passes its own check while buying at the manipulated price.
 * A time-weighted average cannot be moved that way — shifting it means holding
 * the price away from the market for the whole window, across every block in
 * it, which costs far more than the buyback is worth.
 *
 * If the pool cannot serve the window, this reverts rather than falling back
 * to spot. Falling back would reintroduce exactly the hole the TWAP closes,
 * and a buyback that waits is strictly better than one that is robbed. Note
 * that a fresh pool has an observation cardinality of 1 and can serve no
 * window at all until someone calls increaseObservationCardinalityNext — which
 * is permissionless — and enough history accrues.
 */
contract ArcaniumBuyback is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// How far below the time-weighted price the swap may land before it is
    /// refused. Wide enough to absorb ordinary drift over the window, narrow
    /// enough that a sandwich is not worth setting up.
    uint256 public constant MAX_SLIPPAGE_BPS = 300; // 3%

    /**
     * Smallest balance worth acting on.
     *
     * Not a policy so much as arithmetic: below roughly a dollar the gas costs
     * more than the burn is worth, and letting anyone trigger a dust swap is a
     * free way to waste the pool's depth on rounding.
     */
    uint256 public constant MIN_SPEND = 1_000_000; // 1 USDC at 6 decimals

    /// The token being bought and burned.
    address public immutable token;
    /// What it is bought with — Arc's native USDC.
    address public immutable quote;
    /// The pool consulted for spot price. Not used to swap; that is the router.
    address public immutable pool;
    ISwapRouter public immutable router;
    uint24 public immutable poolFee;
    /// Whether `token` sorts below `quote`, which decides how price is read.
    bool public immutable tokenIsToken0;
    /// Seconds of price history the floor is averaged over.
    uint32 public immutable twapWindow;

    /// Running totals, so the flywheel is checkable without reading logs —
    /// Arc's RPCs prune them after a few days.
    uint256 public totalSpent;
    uint256 public totalBurned;
    uint256 public burnCount;

    event BoughtAndBurned(address indexed caller, uint256 spent, uint256 burned, uint256 minimumAccepted);

    error NothingToSpend();
    error ZeroAddress();
    error PoolMismatch();
    error NoSpotPrice();
    error NoPriceHistory();
    error WindowTooShort();

    constructor(
        address token_,
        address quote_,
        address pool_,
        address router_,
        uint24 poolFee_,
        uint32 twapWindow_
    ) {
        // A one-block window is a spot price wearing a disguise, and spot is
        // what this exists to avoid relying on.
        if (twapWindow_ < 60) revert WindowTooShort();
        if (token_ == address(0) || quote_ == address(0) || pool_ == address(0) || router_ == address(0)) {
            revert ZeroAddress();
        }

        // The pool is verified to be the pair it claims rather than trusted
        // from a constructor argument: a wrong pool here would silently price
        // every buyback against an unrelated market.
        address t0 = IUniswapV3PoolMinimal(pool_).token0();
        address t1 = IUniswapV3PoolMinimal(pool_).token1();
        bool tokenIs0 = t0 == token_ && t1 == quote_;
        bool tokenIs1 = t1 == token_ && t0 == quote_;
        if (!tokenIs0 && !tokenIs1) revert PoolMismatch();

        token = token_;
        quote = quote_;
        pool = pool_;
        router = ISwapRouter(router_);
        poolFee = poolFee_;
        tokenIsToken0 = tokenIs0;
        twapWindow = twapWindow_;
    }

    /// @notice USDC sitting here waiting to be spent.
    function pending() public view returns (uint256) {
        return IERC20(quote).balanceOf(address(this));
    }

    /// @notice True when there is enough to be worth a call.
    function ready() external view returns (bool) {
        return pending() >= MIN_SPEND;
    }

    /**
     * @notice Spend everything held on ARCANIUM and burn it.
     *
     * Permissionless. The caller is never paid, the destination is a constant,
     * and the floor is computed here — so calling it confers nothing except
     * the gas bill.
     */
    function buyAndBurn() external nonReentrant returns (uint256 spent, uint256 burned) {
        spent = pending();
        if (spent < MIN_SPEND) revert NothingToSpend();

        uint256 minOut = _minimumOut(spent);

        IERC20(quote).forceApprove(address(router), spent);
        burned = router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: quote,
                tokenOut: token,
                fee: poolFee,
                // Straight to the sink. The tokens are never held here, so
                // there is no moment at which they could be moved elsewhere.
                recipient: BURN_ADDRESS,
                amountIn: spent,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        // Deliberately not wrapped in a try/catch. A failed buyback should
        // revert and leave the USDC here for the next attempt, loudly. The v3
        // distributor swallowed exactly this failure and stranded funds while
        // reporting success, and that is not repeated.
        totalSpent += spent;
        totalBurned += burned;
        burnCount += 1;

        emit BoughtAndBurned(msg.sender, spent, burned, minOut);
    }

    /**
     * @dev The least this swap may return, from the pool's time-weighted price.
     *
     *      Reverts when the pool has no history covering the window. That is
     *      the correct failure: the alternative is falling back to spot, which
     *      an attacker sets, and a buyback that declines to trade loses
     *      nothing but time.
     */
    function _minimumOut(uint256 amountIn) internal view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        ago[1] = 0;

        int56[] memory cumulatives;
        try IUniswapV3Oracle(pool).observe(ago) returns (int56[] memory tc, uint160[] memory) {
            cumulatives = tc;
        } catch {
            revert NoPriceHistory();
        }

        int56 delta = cumulatives[1] - cumulatives[0];
        int24 avgTick = int24(delta / int56(uint56(twapWindow)));
        // Uniswap's own oracle library rounds toward negative infinity here;
        // truncating instead would bias the floor upward for negative ticks and
        // reject honest swaps.
        if (delta < 0 && (delta % int56(uint56(twapWindow)) != 0)) avgTick--;

        uint256 sp = uint256(TickMath.getSqrtPriceAtTick(avgTick));
        if (sp == 0) revert NoSpotPrice();
        uint256 Q96 = 1 << 96;

        // price = (sqrt/2^96)^2, as token1 per token0. Taken in two steps so
        // the intermediate stays inside 256 bits — squaring it does not.
        uint256 expected = tokenIsToken0
            ? Math.mulDiv(Math.mulDiv(amountIn, Q96, sp), Q96, sp)
            : Math.mulDiv(Math.mulDiv(amountIn, sp, Q96), sp, Q96);

        // The pool takes its fee out of the input before the swap reaches the
        // curve, so the floor has to expect less by that much.
        uint256 afterFee = (expected * (BPS_DENOMINATOR - poolFee / 100)) / BPS_DENOMINATOR;
        return (afterFee * (BPS_DENOMINATOR - MAX_SLIPPAGE_BPS)) / BPS_DENOMINATOR;
    }
}
