// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ArchLiquidityVault} from "../src/launchpad/ArchLiquidityVault.sol";
import {ArchLaunchpadFactoryV5} from "../src/launchpad/ArchLaunchpadFactoryV5.sol";
import {ArchModeDistributor} from "../src/launchpad/ArchModeDistributor.sol";
import {GraduationRegistry} from "../src/launchpad/GraduationRegistry.sol";

/// @notice Deploys the full Arcanium launch stack on any supported chain.
///         Factory v5 derives its launch price from the quote token's decimals,
///         so the same script produces an identical $3,000-cap launchpad against
///         6-decimal quotes (Arc USDC, Robinhood USDG) and 18-decimal ones
///         (BNB USDT).
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY
///   UNISWAP_V3_POSITION_MANAGER_ADDRESS
///   UNISWAP_V3_SWAP_ROUTER_ADDRESS
///   QUOTE_TOKEN_ADDRESS              quote/pair asset (must be 6 or 18 dp)
///   PROTOCOL_TREASURY_ADDRESS
/// Optional env:
///   ARC_ADMIN_ADDRESS                final owner (default: deployer)
///   LAUNCH_FEE_QUOTE_UNITS           default 0 — launching is free
///   LAUNCH_FEE_TREASURY_ADDRESS      default PROTOCOL_TREASURY_ADDRESS
///   PAIR_FEE_CREATOR_SHARE_BPS       default 1000 (10% creator / 90% protocol)
///   GRADUATION_QUOTE_UNITS           default 9,000 scaled to quote decimals
contract DeployChain is Script {
    function _envAddrOr(string memory key, address fallbackValue) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            return v == address(0) ? fallbackValue : v;
        } catch {
            return fallbackValue;
        }
    }

    function _envUintOr(string memory key, uint256 fallbackValue) internal view returns (uint256) {
        try vm.envUint(key) returns (uint256 v) {
            return v;
        } catch {
            return fallbackValue;
        }
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address npm = vm.envAddress("UNISWAP_V3_POSITION_MANAGER_ADDRESS");
        address router = vm.envAddress("UNISWAP_V3_SWAP_ROUTER_ADDRESS");
        address quote = vm.envAddress("QUOTE_TOKEN_ADDRESS");
        address protocolTreasury = vm.envAddress("PROTOCOL_TREASURY_ADDRESS");
        address deployer = vm.addr(deployerKey);

        address admin = _envAddrOr("ARC_ADMIN_ADDRESS", deployer);
        uint256 launchFee = _envUintOr("LAUNCH_FEE_QUOTE_UNITS", 0);
        address launchFeeTreasury = _envAddrOr("LAUNCH_FEE_TREASURY_ADDRESS", protocolTreasury);
        uint256 creatorShareBps = _envUintOr("PAIR_FEE_CREATOR_SHARE_BPS", 1_000);

        uint8 quoteDecimals = IDecimals(quote).decimals();
        require(quoteDecimals == 6 || quoteDecimals == 18, "quote must be 6 or 18 decimals");
        uint256 graduationUnits =
            _envUintOr("GRADUATION_QUOTE_UNITS", 9_000 * (10 ** quoteDecimals));

        console.log("chain id           ", block.chainid);
        console.log("deployer           ", deployer);
        console.log("quote token        ", quote);
        console.log("quote decimals     ", quoteDecimals);
        console.log("graduation units   ", graduationUnits);
        console.log("creator share bps  ", creatorShareBps);

        vm.startBroadcast(deployerKey);

        ArchLiquidityVault vault = new ArchLiquidityVault(npm, deployer);
        ArchLaunchpadFactoryV5 factory = new ArchLaunchpadFactoryV5(
            npm, router, address(vault), deployer, quote, launchFee, launchFeeTreasury
        );
        ArchModeDistributor distributor = new ArchModeDistributor(
            address(factory),
            address(vault),
            deployer,
            creatorShareBps,
            protocolTreasury,
            address(0), // no legacy factory on a fresh chain
            router
        );
        GraduationRegistry registry = new GraduationRegistry(address(factory), graduationUnits);

        vault.setFeeDistributor(address(distributor));
        factory.setModeDistributor(address(distributor));

        if (admin != deployer) {
            vault.transferOwnership(admin);
            factory.transferOwnership(admin);
            distributor.transferOwnership(admin);
        }

        vm.stopBroadcast();

        console.log("");
        console.log("=== deployed ===");
        console.log("ArchLiquidityVault      ", address(vault));
        console.log("ArchLaunchpadFactoryV5  ", address(factory));
        console.log("ArchModeDistributor     ", address(distributor));
        console.log("GraduationRegistry      ", address(registry));
        console.log("");
        console.log("Set these in apps/web/.env:");
        console.log("  <CHAIN>_FACTORY_ADDRESS           ", address(factory));
        console.log("  <CHAIN>_LIQUIDITY_VAULT_ADDRESS   ", address(vault));
        console.log("  <CHAIN>_MODE_DISTRIBUTOR_ADDRESS  ", address(distributor));
    }
}

interface IDecimals {
    function decimals() external view returns (uint8);
}
