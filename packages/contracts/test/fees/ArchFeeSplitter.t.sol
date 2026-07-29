// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArchFeeSplitter} from "../../src/fees/ArchFeeSplitter.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract ArchFeeSplitterTest is Test {
    ArchFeeSplitter internal splitter;
    MockUSDC internal token;
    address internal owner = makeAddr("owner");
    address[] internal wallets;

    function setUp() public {
        token = new MockUSDC();
        uint256[] memory weights = new uint256[](7);
        weights[0] = 4_000;
        for (uint256 i = 1; i < 7; i++) weights[i] = 1_000;
        for (uint256 i = 0; i < 7; i++) {
            wallets.push(makeAddr(string(abi.encodePacked("wallet", i))));
        }
        splitter = new ArchFeeSplitter(owner, wallets, weights);
    }

    function test_flushSplits40_10x6() public {
        token.mint(address(splitter), 1_000e6);
        splitter.flush(address(token));
        assertEq(token.balanceOf(wallets[0]), 400e6, "40% wallet");
        for (uint256 i = 1; i < 7; i++) {
            assertEq(token.balanceOf(wallets[i]), 100e6, "10% wallet");
        }
        assertEq(token.balanceOf(address(splitter)), 0, "nothing retained");
    }

    function testFuzz_flushConservesEveryUnit(uint128 amount) public {
        token.mint(address(splitter), amount);
        splitter.flush(address(token));
        uint256 sum;
        for (uint256 i = 0; i < 7; i++) sum += token.balanceOf(wallets[i]);
        assertEq(sum, amount, "conservation");
        assertEq(token.balanceOf(address(splitter)), 0);
        // Dust favors the 40% wallet, never lost.
        assertGe(token.balanceOf(wallets[0]), (uint256(amount) * 4_000) / 10_000);
    }

    function test_flushNative() public {
        vm.deal(address(splitter), 10e18);
        splitter.flushNative();
        assertEq(wallets[0].balance, 4e18);
        for (uint256 i = 1; i < 7; i++) assertEq(wallets[i].balance, 1e18);
    }

    function test_weightsMustSum() public {
        uint256[] memory badWeights = new uint256[](7);
        badWeights[0] = 4_000;
        for (uint256 i = 1; i < 7; i++) badWeights[i] = 999;
        vm.expectRevert(ArchFeeSplitter.WeightsMustSumTo10000.selector);
        new ArchFeeSplitter(owner, wallets, badWeights);
    }

    function test_onlyOwnerUpdatesRecipients() public {
        address[] memory newRecipients = new address[](1);
        newRecipients[0] = makeAddr("solo");
        uint256[] memory newWeights = new uint256[](1);
        newWeights[0] = 10_000;
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        splitter.setRecipients(newRecipients, newWeights);
        vm.prank(owner);
        splitter.setRecipients(newRecipients, newWeights);
        assertEq(splitter.recipientCount(), 1);
    }
}
