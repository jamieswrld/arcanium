// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArchUSD} from "../../src/bridge/ArchUSD.sol";
import {ArchVaultBase} from "../../src/bridge/ArchVaultBase.sol";
import {ArchBridgeArc} from "../../src/bridge/ArchBridgeArc.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Simulates the full cross-chain loop in one environment: a deposit on
///      the vault is followed (by an honest keeper) with the corresponding
///      mint on the bridge, and a burn is followed with the corresponding
///      release. The handler also exercises replay attempts, pauses, and
///      out-of-order processing so the invariants hold under adversarial
///      scheduling, not just the happy path.
contract BridgeHandler is Test {
    MockUSDC public usdc;
    ArchVaultBase public vault;
    ArchUSD public ausd;
    ArchBridgeArc public bridge;

    address public keeper;
    address public owner;

    // Ghost accounting mirrored from emitted values.
    uint256 public totalNetDeposited;
    uint256 public totalMinted;
    uint256 public totalBurned;
    uint256 public totalReleased;

    struct PendingDeposit {
        bytes32 txHash;
        uint256 logIndex;
        address recipient;
        uint256 netAmount;
    }

    struct PendingBurn {
        bytes32 txHash;
        uint256 logIndex;
        address recipient;
        uint256 amount;
    }

    PendingDeposit[] public pendingDeposits;
    PendingBurn[] public pendingBurns;

    address[] internal actors;
    uint256 internal depositSeq;
    uint256 internal burnSeq;

    constructor(
        MockUSDC usdc_,
        ArchVaultBase vault_,
        ArchUSD ausd_,
        ArchBridgeArc bridge_,
        address keeper_,
        address owner_
    ) {
        usdc = usdc_;
        vault = vault_;
        ausd = ausd_;
        bridge = bridge_;
        keeper = keeper_;
        owner = owner_;
        for (uint256 i = 0; i < 4; i++) {
            address actor = makeAddr(string(abi.encodePacked("actor", i)));
            actors.push(actor);
            usdc.mint(actor, 10_000_000e6);
            vm.prank(actor);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// Deposit on Base; queue the resulting mint obligation.
    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, vault.minDeposit(), vault.maxDeposit());
        if (usdc.balanceOf(actor) < amount) return;
        if (vault.depositsPaused()) return;

        uint256 fee = (amount * vault.feeBps()) / 10_000;
        uint256 net = amount - fee;

        vm.prank(actor);
        vault.deposit(amount, actor);

        totalNetDeposited += net;
        pendingDeposits.push(
            PendingDeposit({
                txHash: keccak256(abi.encode("base-tx", depositSeq++)),
                logIndex: depositSeq,
                recipient: actor,
                netAmount: net
            })
        );
    }

    /// Keeper processes a random pending deposit (possibly out of order).
    function processMint(uint256 seed) external {
        if (pendingDeposits.length == 0) return;
        if (bridge.mintsPaused()) return;
        uint256 idx = seed % pendingDeposits.length;
        PendingDeposit memory p = pendingDeposits[idx];
        if (p.netAmount > bridge.maxMintPerTx()) return;

        vm.prank(keeper);
        try bridge.mintDeposit(p.txHash, p.logIndex, p.recipient, p.netAmount) {
            totalMinted += p.netAmount;
            pendingDeposits[idx] = pendingDeposits[pendingDeposits.length - 1];
            pendingDeposits.pop();
        } catch {
            // window cap hit — leave queued
        }
    }

    /// A malicious/buggy keeper retries an already-minted deposit. Must revert.
    function replayMint(uint256 seed) external {
        if (totalMinted == 0) return;
        bytes32 txHash = keccak256(abi.encode("base-tx", seed % depositSeq));
        // Find whether this id was processed; if so a replay must revert.
        for (uint256 li = 0; li <= depositSeq; li++) {
            bytes32 id = keccak256(abi.encode(txHash, li));
            if (bridge.processedDeposits(id)) {
                vm.prank(keeper);
                vm.expectRevert();
                bridge.mintDeposit(txHash, li, _actor(seed), 1e6);
                return;
            }
        }
    }

    /// Burn aUSD on Arc; queue the release obligation.
    function redeem(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 balance = ausd.balanceOf(actor);
        if (balance < bridge.minRedeem()) return;
        if (bridge.redeemsPaused()) return;
        amount = bound(amount, bridge.minRedeem(), balance);

        vm.prank(actor);
        bridge.redeem(amount, actor);

        totalBurned += amount;
        pendingBurns.push(
            PendingBurn({
                txHash: keccak256(abi.encode("arc-tx", burnSeq++)),
                logIndex: burnSeq,
                recipient: actor,
                amount: amount
            })
        );
    }

    /// Keeper releases a random pending burn.
    function processRelease(uint256 seed) external {
        if (pendingBurns.length == 0) return;
        if (vault.releasesPaused()) return;
        uint256 idx = seed % pendingBurns.length;
        PendingBurn memory p = pendingBurns[idx];
        if (p.amount > vault.maxReleasePerTx()) return;

        vm.prank(keeper);
        try vault.release(p.txHash, p.logIndex, p.recipient, p.amount) {
            totalReleased += p.amount;
            pendingBurns[idx] = pendingBurns[pendingBurns.length - 1];
            pendingBurns.pop();
        } catch {
            // window cap hit — leave queued
        }
    }

    /// A malicious/buggy keeper retries an already-released burn. Must revert.
    function replayRelease(uint256 seed) external {
        if (totalReleased == 0) return;
        bytes32 txHash = keccak256(abi.encode("arc-tx", seed % burnSeq));
        for (uint256 li = 0; li <= burnSeq; li++) {
            bytes32 id = keccak256(abi.encode(txHash, li));
            if (vault.processedRedemptions(id)) {
                vm.prank(keeper);
                vm.expectRevert();
                vault.release(txHash, li, _actor(seed), 1e6);
                return;
            }
        }
    }

    /// Owner toggles pauses; paused paths simply stop, never corrupt.
    function togglePauses(uint256 seed) external {
        vm.startPrank(owner);
        vault.setDepositsPaused(seed % 7 == 0);
        vault.setReleasesPaused(seed % 5 == 0);
        vm.stopPrank();
    }

    /// Time moves so rate windows roll over.
    function warp(uint256 seed) external {
        vm.warp(block.timestamp + (seed % 7200));
    }
}

contract BridgeInvariantTest is Test {
    MockUSDC internal usdc;
    ArchVaultBase internal vault;
    ArchUSD internal ausd;
    ArchBridgeArc internal bridge;
    BridgeHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        usdc = new MockUSDC();
        vault = new ArchVaultBase(
            address(usdc),
            owner,
            treasury,
            1500,
            25e6,
            100_000e6,
            100_000e6,
            500_000e6,
            3600
        );
        ausd = new ArchUSD(owner);
        bridge = new ArchBridgeArc(address(ausd), owner, 1e6, 100_000e6, 500_000e6, 3600);

        vm.startPrank(owner);
        ausd.grantRole(ausd.BRIDGE_ROLE(), address(bridge));
        vault.setKeeper(keeper, true);
        bridge.setKeeper(keeper, true);
        vm.stopPrank();

        handler = new BridgeHandler(usdc, vault, ausd, bridge, keeper, owner);
        targetContract(address(handler));
    }

    /// The crown jewel: the Base reserve always covers every aUSD in
    /// existence, no matter how deposits, mints, burns, releases, replays,
    /// pauses, and clock skew interleave.
    function invariant_reserveCoversSupply() public view {
        assertGe(vault.totalReserve(), ausd.totalSupply());
    }

    /// Reserve accounting never diverges from actual token holdings.
    function invariant_reserveMatchesBalance() public view {
        assertEq(usdc.balanceOf(address(vault)), vault.totalReserve());
    }

    /// Mints never exceed confirmed net deposits.
    function invariant_mintsBoundedByDeposits() public view {
        assertLe(handler.totalMinted(), handler.totalNetDeposited());
        assertLe(ausd.totalSupply(), handler.totalMinted());
    }

    /// Releases never exceed confirmed burns.
    function invariant_releasesBoundedByBurns() public view {
        assertLe(handler.totalReleased(), handler.totalBurned());
    }

    /// Supply equals mints minus burns exactly (no other supply paths exist).
    function invariant_supplyIsMintsMinusBurns() public view {
        assertEq(ausd.totalSupply(), handler.totalMinted() - handler.totalBurned());
    }
}
