// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {ArcaniumHook} from "../src/launchpad/v4/ArcaniumHook.sol";
import {ArcaniumLaunchpad} from "../src/launchpad/v4/ArcaniumLaunchpad.sol";

/**
 * Deploy the v4 launch path: the hook, then the launchpad, then bind them.
 *
 * The hook address is not free. v4 reads a hook's permissions out of the low
 * 14 bits of its own address, so the salt has to be mined until CREATE2 lands
 * on one carrying exactly the flags the contract claims — otherwise the
 * PoolManager rejects every pool that names it. Mining is done against the
 * canonical CREATE2 proxy, because that is who `new X{salt:}` deploys through
 * under `forge script --broadcast`, not the EOA running it.
 *
 * Order matters. The launchpad takes the hook in its constructor, and the hook
 * only accepts pool configuration from the address set by setFactory, so the
 * hook has to exist first and be told about the launchpad afterwards. Until
 * that last call lands the hook refuses every launch, which is the correct way
 * round: a half-deployed system that rejects work beats one that accepts it
 * into a contract nothing is bound to.
 *
 *   forge script script/DeployArcaniumV4.s.sol:DeployArcaniumV4 \
 *     --rpc-url $ARC_RPC_URL --broadcast
 */
contract DeployArcaniumV4 is Script {
    /// Arc's official Uniswap v4 PoolManager, live since 2026-09-16.
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// Arc's native USDC — a 6-decimal ERC-20 view of the 18-decimal gas token,
    /// which is why the launchpad is told its quote is native.
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        address owner = vm.envAddress("ARC_OWNER");
        address treasury = vm.envAddress("ARC_FEE_SPLITTER");
        // 40% to the creator, 60% to the protocol.
        uint256 creatorShareBps = vm.envOr("ARC_CREATOR_SHARE_BPS", uint256(4_000));
        uint256 launchFee = vm.envOr("ARC_LAUNCH_FEE", uint256(0));
        address launchFeeTreasury = vm.envOr("ARC_LAUNCH_FEE_TREASURY", treasury);

        // beforeInitialize | afterSwap | afterSwapReturnsDelta — the same set
        // ArcaniumHook.HOOK_FLAGS declares, which the deploy asserts below.
        uint160 flags = uint160(1 << 13) | uint160(1 << 6) | uint160(1 << 2);

        // The hook is owned by the deploying key at first, not by `owner`.
        // setFactory is owner-only and has to run in this same script — the
        // hook rejects every launch until it is bound — so the key doing the
        // binding must be the one that owns it at that moment. Ownership moves
        // to `owner` at the end, which under Ownable2Step is an offer `owner`
        // then accepts; until it does, the deploying key still owns the hook.
        address deployer = msg.sender;
        bytes memory args = abi.encode(IPoolManager(POOL_MANAGER), deployer, treasury, creatorShareBps);
        (address predicted, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(ArcaniumHook).creationCode, args);

        console2.log("hook will deploy to", predicted);

        vm.startBroadcast();

        ArcaniumHook hook =
            new ArcaniumHook{salt: salt}(IPoolManager(POOL_MANAGER), deployer, treasury, creatorShareBps);
        require(address(hook) == predicted, "hook mined to a different address");
        require(uint160(address(hook)) & 0x3FFF == hook.HOOK_FLAGS(), "hook address lacks its flags");

        ArcaniumLaunchpad pad = new ArcaniumLaunchpad(
            IPoolManager(POOL_MANAGER),
            hook,
            ARC_USDC,
            true, // the quote is a view of the native balance, so a creator buy needs no approval
            owner,
            launchFee,
            launchFeeTreasury
        );

        hook.setFactory(address(pad));

        // Hand the hook to its long-term owner. Ownable2Step means this is an
        // offer rather than a transfer, so ARC_OWNER must call
        // acceptOwnership() before it can rotate the treasury or the share.
        // Nothing about launching depends on that happening.
        if (owner != deployer) hook.transferOwnership(owner);

        vm.stopBroadcast();

        console2.log("ArcaniumHook     ", address(hook));
        console2.log("ArcaniumLaunchpad", address(pad));
        console2.log("factory bound    ", hook.factory() == address(pad));
        console2.log("hook owner now   ", hook.owner());
        console2.log("ownership offered to", owner);
    }
}
