// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {ArcaniumHook} from "../../src/launchpad/v4/ArcaniumHook.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// A launch token stand-in that records Divium notifications.
contract MockLaunchToken is ERC20 {
    uint256 public notified;

    constructor() ERC20("Mock Launch", "MOCK") {
        _mint(msg.sender, 1_000_000_000e18);
    }

    function notifyRewardAmount(uint256 amount) external {
        notified += amount;
    }
}

/**
 * The v4 hook, against the PoolManager bytecode that is actually deployed on
 * Arc.
 *
 * PoolManager is not compiled here. It pins `pragma solidity 0.8.26` while this
 * repo is on 0.8.28, and more to the point, compiling our own copy would test a
 * PoolManager that nobody uses. Its runtime code is fetched from Arc and etched
 * at the address it occupies there, which is not a stylistic choice: PoolManager
 * inherits NoDelegateCall, which stores its own address as an immutable baked
 * into the runtime code, so the same bytes at any other address reject every
 * call as a delegatecall.
 *
 * Etching drops constructor-set storage, which for PoolManager is the owner and
 * therefore only protocol-fee administration. Arcanium sets no protocol fee, so
 * nothing under test depends on it.
 */
contract ArcaniumHookTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    ArcaniumHook internal hook;

    MockUSDC internal quote;
    MockLaunchToken internal token;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal distributor = makeAddr("distributor");
    address internal trader = makeAddr("trader");

    uint24 internal constant LP_FEE = 10_000; // 1%, matching the v3 launches
    int24 internal constant TICK_SPACING = 200;
    uint16 internal constant TAX_BPS = 500; // 5%

    function setUp() public {
        string memory hex_ = vm.readFile("test/artifacts/PoolManager.runtime.hex");
        vm.etch(POOL_MANAGER, vm.parseBytes(_trim(hex_)));
        manager = IPoolManager(POOL_MANAGER);

        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        quote = new MockUSDC();
        token = new MockLaunchToken();

        // The hook's permissions live in its address, so it has to be mined.
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
        uint160 flags = uint160(
            uint160(1 << 13) | uint160(1 << 6) | uint160(1 << 2) // beforeInitialize, afterSwap, afterSwapReturnsDelta
        );
        bytes memory args = abi.encode(manager, admin, treasury, uint256(4_000));
        // `new X{salt:}` issues CREATE2 from this contract, not from the
        // canonical deployer proxy, so that is who the salt must be mined for.
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), flags, type(ArcaniumHook).creationCode, args);
        h = new ArcaniumHook{salt: salt}(manager, admin, treasury, 4_000);
        require(address(h) == predicted, "hook mined to a different address");
        vm.prank(admin);
        h.setFactory(address(this));
    }

    function _key(ArcaniumHook.Mode mode) private returns (PoolKey memory key) {
        (Currency c0, Currency c1) = address(token) < address(quote)
            ? (Currency.wrap(address(token)), Currency.wrap(address(quote)))
            : (Currency.wrap(address(quote)), Currency.wrap(address(token)));
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        hook.configurePool(key, address(token), address(quote), creator, distributor, TAX_BPS, mode);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));

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

    function _swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified) private {
        quote.mint(trader, 1e30);
        vm.startPrank(trader);
        quote.approve(address(swapRouter), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
        // The test contract holds the token supply; fund the trader for sells.
        token.transfer(trader, 1_000_000e18);

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
    function _buyIsZeroForOne() private view returns (bool) {
        return address(quote) < address(token);
    }

    // ------------------------------------------------------------------ tests

    function test_hook_address_encodes_its_permissions() public view {
        uint160 mask = 0x3FFF;
        assertEq(uint160(address(hook)) & mask, hook.HOOK_FLAGS() & mask, "address does not carry the flags");
    }

    function test_standard_splits_the_quote_side_between_creator_and_protocol() public {
        PoolKey memory key = _key(ArcaniumHook.Mode.STANDARD);
        // A sell pays its fee in the quote asset, which is the side that gets
        // split. A buy pays in the token and is burned instead.
        _swap(key, !_buyIsZeroForOne(), -1_000e18);

        uint256 toCreator = quote.balanceOf(creator);
        uint256 toProtocol = quote.balanceOf(treasury);
        assertGt(toCreator, 0, "creator got nothing");
        assertGt(toProtocol, 0, "protocol got nothing");
        uint256 total = toCreator + toProtocol;
        assertApproxEqAbs(toCreator, (total * 4_000) / 10_000, 2, "split is not 40/60");

        // And the rate itself, not just its division. Asserting only the ratio
        // would pass just as happily on a hook charging a tenth of the fee it
        // was configured with.
        uint256 received = quote.balanceOf(trader) - 1e30;
        uint256 gross = received + total;
        uint256 rate = hook.BASE_FEE_BPS() + TAX_BPS;
        assertApproxEqRel(total, (gross * rate) / 10_000, 1e15, "rate is not base + tax");
    }

    function test_the_token_side_is_burned_in_every_mode() public {
        PoolKey memory key = _key(ArcaniumHook.Mode.STANDARD);
        uint256 burn0 = token.balanceOf(BURN);
        _swap(key, _buyIsZeroForOne(), -1_000e6);

        assertGt(token.balanceOf(BURN) - burn0, 0, "the token side was not burned");
        // Paying a creator in their own token would hand them sell pressure on
        // their own market, and paying the protocol in it would make revenue
        // depend on whatever happened to trade. Neither should receive any.
        assertEq(token.balanceOf(creator), 0, "creator was paid in the launch token");
        assertEq(token.balanceOf(treasury), 0, "protocol was paid in the launch token");
    }

    function test_arcane_burns_buys_outright_and_parks_sells() public {
        PoolKey memory key = _key(ArcaniumHook.Mode.ARCANE);
        uint256 burn0 = token.balanceOf(BURN);

        // A buy pays in the token: burned in the same transaction, no swap,
        // nothing to fail. This is the case v3 could not do.
        _swap(key, _buyIsZeroForOne(), -1_000e6);
        assertGt(token.balanceOf(BURN) - burn0, 0, "nothing burned on a buy");
        assertEq(hook.pendingBurnQuote(key.toId()), 0, "a buy should leave nothing parked");

        // A sell pays in USDC, which cannot be burned and cannot be swapped
        // back mid-swap, so it is parked for sweepQuote.
        _swap(key, !_buyIsZeroForOne(), -1_000e18);
        assertGt(hook.pendingBurnQuote(key.toId()), 0, "a sell left nothing to sweep");
        assertEq(quote.balanceOf(creator), 0, "creator was paid in a burn mode");
    }

    function test_arcane_sweep_hands_the_parked_quote_to_the_distributor() public {
        PoolKey memory key = _key(ArcaniumHook.Mode.ARCANE);
        _swap(key, !_buyIsZeroForOne(), -1_000e18);
        uint256 parked = hook.pendingBurnQuote(key.toId());
        assertGt(parked, 0, "nothing parked to sweep");

        // Permissionless: it can only move funds to the address fixed at
        // launch, so a stranger calling it has nothing to steer.
        vm.prank(trader);
        hook.sweepQuote(key);

        assertEq(quote.balanceOf(distributor), parked, "distributor did not receive the parked quote");
        assertEq(hook.pendingBurnQuote(key.toId()), 0, "still parked after sweeping");
        vm.expectRevert(ArcaniumHook.NothingPending.selector);
        hook.sweepQuote(key);
    }

    function test_divium_notifies_the_token_on_a_quote_side_fee() public {
        PoolKey memory key = _key(ArcaniumHook.Mode.DIVIUM);
        // A sell pays its fee in the quote asset, which is what holders are owed.
        _swap(key, !_buyIsZeroForOne(), -1_000e18);

        assertGt(quote.balanceOf(distributor), 0, "distributor received nothing");
        assertEq(token.notified(), quote.balanceOf(distributor), "notified amount does not match");
        assertGt(quote.balanceOf(treasury), 0, "protocol share of the quote side is missing");
    }

    function test_a_pool_with_no_creator_tax_still_charges_the_base_fee() public {
        (Currency c0, Currency c1) = address(token) < address(quote)
            ? (Currency.wrap(address(token)), Currency.wrap(address(quote)))
            : (Currency.wrap(address(quote)), Currency.wrap(address(token)));
        PoolKey memory key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LP_FEE,
            tickSpacing: TICK_SPACING + 10,
            hooks: IHooks(address(hook))
        });
        hook.configurePool(key, address(token), address(quote), creator, distributor, 0, ArcaniumHook.Mode.STANDARD);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        quote.mint(address(this), 1e30);
        quote.approve(address(lpRouter), type(uint256).max);
        token.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: -(TICK_SPACING + 10) * 50,
                tickUpper: (TICK_SPACING + 10) * 50,
                liquidityDelta: 1_000_000e18,
                salt: bytes32(0)
            }),
            ""
        );
        uint256 burn0 = token.balanceOf(BURN);
        _swap(key, _buyIsZeroForOne(), -1_000e6);
        // Zero creator tax does not mean zero fee: the 1% base still applies,
        // and on a buy it is burned.
        assertGt(token.balanceOf(BURN) - burn0, 0, "the base fee was not charged");
    }

    function test_a_stranger_cannot_open_a_pool_on_this_hook() public {
        (Currency c0, Currency c1) = address(token) < address(quote)
            ? (Currency.wrap(address(token)), Currency.wrap(address(quote)))
            : (Currency.wrap(address(quote)), Currency.wrap(address(token)));
        PoolKey memory rogue = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        // Never configured by the factory, so initialize must fail.
        vm.expectRevert();
        manager.initialize(rogue, TickMath.getSqrtPriceAtTick(0));
    }

    function test_only_the_factory_can_configure() public {
        (Currency c0, Currency c1) = address(token) < address(quote)
            ? (Currency.wrap(address(token)), Currency.wrap(address(quote)))
            : (Currency.wrap(address(quote)), Currency.wrap(address(token)));
        PoolKey memory key = PoolKey({
            currency0: c0, currency1: c1, fee: LP_FEE, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        vm.prank(trader);
        vm.expectRevert(ArcaniumHook.NotFactory.selector);
        hook.configurePool(key, address(token), address(quote), creator, distributor, 100, ArcaniumHook.Mode.STANDARD);
    }

    function test_terms_cannot_be_rewritten() public {
        PoolKey memory key = _key(ArcaniumHook.Mode.STANDARD);
        vm.expectRevert(ArcaniumHook.AlreadyConfigured.selector);
        hook.configurePool(key, address(token), address(quote), trader, distributor, 900, ArcaniumHook.Mode.ARCANE);
    }

    function test_tax_above_the_cap_is_refused() public {
        (Currency c0, Currency c1) = address(token) < address(quote)
            ? (Currency.wrap(address(token)), Currency.wrap(address(quote)))
            : (Currency.wrap(address(quote)), Currency.wrap(address(token)));
        PoolKey memory key = PoolKey({
            currency0: c0, currency1: c1, fee: LP_FEE, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        vm.expectRevert(ArcaniumHook.TaxAboveCap.selector);
        hook.configurePool(key, address(token), address(quote), creator, distributor, 901, ArcaniumHook.Mode.STANDARD);
    }
}
