// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArchLaunchpadFactoryV4} from "../../src/launchpad/ArchLaunchpadFactoryV4.sol";
import {ArchLiquidityVault} from "../../src/launchpad/ArchLiquidityVault.sol";
import {ArchModeDistributor} from "../../src/launchpad/ArchModeDistributor.sol";
import {WrappedNative} from "../../src/uniswap/WrappedNative.sol";
import {INonfungiblePositionManager, ISwapRouter} from "../../src/launchpad/interfaces/IUniswapV3.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * The three fee modes, end to end, against the real Uniswap v3 bytecode.
 *
 * These did not previously exist. The launchpad suite that used to cover fee
 * distribution is skipped (it targets the v1 factory and the v1 SwapRouter),
 * and it points at a MultiChainLaunch suite that has since been deleted, so
 * ArchModeDistributor, which is what actually implements DIVIUM and ARCANE,
 * had no coverage at all.
 *
 * That matters most for ARCANE. Its buy-and-burn is wrapped in a catch that
 * swallows a failed swap and leaves the quote sitting in the distributor, so a
 * completely broken burn path still returns success to every caller and every
 * simulation. Nothing short of asserting that the sink balance grew can tell
 * the difference, which is what test_arcane does.
 *
 * Fees can only be collected against a real pool, so this deploys Uniswap
 * rather than mocking it: a mock router would prove the distributor calls
 * something, not that it calls something Uniswap accepts. SwapRouter02 in
 * particular dropped the deadline field, and getting that wrong is precisely
 * the bug that forced the factory's v2.
 */
contract ModesTest is Test {
    MockUSDC internal quote;
    address internal uniFactory;
    INonfungiblePositionManager internal npm;
    ISwapRouter internal router;
    ArchLiquidityVault internal vault;
    ArchLaunchpadFactoryV4 internal factory;
    ArchModeDistributor internal distributor;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal feeTreasury = makeAddr("feeTreasury");
    address internal protocolTreasury = makeAddr("protocolTreasury");

    uint256 internal constant LAUNCH_FEE = 0;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

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
                "test/artifacts/SwapRouter02.json",
                abi.encode(address(0), uniFactory, address(npm), address(wnative))
            )
        );

        vault = new ArchLiquidityVault(address(npm), admin);
        factory = new ArchLaunchpadFactoryV4(
            address(npm), address(router), address(vault), admin,
            address(quote), LAUNCH_FEE, feeTreasury
        );
        distributor = new ArchModeDistributor(
            address(factory), address(vault), admin, 1_000, protocolTreasury,
            address(0), address(router)
        );

        vm.startPrank(admin);
        vault.setFeeDistributor(address(distributor));
        factory.setModeDistributor(address(distributor));
        vm.stopPrank();

        quote.mint(creator, 1_000_000e6);
        quote.mint(trader, 1_000_000e6);
        vm.prank(creator);
        quote.approve(address(factory), type(uint256).max);
        vm.prank(trader);
        quote.approve(address(router), type(uint256).max);
    }

    function _launch(string memory sym, uint8 mode, uint256 taxBps) internal returns (address token) {
        ArchLaunchpadFactoryV4.LaunchParams memory p = ArchLaunchpadFactoryV4.LaunchParams({
            name: sym, symbol: sym, metadataUri: "ipfs://t",
            pairToken: address(quote), creatorBuyAmount: 0, minTokensOut: 0,
            deadline: block.timestamp + 300, feeRecipient: address(0),
            taxBps: taxBps, mode: mode
        });
        vm.prank(creator);
        (token,,) = factory.launch(p);
    }

    function _buy(address token, uint256 quoteIn) internal returns (uint256 out) {
        vm.prank(trader);
        return router.exactInputSingle(ISwapRouter.ExactInputSingleParams({
            tokenIn: address(quote), tokenOut: token, fee: 10_000, recipient: trader,
            amountIn: quoteIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }));
    }

    function _sell(address token, uint256 amt) internal returns (uint256 out) {
        vm.startPrank(trader);
        IERC20(token).approve(address(router), amt);
        out = router.exactInputSingle(ISwapRouter.ExactInputSingleParams({
            tokenIn: token, tokenOut: address(quote), fee: 10_000, recipient: trader,
            amountIn: amt, amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ modes

    function test_standard_pays_creator_and_protocol_and_burns_token_side() public {
        address token = _launch("STD", 0, 0);
        uint256 got = _buy(token, 5_000e6);
        _sell(token, got / 2);

        uint256 c0 = quote.balanceOf(creator);
        uint256 p0 = quote.balanceOf(protocolTreasury);
        uint256 b0 = IERC20(token).balanceOf(BURN);

        distributor.distribute(token);

        uint256 cg = quote.balanceOf(creator) - c0;
        uint256 pg = quote.balanceOf(protocolTreasury) - p0;
        assertGt(cg, 0, "creator paid nothing");
        assertGt(pg, 0, "protocol paid nothing");
        assertGt(IERC20(token).balanceOf(BURN) - b0, 0, "token side not burned");
        assertApproxEqAbs(cg, ((cg + pg) * distributor.creatorShareBps()) / 10_000, 2, "split wrong");
        assertEq(quote.balanceOf(address(distributor)), 0, "quote stranded");
    }

    function test_divium_credits_holders_and_they_can_claim() public {
        address token = _launch("DIV", 1, 0);
        uint256 got = _buy(token, 5_000e6);
        _sell(token, got / 2); // keep half, so the trader is an eligible holder

        assertGt(IERC20(token).balanceOf(trader), 0, "trader holds nothing");
        uint256 p0 = quote.balanceOf(protocolTreasury);

        distributor.distribute(token);

        assertGt(quote.balanceOf(protocolTreasury) - p0, 0, "protocol paid nothing");
        uint256 owed = distributor.claimable(token, trader);
        assertGt(owed, 0, "holder accrued nothing");
        // The creator share stays in the distributor until holders claim it.
        assertGe(quote.balanceOf(address(distributor)), owed, "distributor cannot cover claims");

        uint256 t0 = quote.balanceOf(trader);
        vm.prank(trader);
        uint256 paid = distributor.claimRewards(token);
        assertEq(paid, owed, "claimed a different amount than accrued");
        assertEq(quote.balanceOf(trader) - t0, owed, "holder was not paid");
        assertEq(distributor.claimable(token, trader), 0, "still owed after claiming");
    }

    function test_arcane_actually_buys_and_burns() public {
        address token = _launch("ARC", 2, 0);
        uint256 got = _buy(token, 5_000e6);
        _sell(token, got / 2);

        uint256 b0 = IERC20(token).balanceOf(BURN);
        uint256 p0 = quote.balanceOf(protocolTreasury);

        distributor.distribute(token);

        assertGt(quote.balanceOf(protocolTreasury) - p0, 0, "protocol paid nothing");
        // A failed buy-and-burn is caught and leaves the quote here. If the
        // swap worked, nothing is stranded and the sink grew.
        assertEq(quote.balanceOf(address(distributor)), 0, "buy-and-burn failed: quote stranded");
        assertGt(IERC20(token).balanceOf(BURN) - b0, 0, "nothing burned");
    }

    function test_creator_never_receives_quote_in_divium_or_arcane() public {
        address div = _launch("D2", 1, 0);
        address arc = _launch("A2", 2, 0);
        uint256 c0 = quote.balanceOf(creator);
        for (uint256 i = 0; i < 2; i++) {
            address t = i == 0 ? div : arc;
            uint256 got = _buy(t, 3_000e6);
            _sell(t, got / 2);
            distributor.distribute(t);
        }
        assertEq(quote.balanceOf(creator), c0, "creator was paid despite a non-standard mode");
    }

    function test_mode_is_immutable_once_set() public {
        address token = _launch("IMM", 1, 0);
        vm.prank(admin);
        vm.expectRevert(ArchModeDistributor.ModeAlreadySet.selector);
        distributor.adminSetMode(token, 0);
        assertEq(uint8(distributor.modeOf(token)), 1);
    }

    // -------------------------------------------------------------------- tax

    function test_tax_is_taken_on_trades_and_burned() public {
        address token = _launch("TAX", 0, 500); // 5%
        uint256 got = _buy(token, 5_000e6);
        assertGt(got, 0, "no tokens out");
        // A 5% tax means the buyer keeps 95% of what the pool paid out.
        uint256 held = IERC20(token).balanceOf(trader);
        assertApproxEqRel(held, (got * 9_500) / 10_000, 1e15, "tax not applied at 5%");

        uint256 b0 = IERC20(token).balanceOf(BURN);
        distributor.distribute(token);
        assertGt(IERC20(token).balanceOf(BURN) - b0, 0, "tax proceeds not burned");
    }

    /**
     * A taxed token CANNOT be sold on v3. This test pins that down.
     *
     * The existing tax test only ever buys, which is the half of the trade a
     * transfer tax does not interfere with. Selling is where it breaks:
     * Uniswap v3 takes the input by calling back to the router, which
     * transfers the tokens INTO the pool, and the pool then asserts it
     * received what it was promised. The tax skims exactly that transfer, so
     * the pool comes up short and reverts with IIA — the token is a honeypot.
     *
     * This is why the launch form and the transactions API refuse a non-zero
     * tax. It is asserted rather than merely commented so that the day someone
     * makes taxed sells work, this test fails and says to re-enable them.
     *
     * The v4 hook does not have the problem: it takes its fee inside the swap
     * via afterSwap rather than by skimming a transfer, so the pool always
     * receives exactly what it was promised. See ArcaniumHook.t.sol, which
     * sells a token carrying a 5% tax.
     */
    function test_a_taxed_token_cannot_be_sold_on_v3() public {
        address token = _launch("TAXSELL", 0, 500); // 5%
        _buy(token, 5_000e6);
        uint256 held = IERC20(token).balanceOf(trader);
        assertGt(held, 0, "buy produced nothing");

        vm.startPrank(trader);
        IERC20(token).approve(address(router), held);
        vm.expectRevert(bytes("IIA"));
        router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: token, tokenOut: address(quote), fee: 10_000, recipient: trader,
                amountIn: held / 2, amountOutMinimum: 0, sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
    }

    function test_untaxed_launch_leaves_transfers_untouched() public {
        address token = _launch("NOTAX", 0, 0);
        uint256 got = _buy(token, 5_000e6);
        assertEq(IERC20(token).balanceOf(trader), got, "an untaxed launch still took a cut");
    }

    function test_tax_above_cap_reverts() public {
        vm.expectRevert();
        _launch("TOOMUCH", 0, 901);
    }
}
