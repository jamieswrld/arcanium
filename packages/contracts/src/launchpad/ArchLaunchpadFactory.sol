// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArchLaunchToken} from "./ArchLaunchToken.sol";
import {
    INonfungiblePositionManager,
    ISwapRouter
} from "./interfaces/IUniswapV3.sol";

/// @title Arch launchpad factory
/// @notice One transaction creates: a fixed-supply token, a standard Uniswap
///         v3 pool at the 1% tier initialized near a $3,000 market cap, a
///         single-sided position holding the entire one-billion supply locked
///         permanently in the liquidity vault, and (optionally) the creator's
///         first purchase — atomically, so nobody can front-run the creator.
/// @dev    No bonding curve, no internal ledger, no pre-graduation market,
///         no proxy. The pool is real Uniswap from the first block.
contract ArchLaunchpadFactory is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10_000; // 1% tier
    int24 public constant TICK_SPACING = 200;
    /// Highest/lowest usable ticks at spacing 200.
    int24 public constant MAX_USABLE_TICK = 887_200;
    int24 public constant MIN_USABLE_TICK = -887_200;

    /// Launch price ≈ $0.000003/token (≈$3,000 market cap), 6-decimal quote.
    /// sqrt(3/1e18) * 2^96 — exact integer, token as token0.
    uint160 public constant SQRT_PRICE_TOKEN0 = 137227202865029797602;
    /// sqrt(1e18/3) * 2^96 — exact integer, token as token1.
    uint160 public constant SQRT_PRICE_TOKEN1 = 45742400955009932534161870629490520388;
    /// Single-sided range boundaries nearest the start price (± margin).
    int24 public constant LAUNCH_TICK_TOKEN0 = -403_400;
    int24 public constant LAUNCH_TICK_TOKEN1 = 403_400;

    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter public immutable swapRouter;
    address public immutable liquidityVault;

    /// @notice Allowed quote tokens (aUSD now; native-USDC ERC-20 later).
    mapping(address => bool) public allowedPairTokens;
    /// @notice Current canonical pair token (updates at aUSD→USDC migration).
    address public pairToken;
    /// @notice Launch fee in quote units (6 decimals), read live by clients.
    uint256 public launchFee;
    address public launchFeeTreasury;
    bool public launchesPaused;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataUri;
        address pairToken;
        uint256 creatorBuyAmount;
        uint256 minTokensOut;
        uint256 deadline;
    }

    struct LaunchInfo {
        address token;
        address creator;
        address pairToken;
        address pool;
        uint256 positionId;
    }

    mapping(address => LaunchInfo) public launches;
    address[] public allTokens;

    event Launched(
        address indexed token,
        address indexed creator,
        address pairToken,
        address pool,
        uint256 positionId,
        string metadataUri
    );
    event LaunchFeeUpdated(uint256 oldFee, uint256 newFee);
    event LaunchFeeTreasuryUpdated(address oldTreasury, address newTreasury);
    event PairTokenAllowed(address indexed token, bool allowed);
    event PairTokenUpdated(address oldPairToken, address newPairToken);
    event LaunchesPausedSet(bool paused);

    error LaunchesArePaused();
    error PairTokenNotAllowed();
    error ZeroAddress();
    error EmptyString();
    error DeadlinePassed();
    error ResidualSupply();

    constructor(
        address positionManager_,
        address swapRouter_,
        address liquidityVault_,
        address owner_,
        address pairToken_,
        uint256 launchFee_,
        address launchFeeTreasury_
    ) Ownable(owner_) {
        if (
            positionManager_ == address(0) || swapRouter_ == address(0) ||
            liquidityVault_ == address(0) || pairToken_ == address(0) ||
            launchFeeTreasury_ == address(0)
        ) revert ZeroAddress();
        positionManager = INonfungiblePositionManager(positionManager_);
        swapRouter = ISwapRouter(swapRouter_);
        liquidityVault = liquidityVault_;
        pairToken = pairToken_;
        allowedPairTokens[pairToken_] = true;
        launchFee = launchFee_;
        launchFeeTreasury = launchFeeTreasury_;
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    // ------------------------------------------------------------------ launch

    function launch(LaunchParams calldata params)
        external
        nonReentrant
        returns (address token, address pool, uint256 positionId)
    {
        if (launchesPaused) revert LaunchesArePaused();
        if (!allowedPairTokens[params.pairToken]) revert PairTokenNotAllowed();
        if (bytes(params.name).length == 0 || bytes(params.symbol).length == 0) {
            revert EmptyString();
        }
        if (block.timestamp > params.deadline) revert DeadlinePassed();

        // Launch fee, visible and pulled up front.
        if (launchFee > 0) {
            IERC20(params.pairToken).safeTransferFrom(msg.sender, launchFeeTreasury, launchFee);
        }

        // 1. Fixed-supply token minted to this factory.
        ArchLaunchToken launchToken = new ArchLaunchToken(params.name, params.symbol);
        token = address(launchToken);
        uint256 supply = launchToken.FIXED_SUPPLY();

        // 2. Pool at the exact launch price; ordering by address sort.
        bool tokenIsToken0 = token < params.pairToken;
        (address token0, address token1) = tokenIsToken0
            ? (token, params.pairToken)
            : (params.pairToken, token);
        uint160 sqrtPriceX96 = tokenIsToken0 ? SQRT_PRICE_TOKEN0 : SQRT_PRICE_TOKEN1;
        pool = positionManager.createAndInitializePoolIfNecessary(
            token0, token1, POOL_FEE, sqrtPriceX96
        );

        // 3. Entire supply as a single-sided position, minted directly into
        //    the permanent vault.
        (int24 tickLower, int24 tickUpper) = tokenIsToken0
            ? (LAUNCH_TICK_TOKEN0, MAX_USABLE_TICK)
            : (MIN_USABLE_TICK, LAUNCH_TICK_TOKEN1);
        launchToken.approve(address(positionManager), supply);
        (positionId, , , ) = _mintPosition(
            token0, token1, tickLower, tickUpper, tokenIsToken0, supply, params.deadline
        );

        // Rounding can strand a few wei of supply in the factory; burn them so
        // the factory retains nothing and supply accounting stays exact.
        uint256 residual = launchToken.balanceOf(address(this));
        if (residual > 0) {
            if (residual > supply / 1e6) revert ResidualSupply(); // >0.0001% means math is wrong
            launchToken.transfer(0x000000000000000000000000000000000000dEaD, residual);
        }

        launches[token] = LaunchInfo({
            token: token,
            creator: msg.sender,
            pairToken: params.pairToken,
            pool: pool,
            positionId: positionId
        });
        allTokens.push(token);

        emit Launched(token, msg.sender, params.pairToken, pool, positionId, params.metadataUri);

        // 4. Optional atomic creator purchase — same transaction, so no one
        //    can trade before the creator.
        if (params.creatorBuyAmount > 0) {
            IERC20(params.pairToken).safeTransferFrom(
                msg.sender, address(this), params.creatorBuyAmount
            );
            IERC20(params.pairToken).forceApprove(address(swapRouter), params.creatorBuyAmount);
            swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: params.pairToken,
                    tokenOut: token,
                    fee: POOL_FEE,
                    recipient: msg.sender,
                    amountIn: params.creatorBuyAmount,
                    amountOutMinimum: params.minTokensOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }
    }

    function _mintPosition(
        address token0,
        address token1,
        int24 tickLower,
        int24 tickUpper,
        bool tokenIsToken0,
        uint256 supply,
        uint256 deadline
    ) internal returns (uint256 positionId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        (positionId, liquidity, amount0, amount1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: tokenIsToken0 ? supply : 0,
                amount1Desired: tokenIsToken0 ? 0 : supply,
                amount0Min: 0,
                amount1Min: 0,
                recipient: liquidityVault,
                deadline: deadline
            })
        );
    }

    // ------------------------------------------------------------------- admin

    function setLaunchFee(uint256 newFee) external onlyOwner {
        emit LaunchFeeUpdated(launchFee, newFee);
        launchFee = newFee;
    }

    function setLaunchFeeTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit LaunchFeeTreasuryUpdated(launchFeeTreasury, newTreasury);
        launchFeeTreasury = newTreasury;
    }

    function setPairTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedPairTokens[token] = allowed;
        emit PairTokenAllowed(token, allowed);
    }

    /// @notice Update the canonical pair token (aUSD→USDC migration step 13).
    function setPairToken(address newPairToken) external onlyOwner {
        if (newPairToken == address(0)) revert ZeroAddress();
        if (!allowedPairTokens[newPairToken]) revert PairTokenNotAllowed();
        emit PairTokenUpdated(pairToken, newPairToken);
        pairToken = newPairToken;
    }

    function setLaunchesPaused(bool paused) external onlyOwner {
        launchesPaused = paused;
        emit LaunchesPausedSet(paused);
    }
}
