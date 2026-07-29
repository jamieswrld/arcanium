// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Arch fee splitter
/// @notice The protocol treasury. Every protocol fee stream (bridge entry
///         fees, launch fees, the 70% quote-side trading share, gas-station
///         margins) pays into this contract; anyone can flush the balance to
///         the configured recipient set by weight. Deployed identically on
///         Base (bridge fees) and Arc (everything else).
contract ArchFeeSplitter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    address[] public recipients;
    uint256[] public weightsBps;

    event RecipientsUpdated(address[] recipients, uint256[] weightsBps);
    event Flushed(address indexed token, uint256 total);
    event FlushedNative(uint256 total);

    error LengthMismatch();
    error NoRecipients();
    error WeightsMustSumTo10000();
    error ZeroAddress();
    error NativeTransferFailed();

    constructor(address owner_, address[] memory recipients_, uint256[] memory weightsBps_)
        Ownable(owner_)
    {
        _setRecipients(recipients_, weightsBps_);
    }

    receive() external payable {}

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    /// @notice Distribute the full balance of `token` to all recipients by
    ///         weight. Permissionless; rounding dust goes to the first
    ///         (largest-weight) recipient.
    function flush(address token) external nonReentrant {
        uint256 total = IERC20(token).balanceOf(address(this));
        if (total == 0) return;
        uint256 distributed;
        for (uint256 i = 1; i < recipients.length; i++) {
            uint256 share = (total * weightsBps[i]) / BPS_DENOMINATOR;
            distributed += share;
            if (share > 0) IERC20(token).safeTransfer(recipients[i], share);
        }
        IERC20(token).safeTransfer(recipients[0], total - distributed);
        emit Flushed(token, total);
    }

    /// @notice Distribute the native balance (Arc gas-station margins arrive
    ///         as native USDC).
    function flushNative() external nonReentrant {
        uint256 total = address(this).balance;
        if (total == 0) return;
        uint256 distributed;
        for (uint256 i = 1; i < recipients.length; i++) {
            uint256 share = (total * weightsBps[i]) / BPS_DENOMINATOR;
            distributed += share;
            if (share > 0) {
                (bool ok, ) = payable(recipients[i]).call{value: share}("");
                if (!ok) revert NativeTransferFailed();
            }
        }
        (bool okFirst, ) = payable(recipients[0]).call{value: total - distributed}("");
        if (!okFirst) revert NativeTransferFailed();
        emit FlushedNative(total);
    }

    /// @notice Replace the recipient set. Owner-only (protocol multisig);
    ///         intended for rotating in user-controlled wallets pre-mainnet.
    function setRecipients(address[] calldata recipients_, uint256[] calldata weightsBps_)
        external
        onlyOwner
    {
        _setRecipients(recipients_, weightsBps_);
    }

    function _setRecipients(address[] memory recipients_, uint256[] memory weightsBps_)
        internal
    {
        if (recipients_.length == 0) revert NoRecipients();
        if (recipients_.length != weightsBps_.length) revert LengthMismatch();
        uint256 sum;
        for (uint256 i = 0; i < recipients_.length; i++) {
            if (recipients_[i] == address(0)) revert ZeroAddress();
            sum += weightsBps_[i];
        }
        if (sum != BPS_DENOMINATOR) revert WeightsMustSumTo10000();
        recipients = recipients_;
        weightsBps = weightsBps_;
        emit RecipientsUpdated(recipients_, weightsBps_);
    }
}
