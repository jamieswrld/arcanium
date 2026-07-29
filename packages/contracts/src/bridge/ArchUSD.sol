// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Arch USD (aUSD)
/// @notice The temporary bridged dollar on Arc. Every aUSD is backed
///         one-for-one by USDC held in the Arch vault on Base (after the
///         deposit fee). aUSD is issued by Arch, not Circle, and is not
///         native USDC.
/// @dev    Supply changes flow exclusively through BRIDGE_ROLE, which is
///         granted only to the ArchBridgeArc contract. There is no owner or
///         admin mint path: DEFAULT_ADMIN_ROLE can manage roles and pausers
///         but cannot mint or burn directly. The admin is expected to be the
///         timelocked protocol multisig.
contract ArchUSD is ERC20, ERC20Permit, AccessControl, Pausable {
    /// @notice Role that may mint against confirmed Base deposits and burn
    ///         for redemptions. Held by the Arc bridge contract only.
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    /// @notice Role that may pause and unpause all token movement.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    event BridgeMint(address indexed to, uint256 amount);
    event BridgeBurn(address indexed from, uint256 amount);

    constructor(address admin) ERC20("Arch USD", "aUSD") ERC20Permit("Arch USD") {
        require(admin != address(0), "ArchUSD: zero admin");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @notice aUSD mirrors the 6-decimal USDC interface.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint exactly the net amount of a confirmed Base deposit.
    function bridgeMint(address to, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        _mint(to, amount);
        emit BridgeMint(to, amount);
    }

    /// @notice Burn for an Arc→Base redemption. The bridge contract only ever
    ///         passes its own caller, so no holder can be burned without
    ///         initiating a redemption themselves.
    function bridgeBurn(address from, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        _burn(from, amount);
        emit BridgeBurn(from, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @dev Blocks every transfer, mint, and burn while paused.
    function _update(address from, address to, uint256 value)
        internal
        override
        whenNotPaused
    {
        super._update(from, to, value);
    }
}
