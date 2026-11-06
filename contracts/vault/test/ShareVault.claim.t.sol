// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {ShareVault} from "src/ShareVault.sol";

contract ShareVaultClaimTest is Base {
    function test_RevertGiven_ClaimSharesHasNothingToClaim() external {
        vm.expectRevert(ShareVault.ShareVault__ZeroAmount.selector);
        vault.claimShares(alice);
    }

    function testFuzz_GivenASettledDeposit_DeliversSharesAndSetsTheLockup(uint256 assets, address caller) external {
        assets = bound(assets, 1, MAX_DEPOSIT);
        _deposit(alice, assets);
        _close(0, 0);

        vm.prank(caller);
        vault.claimShares(alice);

        assertEq(vault.balanceOf(alice), assets * 1e12);
        assertEq(vault.lockedUntil(alice), block.timestamp + vault.lockupPeriod());
        assertEq(vault.claimableShares(alice), 0);
    }

    function test_RevertGiven_ClaimAssetsHasNothingToClaim() external {
        vm.expectRevert(ShareVault.ShareVault__ZeroAmount.selector);
        vault.claimAssets(alice);
    }

    function testFuzz_GivenASettledRedemption_PaysFromReservedAssets(uint256 deposit, uint256 fraction) external {
        vault.setLockupPeriod(0);
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        fraction = bound(fraction, 1, 25);
        _depositAndClaim(alice, deposit);
        uint256 shares = vault.balanceOf(alice) * fraction / 100;
        vm.prank(alice);
        vault.requestRedeem(shares, alice);
        _close(0, 0);

        uint256 reservedBefore = vault.reservedAssets();
        uint256 balanceBefore = usdc.balanceOf(alice);
        vault.claimAssets(alice);

        uint256 paid = usdc.balanceOf(alice) - balanceBefore;
        assertEq(paid, shares / 1e12);
        assertEq(vault.reservedAssets(), reservedBefore - paid);
        assertEq(vault.ledgerAssets(), deposit - paid);
        assertEq(usdc.balanceOf(address(vault)), deposit - paid);
    }

    function testFuzz_GivenARolledRedemption_AdvanceProcessesOnlyTheRequestedEpochs(uint256 deposit, uint256 steps)
        external
    {
        vault.setLockupPeriod(0);
        deposit = bound(deposit, 10_000e6, MAX_DEPOSIT);
        steps = bound(steps, 1, 3);
        _depositAndClaim(alice, deposit);
        uint256 allShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestRedeem(allShares, alice);
        _close(0, 0);
        _close(0, 0);
        _close(0, 0);
        _close(0, 0);

        vault.advanceRedeem(alice, steps);
        (uint64 epoch,) = vault.redeemRequests(alice);
        assertEq(epoch, 2 + steps);
        uint256 afterSteps = vault.claimableAssets(alice);
        assertGt(afterSteps, 0);

        vault.advanceRedeem(alice, type(uint256).max);
        assertGt(vault.claimableAssets(alice), afterSteps);
        (epoch,) = vault.redeemRequests(alice);
        assertEq(epoch, vault.currentEpoch());
    }
}
