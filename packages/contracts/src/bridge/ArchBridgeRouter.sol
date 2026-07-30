// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

/// @title Arch bridge router
/// @notice Front door for Arcanium's CCTP bridge: takes the protocol's flat
///         fee on the amount in, sends it to the treasury, and burns the rest
///         through Circle's TokenMessenger — one atomic transaction. Deployed
///         identically on every chain the bridge serves.
contract ArchBridgeRouter is Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Compiled-in fee ceiling (5%) — even the owner cannot exceed it.
    uint256 public constant MAX_FEE_BPS = 500;

    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;

    address public treasury;
    uint256 public feeBps;

    event Bridged(
        address indexed sender,
        uint32 indexed destinationDomain,
        bytes32 mintRecipient,
        uint256 amountIn,
        uint256 fee,
        uint256 amountBridged
    );
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    error ZeroAddress();
    error ZeroAmount();
    error FeeAboveCap();

    constructor(
        address usdc_,
        address tokenMessenger_,
        address treasury_,
        uint256 feeBps_,
        address owner_
    ) Ownable(owner_) {
        if (usdc_ == address(0) || tokenMessenger_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeAboveCap();
        usdc = IERC20(usdc_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        treasury = treasury_;
        feeBps = feeBps_;
    }

    /// @notice Bridge `amount` USDC to `destinationDomain`, minting to
    ///         `mintRecipient` (32-byte left-padded address). The protocol fee
    ///         is taken from `amount`; the remainder is burned via CCTP.
    function bridge(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxCctpFee,
        uint32 minFinalityThreshold
    ) external {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        uint256 net = amount - fee;

        usdc.forceApprove(address(tokenMessenger), net);
        tokenMessenger.depositForBurn(
            net,
            destinationDomain,
            mintRecipient,
            address(usdc),
            bytes32(0),
            maxCctpFee,
            minFinalityThreshold
        );

        emit Bridged(msg.sender, destinationDomain, mintRecipient, amount, fee, net);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeAboveCap();
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }
}
