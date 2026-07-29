// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArchUSD} from "../bridge/ArchUSD.sol";

/// @title aUSD → USDC exchange (wind-down)
/// @notice The permanent one-for-one exchange that ends the temporary bridged
///         dollar. It can only open once the USDC it holds fully covers every
///         outstanding aUSD ("the exchange cannot open underwater"), and once
///         open it can never close and has no redemption deadline: the last
///         holder to exchange is covered as fully as the first.
/// @dev    Requires aUSD's BRIDGE_ROLE (to burn on exchange). Opening is a
///         one-way switch.
contract AusdExchange is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    ArchUSD public immutable ausd;
    IERC20 public immutable usdc;

    bool public opened;
    /// @notice aUSD supply recorded at open — the amount the reserve covered.
    uint256 public supplyAtOpen;

    event Opened(uint256 usdcOnHand, uint256 ausdSupply);
    event Exchanged(address indexed holder, uint256 amount);

    error AlreadyOpened();
    error NotOpened();
    error Undercollateralized(uint256 usdcOnHand, uint256 ausdSupply);
    error ZeroAddress();

    constructor(address ausd_, address usdc_, address owner_) Ownable(owner_) {
        if (ausd_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        ausd = ArchUSD(ausd_);
        usdc = IERC20(usdc_);
    }

    /// @notice Open the exchange. Reverts unless USDC on hand covers the full
    ///         outstanding aUSD supply. Irreversible.
    function open() external onlyOwner {
        if (opened) revert AlreadyOpened();
        uint256 onHand = usdc.balanceOf(address(this));
        uint256 supply = ausd.totalSupply();
        if (onHand < supply) revert Undercollateralized(onHand, supply);
        opened = true;
        supplyAtOpen = supply;
        emit Opened(onHand, supply);
    }

    /// @notice Exchange aUSD for native-chain USDC, exactly one for one, any
    ///         time, forever. Burns the aUSD.
    function exchange(uint256 amount) external nonReentrant {
        if (!opened) revert NotOpened();
        ausd.bridgeBurn(msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
        emit Exchanged(msg.sender, amount);
    }

    /// @notice Swap-in for the pool migrator: pulls aUSD and returns USDC 1:1
    ///         (the migrator converts each pool's withdrawn aUSD).
    function exchangeFrom(address from, uint256 amount) external nonReentrant {
        if (!opened) revert NotOpened();
        ausd.bridgeBurn(from, amount);
        usdc.safeTransfer(msg.sender, amount);
        emit Exchanged(from, amount);
    }
}
