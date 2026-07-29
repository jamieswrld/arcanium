// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {INonfungiblePositionManager} from "./interfaces/IUniswapV3.sol";

/// @title Arch liquidity vault
/// @notice Permanent home of every launch position NFT. Principal can never
///         be withdrawn, the NFT can never be transferred out, and liquidity
///         can never be decreased by any administrator. The only outward
///         paths are fee collection (fee distributor only) and the narrow,
///         separately-authorized aUSD→USDC migration.
contract ArchLiquidityVault is Ownable2Step, IERC721Receiver {
    INonfungiblePositionManager public immutable positionManager;

    /// @notice The only address allowed to collect fees (ArchFeeDistributor).
    address public feeDistributor;
    /// @notice The only address allowed to execute pool migration; expected
    ///         to be a dedicated timelocked migration contract, not an EOA.
    address public migrationAuthority;

    mapping(uint256 => bool) public heldPositions;

    event FeeDistributorUpdated(address oldDistributor, address newDistributor);
    event MigrationAuthorityUpdated(address oldAuthority, address newAuthority);
    event PositionReceived(uint256 indexed tokenId);
    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);
    event PositionMigrated(uint256 indexed tokenId, uint256 amount0, uint256 amount1);

    error NotFeeDistributor();
    error NotMigrationAuthority();
    error UnknownPosition();
    error ZeroAddress();
    error OnlyPositionManagerNFTs();

    constructor(address positionManager_, address owner_) Ownable(owner_) {
        if (positionManager_ == address(0)) revert ZeroAddress();
        positionManager = INonfungiblePositionManager(positionManager_);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        override
        returns (bytes4)
    {
        if (msg.sender != address(positionManager)) revert OnlyPositionManagerNFTs();
        heldPositions[tokenId] = true;
        emit PositionReceived(tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Collect accrued trading fees to the fee distributor. Principal
    ///         is untouched — collect only moves fee growth.
    function collectFees(uint256 tokenId)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.sender != feeDistributor) revert NotFeeDistributor();
        // The position manager mints with a plain _mint (no ERC-721 callback),
        // so custody is verified directly rather than via received hooks.
        if (positionManager.ownerOf(tokenId) != address(this)) revert UnknownPosition();
        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: feeDistributor,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit FeesCollected(tokenId, amount0, amount1);
    }

    /// @notice The single, narrow migration path: decrease the position fully
    ///         and send both amounts to the migration authority, which must
    ///         recreate an equivalent USDC pool per the documented process.
    ///         Callable only by the configured authority (timelocked migration
    ///         contract), never by ordinary admins.
    function migratePosition(uint256 tokenId, uint256 deadline)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.sender != migrationAuthority) revert NotMigrationAuthority();
        if (positionManager.ownerOf(tokenId) != address(this)) revert UnknownPosition();
        (, , , , , , , uint128 liquidity, , , , ) = positionManager.positions(tokenId);
        positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: deadline
            })
        );
        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: migrationAuthority,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        heldPositions[tokenId] = false;
        emit PositionMigrated(tokenId, amount0, amount1);
    }

    function setFeeDistributor(address newDistributor) external onlyOwner {
        if (newDistributor == address(0)) revert ZeroAddress();
        emit FeeDistributorUpdated(feeDistributor, newDistributor);
        feeDistributor = newDistributor;
    }

    function setMigrationAuthority(address newAuthority) external onlyOwner {
        emit MigrationAuthorityUpdated(migrationAuthority, newAuthority);
        migrationAuthority = newAuthority;
    }
}
