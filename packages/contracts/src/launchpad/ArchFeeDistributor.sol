// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArchLaunchpadFactory} from "./ArchLaunchpadFactory.sol";
import {ArchLiquidityVault} from "./ArchLiquidityVault.sol";

/// @title Arch fee distributor
/// @notice Permissionless collection and distribution of launch-pool trading
///         fees: 100% of token-side fees are burned; quote-side fees split
///         30% to the immutable token creator and 70% to the Arch protocol
///         treasury. Anyone can trigger distribution for any pool; recipients
///         are fixed for the life of the pool.
contract ArchFeeDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// @notice Creator share bounds. Floor is 1% (protocol keeps the rest);
    ///         ceiling 50%. Compiled-in so even the owner cannot exceed them.
    uint256 public constant MIN_CREATOR_SHARE_BPS = 100;
    uint256 public constant MAX_CREATOR_SHARE_BPS = 5_000;

    ArchLaunchpadFactory public immutable factory;
    /// @notice Previous factory generation (address(0) = none). Lets one
    ///         distributor keep serving tokens launched before an upgrade.
    ArchLaunchpadFactory public immutable legacyFactory;
    ArchLiquidityVault public immutable vault;

    /// @notice Creator share of quote-side fees in bps (3000 = 30%).
    uint256 public creatorShareBps;
    address public protocolTreasury;

    event FeesDistributed(
        address indexed token,
        address indexed pairToken,
        uint256 tokenFeesBurned,
        uint256 creatorReward,
        uint256 protocolReward
    );
    event CreatorShareUpdated(uint256 oldShareBps, uint256 newShareBps);
    event ProtocolTreasuryUpdated(address oldTreasury, address newTreasury);

    error UnknownToken();
    error ShareOutOfBounds();
    error ZeroAddress();

    constructor(
        address factory_,
        address vault_,
        address owner_,
        uint256 creatorShareBps_,
        address protocolTreasury_,
        address legacyFactory_
    ) Ownable(owner_) {
        if (factory_ == address(0) || vault_ == address(0) || protocolTreasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (creatorShareBps_ < MIN_CREATOR_SHARE_BPS || creatorShareBps_ > MAX_CREATOR_SHARE_BPS) {
            revert ShareOutOfBounds();
        }
        factory = ArchLaunchpadFactory(factory_);
        legacyFactory = ArchLaunchpadFactory(legacyFactory_);
        vault = ArchLiquidityVault(vault_);
        creatorShareBps = creatorShareBps_;
        protocolTreasury = protocolTreasury_;
    }

    /// @notice Collect and distribute accrued fees for one launched token.
    ///         Fully permissionless.
    function distribute(address token) public nonReentrant {
        (address launchedToken, address creator, address pairToken, , uint256 positionId) =
            factory.launches(token);
        if (launchedToken == address(0) && address(legacyFactory) != address(0)) {
            (launchedToken, creator, pairToken, , positionId) = legacyFactory.launches(token);
        }
        if (launchedToken == address(0)) revert UnknownToken();

        (uint256 amount0, uint256 amount1) = vault.collectFees(positionId);
        bool tokenIsToken0 = token < pairToken;
        uint256 tokenFees = tokenIsToken0 ? amount0 : amount1;
        uint256 quoteFees = tokenIsToken0 ? amount1 : amount0;

        // Token-side: 100% burned. Never routed to any treasury.
        if (tokenFees > 0) {
            IERC20(token).safeTransfer(BURN_ADDRESS, tokenFees);
        }

        // Quote-side: creator share to the immutable creator, rest to Arch.
        uint256 creatorReward = (quoteFees * creatorShareBps) / BPS_DENOMINATOR;
        uint256 protocolReward = quoteFees - creatorReward;
        if (creatorReward > 0) {
            IERC20(pairToken).safeTransfer(creator, creatorReward);
        }
        if (protocolReward > 0) {
            IERC20(pairToken).safeTransfer(protocolTreasury, protocolReward);
        }

        emit FeesDistributed(token, pairToken, tokenFees, creatorReward, protocolReward);
    }

    /// @notice Operator convenience: distribute a batch of pools.
    function distributeBatch(address[] calldata tokens) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            distribute(tokens[i]);
        }
    }

    function setCreatorShare(uint256 newShareBps) external onlyOwner {
        if (newShareBps < MIN_CREATOR_SHARE_BPS || newShareBps > MAX_CREATOR_SHARE_BPS) {
            revert ShareOutOfBounds();
        }
        emit CreatorShareUpdated(creatorShareBps, newShareBps);
        creatorShareBps = newShareBps;
    }

    function setProtocolTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit ProtocolTreasuryUpdated(protocolTreasury, newTreasury);
        protocolTreasury = newTreasury;
    }
}
