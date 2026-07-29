// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ArchGasStation} from "../src/gas/ArchGasStation.sol";

/// Required env: DEPLOYER_PRIVATE_KEY, ARCH_USD_ADDRESS, ARC_ADMIN_ADDRESS,
/// GAS_RELAYER_ADDRESS, GAS_STATION_MARGIN_BPS, GAS_STATION_COOLDOWN_SECONDS,
/// GAS_STATION_FUND_NATIVE (wei of native USDC inventory to seed).
contract DeployGasStation is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address ausd = vm.envAddress("ARCH_USD_ADDRESS");
        address admin = vm.envAddress("ARC_ADMIN_ADDRESS");
        address relayer = vm.envAddress("GAS_RELAYER_ADDRESS");
        uint256 marginBps = vm.envUint("GAS_STATION_MARGIN_BPS");
        uint256 cooldown = vm.envUint("GAS_STATION_COOLDOWN_SECONDS");
        uint256 fund = vm.envUint("GAS_STATION_FUND_NATIVE");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        ArchGasStation station =
            new ArchGasStation(ausd, deployer, marginBps, cooldown);
        station.setRelayer(relayer, true);
        // Gas-unit budgets per action (swap, launch, redemption, approval) and
        // per-drip native caps.
        station.configureAction(0, 400_000, 1e18);
        station.configureAction(1, 6_000_000, 10e18);
        station.configureAction(2, 300_000, 1e18);
        station.configureAction(3, 120_000, 0.5e18);
        if (fund > 0) {
            (bool ok, ) = address(station).call{value: fund}("");
            require(ok, "funding failed");
        }
        if (admin != deployer) {
            station.transferOwnership(admin);
        }
        vm.stopBroadcast();

        console.log("ArchGasStation deployed:", address(station));
        console.log("  relayer:", relayer);
        console.log("  funded native:", fund);
    }
}
