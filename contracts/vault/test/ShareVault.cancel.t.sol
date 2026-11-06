// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {ShareVault} from "src/ShareVault.sol";

contract ShareVaultCancelTest is Base {
    function test_RevertGiven_CancelDepositHasNoPendingDeposit() external {
        vm.prank(bob);
        vm.expectRevert(ShareVault.ShareVault__NothingToCancel.selector);
        vault.cancelDeposit();
    }

    function testFuzz_RevertGiven_TheDepositBelongsToASettledEpoch(uint256 assets) external {
        assets = bound(assets, 1, MAX_DEPOSIT);
        _deposit(alice, assets);
        _close(0, 0);

        vm.prank(alice);
        vm.expectRevert(ShareVault.ShareVault__EpochClosed.selector);
        vault.cancelDeposit();
    }

    function testFuzz_GivenTheDepositIsInTheOpenEpoch_RefundsAndClears(uint256 assets) external {
        assets = bound(assets, 1, MAX_DEPOSIT);
        uint256 before = usdc.balanceOf(alice);
        _deposit(alice, assets);

        vm.prank(alice);
        vault.cancelDeposit();

        assertEq(usdc.balanceOf(alice), before);
        assertEq(vault.epochDepositAssets(1), 0);
        assertEq(vault.ledgerAssets(), 0);
        (, uint192 pending) = vault.depositRequests(alice);
        assertEq(pending, 0);
    }

    function test_RevertGiven_CancelRedeemHasNoPendingRedemption() external {
        vm.prank(bob);
        vm.expectRevert(ShareVault.ShareVault__NothingToCancel.selector);
        vault.cancelRedeem();
    }

    function testFuzz_GivenAPendingRedemption_ReturnsEscrowedShares(uint256 deposit, uint256 shares) external {
        vault.setLockupPeriod(0);
        deposit = bound(deposit, 1e6, MAX_DEPOSIT);
        _depositAndClaim(alice, deposit);
        shares = bound(shares, 1, vault.balanceOf(alice));

        vm.startPrank(alice);
        vault.requestRedeem(shares, alice);
        assertEq(vault.balanceOf(alice), deposit * 1e12 - shares);
        vault.cancelRedeem();
        vm.stopPrank();

        assertEq(vault.balanceOf(alice), deposit * 1e12);
        assertEq(vault.epochRedeemShares(vault.currentEpoch()), 0);
        (, uint192 remaining) = vault.redeemRequests(alice);
        assertEq(remaining, 0);
    }
}
