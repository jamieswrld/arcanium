// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ArchUSD} from "../src/bridge/ArchUSD.sol";
import {ArchBridgeArc} from "../src/bridge/ArchBridgeArc.sol";

/// @notice Deploys aUSD and the Arc-side bridge on the target Arc network,
///         grants the bridge (and only the bridge) aUSD's BRIDGE_ROLE, and
///         enables the Arc keeper.
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY     deployer key (testnet-only until launch gate)
///   ARC_ADMIN_ADDRESS        protocol multisig (or deployer on testnet)
///   ARC_KEEPER_ADDRESS       Arc keeper hot wallet
///   BRIDGE_MIN_REDEEM_UNITS  e.g. 1000000 (1 aUSD)
///   BRIDGE_MAX_MINT_PER_TX_UNITS
///   BRIDGE_MAX_MINT_PER_WINDOW_UNITS
///   BRIDGE_MINT_WINDOW_SECONDS
contract DeployBridgeArc is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ARC_ADMIN_ADDRESS");
        address keeper = vm.envAddress("ARC_KEEPER_ADDRESS");
        uint256 minRedeem = vm.envUint("BRIDGE_MIN_REDEEM_UNITS");
        uint256 maxMintTx = vm.envUint("BRIDGE_MAX_MINT_PER_TX_UNITS");
        uint256 maxMintWindow = vm.envUint("BRIDGE_MAX_MINT_PER_WINDOW_UNITS");
        uint256 windowSeconds = vm.envUint("BRIDGE_MINT_WINDOW_SECONDS");

        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        ArchUSD ausd = new ArchUSD(deployer);
        ArchBridgeArc bridge = new ArchBridgeArc(
            address(ausd), deployer, minRedeem, maxMintTx, maxMintWindow, windowSeconds
        );

        ausd.grantRole(ausd.BRIDGE_ROLE(), address(bridge));
        bridge.setKeeper(keeper, true);

        if (admin != deployer) {
            // Hand aUSD role administration to the multisig, then renounce.
            ausd.grantRole(ausd.DEFAULT_ADMIN_ROLE(), admin);
            ausd.grantRole(ausd.PAUSER_ROLE(), admin);
            ausd.renounceRole(ausd.PAUSER_ROLE(), deployer);
            ausd.renounceRole(ausd.DEFAULT_ADMIN_ROLE(), deployer);
            // Two-step: the multisig must call acceptOwnership() on the bridge.
            bridge.transferOwnership(admin);
        }
        vm.stopBroadcast();

        console.log("ArchUSD deployed:", address(ausd));
        console.log("ArchBridgeArc deployed:", address(bridge));
        console.log("  admin:", admin);
        console.log("  keeper:", keeper);
    }
}
