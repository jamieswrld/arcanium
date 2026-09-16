// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {XCreatorVaultFactory} from "../src/xcreator/XCreatorVaultFactory.sol";

/// @notice Deploys the X creator vault factory, which deploys its own vault
///         implementation in the constructor.
///
/// Additive: individual vaults are minimal proxies at CREATE2 addresses, so
/// nothing existing changes and no launch has to be migrated. A launch simply
/// names a vault address as its creator-fee recipient, and that address can be
/// used before the vault is deployed.
///
/// X_ATTESTATION_SIGNER is the address whose EIP-712 signatures vaults accept.
/// Its private key belongs in the web backend's server-only environment and
/// must never reach the client. It can be rotated later with
/// setAttestationSigner without redeploying anything or moving funds.
///
/// Required env: DEPLOYER_PRIVATE_KEY, X_ATTESTATION_SIGNER
/// Optional env: ARC_ADMIN_ADDRESS (factory owner, default deployer)
///
///   forge script script/DeployXCreator.s.sol:DeployXCreator \
///     --rpc-url https://rpc.quicknode.mainnet.arc.io --broadcast
contract DeployXCreator is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address signer = vm.envAddress("X_ATTESTATION_SIGNER");
        address deployer = vm.addr(deployerKey);

        address admin = deployer;
        try vm.envAddress("ARC_ADMIN_ADDRESS") returns (address v) {
            if (v != address(0)) admin = v;
        } catch {}

        require(signer != address(0), "X_ATTESTATION_SIGNER is required");
        // The signer attests identity; it must not also be the key that can
        // rotate itself, or a single compromise is total.
        require(signer != admin, "signer must not be the factory owner");

        vm.startBroadcast(deployerKey);
        XCreatorVaultFactory factory = new XCreatorVaultFactory(admin, signer);
        vm.stopBroadcast();

        console.log("XCreatorVaultFactory:", address(factory));
        console.log("vault implementation:", factory.implementation());
        console.log("attestation signer:  ", signer);
        console.log("owner:               ", admin);
        console.log("chainId:", block.chainid);
    }
}
