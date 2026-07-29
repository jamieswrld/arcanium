// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ArchUSD} from "../../src/bridge/ArchUSD.sol";

contract ArchUSDTest is Test {
    ArchUSD internal ausd;

    address internal admin = makeAddr("admin");
    address internal bridge = makeAddr("bridge");
    address internal alice;
    uint256 internal alicePk;

    function setUp() public {
        (alice, alicePk) = makeAddrAndKey("alice");
        ausd = new ArchUSD(admin);
        bytes32 bridgeRole = ausd.BRIDGE_ROLE();
        vm.prank(admin);
        ausd.grantRole(bridgeRole, bridge);
    }

    function test_metadata() public view {
        assertEq(ausd.name(), "Arch USD");
        assertEq(ausd.symbol(), "aUSD");
        assertEq(ausd.decimals(), 6);
        assertEq(ausd.totalSupply(), 0);
    }

    function test_bridgeMintAndBurn() public {
        vm.prank(bridge);
        vm.expectEmit(true, false, false, true);
        emit ArchUSD.BridgeMint(alice, 100e6);
        ausd.bridgeMint(alice, 100e6);
        assertEq(ausd.balanceOf(alice), 100e6);
        assertEq(ausd.totalSupply(), 100e6);

        vm.prank(bridge);
        vm.expectEmit(true, false, false, true);
        emit ArchUSD.BridgeBurn(alice, 40e6);
        ausd.bridgeBurn(alice, 40e6);
        assertEq(ausd.balanceOf(alice), 60e6);
        assertEq(ausd.totalSupply(), 60e6);
    }

    function test_adminCannotMint() public {
        bytes32 bridgeRole = ausd.BRIDGE_ROLE();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, bridgeRole
            )
        );
        ausd.bridgeMint(admin, 1e6);
    }

    function test_strangerCannotMintOrBurn() public {
        address attacker = makeAddr("attacker");
        vm.startPrank(attacker);
        vm.expectRevert();
        ausd.bridgeMint(attacker, 1e6);
        vm.expectRevert();
        ausd.bridgeBurn(alice, 1e6);
        vm.stopPrank();
    }

    function test_pauseBlocksAllMovement() public {
        vm.prank(bridge);
        ausd.bridgeMint(alice, 100e6);

        vm.prank(admin);
        ausd.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ausd.transfer(admin, 1e6);

        vm.prank(bridge);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ausd.bridgeMint(alice, 1e6);

        vm.prank(bridge);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ausd.bridgeBurn(alice, 1e6);

        vm.prank(admin);
        ausd.unpause();
        vm.prank(alice);
        ausd.transfer(admin, 1e6);
        assertEq(ausd.balanceOf(admin), 1e6);
    }

    function test_permit() public {
        vm.prank(bridge);
        ausd.bridgeMint(alice, 50e6);

        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                alice,
                spender,
                50e6,
                ausd.nonces(alice),
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        ausd.permit(alice, spender, 50e6, deadline, v, r, s);
        assertEq(ausd.allowance(alice, spender), 50e6);

        vm.prank(spender);
        ausd.transferFrom(alice, spender, 50e6);
        assertEq(ausd.balanceOf(spender), 50e6);
    }

    function test_expiredPermitReverts() public {
        uint256 deadline = block.timestamp - 1;
        vm.expectRevert();
        ausd.permit(alice, makeAddr("spender"), 1e6, deadline, 27, bytes32(0), bytes32(0));
    }

    function testFuzz_supplyTracksMintsAndBurns(uint128 mintAmount, uint128 burnAmount) public {
        burnAmount = uint128(bound(burnAmount, 0, mintAmount));
        vm.startPrank(bridge);
        ausd.bridgeMint(alice, mintAmount);
        ausd.bridgeBurn(alice, burnAmount);
        vm.stopPrank();
        assertEq(ausd.totalSupply(), uint256(mintAmount) - burnAmount);
    }
}
