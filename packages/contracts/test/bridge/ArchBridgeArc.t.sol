// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArchUSD} from "../../src/bridge/ArchUSD.sol";
import {ArchBridgeArc} from "../../src/bridge/ArchBridgeArc.sol";

contract ArchBridgeArcTest is Test {
    ArchUSD internal ausd;
    ArchBridgeArc internal bridge;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal baseRecipient = makeAddr("baseRecipient");

    uint256 internal constant MIN_REDEEM = 1e6;
    uint256 internal constant MAX_MINT_TX = 100_000e6;
    uint256 internal constant MAX_MINT_WINDOW = 500_000e6;
    uint256 internal constant WINDOW_SECONDS = 3600;

    function setUp() public {
        ausd = new ArchUSD(admin);
        bridge = new ArchBridgeArc(
            address(ausd), admin, MIN_REDEEM, MAX_MINT_TX, MAX_MINT_WINDOW, WINDOW_SECONDS
        );
        vm.startPrank(admin);
        ausd.grantRole(ausd.BRIDGE_ROLE(), address(bridge));
        bridge.setKeeper(keeper, true);
        vm.stopPrank();
    }

    function _mintTo(address to, uint256 amount, bytes32 baseTx, uint256 logIndex) internal {
        vm.prank(keeper);
        bridge.mintDeposit(baseTx, logIndex, to, amount);
    }

    // ------------------------------------------------------------------- mints

    function test_mintDeposit() public {
        bytes32 baseTx = keccak256("base-deposit-1");
        bytes32 expectedId = keccak256(abi.encode(baseTx, uint256(7)));

        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit ArchBridgeArc.DepositMinted(expectedId, baseTx, 7, alice, 85e6);
        bridge.mintDeposit(baseTx, 7, alice, 85e6);

        assertEq(ausd.balanceOf(alice), 85e6);
        assertTrue(bridge.processedDeposits(expectedId));
    }

    function test_mintReplayReverts() public {
        bytes32 baseTx = keccak256("base-deposit-1");
        _mintTo(alice, 85e6, baseTx, 7);
        bytes32 id = keccak256(abi.encode(baseTx, uint256(7)));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ArchBridgeArc.AlreadyProcessed.selector, id));
        bridge.mintDeposit(baseTx, 7, alice, 85e6);
    }

    function test_mintOnlyKeeper() public {
        vm.prank(alice);
        vm.expectRevert(ArchBridgeArc.NotKeeper.selector);
        bridge.mintDeposit(keccak256("x"), 0, alice, 1e6);
    }

    function test_mintPerTxCap() public {
        vm.prank(keeper);
        vm.expectRevert(ArchBridgeArc.MintExceedsTxCap.selector);
        bridge.mintDeposit(keccak256("x"), 0, alice, MAX_MINT_TX + 1);
    }

    function test_mintWindowCapAndReset() public {
        vm.prank(admin);
        bridge.setMintLimits(MAX_MINT_TX, 100e6, WINDOW_SECONDS);

        _mintTo(alice, 80e6, keccak256("a"), 0);
        vm.prank(keeper);
        vm.expectRevert(ArchBridgeArc.MintExceedsWindowCap.selector);
        bridge.mintDeposit(keccak256("b"), 0, alice, 30e6);

        vm.warp(block.timestamp + WINDOW_SECONDS);
        _mintTo(alice, 30e6, keccak256("b"), 0);
        assertEq(ausd.balanceOf(alice), 110e6);
    }

    function test_mintPause() public {
        vm.prank(admin);
        bridge.setMintsPaused(true);
        vm.prank(keeper);
        vm.expectRevert(ArchBridgeArc.MintsArePaused.selector);
        bridge.mintDeposit(keccak256("x"), 0, alice, 1e6);
    }

    // -------------------------------------------------------------- redemption

    function test_redeemBurnsAndEmitsIncrementingNonce() public {
        _mintTo(alice, 100e6, keccak256("a"), 0);

        vm.startPrank(alice);
        vm.expectEmit(true, true, false, true);
        emit ArchBridgeArc.Redeemed(alice, baseRecipient, 40e6, 0);
        bridge.redeem(40e6, baseRecipient);

        vm.expectEmit(true, true, false, true);
        emit ArchBridgeArc.Redeemed(alice, baseRecipient, 10e6, 1);
        bridge.redeem(10e6, baseRecipient);
        vm.stopPrank();

        assertEq(ausd.balanceOf(alice), 50e6);
        assertEq(ausd.totalSupply(), 50e6);
        assertEq(bridge.redeemNonce(), 2);
    }

    function test_redeemBelowMinReverts() public {
        _mintTo(alice, 100e6, keccak256("a"), 0);
        vm.prank(alice);
        vm.expectRevert(ArchBridgeArc.BelowMinRedeem.selector);
        bridge.redeem(MIN_REDEEM - 1, baseRecipient);
    }

    function test_redeemZeroRecipientReverts() public {
        _mintTo(alice, 100e6, keccak256("a"), 0);
        vm.prank(alice);
        vm.expectRevert(ArchBridgeArc.ZeroAddress.selector);
        bridge.redeem(10e6, address(0));
    }

    function test_redeemMoreThanBalanceReverts() public {
        _mintTo(alice, 100e6, keccak256("a"), 0);
        vm.prank(alice);
        vm.expectRevert(); // ERC20InsufficientBalance from the burn
        bridge.redeem(101e6, baseRecipient);
    }

    function test_redeemPause() public {
        _mintTo(alice, 100e6, keccak256("a"), 0);
        vm.prank(admin);
        bridge.setRedeemsPaused(true);
        vm.prank(alice);
        vm.expectRevert(ArchBridgeArc.RedeemsArePaused.selector);
        bridge.redeem(10e6, baseRecipient);
    }

    function test_redeemCannotBurnOthers() public {
        // The bridge only ever burns msg.sender; there is no path to burn a
        // third party. Verify the only external burn entry point behaves so.
        _mintTo(alice, 100e6, keccak256("a"), 0);
        address bob = makeAddr("bob");
        vm.prank(bob);
        vm.expectRevert(); // bob has no balance to burn
        bridge.redeem(1e6, baseRecipient);
        assertEq(ausd.balanceOf(alice), 100e6, "alice untouched");
    }
}
