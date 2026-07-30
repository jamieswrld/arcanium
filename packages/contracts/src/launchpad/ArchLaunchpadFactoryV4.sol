// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArchLaunchTokenV2} from "./ArchLaunchTokenV2.sol";
import {INonfungiblePositionManager, ISwapRouter} from "./interfaces/IUniswapV3.sol";

interface IModeDistributor {
    function setMode(address token, uint8 mode) external;
}

/// @title Arch launchpad factory (v4)
/// @notice Adds creator-selected launch options on top of v3: an optional
///         swap tax tier and a fee mode (STANDARD / DIVIUM / ARCANE), both
///         fixed forever at launch. Everything else is unchanged — fixed
///         supply, real Uniswap pool from block one, permanently locked
///         liquidity, optional atomic creator buy.
contract ArchLaunchpadFactoryV4 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10_000;
    int24 public constant MAX_USABLE_TICK = 887_200;
    int24 public constant MIN_USABLE_TICK = -887_200;
    uint160 public constant SQRT_PRICE_TOKEN0 = 137227202865029797602;
    uint160 public constant SQRT_PRICE_TOKEN1 = 45742400955009932534161870629490520388;
    int24 public constant LAUNCH_TICK_TOKEN0 = -403_400;
    int24 public constant LAUNCH_TICK_TOKEN1 = 403_400;

    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter public immutable swapRouter;
    address public immutable liquidityVault;

    mapping(address => bool) public allowedPairTokens;
    address public pairToken;
    uint256 public launchFee;
    address public launchFeeTreasury;
    bool public launchesPaused;
    /// @notice Mode distributor: receives tax proceeds and routes creator fees.
    address public modeDistributor;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataUri;
        address pairToken;
        uint256 creatorBuyAmount;
        uint256 minTokensOut;
        uint256 deadline;
        address feeRecipient;
        /// Extra tax on pool trades in bps (0 = default 1% tier, max 900).
        uint256 taxBps;
        /// 0 = STANDARD, 1 = DIVIUM, 2 = ARCANE.
        uint8 mode;
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
    event LaunchOptions(address indexed token, uint256 taxBps, uint8 mode);
    event ModeDistributorUpdated(address oldDistributor, address newDistributor);
    event LaunchFeeUpdated(uint256 oldFee, uint256 newFee);
    event PairTokenAllowed(address indexed token, bool allowed);
    event LaunchesPausedSet(bool paused);

    error LaunchesArePaused();
    error PairTokenNotAllowed();
    error ZeroAddress();
    error EmptyString();
    error DeadlinePassed();
    error ResidualSupply();
    error DistributorNotSet();
    error BadMode();

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

    function launch(LaunchParams calldata params)
        external
        nonReentrant
        returns (address token, address pool, uint256 positionId)
    {
        if (launchesPaused) revert LaunchesArePaused();
        if (!allowedPairTokens[params.pairToken]) revert PairTokenNotAllowed();
        if (bytes(params.name).length == 0 || bytes(params.symbol).length == 0) revert EmptyString();
        if (block.timestamp > params.deadline) revert DeadlinePassed();
        if (params.mode > 2) revert BadMode();
        address distributor = modeDistributor;
        if (distributor == address(0)) revert DistributorNotSet();

        if (launchFee > 0) {
            IERC20(params.pairToken).safeTransferFrom(msg.sender, launchFeeTreasury, launchFee);
        }

        // 1. Token with the creator's chosen options baked in permanently.
        ArchLaunchTokenV2 launchToken = new ArchLaunchTokenV2(
            params.name, params.symbol, params.taxBps, distributor, params.mode == 1
        );
        token = address(launchToken);
        uint256 supply = launchToken.FIXED_SUPPLY();

        // 2. Pool at the fixed launch price.
        bool tokenIsToken0 = token < params.pairToken;
        (address token0, address token1) = tokenIsToken0
            ? (token, params.pairToken)
            : (params.pairToken, token);
        uint160 sqrtPriceX96 = tokenIsToken0 ? SQRT_PRICE_TOKEN0 : SQRT_PRICE_TOKEN1;
        pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, POOL_FEE, sqrtPriceX96);
        // Bind the pool so trades against it are the taxed/excluded direction.
        launchToken.setPool(pool);

        // 3. Entire supply as one locked single-sided position.
        (int24 tickLower, int24 tickUpper) = tokenIsToken0
            ? (LAUNCH_TICK_TOKEN0, MAX_USABLE_TICK)
            : (MIN_USABLE_TICK, LAUNCH_TICK_TOKEN1);
        launchToken.approve(address(positionManager), supply);
        (positionId, , , ) = positionManager.mint(
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
                deadline: params.deadline
            })
        );

        uint256 residual = launchToken.balanceOf(address(this));
        if (residual > 0) {
            if (residual > supply / 1e6) revert ResidualSupply();
            launchToken.transfer(0x000000000000000000000000000000000000dEaD, residual);
        }

        address rewardWallet = params.feeRecipient == address(0) ? msg.sender : params.feeRecipient;
        launches[token] = LaunchInfo({
            token: token,
            creator: rewardWallet,
            pairToken: params.pairToken,
            pool: pool,
            positionId: positionId
        });
        allTokens.push(token);

        // 4. Record the fee mode with the distributor (one-time, immutable).
        IModeDistributor(distributor).setMode(token, params.mode);

        emit Launched(token, rewardWallet, params.pairToken, pool, positionId, params.metadataUri);
        emit LaunchOptions(token, params.taxBps, params.mode);

        // 5. Optional atomic creator buy — nobody can trade ahead of them.
        if (params.creatorBuyAmount > 0) {
            IERC20(params.pairToken).safeTransferFrom(msg.sender, address(this), params.creatorBuyAmount);
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

    function setModeDistributor(address newDistributor) external onlyOwner {
        if (newDistributor == address(0)) revert ZeroAddress();
        emit ModeDistributorUpdated(modeDistributor, newDistributor);
        modeDistributor = newDistributor;
    }

    function setLaunchFee(uint256 newFee) external onlyOwner {
        emit LaunchFeeUpdated(launchFee, newFee);
        launchFee = newFee;
    }

    function setLaunchFeeTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        launchFeeTreasury = newTreasury;
    }

    function setPairTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedPairTokens[token] = allowed;
        emit PairTokenAllowed(token, allowed);
    }

    function setPairToken(address newPairToken) external onlyOwner {
        if (newPairToken == address(0)) revert ZeroAddress();
        if (!allowedPairTokens[newPairToken]) revert PairTokenNotAllowed();
        pairToken = newPairToken;
    }

    function setLaunchesPaused(bool paused) external onlyOwner {
        launchesPaused = paused;
        emit LaunchesPausedSet(paused);
    }
}
