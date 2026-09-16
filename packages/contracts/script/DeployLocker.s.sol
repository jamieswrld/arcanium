// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ArcTokenLocker} from "../src/locker/ArcTokenLocker.sol";

/// @notice Deploys the Arc token locker.
///
/// The locker takes no constructor arguments and has no owner, so there is
/// nothing to configure and nothing to get wrong. It is additive: no existing
/// contract knows or cares that it exists.
///
/// Required env: DEPLOYER_PRIVATE_KEY
///
///   forge script script/DeployLocker.s.sol:DeployLocker \
///     --rpc-url https://rpc.quicknode.mainnet.arc.io --broadcast
contract DeployLocker is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        ArcTokenLocker locker = new ArcTokenLocker();
        vm.stopBroadcast();

        console.log("ArcTokenLocker:", address(locker));
        console.log("chainId:", block.chainid);
    }
}
