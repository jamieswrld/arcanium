// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArcTokenLocker} from "../../src/locker/ArcTokenLocker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Plain 18-decimal token.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Takes a percentage on every transfer, so the locker must credit what it
/// actually received rather than what it was asked for.
contract FeeOnTransferToken is ERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) ERC20("Fee", "FEE") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(0xFEE), fee);
        super._update(from, to, value - fee);
    }
}

/// Returns false instead of reverting — the classic non-compliant ERC-20 that
/// SafeERC20 exists to catch.
contract FalseReturningToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// Attempts to re-enter claim() from the token's transfer hook.
contract ReentrantToken is ERC20 {
    ArcTokenLocker public locker;
    uint256 public targetLock;
    bool private _attacking;

    constructor() ERC20("Re", "RE") {}

    function setTarget(ArcTokenLocker locker_, uint256 lockId) external {
        locker = locker_;
        targetLock = lockId;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(locker) != address(0) && from == address(locker) && !_attacking) {
            _attacking = true;
            // Should revert: nonReentrant, and `claimed` is already true.
            try locker.claim(targetLock) {} catch {}
            _attacking = false;
        }
    }
}

contract ArcTokenLockerTest is Test {
    ArcTokenLocker internal locker;
    MockERC20 internal token;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint64 internal constant THIRTY_DAYS = 30 days;

    event LockCreated(
        uint256 indexed lockId,
        address indexed token,
        address indexed beneficiary,
        address depositor,
        uint256 amount,
        uint64 unlockTime,
        uint64 createdAt
    );
    event LockClaimed(
        uint256 indexed lockId,
        address indexed token,
        address indexed beneficiary,
        uint256 amount,
        uint64 claimedAt
    );

    function setUp() public {
        // Start well past the epoch so `unlockTime > block.timestamp` is a
        // meaningful constraint rather than trivially true.
        vm.warp(1_700_000_000);
        locker = new ArcTokenLocker();
        token = new MockERC20("Token", "TKN", 18);
        token.mint(alice, 1_000_000 ether);
        vm.prank(alice);
        token.approve(address(locker), type(uint256).max);
    }

    function _unlockIn(uint64 secs) internal view returns (uint64) {
        return uint64(block.timestamp) + secs;
    }

    /* ------------------------------------------------------------ creation */

    function test_createLock_recordsEverything() public {
        uint64 unlock = _unlockIn(THIRTY_DAYS);
        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 100 ether, bob, unlock);

        assertEq(id, 1, "ids start at 1");
        ArcTokenLocker.Lock memory lock = locker.getLock(id);
        assertEq(lock.token, address(token));
        assertEq(lock.depositor, alice);
        assertEq(lock.beneficiary, bob);
        assertEq(lock.amount, 100 ether);
        assertEq(lock.unlockTime, unlock);
        assertEq(lock.createdAt, uint64(block.timestamp));
        assertFalse(lock.claimed);

        assertEq(token.balanceOf(address(locker)), 100 ether, "tokens actually held");
        assertEq(locker.totalLocked(address(token)), 100 ether);
        assertEq(locker.lockCount(), 1);
    }

    function test_createLock_emitsEvent() public {
        uint64 unlock = _unlockIn(THIRTY_DAYS);
        vm.expectEmit(true, true, true, true);
        emit LockCreated(1, address(token), bob, alice, 100 ether, unlock, uint64(block.timestamp));
        vm.prank(alice);
        locker.createLock(address(token), 100 ether, bob, unlock);
    }

    function test_createLock_rejectsZeroToken() public {
        vm.prank(alice);
        vm.expectRevert(ArcTokenLocker.ZeroToken.selector);
        locker.createLock(address(0), 1 ether, bob, _unlockIn(THIRTY_DAYS));
    }

    function test_createLock_rejectsEOAAsToken() public {
        vm.prank(alice);
        vm.expectRevert(ArcTokenLocker.TokenNotAContract.selector);
        locker.createLock(address(0xDEAD), 1 ether, bob, _unlockIn(THIRTY_DAYS));
    }

    function test_createLock_rejectsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(ArcTokenLocker.ZeroAmount.selector);
        locker.createLock(address(token), 0, bob, _unlockIn(THIRTY_DAYS));
    }

    function test_createLock_rejectsZeroBeneficiary() public {
        vm.prank(alice);
        vm.expectRevert(ArcTokenLocker.ZeroBeneficiary.selector);
        locker.createLock(address(token), 1 ether, address(0), _unlockIn(THIRTY_DAYS));
    }

    function test_createLock_rejectsPastUnlock() public {
        vm.prank(alice);
        vm.expectRevert(ArcTokenLocker.UnlockNotInFuture.selector);
        locker.createLock(address(token), 1 ether, bob, uint64(block.timestamp) - 1);
    }

    function test_createLock_rejectsUnlockEqualToNow() public {
        vm.prank(alice);
        vm.expectRevert(ArcTokenLocker.UnlockNotInFuture.selector);
        locker.createLock(address(token), 1 ether, bob, uint64(block.timestamp));
    }

    function test_createLock_revertsWhenTokenReturnsFalse() public {
        FalseReturningToken bad = new FalseReturningToken();
        bad.mint(alice, 100 ether);
        vm.startPrank(alice);
        bad.approve(address(locker), type(uint256).max);
        vm.expectRevert(); // SafeERC20 turns the false return into a revert
        locker.createLock(address(bad), 1 ether, bob, _unlockIn(THIRTY_DAYS));
        vm.stopPrank();
    }

    /* --------------------------------------------- fee-on-transfer accounting */

    function test_createLock_creditsWhatArrivedNotWhatWasAsked() public {
        FeeOnTransferToken fee = new FeeOnTransferToken(500); // 5%
        fee.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        fee.approve(address(locker), type(uint256).max);
        uint256 id = locker.createLock(address(fee), 100 ether, bob, _unlockIn(THIRTY_DAYS));
        vm.stopPrank();

        ArcTokenLocker.Lock memory lock = locker.getLock(id);
        assertEq(lock.amount, 95 ether, "credited the delta, not the request");
        assertEq(fee.balanceOf(address(locker)), 95 ether);
    }

    /// The failure this guards against: crediting the requested amount would
    /// let the second lock's claim drain the first lock's deposit, and leave
    /// the last claimer unable to withdraw at all.
    function test_feeOnTransfer_twoLocksBothFullyClaimable() public {
        FeeOnTransferToken fee = new FeeOnTransferToken(500);
        fee.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        fee.approve(address(locker), type(uint256).max);
        uint256 a = locker.createLock(address(fee), 100 ether, alice, _unlockIn(1 days));
        uint256 b = locker.createLock(address(fee), 100 ether, bob, _unlockIn(1 days));
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        locker.claim(a);
        vm.prank(bob);
        locker.claim(b);

        assertEq(fee.balanceOf(address(locker)), 0, "locker fully drained, nothing stranded");
        assertEq(locker.totalLocked(address(fee)), 0);
    }

    function test_createLock_revertsIfNothingArrives() public {
        FeeOnTransferToken fee = new FeeOnTransferToken(10_000); // 100% fee
        fee.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        fee.approve(address(locker), type(uint256).max);
        vm.expectRevert(ArcTokenLocker.NoTokensReceived.selector);
        locker.createLock(address(fee), 100 ether, bob, _unlockIn(THIRTY_DAYS));
        vm.stopPrank();
    }

    /* ------------------------------------------------------------- claiming */

    function test_claim_revertsBeforeUnlock() public {
        uint64 unlock = _unlockIn(THIRTY_DAYS);
        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 100 ether, bob, unlock);

        vm.warp(unlock - 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArcTokenLocker.StillLocked.selector, unlock));
        locker.claim(id);
    }

    function test_claim_succeedsExactlyAtUnlock() public {
        uint64 unlock = _unlockIn(THIRTY_DAYS);
        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 100 ether, bob, unlock);

        vm.warp(unlock);
        vm.prank(bob);
        locker.claim(id);
        assertEq(token.balanceOf(bob), 100 ether);
        assertEq(locker.totalLocked(address(token)), 0);
    }

    function test_claim_emitsEvent() public {
        uint64 unlock = _unlockIn(THIRTY_DAYS);
        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 100 ether, bob, unlock);
        vm.warp(unlock);

        vm.expectEmit(true, true, true, true);
        emit LockClaimed(id, address(token), bob, 100 ether, uint64(unlock));
        vm.prank(bob);
        locker.claim(id);
    }

    function test_claim_onlyBeneficiary() public {
        uint64 unlock = _unlockIn(THIRTY_DAYS);
        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 100 ether, bob, unlock);
        vm.warp(unlock);

        // Not even the depositor, who put the tokens in.
        vm.prank(alice);
        vm.expectRevert(ArcTokenLocker.NotBeneficiary.selector);
        locker.claim(id);

        vm.prank(address(0xC0FFEE));
        vm.expectRevert(ArcTokenLocker.NotBeneficiary.selector);
        locker.claim(id);
    }

    function test_claim_cannotClaimTwice() public {
        uint64 unlock = _unlockIn(THIRTY_DAYS);
        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 100 ether, bob, unlock);
        vm.warp(unlock);

        vm.startPrank(bob);
        locker.claim(id);
        vm.expectRevert(ArcTokenLocker.AlreadyClaimed.selector);
        locker.claim(id);
        vm.stopPrank();
    }

    function test_claim_unknownLockReverts() public {
        vm.prank(bob);
        vm.expectRevert(ArcTokenLocker.NoSuchLock.selector);
        locker.claim(999);
    }

    function test_reentrantTokenCannotDoubleClaim() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        evil.approve(address(locker), type(uint256).max);
        uint256 id = locker.createLock(address(evil), 100 ether, bob, _unlockIn(1 days));
        vm.stopPrank();
        evil.setTarget(locker, id);

        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        locker.claim(id);

        // Exactly one payout despite the hook trying for a second.
        assertEq(evil.balanceOf(bob), 100 ether);
        assertEq(evil.balanceOf(address(locker)), 0);
    }

    /* ------------------------------------------- no privileged escape hatch */

    /// The contract exposes exactly two state-changing functions. If a future
    /// change adds an admin unlock, this test is where it should hurt.
    function test_noAdminCanUnlockEarly() public {
        uint64 unlock = _unlockIn(365 days);
        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 100 ether, bob, unlock);

        // Deployer of the locker in this test is address(this).
        vm.expectRevert(ArcTokenLocker.NotBeneficiary.selector);
        locker.claim(id);

        assertEq(token.balanceOf(address(locker)), 100 ether, "still held");
    }

    /* ------------------------------------------------- many locks and users */

    function test_manyLocksSameToken() public {
        uint64 unlock = _unlockIn(10 days);
        vm.startPrank(alice);
        for (uint256 i = 0; i < 25; i++) {
            locker.createLock(address(token), 10 ether, bob, unlock + uint64(i));
        }
        vm.stopPrank();

        assertEq(locker.lockCount(), 25);
        assertEq(locker.totalLocked(address(token)), 250 ether);
    }

    function test_multipleUsersAndTokens() public {
        MockERC20 second = new MockERC20("Two", "TWO", 6);
        second.mint(bob, 1_000e6);
        vm.prank(bob);
        second.approve(address(locker), type(uint256).max);

        vm.prank(alice);
        uint256 a = locker.createLock(address(token), 50 ether, bob, _unlockIn(1 days));
        vm.prank(bob);
        uint256 b = locker.createLock(address(second), 500e6, alice, _unlockIn(2 days));

        assertEq(locker.totalLocked(address(token)), 50 ether);
        assertEq(locker.totalLocked(address(second)), 500e6);

        vm.warp(block.timestamp + 2 days);
        vm.prank(bob);
        locker.claim(a);
        vm.prank(alice);
        locker.claim(b);

        assertEq(token.balanceOf(bob), 50 ether);
        assertEq(second.balanceOf(alice), 500e6);
    }

    function test_weirdDecimals() public {
        MockERC20 tiny = new MockERC20("Tiny", "TINY", 2);
        MockERC20 huge = new MockERC20("Huge", "HUGE", 27);
        tiny.mint(alice, 10_000);
        huge.mint(alice, 10_000e27);

        vm.startPrank(alice);
        tiny.approve(address(locker), type(uint256).max);
        huge.approve(address(locker), type(uint256).max);
        uint256 a = locker.createLock(address(tiny), 1234, bob, _unlockIn(1 days));
        uint256 b = locker.createLock(address(huge), 5e27, bob, _unlockIn(1 days));
        vm.stopPrank();

        assertEq(locker.getLock(a).amount, 1234);
        assertEq(locker.getLock(b).amount, 5e27);
    }

    /* --------------------------------------------------------------- views */

    function test_views() public {
        uint64 unlock = _unlockIn(THIRTY_DAYS);
        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 100 ether, bob, unlock);

        assertFalse(locker.isClaimable(id));
        assertEq(locker.timeRemaining(id), THIRTY_DAYS);

        vm.warp(unlock);
        assertTrue(locker.isClaimable(id));
        assertEq(locker.timeRemaining(id), 0);

        vm.prank(bob);
        locker.claim(id);
        assertFalse(locker.isClaimable(id), "claimed is not claimable");
    }

    function test_getLock_unknownReverts() public {
        vm.expectRevert(ArcTokenLocker.NoSuchLock.selector);
        locker.getLock(42);
    }

    function test_isClaimable_unknownIsFalseNotRevert() public view {
        assertFalse(locker.isClaimable(42));
    }

    /* ---------------------------------------------------------------- fuzz */

    function testFuzz_lockAndClaim(uint128 amount, uint32 duration) public {
        amount = uint128(bound(amount, 1, 1_000_000 ether));
        duration = uint32(bound(duration, 1, 4 * 365 days));
        uint64 unlock = uint64(block.timestamp) + duration;

        vm.prank(alice);
        uint256 id = locker.createLock(address(token), amount, bob, unlock);

        vm.warp(unlock - 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArcTokenLocker.StillLocked.selector, unlock));
        locker.claim(id);

        vm.warp(unlock);
        vm.prank(bob);
        locker.claim(id);
        assertEq(token.balanceOf(bob), amount);
        assertEq(locker.totalLocked(address(token)), 0);
    }

    function testFuzz_cannotClaimEarly(uint32 duration, uint32 elapsed) public {
        duration = uint32(bound(duration, 2, 4 * 365 days));
        elapsed = uint32(bound(elapsed, 0, duration - 1));
        uint64 unlock = uint64(block.timestamp) + duration;

        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 1 ether, bob, unlock);

        vm.warp(block.timestamp + elapsed);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArcTokenLocker.StillLocked.selector, unlock));
        locker.claim(id);
    }

    function testFuzz_onlyBeneficiaryEverClaims(address caller) public {
        vm.assume(caller != bob && caller != address(0));
        uint64 unlock = _unlockIn(1 days);
        vm.prank(alice);
        uint256 id = locker.createLock(address(token), 1 ether, bob, unlock);

        vm.warp(unlock);
        vm.prank(caller);
        vm.expectRevert(ArcTokenLocker.NotBeneficiary.selector);
        locker.claim(id);
    }
}
