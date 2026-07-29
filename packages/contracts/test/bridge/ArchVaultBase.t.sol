// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArchVaultBase} from "../../src/bridge/ArchVaultBase.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract ArchVaultBaseTest is Test {
    MockUSDC internal usdc;
    ArchVaultBase internal vault;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal user = makeAddr("user");
    address internal recipientArc = makeAddr("recipientArc");
    address internal recipientBase = makeAddr("recipientBase");

    uint256 internal constant FEE_BPS = 1500; // 15%
    uint256 internal constant MIN_DEPOSIT = 25e6;
    uint256 internal constant MAX_DEPOSIT = 100_000e6;
    uint256 internal constant MAX_RELEASE_TX = 100_000e6;
    uint256 internal constant MAX_RELEASE_WINDOW = 500_000e6;
    uint256 internal constant WINDOW_SECONDS = 3600;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new ArchVaultBase(
            address(usdc),
            owner,
            treasury,
            FEE_BPS,
            MIN_DEPOSIT,
            MAX_DEPOSIT,
            MAX_RELEASE_TX,
            MAX_RELEASE_WINDOW,
            WINDOW_SECONDS
        );
        vm.prank(owner);
        vault.setKeeper(keeper, true);

        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ---------------------------------------------------------------- deposits

    function test_depositTakes15PercentFee() public {
        vm.prank(user);
        vm.expectEmit(true, true, false, true);
        emit ArchVaultBase.Deposited(user, recipientArc, 100e6, 15e6, 85e6, 0);
        vault.deposit(100e6, recipientArc);

        assertEq(usdc.balanceOf(treasury), 15e6, "fee to treasury");
        assertEq(usdc.balanceOf(address(vault)), 85e6, "net retained");
        assertEq(vault.totalReserve(), 85e6, "reserve accounting");
        assertEq(vault.depositNonce(), 1);
    }

    function test_depositBelowMinReverts() public {
        vm.prank(user);
        vm.expectRevert(ArchVaultBase.AmountOutOfRange.selector);
        vault.deposit(MIN_DEPOSIT - 1, recipientArc);
    }

    function test_depositAboveMaxReverts() public {
        vm.prank(user);
        vm.expectRevert(ArchVaultBase.AmountOutOfRange.selector);
        vault.deposit(MAX_DEPOSIT + 1, recipientArc);
    }

    function test_depositZeroRecipientReverts() public {
        vm.prank(user);
        vm.expectRevert(ArchVaultBase.ZeroAddress.selector);
        vault.deposit(100e6, address(0));
    }

    function test_depositPause() public {
        vm.prank(owner);
        vault.setDepositsPaused(true);
        vm.prank(user);
        vm.expectRevert(ArchVaultBase.DepositsArePaused.selector);
        vault.deposit(100e6, recipientArc);
    }

    function testFuzz_depositFeeMath(uint256 amount) public {
        amount = bound(amount, MIN_DEPOSIT, MAX_DEPOSIT);
        uint256 expectedFee = (amount * FEE_BPS) / 10_000;
        vm.prank(user);
        vault.deposit(amount, recipientArc);
        assertEq(usdc.balanceOf(treasury), expectedFee);
        assertEq(vault.totalReserve(), amount - expectedFee);
        assertEq(usdc.balanceOf(address(vault)), vault.totalReserve());
    }

    // ---------------------------------------------------------------- releases

    function _fundReserve(uint256 grossAmount) internal returns (uint256 net) {
        vm.prank(user);
        vault.deposit(grossAmount, recipientArc);
        return grossAmount - (grossAmount * FEE_BPS) / 10_000;
    }

    function test_releaseHappyPath() public {
        uint256 net = _fundReserve(100_000e6);
        bytes32 arcTx = keccak256("arc-burn-1");
        bytes32 expectedId = keccak256(abi.encode(arcTx, uint256(3)));

        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit ArchVaultBase.Released(expectedId, arcTx, 3, recipientBase, 1_000e6);
        vault.release(arcTx, 3, recipientBase, 1_000e6);

        assertEq(usdc.balanceOf(recipientBase), 1_000e6);
        assertEq(vault.totalReserve(), net - 1_000e6);
        assertTrue(vault.processedRedemptions(expectedId));
    }

    function test_releaseReplayReverts() public {
        _fundReserve(100_000e6);
        bytes32 arcTx = keccak256("arc-burn-1");
        vm.startPrank(keeper);
        vault.release(arcTx, 3, recipientBase, 1_000e6);
        bytes32 id = keccak256(abi.encode(arcTx, uint256(3)));
        vm.expectRevert(abi.encodeWithSelector(ArchVaultBase.AlreadyProcessed.selector, id));
        vault.release(arcTx, 3, recipientBase, 1_000e6);
        vm.stopPrank();
    }

    function test_releaseSameTxDifferentLogIndexAllowed() public {
        _fundReserve(100_000e6);
        bytes32 arcTx = keccak256("arc-burn-1");
        vm.startPrank(keeper);
        vault.release(arcTx, 3, recipientBase, 1_000e6);
        vault.release(arcTx, 4, recipientBase, 2_000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(recipientBase), 3_000e6);
    }

    function test_releaseOnlyKeeper() public {
        _fundReserve(100_000e6);
        vm.prank(user);
        vm.expectRevert(ArchVaultBase.NotKeeper.selector);
        vault.release(keccak256("x"), 0, recipientBase, 1e6);
    }

    function test_releasePerTxCap() public {
        vm.prank(owner);
        vault.setReleaseLimits(500e6, MAX_RELEASE_WINDOW, WINDOW_SECONDS);
        _fundReserve(100_000e6);
        vm.prank(keeper);
        vm.expectRevert(ArchVaultBase.ReleaseExceedsTxCap.selector);
        vault.release(keccak256("x"), 0, recipientBase, 501e6);
    }

    function test_releaseWindowCapAndReset() public {
        vm.prank(owner);
        vault.setReleaseLimits(MAX_RELEASE_TX, 1_500e6, WINDOW_SECONDS);
        _fundReserve(100_000e6);

        vm.startPrank(keeper);
        vault.release(keccak256("a"), 0, recipientBase, 1_000e6);
        vm.expectRevert(ArchVaultBase.ReleaseExceedsWindowCap.selector);
        vault.release(keccak256("b"), 0, recipientBase, 600e6);

        // A new window opens after the interval elapses.
        vm.warp(block.timestamp + WINDOW_SECONDS);
        vault.release(keccak256("b"), 0, recipientBase, 600e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(recipientBase), 1_600e6);
    }

    function test_releaseInsufficientReserveReverts() public {
        _fundReserve(1_000e6); // net 850e6
        vm.prank(keeper);
        vm.expectRevert(ArchVaultBase.InsufficientReserve.selector);
        vault.release(keccak256("x"), 0, recipientBase, 851e6);
    }

    function test_releasePause() public {
        _fundReserve(1_000e6);
        vm.prank(owner);
        vault.setReleasesPaused(true);
        vm.prank(keeper);
        vm.expectRevert(ArchVaultBase.ReleasesArePaused.selector);
        vault.release(keccak256("x"), 0, recipientBase, 1e6);
    }

    // ------------------------------------------------------------------- admin

    function test_feeCapEnforced() public {
        vm.prank(owner);
        vm.expectRevert(ArchVaultBase.FeeAboveCap.selector);
        vault.setFeeBps(2_001);

        vm.expectRevert(ArchVaultBase.FeeAboveCap.selector);
        new ArchVaultBase(
            address(usdc), owner, treasury, 2_001, 1, 2, 1, 1, 1
        );
    }

    function test_reserveCannotBeSwept() public {
        _fundReserve(1_000e6);
        vm.prank(owner);
        vm.expectRevert(ArchVaultBase.CannotRescueReserveAsset.selector);
        vault.rescueToken(address(usdc), owner, 1);
    }

    function test_rescueOtherToken() public {
        MockUSDC stray = new MockUSDC();
        stray.mint(address(vault), 777e6);
        vm.prank(owner);
        vault.rescueToken(address(stray), owner, 777e6);
        assertEq(stray.balanceOf(owner), 777e6);
    }

    function test_twoStepOwnership() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        vault.transferOwnership(newOwner);
        assertEq(vault.owner(), owner, "still old owner until accepted");
        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), newOwner);
    }

    function test_nonOwnerCannotAdmin() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vault.setFeeBps(100);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vault.setDepositsPaused(true);
        vm.stopPrank();
    }

    // --------------------------------------------------------------- migration

    function test_migrationRequiresPausesAndTarget() public {
        _fundReserve(1_000e6);
        address target = makeAddr("migrationTarget");

        vm.startPrank(owner);
        vm.expectRevert(ArchVaultBase.MigrationNotConfigured.selector);
        vault.migrateReserve(1e6);

        vault.setMigrationTarget(target);
        vm.expectRevert(ArchVaultBase.MigrationRequiresPause.selector);
        vault.migrateReserve(1e6);

        vault.setDepositsPaused(true);
        vm.expectRevert(ArchVaultBase.MigrationRequiresPause.selector);
        vault.migrateReserve(1e6);

        vault.setReleasesPaused(true);
        vault.migrateReserve(850e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(target), 850e6);
        assertEq(vault.totalReserve(), 0);
    }
}
