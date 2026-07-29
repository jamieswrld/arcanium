// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArchUSD} from "../../src/bridge/ArchUSD.sol";
import {ArchGasStation} from "../../src/gas/ArchGasStation.sol";

contract ArchGasStationTest is Test {
    ArchUSD internal ausd;
    ArchGasStation internal station;

    address internal admin = makeAddr("admin");
    address internal relayer = makeAddr("relayer");
    address internal bridge = makeAddr("bridge");
    address internal user;
    uint256 internal userPk;

    uint256 internal constant MARGIN_BPS = 500; // 5%
    uint256 internal constant COOLDOWN = 60;

    function setUp() public {
        (user, userPk) = makeAddrAndKey("user");
        ausd = new ArchUSD(admin);
        station = new ArchGasStation(address(ausd), admin, MARGIN_BPS, COOLDOWN);

        bytes32 bridgeRole = ausd.BRIDGE_ROLE();
        vm.startPrank(admin);
        ausd.grantRole(bridgeRole, bridge);
        station.setRelayer(relayer, true);
        // swap: 300k gas units, cap 0.5 native USDC; launch: 3M units, cap 5.
        station.configureAction(0, 300_000, 0.5e18);
        station.configureAction(1, 3_000_000, 5e18);
        station.configureAction(2, 300_000, 0.5e18);
        station.configureAction(3, 100_000, 0.2e18);
        vm.stopPrank();

        vm.prank(bridge);
        ausd.bridgeMint(user, 100e6);
        vm.deal(address(station), 10e18); // native inventory
    }

    function _signPermit(uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                user,
                address(station),
                value,
                ausd.nonces(user),
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(userPk, digest);
    }

    function test_quoteIncludesMarginRoundedUp() public view {
        // 300k units at 1 gwei → 3e14 native wei → par 0.3 aUSD units? No:
        // 3e14 / 1e12 = 300 aUSD units; +5% = 315.
        (uint256 nativeOut, uint256 ausdIn) = station.quote(0, 1 gwei);
        assertEq(nativeOut, 300_000 * 1 gwei);
        assertEq(ausdIn, 315);
    }

    function test_quoteCapsAtActionMax() public view {
        (uint256 nativeOut, ) = station.quote(0, 1e13); // would be 3e18
        assertEq(nativeOut, 0.5e18);
    }

    function test_dripHappyPath() public {
        (uint256 nativeOut, uint256 ausdIn) = station.quote(0, 1 gwei);
        uint256 deadline = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(ausdIn, deadline);

        uint256 userNativeBefore = user.balance;
        vm.prank(relayer);
        vm.expectEmit(true, true, false, true);
        emit ArchGasStation.Dripped(user, 0, nativeOut, ausdIn);
        station.drip(user, 0, nativeOut, ausdIn, deadline, v, r, s);

        assertEq(user.balance - userNativeBefore, nativeOut);
        assertEq(ausd.balanceOf(address(station)), ausdIn);
        assertEq(ausd.balanceOf(user), 100e6 - ausdIn);
    }

    function test_dripOnlyRelayer() public {
        vm.prank(user);
        vm.expectRevert(ArchGasStation.NotRelayer.selector);
        station.drip(user, 0, 1, 1, block.timestamp, 27, bytes32(0), bytes32(0));
    }

    function test_dripRejectsUnderpriced() public {
        (uint256 nativeOut, uint256 ausdIn) = station.quote(0, 1 gwei);
        uint256 deadline = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(ausdIn - 1, deadline);
        vm.prank(relayer);
        vm.expectRevert(ArchGasStation.UnderpricedDrip.selector);
        station.drip(user, 0, nativeOut, ausdIn - 1, deadline, v, r, s);
    }

    function test_dripRejectsOverCap() public {
        uint256 deadline = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(1e6, deadline);
        vm.prank(relayer);
        vm.expectRevert(ArchGasStation.ExceedsActionCap.selector);
        station.drip(user, 0, 0.6e18, 1e6, deadline, v, r, s);
    }

    function test_dripCooldown() public {
        (uint256 nativeOut, uint256 ausdIn) = station.quote(0, 1 gwei);
        uint256 deadline = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(ausdIn, deadline);
        vm.prank(relayer);
        station.drip(user, 0, nativeOut, ausdIn, deadline, v, r, s);

        (v, r, s) = _signPermit(ausdIn, deadline);
        vm.prank(relayer);
        vm.expectRevert(ArchGasStation.CooldownActive.selector);
        station.drip(user, 0, nativeOut, ausdIn, deadline, v, r, s);

        // Different action id is independently rate limited.
        (uint256 n3, uint256 a3) = station.quote(3, 1 gwei);
        (v, r, s) = _signPermit(a3, deadline);
        vm.prank(relayer);
        station.drip(user, 3, n3, a3, deadline, v, r, s);

        vm.warp(block.timestamp + COOLDOWN);
        (v, r, s) = _signPermit(ausdIn, deadline + COOLDOWN);
        vm.prank(relayer);
        station.drip(user, 0, nativeOut, ausdIn, deadline + COOLDOWN, v, r, s);
    }

    function test_dripExpiredPermitReverts() public {
        (uint256 nativeOut, uint256 ausdIn) = station.quote(0, 1 gwei);
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(ausdIn, deadline);
        vm.prank(relayer);
        // permit reverts silently (caught), then transferFrom fails on allowance.
        vm.expectRevert();
        station.drip(user, 0, nativeOut, ausdIn, deadline, v, r, s);
    }

    function test_dripPause() public {
        vm.prank(admin);
        station.setPaused(true);
        vm.prank(relayer);
        vm.expectRevert(ArchGasStation.StationPaused.selector);
        station.drip(user, 0, 1, 1, block.timestamp, 27, bytes32(0), bytes32(0));
    }

    function test_dripInsufficientInventory() public {
        vm.deal(address(station), 0);
        (uint256 nativeOut, uint256 ausdIn) = station.quote(0, 1 gwei);
        uint256 deadline = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(ausdIn, deadline);
        vm.prank(relayer);
        vm.expectRevert(ArchGasStation.InsufficientInventory.selector);
        station.drip(user, 0, nativeOut, ausdIn, deadline, v, r, s);
    }

    function test_marginCap() public {
        vm.prank(admin);
        vm.expectRevert(ArchGasStation.MarginAboveCap.selector);
        station.setMargin(2_001);
    }

    function test_withdrawals() public {
        vm.deal(address(station), 3e18);
        address payable to = payable(makeAddr("treasury"));
        vm.prank(admin);
        station.withdrawInventory(to, 1e18);
        assertEq(to.balance, 1e18);
    }

    function testFuzz_stationNeverSellsBelowPar(uint256 gasPrice) public view {
        gasPrice = bound(gasPrice, 1, 1e15);
        (uint256 nativeOut, uint256 ausdIn) = station.quote(1, gasPrice);
        // aUSD taken (scaled to 18d) must always cover native sent.
        assertGe(ausdIn * 1e12, nativeOut);
    }
}
