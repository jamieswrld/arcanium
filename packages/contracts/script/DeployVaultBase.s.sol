// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ArchVaultBase} from "../src/bridge/ArchVaultBase.sol";

/// @notice Deploys the Base-side vault against the real Circle USDC of the
///         target Base network. All parameters come from environment
///         variables — nothing is hardcoded per-network.
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY        deployer key (testnet-only until launch gate)
///   VAULT_USDC_ADDRESS          canonical Circle USDC on the target network
///   VAULT_OWNER_ADDRESS         protocol multisig (or deployer on testnet)
///   VAULT_TREASURY_ADDRESS      bridge treasury
///   VAULT_KEEPER_ADDRESS        Base keeper hot wallet
///   BRIDGE_DEPOSIT_FEE_BPS      1500
///   BRIDGE_MIN_DEPOSIT_UNITS    25000000
///   BRIDGE_MAX_DEPOSIT_UNITS    100000000000
///   BRIDGE_MAX_RELEASE_PER_TX_UNITS
///   BRIDGE_MAX_RELEASE_PER_WINDOW_UNITS
///   BRIDGE_RELEASE_WINDOW_SECONDS
contract DeployVaultBase is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = vm.envAddress("VAULT_USDC_ADDRESS");
        address owner = vm.envAddress("VAULT_OWNER_ADDRESS");
        address treasury = vm.envAddress("VAULT_TREASURY_ADDRESS");
        address keeper = vm.envAddress("VAULT_KEEPER_ADDRESS");
        uint256 feeBps = vm.envUint("BRIDGE_DEPOSIT_FEE_BPS");
        uint256 minDeposit = vm.envUint("BRIDGE_MIN_DEPOSIT_UNITS");
        uint256 maxDeposit = vm.envUint("BRIDGE_MAX_DEPOSIT_UNITS");
        uint256 maxReleaseTx = vm.envUint("BRIDGE_MAX_RELEASE_PER_TX_UNITS");
        uint256 maxReleaseWindow = vm.envUint("BRIDGE_MAX_RELEASE_PER_WINDOW_UNITS");
        uint256 windowSeconds = vm.envUint("BRIDGE_RELEASE_WINDOW_SECONDS");

        vm.startBroadcast(deployerKey);
        ArchVaultBase vault = new ArchVaultBase(
            usdc,
            vm.addr(deployerKey), // deployer configures, then hands off below
            treasury,
            feeBps,
            minDeposit,
            maxDeposit,
            maxReleaseTx,
            maxReleaseWindow,
            windowSeconds
        );
        vault.setKeeper(keeper, true);
        if (owner != vm.addr(deployerKey)) {
            // Two-step: the multisig must call acceptOwnership() to finish.
            vault.transferOwnership(owner);
        }
        vm.stopBroadcast();

        console.log("ArchVaultBase deployed:", address(vault));
        console.log("  usdc:", usdc);
        console.log("  feeBps:", feeBps);
        console.log("  pending owner (must acceptOwnership):", owner);
    }
}
