// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Arc token locker
/// @notice Locks an ERC-20 balance until a chosen timestamp, after which only
///         the named beneficiary can withdraw it.
///
/// @dev    This is *not* the liquidity vault that holds an Arcanium launch's
///         Uniswap position. That liquidity is locked forever and belongs to
///         nobody. These are ordinary allocation locks: a depositor picks a
///         beneficiary and a date, and the tokens are unreachable until then.
///
///         There is deliberately no owner. No pause, no rescue, no admin
///         unlock, no upgrade path. A lock that someone can shorten is not a
///         lock, and the whole value of this contract is that the promise it
///         makes is the one it keeps. That also means a lock created with the
///         wrong beneficiary or the wrong date cannot be repaired — the UI
///         carries the weight of confirming both before signing.
///
///         Nothing here is upgradeable because nothing here needs to be: the
///         contract stores balances and a timestamp, and neither has a future
///         requirement that could justify letting someone swap the logic out
///         from under deposited funds.
contract ArcTokenLocker is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Lock {
        address token;
        address depositor;
        address beneficiary;
        /// Tokens actually received, which is not necessarily the amount asked
        /// for — see the balance delta in createLock.
        uint256 amount;
        uint64 createdAt;
        uint64 unlockTime;
        bool claimed;
    }

    /// @notice Every lock ever created, by id. Ids start at 1 so that zero can
    ///         mean "no such lock" in callers and in the indexer.
    mapping(uint256 => Lock) private _locks;

    /// @notice Total locks created. Also the highest valid id.
    uint256 public lockCount;

    /// @notice Sum of currently locked (unclaimed) amounts per token. Lets a
    ///         token page state how much is locked without walking every lock.
    mapping(address => uint256) public totalLocked;

    /// @dev Indexed on token, depositor and beneficiary so the three questions
    ///      anyone actually asks — what is locked in this token, what did I
    ///      lock, what is coming to me — are all one filtered log query.
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

    error ZeroToken();
    error TokenNotAContract();
    error ZeroAmount();
    error ZeroBeneficiary();
    error UnlockNotInFuture();
    error NoTokensReceived();
    error NoSuchLock();
    error NotBeneficiary();
    error StillLocked(uint64 unlockTime);
    error AlreadyClaimed();

    /// @notice Lock `amount` of `token` until `unlockTime`, withdrawable only
    ///         by `beneficiary`.
    /// @dev    The amount recorded is the balance delta this contract actually
    ///         observes, not the amount requested. A fee-on-transfer token
    ///         delivers less than was asked for, and crediting the requested
    ///         figure would let the last lock of that token fail to pay out by
    ///         quietly spending an earlier lock's deposit.
    /// @return lockId The new lock's id.
    function createLock(address token, uint256 amount, address beneficiary, uint64 unlockTime)
        external
        nonReentrant
        returns (uint256 lockId)
    {
        if (token == address(0)) revert ZeroToken();
        if (token.code.length == 0) revert TokenNotAContract();
        if (amount == 0) revert ZeroAmount();
        if (beneficiary == address(0)) revert ZeroBeneficiary();
        // Strictly future: a lock that is already claimable is not a lock, and
        // allowing == now would make the guard depend on miner timestamp slop.
        if (unlockTime <= block.timestamp) revert UnlockNotInFuture();

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert NoTokensReceived();

        unchecked {
            lockId = ++lockCount;
        }
        _locks[lockId] = Lock({
            token: token,
            depositor: msg.sender,
            beneficiary: beneficiary,
            amount: received,
            createdAt: uint64(block.timestamp),
            unlockTime: unlockTime,
            claimed: false
        });
        totalLocked[token] += received;

        emit LockCreated(
            lockId, token, beneficiary, msg.sender, received, unlockTime, uint64(block.timestamp)
        );
    }

    /// @notice Withdraw a matured lock to its beneficiary.
    /// @dev    Effects before interactions, and `claimed` is set before the
    ///         transfer, so a token with a transfer hook cannot re-enter and
    ///         claim twice. nonReentrant is belt to that braces.
    function claim(uint256 lockId) external nonReentrant {
        Lock storage lock = _locks[lockId];
        if (lock.beneficiary == address(0)) revert NoSuchLock();
        if (msg.sender != lock.beneficiary) revert NotBeneficiary();
        if (lock.claimed) revert AlreadyClaimed();
        // At the unlock second exactly, it is claimable. Anything earlier is not.
        if (block.timestamp < lock.unlockTime) revert StillLocked(lock.unlockTime);

        uint256 amount = lock.amount;
        lock.claimed = true;
        totalLocked[lock.token] -= amount;

        IERC20(lock.token).safeTransfer(lock.beneficiary, amount);

        emit LockClaimed(lockId, lock.token, lock.beneficiary, amount, uint64(block.timestamp));
    }

    /// @notice One lock by id. Reverts rather than returning an empty struct,
    ///         so a caller cannot mistake "never existed" for "zero amount".
    function getLock(uint256 lockId) external view returns (Lock memory) {
        Lock memory lock = _locks[lockId];
        if (lock.beneficiary == address(0)) revert NoSuchLock();
        return lock;
    }

    /// @notice Whether a lock exists, has matured and has not been claimed.
    function isClaimable(uint256 lockId) external view returns (bool) {
        Lock memory lock = _locks[lockId];
        return lock.beneficiary != address(0) && !lock.claimed && block.timestamp >= lock.unlockTime;
    }

    /// @notice Seconds until a lock matures; zero once it has.
    function timeRemaining(uint256 lockId) external view returns (uint64) {
        Lock memory lock = _locks[lockId];
        if (lock.beneficiary == address(0)) revert NoSuchLock();
        if (block.timestamp >= lock.unlockTime) return 0;
        return lock.unlockTime - uint64(block.timestamp);
    }
}
