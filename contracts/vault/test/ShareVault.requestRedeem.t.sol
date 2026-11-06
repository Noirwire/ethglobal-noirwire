// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {ShareVault} from "src/ShareVault.sol";

contract ShareVaultRequestRedeemTest is Base {
    function test_RevertWhen_SharesIsZero() external {
        vm.prank(alice);
        vm.expectRevert(ShareVault.ShareVault__ZeroAmount.selector);
        vault.requestRedeem(0, alice);
    }

    function test_RevertWhen_ReceiverIsTheZeroAddress() external {
        vm.prank(alice);
        vm.expectRevert(ShareVault.ShareVault__ZeroAddress.selector);
        vault.requestRedeem(1, address(0));
    }

    function testFuzz_RevertGiven_RequestsArePaused(uint256 shares) external {
        vault.setLockupPeriod(0);
        _depositAndClaim(alice, 1000e6);
        _closeAt(1);
        shares = bound(shares, 1, vault.balanceOf(alice));

        vm.prank(alice);
        vm.expectRevert(ShareVault.ShareVault__RequestsPaused.selector);
        vault.requestRedeem(shares, alice);
    }

    function testFuzz_RevertGiven_TheCallerIsInsideTheLockup(uint256 deposit, uint256 elapsed) external {
        deposit = bound(deposit, 1e6, MAX_DEPOSIT);
        _depositAndClaim(alice, deposit);
        uint256 unlocksAt = vault.lockedUntil(alice);
        elapsed = bound(elapsed, 0, vault.lockupPeriod() - 1);
        vm.warp(block.timestamp + elapsed);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.ShareVault__LockupActive.selector, unlocksAt));
        vault.requestRedeem(1, alice);
    }

    function testFuzz_RevertGiven_SharesWereTransferredWhileLocked(uint256 deposit, uint256 sent) external {
        deposit = bound(deposit, 1e6, MAX_DEPOSIT);
        _depositAndClaim(alice, deposit);
        sent = bound(sent, 1, vault.balanceOf(alice));
        vm.prank(alice);
        vault.transfer(bob, sent);

        bytes memory expected =
            abi.encodeWithSelector(ShareVault.ShareVault__LockupActive.selector, vault.lockedUntil(alice));
        vm.prank(bob);
        vm.expectRevert(expected);
        vault.requestRedeem(1, bob);
    }

    function testFuzz_RevertWhen_SharesExceedTheCallerBalance(uint256 deposit, uint256 extra) external {
        vault.setLockupPeriod(0);
        deposit = bound(deposit, 1e6, MAX_DEPOSIT);
        _depositAndClaim(alice, deposit);
        extra = bound(extra, 1, 1e30);

        uint256 tooMany = vault.balanceOf(alice) + extra;
        vm.prank(alice);
        vm.expectRevert();
        vault.requestRedeem(tooMany, alice);
    }

    function testFuzz_WhenSharesAreWithinBalance_EscrowsForTheCurrentEpoch(
        uint256 deposit,
        uint256 shares,
        uint256 elapsed
    ) external {
        deposit = bound(deposit, 1e6, MAX_DEPOSIT);
        _depositAndClaim(alice, deposit);
        shares = bound(shares, 1, vault.balanceOf(alice));
        elapsed = bound(elapsed, vault.lockupPeriod(), 365 days);
        vm.warp(block.timestamp + elapsed);

        vm.prank(alice);
        vault.requestRedeem(shares, bob);

        (uint64 epoch, uint192 pending) = vault.redeemRequests(bob);
        assertEq(epoch, vault.currentEpoch());
        assertEq(pending, shares);
        assertEq(vault.epochRedeemShares(vault.currentEpoch()), shares);
        assertEq(vault.balanceOf(address(vault)), shares);
    }
}
