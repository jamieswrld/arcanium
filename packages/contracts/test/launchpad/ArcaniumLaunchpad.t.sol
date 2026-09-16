// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {ArcaniumHook} from "../../src/launchpad/v4/ArcaniumHook.sol";
import {ArcaniumLaunchpad} from "../../src/launchpad/v4/ArcaniumLaunchpad.sol";
import {ArcaniumLaunchToken} from "../../src/launchpad/v4/ArcaniumLaunchToken.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * The v4 launch, end to end, against Arc's deployed PoolManager bytecode.
 *
 * These run the ERC-20 quote path. The native path — where the creator's
 * opening buy arrives as msg.value and needs no approval, which is the whole
 * reason a launch is one signature on Arc — cannot be exercised here: Arc's
 * USDC moves native balance through machinery the node implements rather than
 * the EVM, so its transfers revert under Foundry even on a fork. That path
 * needs a smoke test on chain before it carries anyone's money.
 */
contract ArcaniumLaunchpadTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    ArcaniumHook internal hook;
    ArcaniumLaunchpad internal pad;
    MockUSDC internal quote;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal feeTreasury = makeAddr("feeTreasury");
    address internal trader = makeAddr("trader");

    function setUp() public {
        vm.etch(POOL_MANAGER, vm.parseBytes(_trim(vm.readFile("test/artifacts/PoolManager.runtime.hex"))));
        manager = IPoolManager(POOL_MANAGER);
        swapRouter = new PoolSwapTest(manager);
        quote = new MockUSDC();

        uint160 flags = uint160(1 << 13) | uint160(1 << 6) | uint160(1 << 2);
        bytes memory args = abi.encode(manager, admin, treasury, uint256(4_000));
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), flags, type(ArcaniumHook).creationCode, args);
        hook = new ArcaniumHook{salt: salt}(manager, admin, treasury, 4_000);
        require(address(hook) == predicted, "hook mined to a different address");

        pad = new ArcaniumLaunchpad(manager, hook, address(quote), false, admin, 0, feeTreasury);
        vm.prank(admin);
        hook.setFactory(address(pad));

        quote.mint(creator, 1_000_000e6);
        vm.prank(creator);
        quote.approve(address(pad), type(uint256).max);
    }

    function _trim(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 end = b.length;
        while (end > 0 && (b[end - 1] == 0x0a || b[end - 1] == 0x0d || b[end - 1] == 0x20)) end--;
        bytes memory out = new bytes(end);
        for (uint256 i = 0; i < end; i++) out[i] = b[i];
        return string(out);
    }

    function _params(uint256 buyAmount, uint16 taxBps, uint8 mode)
        private
        view
        returns (ArcaniumLaunchpad.LaunchParams memory)
    {
        return ArcaniumLaunchpad.LaunchParams({
            name: "Test Token",
            symbol: "TEST",
            metadataUri: "ipfs://x",
            creatorBuyAmount: buyAmount,
            minTokensOut: 0,
            deadline: block.timestamp + 300,
            feeRecipient: address(0),
            taxBps: taxBps,
            mode: mode
        });
    }

    function _keyFor(address token) private view returns (PoolKey memory) {
        bool tokenIs0 = token < address(quote);
        return PoolKey({
            currency0: Currency.wrap(tokenIs0 ? token : address(quote)),
            currency1: Currency.wrap(tokenIs0 ? address(quote) : token),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
    }

    // ------------------------------------------------------------------ tests

    function test_launch_is_a_single_call_and_needs_no_quote_without_a_buy() public {
        vm.prank(creator);
        (address token, ) = pad.launch(_params(0, 0, 0));

        assertTrue(token != address(0), "no token");
        assertEq(pad.allTokensLength(), 1);
        // The whole supply went into the pool; the launchpad kept none.
        assertEq(IERC20(token).balanceOf(address(pad)), 0, "launchpad retained supply");
        assertGt(IERC20(token).balanceOf(POOL_MANAGER), 0, "pool holds no supply");
        assertEq(quote.balanceOf(creator), 1_000_000e6, "a launch without a buy charged the creator");
    }

    function test_supply_is_fully_accounted_after_launch() public {
        vm.prank(creator);
        (address token, ) = pad.launch(_params(0, 0, 0));

        uint256 inPool = IERC20(token).balanceOf(POOL_MANAGER);
        uint256 burned = IERC20(token).balanceOf(BURN);
        uint256 inPad = IERC20(token).balanceOf(address(pad));
        assertEq(inPool + burned + inPad, 1_000_000_000 ether, "supply is unaccounted for");
        assertEq(inPad, 0, "launchpad is holding supply");
    }

    function test_creator_buy_is_atomic_and_delivered_in_the_same_call() public {
        uint256 before = quote.balanceOf(creator);
        vm.prank(creator);
        (address token, ) = pad.launch(_params(5_000e6, 0, 0));

        assertEq(before - quote.balanceOf(creator), 5_000e6, "creator was charged the wrong amount");
        assertGt(IERC20(token).balanceOf(creator), 0, "creator received no tokens");
        // Nobody could have traded in between: the pool did not exist before
        // this call and the buy happened inside it.
        assertEq(IERC20(token).balanceOf(address(pad)), 0, "launchpad retained tokens");
        assertEq(quote.balanceOf(address(pad)), 0, "launchpad retained quote");
    }

    function test_creator_buy_respects_minimum_out() public {
        ArcaniumLaunchpad.LaunchParams memory p = _params(5_000e6, 0, 0);
        p.minTokensOut = type(uint256).max;
        vm.prank(creator);
        vm.expectRevert();
        pad.launch(p);
    }

    function test_launch_opens_a_tradable_market_immediately() public {
        vm.prank(creator);
        (address token, ) = pad.launch(_params(0, 0, 0));
        PoolKey memory key = _keyFor(token);

        quote.mint(trader, 100_000e6);
        vm.startPrank(trader);
        quote.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();

        bool buyIsZeroForOne = address(quote) < token;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: buyIsZeroForOne,
                amountSpecified: -1_000e6,
                sqrtPriceLimitX96: buyIsZeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        assertGt(IERC20(token).balanceOf(trader), 0, "the market did not trade");
        // The 1% base fee was charged on the token side and burned.
        assertGt(IERC20(token).balanceOf(BURN), 0, "no fee was taken on the first trade");
    }

    function test_terms_reach_the_hook() public {
        vm.prank(creator);
        (address token, ) = pad.launch(_params(0, 750, 2));
        PoolKey memory key = _keyFor(token);
        ArcaniumHook.PoolConfig memory cfg = hook.configOf(key.toId());

        assertEq(cfg.token, token);
        assertEq(cfg.taxBps, 750, "tax did not reach the hook");
        assertEq(uint8(cfg.mode), 2, "mode did not reach the hook");
        assertEq(cfg.creator, creator, "an empty fee recipient should mean the launcher");
    }

    function test_fee_recipient_can_be_someone_else() public {
        address payee = makeAddr("payee");
        ArcaniumLaunchpad.LaunchParams memory p = _params(0, 0, 0);
        p.feeRecipient = payee;
        vm.prank(creator);
        (address token, ) = pad.launch(p);
        assertEq(hook.configOf(_keyFor(token).toId()).creator, payee);
    }

    function test_a_second_launch_gets_its_own_pool() public {
        vm.prank(creator);
        (address a, PoolId idA) = pad.launch(_params(0, 0, 0));
        vm.prank(creator);
        (address b, PoolId idB) = pad.launch(_params(0, 0, 0));
        assertTrue(a != b, "same token twice");
        assertTrue(PoolId.unwrap(idA) != PoolId.unwrap(idB), "same pool twice");
        assertEq(pad.allTokensLength(), 2);
    }

    function test_launches_can_be_paused() public {
        vm.prank(admin);
        pad.setLaunchesPaused(true);
        vm.prank(creator);
        vm.expectRevert(ArcaniumLaunchpad.LaunchesPaused.selector);
        pad.launch(_params(0, 0, 0));
    }

    function test_a_stale_deadline_is_refused() public {
        ArcaniumLaunchpad.LaunchParams memory p = _params(0, 0, 0);
        p.deadline = block.timestamp - 1;
        vm.prank(creator);
        vm.expectRevert(ArcaniumLaunchpad.DeadlinePassed.selector);
        pad.launch(p);
    }

    function test_an_unknown_mode_is_refused() public {
        vm.prank(creator);
        vm.expectRevert(ArcaniumLaunchpad.BadMode.selector);
        pad.launch(_params(0, 0, 3));
    }

    function test_tax_above_the_cap_is_refused() public {
        vm.prank(creator);
        vm.expectRevert(ArcaniumHook.TaxAboveCap.selector);
        pad.launch(_params(0, 901, 0));
    }

    function test_launch_fee_is_taken_when_set() public {
        vm.prank(admin);
        pad.setLaunchFee(50e6);
        uint256 before = quote.balanceOf(creator);
        vm.prank(creator);
        pad.launch(_params(0, 0, 0));
        assertEq(before - quote.balanceOf(creator), 50e6, "launch fee not charged");
        assertEq(quote.balanceOf(feeTreasury), 50e6, "launch fee did not reach the treasury");
    }

    function test_the_launchpad_exposes_no_way_to_remove_liquidity() public {
        vm.prank(creator);
        (address token, ) = pad.launch(_params(0, 0, 0));
        uint256 held = IERC20(token).balanceOf(POOL_MANAGER);
        assertGt(held, 0);

        // The position belongs to the launchpad, and the launchpad's only
        // entry into the PoolManager's lock is unlockCallback — which is
        // callable by the PoolManager alone and only ever adds. There is no
        // owner function that withdraws, so not even the owner can.
        vm.prank(admin);
        vm.expectRevert(ArcaniumLaunchpad.NotPoolManager.selector);
        pad.unlockCallback("");
    }
}
