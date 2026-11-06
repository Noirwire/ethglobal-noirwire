// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {ShareVault} from "src/ShareVault.sol";

contract ShareVaultRequestDepositTest is Base {
    function test_RevertWhen_AssetsIsZero() external {
        vm.prank(alice);
        vm.expectRevert(ShareVault.ShareVault__ZeroAmount.selector);
        vault.requestDeposit(0, alice);
    }

    function testFuzz_RevertWhen_ReceiverIsTheZeroAddress(uint256 assets) external {
        assets = bound(assets, 1, MAX_DEPOSIT);
        vm.prank(alice);
        vm.expectRevert(ShareVault.ShareVault__ZeroAddress.selector);
        vault.requestDeposit(assets, address(0));
    }

    function testFuzz_RevertGiven_RequestsArePaused(uint256 assets) external {
        assets = bound(assets, 1, MAX_DEPOSIT);
        _depositAndClaim(alice, 1000e6);
        _closeAt(1);
        assertTrue(vault.requestsPaused());

        vm.prank(alice);
        vm.expectRevert(ShareVault.ShareVault__RequestsPaused.selector);
        vault.requestDeposit(assets, alice);
    }

    function testFuzz_RevertGiven_TheVaultIsStalled(uint256 assets, uint256 lateness) external {
        assets = bound(assets, 1, MAX_DEPOSIT);
        lateness = bound(lateness, 1, 365 days);
        vm.warp(block.timestamp + vault.maxEpochGap() + lateness);

        vm.prank(alice);
        vm.expectRevert(ShareVault.ShareVault__StaleHalt.selector);
        vault.requestDeposit(assets, alice);
    }

    function testFuzz_GivenOlderSettledDeposit_TurnsIntoClaimableShares(uint256 first, uint256 second) external {
        first = bound(first, 1, MAX_DEPOSIT);
        second = bound(second, 1, MAX_DEPOSIT);
        _deposit(alice, first);
        _close(0, 0);

        _deposit(alice, second);
        assertEq(vault.claimableShares(alice), first * 1e12);
        (uint64 epoch, uint192 pending) = vault.depositRequests(alice);
        assertEq(epoch, 2);
        assertEq(pending, second);
    }

    function testFuzz_GivenNoOlderDeposit_RecordsPendingAssetsInCurrentEpoch(uint256 assets, address receiver)
        external
    {
        assets = bound(assets, 1, MAX_DEPOSIT);
        vm.assume(receiver != address(0));
        uint256 before = usdc.balanceOf(alice);

        vm.prank(alice);
        vault.requestDeposit(assets, receiver);

        (uint64 epoch, uint192 pending) = vault.depositRequests(receiver);
        assertEq(epoch, 1);
        assertEq(pending, assets);
        assertEq(vault.epochDepositAssets(1), assets);
        assertEq(vault.ledgerAssets(), assets);
        assertEq(before - usdc.balanceOf(alice), assets);
    }

    function testFuzz_GivenNoOlderDeposit_DirectTransferIsNotADeposit(uint256 donated) external {
        donated = bound(donated, 1, MAX_DEPOSIT);
        vm.prank(bob);
        usdc.transfer(address(vault), donated);

        assertEq(vault.totalPendingDeposits(), 0);
        assertEq(vault.navCash(), 0);
        assertEq(vault.surplusAssets(), donated);
        assertEq(vault.totalSupply(), 0);
    }
}
