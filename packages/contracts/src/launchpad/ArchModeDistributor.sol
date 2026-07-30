// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArchLaunchpadFactory} from "./ArchLaunchpadFactory.sol";
import {ArchLiquidityVault} from "./ArchLiquidityVault.sol";
import {ISwapRouter} from "./interfaces/IUniswapV3.sol";

interface IArchLaunchTokenV2 {
    function notifyRewardAmount(uint256 usdcAmount) external;
    function consumeRewards(address account) external returns (uint256);
    function earned(address account) external view returns (uint256);
    function rewardsEnabled() external view returns (bool);
}

/// @title Arch mode distributor
/// @notice Collects each pool's trading fees and routes the creator's share
///         according to the mode the creator chose at launch:
///
///           STANDARD — paid to the creator's wallet (the default).
///           DIVIUM   — paid to token holders in USDC, pro-rata and forever;
///                      holders claim what they've accrued at any time.
///           ARCANE   — used to buy the token on the open market and burn it,
///                      permanently reducing supply.
///
///         The protocol's share and the token-side burn are identical in every
///         mode. Modes are fixed at launch and can never be changed.
contract ArchModeDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Mode { STANDARD, DIVIUM, ARCANE }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MIN_CREATOR_SHARE_BPS = 100;
    uint256 public constant MAX_CREATOR_SHARE_BPS = 5_000;
    uint24 public constant POOL_FEE = 10_000;

    ArchLaunchpadFactory public immutable factory;
    ArchLaunchpadFactory public immutable legacyFactory;
    ArchLiquidityVault public immutable vault;
    ISwapRouter public immutable swapRouter;

    uint256 public creatorShareBps;
    address public protocolTreasury;

    /// @notice Launch mode per token, set once by the factory at launch.
    mapping(address => Mode) public modeOf;
    mapping(address => bool) public modeSet;

    event FeesDistributed(
        address indexed token,
        address indexed pairToken,
        uint256 tokenFeesBurned,
        uint256 creatorReward,
        uint256 protocolReward
    );
    event ModeApplied(address indexed token, Mode mode, uint256 creatorShare);
    event RewardsClaimed(address indexed token, address indexed holder, uint256 amount);
    event CreatorShareUpdated(uint256 oldShareBps, uint256 newShareBps);
    event ProtocolTreasuryUpdated(address oldTreasury, address newTreasury);

    error UnknownToken();
    error ShareOutOfBounds();
    error ZeroAddress();
    error NotFactory();
    error ModeAlreadySet();

    constructor(
        address factory_,
        address vault_,
        address owner_,
        uint256 creatorShareBps_,
        address protocolTreasury_,
        address legacyFactory_,
        address swapRouter_
    ) Ownable(owner_) {
        if (factory_ == address(0) || vault_ == address(0) || protocolTreasury_ == address(0) || swapRouter_ == address(0)) {
            revert ZeroAddress();
        }
        if (creatorShareBps_ < MIN_CREATOR_SHARE_BPS || creatorShareBps_ > MAX_CREATOR_SHARE_BPS) {
            revert ShareOutOfBounds();
        }
        factory = ArchLaunchpadFactory(factory_);
        legacyFactory = ArchLaunchpadFactory(legacyFactory_);
        vault = ArchLiquidityVault(vault_);
        swapRouter = ISwapRouter(swapRouter_);
        creatorShareBps = creatorShareBps_;
        protocolTreasury = protocolTreasury_;
    }

    /// @notice Factory-only, one-time mode assignment at launch.
    function setMode(address token, uint8 mode) external {
        if (msg.sender != address(factory)) revert NotFactory();
        if (modeSet[token]) revert ModeAlreadySet();
        modeSet[token] = true;
        modeOf[token] = Mode(mode);
    }

    /// @notice Collect and route this pool's accrued fees. Permissionless.
    function distribute(address token) public nonReentrant {
        (address launched, address creator, address pairToken, , uint256 positionId) = factory.launches(token);
        if (launched == address(0) && address(legacyFactory) != address(0)) {
            (launched, creator, pairToken, , positionId) = legacyFactory.launches(token);
        }
        if (launched == address(0)) revert UnknownToken();

        (uint256 amount0, uint256 amount1) = vault.collectFees(positionId);
        bool tokenIsToken0 = token < pairToken;
        uint256 tokenFees = tokenIsToken0 ? amount0 : amount1;
        uint256 quoteFees = tokenIsToken0 ? amount1 : amount0;

        // Token-side fees are always burned, plus any swap-tax proceeds that
        // accumulated here from the token's own tax hook.
        uint256 tokenBalance = IERC20(token).balanceOf(address(this));
        if (tokenBalance > 0) {
            IERC20(token).safeTransfer(BURN_ADDRESS, tokenBalance);
            tokenFees = tokenBalance;
        }

        uint256 creatorReward = (quoteFees * creatorShareBps) / BPS_DENOMINATOR;
        uint256 protocolReward = quoteFees - creatorReward;
        if (protocolReward > 0) IERC20(pairToken).safeTransfer(protocolTreasury, protocolReward);

        if (creatorReward > 0) {
            Mode mode = modeOf[token];
            if (mode == Mode.DIVIUM) {
                // Held here; the token's index advances so holders can claim.
                IArchLaunchTokenV2(token).notifyRewardAmount(creatorReward);
            } else if (mode == Mode.ARCANE) {
                _buyAndBurn(token, pairToken, creatorReward);
            } else {
                IERC20(pairToken).safeTransfer(creator, creatorReward);
            }
            emit ModeApplied(token, mode, creatorReward);
        }

        emit FeesDistributed(token, pairToken, tokenFees, creatorReward, protocolReward);
    }

    function distributeBatch(address[] calldata tokens) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            distribute(tokens[i]);
        }
    }

    /// @notice Divium: claim the USDC a holder has accrued for `token`.
    function claimRewards(address token) external nonReentrant returns (uint256 amount) {
        amount = IArchLaunchTokenV2(token).consumeRewards(msg.sender);
        if (amount == 0) return 0;
        (, , address pairToken, , ) = factory.launches(token);
        if (pairToken == address(0) && address(legacyFactory) != address(0)) {
            (, , pairToken, , ) = legacyFactory.launches(token);
        }
        IERC20(pairToken).safeTransfer(msg.sender, amount);
        emit RewardsClaimed(token, msg.sender, amount);
    }

    /// @notice Rewards a holder can claim right now.
    function claimable(address token, address holder) external view returns (uint256) {
        return IArchLaunchTokenV2(token).earned(holder);
    }

    /// @dev Arcane: market-buy the token with the creator share and burn it.
    ///      A failed swap must never brick fee collection, so it degrades to
    ///      leaving the quote here for the next attempt.
    function _buyAndBurn(address token, address pairToken, uint256 quoteIn) internal {
        IERC20(pairToken).forceApprove(address(swapRouter), quoteIn);
        try swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: pairToken,
                tokenOut: token,
                fee: POOL_FEE,
                recipient: BURN_ADDRESS,
                amountIn: quoteIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256) {
            // Bought and burned in one hop — tokens went straight to the sink.
        } catch {
            IERC20(pairToken).forceApprove(address(swapRouter), 0);
        }
    }

    function setCreatorShare(uint256 newShareBps) external onlyOwner {
        if (newShareBps < MIN_CREATOR_SHARE_BPS || newShareBps > MAX_CREATOR_SHARE_BPS) revert ShareOutOfBounds();
        emit CreatorShareUpdated(creatorShareBps, newShareBps);
        creatorShareBps = newShareBps;
    }

    function setProtocolTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit ProtocolTreasuryUpdated(protocolTreasury, newTreasury);
        protocolTreasury = newTreasury;
    }
}
