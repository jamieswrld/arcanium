// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArchLaunchpadFactory} from "./ArchLaunchpadFactory.sol";

/// @title Arch graduation registry
/// @notice Graduation is a permanent display milestone, nothing more. A token
///         graduates when its pool's quote-token balance first reaches the
///         threshold (9,000 aUSD/USDC). Graduation never reverses, never
///         unlocks liquidity, never creates a new pool, never changes the
///         token, and never changes the fee split. Anyone can trigger the
///         check; the indexer verifies the same condition independently.
contract GraduationRegistry {
    ArchLaunchpadFactory public immutable factory;
    /// @notice Threshold in quote units (6 decimals): 9,000_000000.
    uint256 public immutable graduationQuoteUnits;

    mapping(address => bool) public graduated;
    mapping(address => uint256) public graduatedAtBlock;

    event Graduated(address indexed token, uint256 poolQuoteBalance, uint256 blockNumber);

    error UnknownToken();
    error ThresholdNotReached();
    error AlreadyGraduated();

    constructor(address factory_, uint256 graduationQuoteUnits_) {
        factory = ArchLaunchpadFactory(factory_);
        graduationQuoteUnits = graduationQuoteUnits_;
    }

    /// @notice Permissionlessly mark a token graduated once its pool holds
    ///         the threshold quote balance.
    function checkGraduation(address token) external {
        if (graduated[token]) revert AlreadyGraduated();
        (address launchedToken, , address pairToken, address pool, ) = factory.launches(token);
        if (launchedToken == address(0)) revert UnknownToken();
        uint256 quoteBalance = IERC20(pairToken).balanceOf(pool);
        if (quoteBalance < graduationQuoteUnits) revert ThresholdNotReached();
        graduated[token] = true;
        graduatedAtBlock[token] = block.number;
        emit Graduated(token, quoteBalance, block.number);
    }
}
