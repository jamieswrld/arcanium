// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ArchFeeSplitter} from "../src/fees/ArchFeeSplitter.sol";

interface IModeDistributorAdmin {
    function setProtocolTreasury(address newTreasury) external;
    function protocolTreasury() external view returns (address);
}

/// @notice Deploys the fee splitter on a chain and points that chain's mode
///         distributor at it, so protocol fees land on the same recipient set
///         and weights as Arc and Base.
///
/// Required env: DEPLOYER_PRIVATE_KEY, FEE_RECIPIENTS, FEE_WEIGHTS
/// Optional env: MODE_DISTRIBUTOR_ADDRESS (repointed when set),
///               ARC_ADMIN_ADDRESS (final owner, default deployer)
contract DeploySplitter is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address[] memory recipients = vm.envAddress("FEE_RECIPIENTS", ",");
        uint256[] memory weights = vm.envUint("FEE_WEIGHTS", ",");
        address deployer = vm.addr(deployerKey);

        address admin = deployer;
        try vm.envAddress("ARC_ADMIN_ADDRESS") returns (address v) {
            if (v != address(0)) admin = v;
        } catch {}

        address distributor = address(0);
        try vm.envAddress("MODE_DISTRIBUTOR_ADDRESS") returns (address v) {
            distributor = v;
        } catch {}

        require(recipients.length == weights.length, "recipients/weights length mismatch");
        uint256 sum;
        for (uint256 i = 0; i < weights.length; i++) sum += weights[i];
        require(sum == 10_000, "weights must sum to 10000");

        console.log("chain id      ", block.chainid);
        console.log("recipients    ", recipients.length);
        for (uint256 i = 0; i < recipients.length; i++) {
            console.log("   ", recipients[i], weights[i]);
        }

        vm.startBroadcast(deployerKey);
        ArchFeeSplitter splitter = new ArchFeeSplitter(deployer, recipients, weights);
        if (distributor != address(0)) {
            IModeDistributorAdmin(distributor).setProtocolTreasury(address(splitter));
        }
        if (admin != deployer) splitter.transferOwnership(admin);
        vm.stopBroadcast();

        console.log("");
        console.log("ArchFeeSplitter", address(splitter));
        if (distributor != address(0)) {
            console.log("distributor.protocolTreasury now",
                IModeDistributorAdmin(distributor).protocolTreasury());
        }
    }
}
