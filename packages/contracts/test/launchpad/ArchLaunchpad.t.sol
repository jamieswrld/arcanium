// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArchLaunchpadFactory} from "../../src/launchpad/ArchLaunchpadFactory.sol";
import {ArchLiquidityVault} from "../../src/launchpad/ArchLiquidityVault.sol";
import {ArchFeeDistributor} from "../../src/launchpad/ArchFeeDistributor.sol";
import {GraduationRegistry} from "../../src/launchpad/GraduationRegistry.sol";
import {ArchLaunchToken} from "../../src/launchpad/ArchLaunchToken.sol";
import {WrappedNative} from "../../src/uniswap/WrappedNative.sol";
import {
    INonfungiblePositionManager,
    ISwapRouter,
    IUniswapV3PoolMinimal
} from "../../src/launchpad/interfaces/IUniswapV3.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// Integration tests against the REAL official Uniswap v3 bytecode
/// (v3-core 1.0.1, v3-periphery 1.4.4) deployed from vendored artifacts.
contract ArchLaunchpadTest is Test {
    MockUSDC internal quote; // stands in for aUSD (6 decimals)
    address internal uniFactory;
    INonfungiblePositionManager internal npm;
    ISwapRouter internal router;
    ArchLiquidityVault internal vault;
    ArchLaunchpadFactory internal factory;
    ArchFeeDistributor internal distributor;
    GraduationRegistry internal graduation;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal feeTreasury = makeAddr("feeTreasury");
    address internal protocolTreasury = makeAddr("protocolTreasury");

    uint256 internal constant LAUNCH_FEE = 52_500_000; // 52.5 quote units
    uint256 internal constant GRADUATION_UNITS = 9_000e6;

    function setUp() public {
        quote = new MockUSDC();

        uniFactory = deployCode("test/artifacts/UniswapV3Factory.json");
        WrappedNative wnative = new WrappedNative();
        npm = INonfungiblePositionManager(
            deployCode(
                "test/artifacts/NonfungiblePositionManager.json",
                abi.encode(uniFactory, address(wnative), address(0))
            )
        );
        router = ISwapRouter(
            deployCode(
                "test/artifacts/SwapRouter.json",
                abi.encode(uniFactory, address(wnative))
            )
        );

        vault = new ArchLiquidityVault(address(npm), admin);
        factory = new ArchLaunchpadFactory(
            address(npm),
            address(router),
            address(vault),
            admin,
            address(quote),
            LAUNCH_FEE,
            feeTreasury
        );
        distributor = new ArchFeeDistributor(
            address(factory), address(vault), admin, 3_000, protocolTreasury
        );
        graduation = new GraduationRegistry(address(factory), GRADUATION_UNITS);

        vm.prank(admin);
        vault.setFeeDistributor(address(distributor));

        quote.mint(creator, 1_000_000e6);
        quote.mint(trader, 1_000_000e6);
        vm.prank(creator);
        quote.approve(address(factory), type(uint256).max);
        vm.prank(trader);
        quote.approve(address(router), type(uint256).max);
    }

    function _launch(string memory name, string memory symbol, uint256 creatorBuy)
        internal
        returns (address token, address pool, uint256 positionId)
    {
        ArchLaunchpadFactory.LaunchParams memory params = ArchLaunchpadFactory.LaunchParams({
            name: name,
            symbol: symbol,
            metadataUri: "ipfs://arch-test",
            pairToken: address(quote),
            creatorBuyAmount: creatorBuy,
            minTokensOut: 0,
            deadline: block.timestamp + 300
        });
        vm.prank(creator);
        return factory.launch(params);
    }

    function _buy(address token, uint256 quoteIn) internal returns (uint256 out) {
        vm.prank(trader);
        return router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(quote),
                tokenOut: token,
                fee: 10_000,
                recipient: trader,
                deadline: block.timestamp + 300,
                amountIn: quoteIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _sell(address token, uint256 tokenIn) internal returns (uint256 out) {
        vm.startPrank(trader);
        IERC20(token).approve(address(router), tokenIn);
        out = router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: address(quote),
                fee: 10_000,
                recipient: trader,
                deadline: block.timestamp + 300,
                amountIn: tokenIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ launch

    function test_launchCreatesLockedPoolAndTakesFee() public {
        uint256 treasuryBefore = quote.balanceOf(feeTreasury);
        (address token, address pool, uint256 positionId) = _launch("Alpha", "ALPHA", 0);

        assertEq(quote.balanceOf(feeTreasury) - treasuryBefore, LAUNCH_FEE, "launch fee");
        assertEq(npm.ownerOf(positionId), address(vault), "position locked in vault");
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "no residual in factory");
        assertEq(ArchLaunchToken(token).totalSupply(), 1_000_000_000e18);

        // Pool initialized at the exact configured price for its ordering.
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3PoolMinimal(pool).slot0();
        bool tokenIsToken0 = token < address(quote);
        assertEq(
            sqrtPriceX96,
            tokenIsToken0 ? factory.SQRT_PRICE_TOKEN0() : factory.SQRT_PRICE_TOKEN1()
        );

        // Entirely token-sided at creation: pool holds no quote principal.
        assertEq(quote.balanceOf(pool), 0, "no quote at launch");
        assertGt(IERC20(token).balanceOf(pool), 999_000_000e18, "supply in pool");
    }

    function test_bothTokenOrderingsWork() public {
        bool seen0;
        bool seen1;
        for (uint256 i = 0; i < 12 && !(seen0 && seen1); i++) {
            (address token, address pool, ) =
                _launch(string(abi.encodePacked("T", i)), "TKN", 0);
            bool isToken0 = token < address(quote);
            if (isToken0) seen0 = true;
            else seen1 = true;

            // Buys work immediately in either ordering.
            uint256 out = _buy(token, 10e6);
            assertGt(out, 0, "buy failed");
            assertGt(quote.balanceOf(pool), 0, "quote entered pool");
        }
        assertTrue(seen0 && seen1, "did not exercise both orderings");
    }

    function test_startingPriceNearThreeThousandMcap() public {
        (address token, , ) = _launch("Priced", "PRC", 0);
        // Buying $30 of quote at launch should yield roughly 30/0.000003 = 10M
        // tokens (within fee + range-boundary tolerance).
        uint256 out = _buy(token, 30e6);
        // 1% pool fee and the tick-boundary gap put the effective first-buy
        // price a little above spot; accept 8M..10.5M tokens.
        assertGt(out, 8_000_000e18, "price too high vs $3k mcap");
        assertLt(out, 10_500_000e18, "price too low vs $3k mcap");
    }

    function test_creatorBuyIsAtomicAndPriced() public {
        uint256 balBefore = quote.balanceOf(creator);
        (address token, , ) = _launch("Mine", "MINE", 100e6);
        assertGt(IERC20(token).balanceOf(creator), 0, "creator received tokens");
        // creator paid launch fee + buy amount
        assertEq(balBefore - quote.balanceOf(creator), LAUNCH_FEE + 100e6);
    }

    function test_buysRaisePriceSellsLowerPrice() public {
        (address token, , ) = _launch("Moves", "MOVE", 0);
        uint256 out1 = _buy(token, 100e6);
        uint256 out2 = _buy(token, 100e6);
        assertLt(out2, out1, "second buy should get fewer tokens (price rose)");

        // Small probe buys around a sell: identical spend must yield more
        // tokens after the sell than before it (spot price fell).
        uint256 probeBefore = _buy(token, 1e6);
        _sell(token, out1 / 2);
        uint256 probeAfter = _buy(token, 1e6);
        assertGt(probeAfter, probeBefore, "sell must lower the price");
    }

    function test_launchFeeReadLiveAndPausable() public {
        vm.startPrank(admin);
        factory.setLaunchFee(60e6);
        factory.setLaunchesPaused(true);
        vm.stopPrank();

        ArchLaunchpadFactory.LaunchParams memory params = ArchLaunchpadFactory.LaunchParams({
            name: "X",
            symbol: "X",
            metadataUri: "",
            pairToken: address(quote),
            creatorBuyAmount: 0,
            minTokensOut: 0,
            deadline: block.timestamp + 300
        });
        vm.prank(creator);
        vm.expectRevert(ArchLaunchpadFactory.LaunchesArePaused.selector);
        factory.launch(params);
    }

    function test_disallowedPairTokenReverts() public {
        MockUSDC other = new MockUSDC();
        ArchLaunchpadFactory.LaunchParams memory params = ArchLaunchpadFactory.LaunchParams({
            name: "X",
            symbol: "X",
            metadataUri: "",
            pairToken: address(other),
            creatorBuyAmount: 0,
            minTokensOut: 0,
            deadline: block.timestamp + 300
        });
        vm.prank(creator);
        vm.expectRevert(ArchLaunchpadFactory.PairTokenNotAllowed.selector);
        factory.launch(params);
    }

    // -------------------------------------------------------------------- fees

    function test_feeDistribution_burnsTokenSide_splits30_70() public {
        (address token, , ) = _launch("Fees", "FEES", 0);

        // Generate volume both directions so both fee sides accrue.
        uint256 bought = _buy(token, 1_000e6);
        _sell(token, bought / 2);
        _buy(token, 500e6);

        uint256 creatorBefore = quote.balanceOf(creator);
        uint256 treasuryBefore = quote.balanceOf(protocolTreasury);
        uint256 deadBefore = IERC20(token).balanceOf(distributor.BURN_ADDRESS());

        distributor.distribute(token);

        uint256 creatorGot = quote.balanceOf(creator) - creatorBefore;
        uint256 treasuryGot = quote.balanceOf(protocolTreasury) - treasuryBefore;
        uint256 burned = IERC20(token).balanceOf(distributor.BURN_ADDRESS()) - deadBefore;

        assertGt(creatorGot, 0, "creator reward accrued");
        assertGt(treasuryGot, 0, "protocol reward accrued");
        assertGt(burned, 0, "token-side fees burned");

        // Exact 30/70: creator = floor(total*0.3), protocol = remainder.
        uint256 total = creatorGot + treasuryGot;
        assertEq(creatorGot, (total * 3_000) / 10_000, "creator share exact");

        // Token side never reaches any treasury.
        assertEq(IERC20(token).balanceOf(protocolTreasury), 0);
        assertEq(IERC20(token).balanceOf(address(distributor)), 0);
        assertEq(quote.balanceOf(address(distributor)), 0);
    }

    function test_distributionIsPermissionless() public {
        (address token, , ) = _launch("Anyone", "ANY", 0);
        _buy(token, 100e6);
        address randomCaller = makeAddr("random");
        vm.prank(randomCaller);
        distributor.distribute(token);
    }

    function test_creatorShareBounds() public {
        vm.startPrank(admin);
        vm.expectRevert(ArchFeeDistributor.ShareOutOfBounds.selector);
        distributor.setCreatorShare(999);
        vm.expectRevert(ArchFeeDistributor.ShareOutOfBounds.selector);
        distributor.setCreatorShare(5_001);
        distributor.setCreatorShare(3_500);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------- lock

    function test_liquidityCannotBeWithdrawn() public {
        (, , uint256 positionId) = _launch("Locked", "LOCK", 0);

        // Direct decrease by anyone (including admin) fails: vault owns the NFT.
        vm.prank(admin);
        vm.expectRevert();
        npm.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: positionId,
                liquidity: 1,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp + 60
            })
        );

        // NFT cannot be transferred out of the vault (no such function exists;
        // direct ERC721 transfer requires vault authorization it never grants).
        vm.prank(admin);
        vm.expectRevert();
        npm.safeTransferFrom(address(vault), admin, positionId);

        // Fee collection is distributor-only.
        vm.prank(admin);
        vm.expectRevert(ArchLiquidityVault.NotFeeDistributor.selector);
        vault.collectFees(positionId);

        // Migration path is authority-only (unset by default).
        vm.prank(admin);
        vm.expectRevert(ArchLiquidityVault.NotMigrationAuthority.selector);
        vault.migratePosition(positionId, block.timestamp + 60);
    }

    // -------------------------------------------------------------- graduation

    function test_graduationAtThresholdPermanent() public {
        (address token, address pool, ) = _launch("Grad", "GRAD", 0);

        vm.expectRevert(GraduationRegistry.ThresholdNotReached.selector);
        graduation.checkGraduation(token);

        _buy(token, 10_000e6); // pushes pool quote balance past 9,000
        assertGe(quote.balanceOf(pool), GRADUATION_UNITS);

        graduation.checkGraduation(token);
        assertTrue(graduated(token));

        vm.expectRevert(GraduationRegistry.AlreadyGraduated.selector);
        graduation.checkGraduation(token);
    }

    function graduated(address token) internal view returns (bool) {
        return graduation.graduated(token);
    }

    // ------------------------------------------------------------------ supply

    function test_supplyFullyAccounted() public {
        (address token, address pool, ) = _launch("Books", "BOOK", 25e6);
        uint256 bought = _buy(token, 200e6);
        _sell(token, bought / 3);
        distributor.distribute(token);

        uint256 total = IERC20(token).balanceOf(pool) +
            IERC20(token).balanceOf(trader) +
            IERC20(token).balanceOf(creator) +
            IERC20(token).balanceOf(distributor.BURN_ADDRESS()) +
            IERC20(token).balanceOf(address(npm));
        assertEq(total, 1_000_000_000e18, "every token accounted for");
        assertEq(IERC20(token).balanceOf(address(factory)), 0);
        assertEq(IERC20(token).balanceOf(address(vault)), 0);
    }
}
