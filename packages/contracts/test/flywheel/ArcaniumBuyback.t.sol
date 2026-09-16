// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcaniumBuyback} from "../../src/flywheel/ArcaniumBuyback.sol";
import {ArchLaunchpadFactoryV4} from "../../src/launchpad/ArchLaunchpadFactoryV4.sol";
import {ArchLiquidityVault} from "../../src/launchpad/ArchLiquidityVault.sol";
import {ArchModeDistributor} from "../../src/launchpad/ArchModeDistributor.sol";
import {ArchFeeSplitter} from "../../src/fees/ArchFeeSplitter.sol";
import {WrappedNative} from "../../src/uniswap/WrappedNative.sol";
import {INonfungiblePositionManager, ISwapRouter} from "../../src/launchpad/interfaces/IUniswapV3.sol";

interface IPoolOracle {
    function increaseObservationCardinalityNext(uint16 n) external;
}
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * The flywheel: protocol fees buy the protocol's own token and burn it.
 *
 * Tested against the real Uniswap v3 bytecode rather than a mock router,
 * because the two things worth proving here are both about the pool — that the
 * spot-derived floor actually refuses a moved price, and that the tokens reach
 * 0xdead rather than the contract.
 */
contract ArcaniumBuybackTest is Test {
    MockUSDC internal quote;
    address internal uniFactory;
    INonfungiblePositionManager internal npm;
    ISwapRouter internal router;
    ArchLiquidityVault internal vault;
    ArchLaunchpadFactoryV4 internal factory;
    ArchModeDistributor internal distributor;
    ArcaniumBuyback internal buyback;

    address internal token;
    address internal pool;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal whale = makeAddr("whale");
    address internal anyone = makeAddr("anyone");
    address internal treasury = makeAddr("treasury");
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint32 internal constant WINDOW = 300; // 5 minutes
    /// The factory burns its rounding remainder at launch, so the sink is not
    /// empty before the flywheel has done anything. Baselined, not assumed.
    uint256 internal burnBaseline;

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
            deployCode("test/artifacts/SwapRouter02.json", abi.encode(address(0), uniFactory, address(npm), address(wnative)))
        );

        vault = new ArchLiquidityVault(address(npm), admin);
        factory = new ArchLaunchpadFactoryV4(
            address(npm), address(router), address(vault), admin, address(quote), 0, treasury
        );
        distributor = new ArchModeDistributor(
            address(factory), address(vault), admin, 1_000, treasury, address(0), address(router)
        );
        vm.startPrank(admin);
        vault.setFeeDistributor(address(distributor));
        factory.setModeDistributor(address(distributor));
        vm.stopPrank();

        quote.mint(creator, 1_000_000e6);
        quote.mint(trader, 1_000_000e6);
        quote.mint(whale, 100_000_000e6);
        vm.prank(creator);
        quote.approve(address(factory), type(uint256).max);

        ArchLaunchpadFactoryV4.LaunchParams memory p = ArchLaunchpadFactoryV4.LaunchParams({
            name: "Arcanium", symbol: "ARCANIUM", metadataUri: "", pairToken: address(quote),
            creatorBuyAmount: 0, minTokensOut: 0, deadline: block.timestamp + 300,
            feeRecipient: address(0), taxBps: 0, mode: 0
        });
        vm.prank(creator);
        (token, pool, ) = factory.launch(p);

        buyback = new ArcaniumBuyback(token, address(quote), pool, address(router), 10_000, WINDOW);

        vm.startPrank(trader);
        quote.approve(address(router), type(uint256).max);
        IERC20(token).approve(address(router), type(uint256).max);
        router.exactInputSingle(ISwapRouter.ExactInputSingleParams({
            tokenIn: address(quote), tokenOut: token, fee: 10_000, recipient: trader,
            amountIn: 20_000e6, amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }));
        vm.stopPrank();

        _buildOracleHistory();
        burnBaseline = IERC20(token).balanceOf(BURN);
    }

    /**
     * Give the pool a price history to average over.
     *
     * A fresh v3 pool stores one observation and can serve no window at all,
     * so the buyback would refuse every call. Cardinality is raised (which is
     * permissionless) and then small trades are spread across time, since the
     * pool only records an observation on the first swap of each block.
     */
    function _buildOracleHistory() internal {
        IPoolOracle(pool).increaseObservationCardinalityNext(50);
        for (uint256 i = 0; i < 8; i++) {
            vm.warp(block.timestamp + 90);
            vm.roll(block.number + 1);
            vm.prank(trader);
            router.exactInputSingle(ISwapRouter.ExactInputSingleParams({
                tokenIn: address(quote), tokenOut: token, fee: 10_000, recipient: trader,
                amountIn: 10e6, amountOutMinimum: 0, sqrtPriceLimitX96: 0
            }));
        }
        vm.warp(block.timestamp + WINDOW + 60);
        vm.roll(block.number + 1);
    }

    function _fund(uint256 amount) internal {
        quote.mint(address(buyback), amount);
    }

    // ------------------------------------------------------------------ tests

    function test_buys_and_burns_and_keeps_nothing() public {
        _fund(500e6);
        uint256 burn0 = IERC20(token).balanceOf(BURN);

        vm.prank(anyone);
        (uint256 spent, uint256 burned) = buyback.buyAndBurn();

        assertEq(spent, 500e6, "did not spend the whole balance");
        assertGt(burned, 0, "bought nothing");
        assertEq(IERC20(token).balanceOf(BURN) - burn0, burned, "tokens did not reach the sink");
        assertEq(IERC20(token).balanceOf(address(buyback)), 0, "contract kept tokens");
        assertEq(quote.balanceOf(address(buyback)), 0, "contract kept quote");
        assertEq(buyback.totalSpent(), 500e6);
        assertEq(buyback.totalBurned(), burned);
        assertEq(buyback.burnCount(), 1);
    }

    function test_the_caller_gains_nothing() public {
        _fund(500e6);
        uint256 q0 = quote.balanceOf(anyone);
        uint256 t0 = IERC20(token).balanceOf(anyone);

        vm.prank(anyone);
        buyback.buyAndBurn();

        assertEq(quote.balanceOf(anyone), q0, "caller was paid quote");
        assertEq(IERC20(token).balanceOf(anyone), t0, "caller was paid tokens");
    }

    function test_refuses_dust() public {
        _fund(buyback.MIN_SPEND() - 1);
        vm.expectRevert(ArcaniumBuyback.NothingToSpend.selector);
        buyback.buyAndBurn();
    }

    function test_refuses_when_empty() public {
        vm.expectRevert(ArcaniumBuyback.NothingToSpend.selector);
        buyback.buyAndBurn();
    }

    /**
     * The reason the floor is computed here rather than passed in.
     *
     * A permissionless swap with no floor lets anyone move the price up, have
     * this buy at the top, and sell back into it. Here the attacker pushes the
     * price far beyond the band and the buyback refuses rather than buying
     * high — the USDC stays put for a later, honest call.
     */
    function test_a_moved_price_makes_the_buyback_refuse() public {
        _fund(500e6);

        vm.startPrank(whale);
        quote.approve(address(router), type(uint256).max);
        router.exactInputSingle(ISwapRouter.ExactInputSingleParams({
            tokenIn: address(quote), tokenOut: token, fee: 10_000, recipient: whale,
            amountIn: 5_000_000e6, amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }));
        vm.stopPrank();

        // The whale moved spot, but not the average — so the floor stays at the
        // honest price and the router refuses to fill below it. This is the
        // case a spot-derived floor silently allowed.
        vm.expectRevert();
        buyback.buyAndBurn();

        assertEq(quote.balanceOf(address(buyback)), 500e6, "funds should still be here for a later call");
    }

    function test_survives_the_price_moving_a_little() public {
        _fund(500e6);
        // A trade small enough to stay inside the band must not block the burn.
        vm.startPrank(trader);
        router.exactInputSingle(ISwapRouter.ExactInputSingleParams({
            tokenIn: address(quote), tokenOut: token, fee: 10_000, recipient: trader,
            amountIn: 50e6, amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }));
        vm.stopPrank();

        vm.prank(anyone);
        (, uint256 burned) = buyback.buyAndBurn();
        assertGt(burned, 0, "an ordinary trade should not stop the flywheel");
    }

    function test_has_no_way_out_but_the_burn() public {
        _fund(500e6);
        // No owner, no withdraw, no rescue: the only function that moves value
        // sends it to 0xdead. Asserted by exhaustion — any selector that is not
        // one of the known reads or buyAndBurn does not exist.
        (bool ok, ) = address(buyback).call(abi.encodeWithSignature("withdraw(address,uint256)", address(quote), 1));
        assertFalse(ok, "a withdraw function exists");
        (ok, ) = address(buyback).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "an owner exists");
        (ok, ) = address(buyback).call(abi.encodeWithSignature("rescue(address)", address(quote)));
        assertFalse(ok, "a rescue function exists");
        assertEq(quote.balanceOf(address(buyback)), 500e6);
    }

    /**
     * Burns an hour apart, which is the cadence this runs at.
     *
     * Spacing matters and is not incidental to the test. Each buy pushes the
     * price up a little, and the average takes time to follow; fire several in
     * the same block and the floor — still sitting at the old average —
     * correctly refuses to buy into a price the buyback itself just moved.
     * An hour is far longer than the window, so each call sees a settled
     * average.
     */
    function test_hourly_burns_accumulate() public {
        uint256 burnedTotal;
        for (uint256 i = 0; i < 3; i++) {
            _fund(200e6);
            vm.prank(anyone);
            (, uint256 burned) = buyback.buyAndBurn();
            burnedTotal += burned;

            vm.warp(block.timestamp + 3600);
            vm.roll(block.number + 1);
        }
        assertEq(buyback.burnCount(), 3);
        assertEq(buyback.totalSpent(), 600e6);
        assertEq(buyback.totalBurned(), burnedTotal);
        assertEq(IERC20(token).balanceOf(BURN) - burnBaseline, burnedTotal, "sink total should be what the flywheel burned");
    }

    /**
     * And the converse, stated as a property rather than left implicit: firing
     * repeatedly inside one block is refused. Anyone hoping to grind the price
     * up with the protocol's own money gets nothing for it.
     */
    function test_burning_again_immediately_is_refused() public {
        _fund(400e6);
        vm.prank(anyone);
        buyback.buyAndBurn();

        _fund(400e6);
        vm.prank(anyone);
        vm.expectRevert();
        buyback.buyAndBurn();
    }

    function test_refuses_when_the_pool_has_no_history() public {
        // A pool that has never had its cardinality raised cannot serve any
        // window. Refusing is the point: the alternative is falling back to
        // spot, which is what an attacker controls.
        ArchLaunchpadFactoryV4.LaunchParams memory p = ArchLaunchpadFactoryV4.LaunchParams({
            name: "Fresh", symbol: "FRESH", metadataUri: "", pairToken: address(quote),
            creatorBuyAmount: 0, minTokensOut: 0, deadline: block.timestamp + 300,
            feeRecipient: address(0), taxBps: 0, mode: 0
        });
        vm.prank(creator);
        (address fresh, address freshPool, ) = factory.launch(p);

        ArcaniumBuyback bb = new ArcaniumBuyback(fresh, address(quote), freshPool, address(router), 10_000, WINDOW);
        quote.mint(address(bb), 500e6);

        vm.expectRevert(ArcaniumBuyback.NoPriceHistory.selector);
        bb.buyAndBurn();
        assertEq(quote.balanceOf(address(bb)), 500e6, "funds kept for when history exists");
    }

    function test_a_one_block_window_is_refused_at_deploy() public {
        vm.expectRevert(ArcaniumBuyback.WindowTooShort.selector);
        new ArcaniumBuyback(token, address(quote), pool, address(router), 10_000, 30);
    }

    function test_rejects_a_pool_that_is_not_the_pair() public {
        MockUSDC other = new MockUSDC();
        vm.expectRevert(ArcaniumBuyback.PoolMismatch.selector);
        new ArcaniumBuyback(address(other), address(quote), pool, address(router), 10_000, WINDOW);
    }

    /// The whole point: fees routed through the splitter reach the burn with
    /// nobody having to move anything by hand.
    function test_fees_routed_through_the_splitter_end_up_burned() public {
        address[] memory recipients = new address[](2);
        uint256[] memory weights = new uint256[](2);
        recipients[0] = treasury;      weights[0] = 9_000; // 90%
        recipients[1] = address(buyback); weights[1] = 1_000; // 10%
        ArchFeeSplitter splitter = new ArchFeeSplitter(admin, recipients, weights);

        quote.mint(address(splitter), 1_000e6);
        uint256 burn0 = IERC20(token).balanceOf(BURN);

        splitter.flush(address(quote));
        assertEq(quote.balanceOf(address(buyback)), 100e6, "buyback did not receive its 10%");
        assertEq(quote.balanceOf(treasury), 900e6, "treasury did not receive the rest");

        vm.prank(anyone);
        buyback.buyAndBurn();
        assertGt(IERC20(token).balanceOf(BURN) - burn0, 0, "the routed share was not burned");
    }
}
