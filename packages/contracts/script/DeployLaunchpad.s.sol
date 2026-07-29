// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ArchLiquidityVault} from "../src/launchpad/ArchLiquidityVault.sol";
import {ArchLaunchpadFactory} from "../src/launchpad/ArchLaunchpadFactory.sol";
import {ArchFeeDistributor} from "../src/launchpad/ArchFeeDistributor.sol";
import {GraduationRegistry} from "../src/launchpad/GraduationRegistry.sol";

/// Required env: DEPLOYER_PRIVATE_KEY, UNISWAP_V3_POSITION_MANAGER_ADDRESS,
/// UNISWAP_V3_SWAP_ROUTER_ADDRESS, ARCH_USD_ADDRESS, ARC_ADMIN_ADDRESS,
/// LAUNCH_FEE_QUOTE_UNITS, LAUNCH_FEE_TREASURY_ADDRESS,
/// PAIR_FEE_CREATOR_SHARE_BPS, PROTOCOL_TREASURY_ADDRESS,
/// GRADUATION_QUOTE_UNITS.
contract DeployLaunchpad is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address npm = vm.envAddress("UNISWAP_V3_POSITION_MANAGER_ADDRESS");
        address router = vm.envAddress("UNISWAP_V3_SWAP_ROUTER_ADDRESS");
        address ausd = vm.envAddress("ARCH_USD_ADDRESS");
        address admin = vm.envAddress("ARC_ADMIN_ADDRESS");
        uint256 launchFee = vm.envUint("LAUNCH_FEE_QUOTE_UNITS");
        address launchFeeTreasury = vm.envAddress("LAUNCH_FEE_TREASURY_ADDRESS");
        uint256 creatorShareBps = vm.envUint("PAIR_FEE_CREATOR_SHARE_BPS");
        address protocolTreasury = vm.envAddress("PROTOCOL_TREASURY_ADDRESS");
        uint256 graduationUnits = vm.envUint("GRADUATION_QUOTE_UNITS");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        ArchLiquidityVault vault = new ArchLiquidityVault(npm, deployer);
        ArchLaunchpadFactory factory = new ArchLaunchpadFactory(
            npm, router, address(vault), deployer, ausd, launchFee, launchFeeTreasury
        );
        ArchFeeDistributor distributor = new ArchFeeDistributor(
            address(factory), address(vault), deployer, creatorShareBps, protocolTreasury
        );
        GraduationRegistry registry =
            new GraduationRegistry(address(factory), graduationUnits);
        vault.setFeeDistributor(address(distributor));
        if (admin != deployer) {
            vault.transferOwnership(admin);
            factory.transferOwnership(admin);
            distributor.transferOwnership(admin);
        }
        vm.stopBroadcast();

        console.log("ArchLiquidityVault:", address(vault));
        console.log("ArchLaunchpadFactory:", address(factory));
        console.log("ArchFeeDistributor:", address(distributor));
        console.log("GraduationRegistry:", address(registry));
    }
}
