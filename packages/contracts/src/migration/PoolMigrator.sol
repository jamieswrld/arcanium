// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArchLiquidityVault} from "../launchpad/ArchLiquidityVault.sol";
import {ArchLaunchpadFactory} from "../launchpad/ArchLaunchpadFactory.sol";
import {AusdExchange} from "./AusdExchange.sol";
import {
    INonfungiblePositionManager,
    IUniswapV3PoolMinimal
} from "../launchpad/interfaces/IUniswapV3.sol";

/// @title Arch pool migrator
/// @notice Converts an aUSD-paired launch pool to a native-USDC pool with the
///         same effective price, the same token amounts (aUSD exchanged 1:1),
///         and the closest range Uniswap math permits. The new position locks
///         straight back into the liquidity vault; fee recipients are
///         unchanged because the factory's launch registry (creator, token)
///         is unchanged. Owner is expected to be the timelocked multisig, and
///         this contract must be set as the vault's migrationAuthority.
contract PoolMigrator is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10_000;
    uint256 public constant Q96 = 2 ** 96;

    ArchLiquidityVault public immutable vault;
    ArchLaunchpadFactory public immutable factory;
    AusdExchange public immutable exchange;
    INonfungiblePositionManager public immutable positionManager;
    IERC20 public immutable ausd;
    IERC20 public immutable usdc;

    mapping(address => bool) public migrated;
    mapping(address => uint256) public newPositionIds;

    event PoolMigrated(
        address indexed token,
        address oldPool,
        address newPool,
        uint256 oldPositionId,
        uint256 newPositionId,
        uint256 tokenAmount,
        uint256 quoteAmount
    );

    error AlreadyMigrated();
    error UnknownToken();
    error NotAusdPool();
    error ZeroAddress();

    constructor(
        address vault_,
        address factory_,
        address exchange_,
        address positionManager_,
        address ausd_,
        address usdc_,
        address owner_
    ) Ownable(owner_) {
        if (
            vault_ == address(0) || factory_ == address(0) || exchange_ == address(0) ||
            positionManager_ == address(0) || ausd_ == address(0) || usdc_ == address(0)
        ) revert ZeroAddress();
        vault = ArchLiquidityVault(vault_);
        factory = ArchLaunchpadFactory(factory_);
        exchange = AusdExchange(exchange_);
        positionManager = INonfungiblePositionManager(positionManager_);
        ausd = IERC20(ausd_);
        usdc = IERC20(usdc_);
    }

    /// @notice Migrate one launch pool from aUSD to USDC. Reads the old
    ///         pool's exact price and range first, withdraws via the vault's
    ///         narrow authority path, exchanges aUSD 1:1, recreates the pool
    ///         at the equivalent price, and locks the new position back into
    ///         the vault.
    function migratePool(address token, uint256 deadline)
        external
        onlyOwner
        nonReentrant
        returns (address newPool, uint256 newPositionId)
    {
        if (migrated[token]) revert AlreadyMigrated();
        (address launchedToken, , address pairToken, address oldPool, uint256 oldPositionId) =
            factory.launches(token);
        if (launchedToken == address(0)) revert UnknownToken();
        if (pairToken != address(ausd)) revert NotAusdPool();

        // Capture the old price and range before touching the position.
        (uint160 oldSqrtPriceX96, , , , , , ) = IUniswapV3PoolMinimal(oldPool).slot0();
        bool tokenWasToken0 = token < address(ausd);
        (, , , , , int24 oldTickLower, int24 oldTickUpper, , , , , ) =
            positionManager.positions(oldPositionId);

        // Withdraw principal through the vault's authority path.
        vault.migratePosition(oldPositionId, deadline);

        // Exchange every withdrawn aUSD for USDC, one for one.
        uint256 ausdAmount = ausd.balanceOf(address(this));
        if (ausdAmount > 0) {
            exchange.exchangeFrom(address(this), ausdAmount);
        }
        uint256 tokenAmount = IERC20(token).balanceOf(address(this));
        uint256 quoteAmount = usdc.balanceOf(address(this));

        // Recreate at the same effective price. If the token/quote ordering
        // flips (USDC address sorts differently than aUSD), invert the price
        // and mirror the range.
        bool tokenIsToken0 = token < address(usdc);
        uint160 newSqrtPriceX96 = tokenIsToken0 == tokenWasToken0
            ? oldSqrtPriceX96
            : uint160((Q96 * Q96) / oldSqrtPriceX96);
        (int24 newTickLower, int24 newTickUpper) = tokenIsToken0 == tokenWasToken0
            ? (oldTickLower, oldTickUpper)
            : (-oldTickUpper, -oldTickLower);

        (address token0, address token1) =
            tokenIsToken0 ? (token, address(usdc)) : (address(usdc), token);
        newPool = positionManager.createAndInitializePoolIfNecessary(
            token0, token1, POOL_FEE, newSqrtPriceX96
        );

        IERC20(token).forceApprove(address(positionManager), tokenAmount);
        usdc.forceApprove(address(positionManager), quoteAmount);
        (newPositionId, , , ) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: newTickLower,
                tickUpper: newTickUpper,
                amount0Desired: tokenIsToken0 ? tokenAmount : quoteAmount,
                amount1Desired: tokenIsToken0 ? quoteAmount : tokenAmount,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(vault),
                deadline: deadline
            })
        );

        // Rounding dust from re-minting goes back to the vault owner-less
        // paths: burn token dust, send quote dust to the exchange reserve.
        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) {
            IERC20(token).safeTransfer(0x000000000000000000000000000000000000dEaD, tokenDust);
        }
        uint256 quoteDust = usdc.balanceOf(address(this));
        if (quoteDust > 0) {
            usdc.safeTransfer(address(exchange), quoteDust);
        }

        migrated[token] = true;
        newPositionIds[token] = newPositionId;
        emit PoolMigrated(
            token, oldPool, newPool, oldPositionId, newPositionId, tokenAmount, quoteAmount
        );
    }
}
