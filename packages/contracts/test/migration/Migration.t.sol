// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArchUSD} from "../../src/bridge/ArchUSD.sol";
import {AusdExchange} from "../../src/migration/AusdExchange.sol";
import {PoolMigrator} from "../../src/migration/PoolMigrator.sol";
import {ArchLaunchpadFactory} from "../../src/launchpad/ArchLaunchpadFactory.sol";
import {ArchLiquidityVault} from "../../src/launchpad/ArchLiquidityVault.sol";
import {ArchFeeDistributor} from "../../src/launchpad/ArchFeeDistributor.sol";
import {WrappedNative} from "../../src/uniswap/WrappedNative.sol";
import {
    INonfungiblePositionManager,
    ISwapRouter,
    IUniswapV3PoolMinimal
} from "../../src/launchpad/interfaces/IUniswapV3.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract MigrationTest is Test {
    ArchUSD internal ausd;
    MockUSDC internal usdc;
    AusdExchange internal exchange;
    PoolMigrator internal migrator;
    INonfungiblePositionManager internal npm;
    ISwapRouter internal router;
    ArchLiquidityVault internal vault;
    ArchLaunchpadFactory internal factory;
    ArchFeeDistributor internal distributor;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal bridge = makeAddr("bridge");

    function setUp() public {
        ausd = new ArchUSD(admin);
        usdc = new MockUSDC();

        address uniFactory = deployCode("test/artifacts/UniswapV3Factory.json");
        WrappedNative wnative = new WrappedNative();
        npm = INonfungiblePositionManager(
            deployCode(
                "test/artifacts/NonfungiblePositionManager.json",
                abi.encode(uniFactory, address(wnative), address(0))
            )
        );
        router = ISwapRouter(
            deployCode("test/artifacts/SwapRouter.json", abi.encode(uniFactory, address(wnative)))
        );

        vault = new ArchLiquidityVault(address(npm), admin);
        factory = new ArchLaunchpadFactory(
            address(npm), address(router), address(vault), admin,
            address(ausd), 0, makeAddr("feeTreasury")
        );
        distributor = new ArchFeeDistributor(
            address(factory), address(vault), admin, 3_000, makeAddr("protocolTreasury")
        );
        exchange = new AusdExchange(address(ausd), address(usdc), admin);
        migrator = new PoolMigrator(
            address(vault), address(factory), address(exchange),
            address(npm), address(ausd), address(usdc), admin
        );

        bytes32 bridgeRole = ausd.BRIDGE_ROLE();
        vm.startPrank(admin);
        ausd.grantRole(bridgeRole, bridge);
        ausd.grantRole(bridgeRole, address(exchange));
        vault.setFeeDistributor(address(distributor));
        vault.setMigrationAuthority(address(migrator));
        vm.stopPrank();

        vm.startPrank(bridge);
        ausd.bridgeMint(creator, 100_000e6);
        ausd.bridgeMint(trader, 100_000e6);
        vm.stopPrank();
        vm.prank(creator);
        ausd.approve(address(factory), type(uint256).max);
        vm.prank(trader);
        ausd.approve(address(router), type(uint256).max);
    }

    function _launchAndTrade() internal returns (address token, address pool) {
        ArchLaunchpadFactory.LaunchParams memory params = ArchLaunchpadFactory.LaunchParams({
            name: "Migrate Me",
            symbol: "MIGR",
            metadataUri: "",
            pairToken: address(ausd),
            creatorBuyAmount: 0,
            minTokensOut: 0,
            deadline: block.timestamp + 300
        });
        vm.prank(creator);
        (token, pool, ) = factory.launch(params);

        vm.prank(trader);
        router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(ausd),
                tokenOut: token,
                fee: 10_000,
                recipient: trader,
                deadline: block.timestamp + 300,
                amountIn: 5_000e6,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function test_exchangeCannotOpenUnderwater() public {
        vm.prank(bridge);
        ausd.bridgeMint(makeAddr("holder"), 1e6); // supply > 0, no USDC funded
        vm.prank(admin);
        vm.expectRevert();
        exchange.open();
    }

    function test_exchangeOneForOneForever() public {
        address holder = makeAddr("holder");
        vm.prank(bridge);
        ausd.bridgeMint(holder, 500e6);
        usdc.mint(address(exchange), ausd.totalSupply());

        vm.prank(admin);
        exchange.open();

        // No deadline: warp far into the future, still exchangeable.
        vm.warp(block.timestamp + 365 days * 10);
        vm.prank(holder);
        exchange.exchange(500e6);
        assertEq(usdc.balanceOf(holder), 500e6, "exactly one for one");
        assertEq(ausd.balanceOf(holder), 0);
    }

    function test_poolMigrationPreservesPriceAndValue() public {
        (address token, address oldPool) = _launchAndTrade();

        // Fund + open the exchange to cover the entire aUSD supply.
        usdc.mint(address(exchange), ausd.totalSupply());
        vm.prank(admin);
        exchange.open();

        // Runbook order: distribute accrued fees first — they belong to the
        // creator/protocol/burn split, not to the migrated principal.
        distributor.distribute(token);

        (uint160 oldSqrt, , , , , , ) = IUniswapV3PoolMinimal(oldPool).slot0();
        uint256 oldPoolToken = IERC20(token).balanceOf(oldPool);
        uint256 oldPoolQuote = ausd.balanceOf(oldPool);
        bool tokenWasToken0 = token < address(ausd);

        vm.prank(admin);
        (address newPool, uint256 newPositionId) =
            migrator.migratePool(token, block.timestamp + 300);

        // New position is locked in the vault.
        assertEq(npm.ownerOf(newPositionId), address(vault));

        // Effective USD price preserved within 0.1% (inversion rounding only).
        (uint160 newSqrt, , , , , , ) = IUniswapV3PoolMinimal(newPool).slot0();
        bool tokenIsToken0 = token < address(usdc);
        uint256 oldPriceE18 = _priceE18(oldSqrt, tokenWasToken0);
        uint256 newPriceE18 = _priceE18(newSqrt, tokenIsToken0);
        assertApproxEqRel(newPriceE18, oldPriceE18, 0.001e18, "price preserved");

        // Token quantity and quote value preserved within 0.1% (mint rounding).
        uint256 newPoolToken = IERC20(token).balanceOf(newPool);
        uint256 newPoolQuote = usdc.balanceOf(newPool);
        assertApproxEqRel(newPoolToken, oldPoolToken, 0.001e18, "token amount preserved");
        assertApproxEqRel(newPoolQuote, oldPoolQuote, 0.001e18, "quote amount preserved");

        // Nothing stranded in the migrator.
        assertEq(IERC20(token).balanceOf(address(migrator)), 0);
        assertEq(usdc.balanceOf(address(migrator)), 0);
        assertEq(ausd.balanceOf(address(migrator)), 0);

        // One-shot per pool.
        vm.prank(admin);
        vm.expectRevert(PoolMigrator.AlreadyMigrated.selector);
        migrator.migratePool(token, block.timestamp + 300);
    }

    function test_migrationRequiresAuthority() public {
        (address token, ) = _launchAndTrade();
        (, , , , uint256 positionId) = factory.launches(token);
        vm.prank(admin);
        vm.expectRevert(ArchLiquidityVault.NotMigrationAuthority.selector);
        vault.migratePosition(positionId, block.timestamp + 300);
    }

    function test_onlyOwnerMigrates() public {
        (address token, ) = _launchAndTrade();
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        migrator.migratePool(token, block.timestamp + 300);
    }

    function _priceE18(uint160 sqrtPriceX96, bool tokenIsToken0)
        internal
        pure
        returns (uint256)
    {
        uint256 num = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        if (tokenIsToken0) {
            return (num * 1e30) / (2 ** 192);
        }
        // 1e30·2¹⁹²/sqrtP² without overflowing: square (2⁹⁶·1e15)/sqrtP.
        uint256 inv = ((2 ** 96) * 1e15) / uint256(sqrtPriceX96);
        return inv * inv;
    }
}
