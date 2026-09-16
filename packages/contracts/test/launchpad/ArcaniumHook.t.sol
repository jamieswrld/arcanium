// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {ArcaniumHook} from "../../src/launchpad/v4/ArcaniumHook.sol";
import {ArcaniumLaunchToken} from "../../src/launchpad/v4/ArcaniumLaunchToken.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * The v4 hook, against the PoolManager bytecode actually deployed on Arc.
 *
 * PoolManager is not compiled here. It pins `pragma solidity 0.8.26` while this
 * repo is on 0.8.28, and compiling our own copy would test a PoolManager nobody
 * uses. Its runtime code is fetched from Arc and etched at the address it
 * occupies there, which is not a stylistic choice: PoolManager inherits
 * NoDelegateCall, which stores its own address as an immutable baked into the
 * runtime code, so the same bytes at any other address reject every call.
 *
 * Etching drops constructor-set storage, which for PoolManager is the owner and
 * therefore only protocol-fee administration. Arcanium sets no protocol fee.
 *
 * Pools are opened with an LP fee of zero, as the launchpad will: the hook
 * takes the 1% itself so it can route it in the same transaction, and leaving
 * the pool fee on as well would charge traders twice.
 */
contract ArcaniumHookTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    ArcaniumHook internal hook;
    MockUSDC internal quote;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal trader = makeAddr("trader");

    uint24 internal constant LP_FEE = 0;
    int24 internal constant TICK_SPACING = 200;
    uint16 internal constant TAX_BPS = 500; // 5% on top of the 1% base

    function setUp() public {
        vm.etch(POOL_MANAGER, vm.parseBytes(_trim(vm.readFile("test/artifacts/PoolManager.runtime.hex"))));
        manager = IPoolManager(POOL_MANAGER);
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);
        quote = new MockUSDC();
        hook = _deployHook();
    }

    function _trim(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 end = b.length;
        while (end > 0 && (b[end - 1] == 0x0a || b[end - 1] == 0x0d || b[end - 1] == 0x20)) end--;
        bytes memory out = new bytes(end);
        for (uint256 i = 0; i < end; i++) out[i] = b[i];
        return string(out);
    }

    function _deployHook() private returns (ArcaniumHook h) {
        uint160 flags = uint160(1 << 13) | uint160(1 << 6) | uint160(1 << 2);
        bytes memory args = abi.encode(manager, admin, treasury, uint256(4_000));
        // `new X{salt:}` issues CREATE2 from this contract, so that is who the
        // salt has to be mined for.
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), flags, type(ArcaniumHook).creationCode, args);
        h = new ArcaniumHook{salt: salt}(manager, admin, treasury, 4_000);
        require(address(h) == predicted, "hook mined to a different address");
        vm.prank(admin);
        h.setFactory(address(this));
    }

    /// Deploy a token and open its pool, as the launchpad will.
    function _launch(ArcaniumHook.Mode mode, uint16 taxBps)
        private
        returns (ArcaniumLaunchToken token, PoolKey memory key)
    {
        token = new ArcaniumLaunchToken("Mock", "MOCK", address(hook), mode == ArcaniumHook.Mode.DIVIUM);

        (Currency c0, Currency c1) = address(token) < address(quote)
            ? (Currency.wrap(address(token)), Currency.wrap(address(quote)))
            : (Currency.wrap(address(quote)), Currency.wrap(address(token)));
        key = PoolKey({
            currency0: c0, currency1: c1, fee: LP_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))
        });

        hook.configurePool(key, address(token), address(quote), creator, address(0), taxBps, mode);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        // The venue holds the liquidity; it is not a holder to pay.
        token.excludeFromRewards(POOL_MANAGER);

        quote.mint(address(this), 1e30);
        quote.approve(address(lpRouter), type(uint256).max);
        token.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: -TICK_SPACING * 50,
                tickUpper: TICK_SPACING * 50,
                liquidityDelta: 1_000_000e18,
                salt: bytes32(0)
            }),
            ""
        );
    }

    function _fundTrader(ArcaniumLaunchToken token) private {
        quote.mint(trader, 1e30);
        token.transfer(trader, 1_000_000e18);
        vm.startPrank(trader);
        quote.approve(address(swapRouter), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function _swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified) private {
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// A buy is the swap whose output is the launch token.
    function _buyIsZeroForOne(ArcaniumLaunchToken token) private view returns (bool) {
        return address(quote) < address(token);
    }

    // ------------------------------------------------------------------ tests

    function test_hook_address_encodes_its_permissions() public view {
        uint160 mask = 0x3FFF;
        assertEq(uint160(address(hook)) & mask, hook.HOOK_FLAGS() & mask, "address does not carry the flags");
    }

    function test_standard_splits_the_quote_side_between_creator_and_protocol() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.STANDARD, TAX_BPS);
        _fundTrader(token);
        // A sell pays in the quote asset, which is the side that gets split.
        _swap(key, !_buyIsZeroForOne(token), -1_000e18);

        uint256 toCreator = quote.balanceOf(creator);
        uint256 toProtocol = quote.balanceOf(treasury);
        assertGt(toCreator, 0, "creator got nothing");
        assertGt(toProtocol, 0, "protocol got nothing");
        uint256 total = toCreator + toProtocol;
        assertApproxEqAbs(toCreator, (total * 4_000) / 10_000, 2, "split is not 40/60");

        // And the rate, not only its division: asserting the ratio alone would
        // pass on a hook charging a tenth of what it was configured with.
        uint256 gross = (quote.balanceOf(trader) - 1e30) + total;
        uint256 rate = hook.BASE_FEE_BPS() + TAX_BPS;
        assertApproxEqRel(total, (gross * rate) / 10_000, 1e15, "rate is not base + tax");
    }

    function test_the_token_side_is_burned_in_every_mode() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.STANDARD, TAX_BPS);
        _fundTrader(token);
        uint256 burn0 = token.balanceOf(BURN);
        _swap(key, _buyIsZeroForOne(token), -1_000e6);

        assertGt(token.balanceOf(BURN) - burn0, 0, "the token side was not burned");
        assertEq(token.balanceOf(creator), 0, "creator was paid in the launch token");
        assertEq(token.balanceOf(treasury), 0, "protocol was paid in the launch token");
    }

    function test_arcane_burns_on_a_buy_and_on_a_sell_without_a_keeper() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.ARCANE, TAX_BPS);
        _fundTrader(token);

        uint256 burn0 = token.balanceOf(BURN);
        _swap(key, _buyIsZeroForOne(token), -1_000e6);
        uint256 afterBuy = token.balanceOf(BURN);
        assertGt(afterBuy - burn0, 0, "nothing burned on a buy");

        // A sell pays in USDC, which is bought back and burned in the same
        // transaction rather than parked for anyone to come and collect.
        _swap(key, !_buyIsZeroForOne(token), -1_000e18);
        assertGt(token.balanceOf(BURN) - afterBuy, 0, "the sell's share was not burned");
        assertEq(hook.pendingBurnQuote(key.toId()), 0, "a burn was deferred when it should have completed");
        assertEq(quote.balanceOf(creator), 0, "creator was paid in a burn mode");
        assertEq(quote.balanceOf(address(hook)), 0, "quote stranded in the hook");
    }

    function test_divium_pays_the_trader_inside_the_very_transaction() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.DIVIUM, TAX_BPS);
        _fundTrader(token);

        _swap(key, !_buyIsZeroForOne(token), -1_000e18);

        // The trader's own token movement settles their rewards on the way
        // past, so by the end of the trade there is nothing left to collect.
        // This is the whole point: nobody has to come back and claim.
        assertEq(hook.claimable(address(token), trader), 0, "the trader was left holding a claim");
        assertGt(quote.balanceOf(treasury), 0, "protocol share of the quote side is missing");
    }

    function test_divium_accrues_to_a_passive_holder_and_anyone_can_settle_them() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.DIVIUM, TAX_BPS);
        _fundTrader(token);

        // Somebody who holds but never trades. They cannot be paid on their own
        // activity because they have none, which is exactly the case a pull has
        // to exist for.
        address hodler = makeAddr("hodler");
        vm.prank(trader);
        token.transfer(hodler, 500_000e18);

        _swap(key, !_buyIsZeroForOne(token), -1_000e18);

        uint256 owed = hook.claimable(address(token), hodler);
        assertGt(owed, 0, "a holder accrued nothing");
        assertGe(quote.balanceOf(address(hook)), owed, "hook cannot cover what it owes");

        uint256 before = quote.balanceOf(hodler);
        hook.payOut(address(token), hodler);
        assertEq(quote.balanceOf(hodler) - before, owed, "holder was not paid");
        assertEq(hook.claimable(address(token), hodler), 0, "still owed after paying");
    }

    function test_divium_pays_a_holder_automatically_when_they_move_tokens() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.DIVIUM, TAX_BPS);
        _fundTrader(token);

        address hodler = makeAddr("hodler");
        vm.prank(trader);
        token.transfer(hodler, 500_000e18);

        _swap(key, !_buyIsZeroForOne(token), -1_000e18);
        assertGt(hook.claimable(address(token), hodler), 0, "nothing accrued to collect");

        uint256 before = quote.balanceOf(hodler);
        // No claim call: an ordinary transfer settles what they are owed.
        vm.prank(hodler);
        token.transfer(makeAddr("friend"), 1e18);

        assertGt(quote.balanceOf(hodler), before, "a transfer did not settle the holder's rewards");
        assertEq(hook.claimable(address(token), hodler), 0, "rewards still outstanding after a transfer");
    }

    function test_payout_pays_the_holder_not_the_caller() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.DIVIUM, TAX_BPS);
        _fundTrader(token);

        address hodler = makeAddr("hodler");
        vm.prank(trader);
        token.transfer(hodler, 500_000e18);
        _swap(key, !_buyIsZeroForOne(token), -1_000e18);

        address thief = makeAddr("thief");
        assertGt(hook.claimable(address(token), hodler), 0);

        vm.prank(thief);
        hook.payOut(address(token), hodler);

        assertEq(quote.balanceOf(thief), 0, "the caller was paid");
        assertEq(hook.claimable(address(token), hodler), 0, "the holder was not settled");
    }

    /**
     * A Divium fee taken while nobody can receive it must not vanish.
     *
     * notifyRewardAmount divides by the eligible supply and returns silently
     * when that is zero, so calling it blindly takes the quote out of the
     * PoolManager and books nothing against it — stranding it in a contract
     * that deliberately has no rescue function. Here the seller is the factory
     * address, which is excluded from rewards, so the eligible supply is zero
     * at the moment the fee lands.
     */
    function test_divium_carries_a_fee_taken_while_nobody_is_eligible() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.DIVIUM, TAX_BPS);
        assertEq(token.rewardEligibleSupply(), 0, "somebody is eligible already");

        // Sell as the factory, which is excluded, so nothing becomes eligible.
        token.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: !_buyIsZeroForOne(token),
                amountSpecified: -1_000e18,
                sqrtPriceLimitX96: !_buyIsZeroForOne(token)
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 carried = hook.pendingDivium(key.toId());
        assertGt(carried, 0, "the fee was taken but not carried: it is stranded");
        assertGe(quote.balanceOf(address(hook)), carried, "hook does not hold what it carried");

        // Once somebody holds the token, the carried amount joins the next
        // distribution rather than being lost.
        token.transfer(trader, 1_000_000e18);
        assertGt(token.rewardEligibleSupply(), 0);
        _fundTrader(token);
        _swap(key, !_buyIsZeroForOne(token), -1_000e18);

        assertEq(hook.pendingDivium(key.toId()), 0, "carried amount was never released");
    }

    function test_a_pool_with_no_creator_tax_still_charges_the_base_fee() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.STANDARD, 0);
        _fundTrader(token);
        uint256 burn0 = token.balanceOf(BURN);
        _swap(key, _buyIsZeroForOne(token), -1_000e6);
        // Zero creator tax is not zero fee: the 1% base still applies, and on
        // a buy it is burned.
        assertGt(token.balanceOf(BURN) - burn0, 0, "the base fee was not charged");
    }

    function test_a_stranger_cannot_open_a_pool_on_this_hook() public {
        PoolKey memory rogue = PoolKey({
            currency0: Currency.wrap(address(0x1111)),
            currency1: Currency.wrap(address(quote)),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.expectRevert();
        manager.initialize(rogue, TickMath.getSqrtPriceAtTick(0));
    }

    function test_only_the_factory_can_configure() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0x1111)),
            currency1: Currency.wrap(address(quote)),
            fee: LP_FEE,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.prank(trader);
        vm.expectRevert(ArcaniumHook.NotFactory.selector);
        hook.configurePool(key, address(0x1111), address(quote), creator, address(0), 100, ArcaniumHook.Mode.STANDARD);
    }

    function test_terms_cannot_be_rewritten() public {
        (ArcaniumLaunchToken token, PoolKey memory key) = _launch(ArcaniumHook.Mode.STANDARD, TAX_BPS);
        vm.expectRevert(ArcaniumHook.AlreadyConfigured.selector);
        hook.configurePool(key, address(token), address(quote), trader, address(0), 900, ArcaniumHook.Mode.ARCANE);
    }

    function test_tax_above_the_cap_is_refused() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0x1111)),
            currency1: Currency.wrap(address(quote)),
            fee: LP_FEE,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.expectRevert(ArcaniumHook.TaxAboveCap.selector);
        hook.configurePool(key, address(0x1111), address(quote), creator, address(0), 901, ArcaniumHook.Mode.STANDARD);
    }
}
