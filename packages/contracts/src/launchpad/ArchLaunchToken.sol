// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Arch launch token
/// @notice Every Arch launch is this exact contract: a fixed supply of one
///         billion 18-decimal tokens minted once to the launchpad factory at
///         construction. No owner, no further minting, no taxes, no
///         blacklist, no trading restrictions, no upgradeability.
contract ArchLaunchToken is ERC20 {
    uint256 public constant FIXED_SUPPLY = 1_000_000_000e18;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _mint(msg.sender, FIXED_SUPPLY);
    }
}
