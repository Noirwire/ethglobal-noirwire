// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {stdStorage, StdStorage} from "forge-std/Test.sol";
import {Base} from "test/Base.t.sol";
import {ShareVault} from "src/ShareVault.sol";

contract ShareVaultClaimTest is Base {
    using stdStorage for StdStorage;

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

    function testFuzz_GivenReservedAssetsBelowTheClaim_PaysTheReservedAndKeepsTheRemainder(
        uint256 deposit,
        uint256 shortfall
    ) external {
        vault.setLockupPeriod(0);
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        _depositAndClaim(alice, deposit);
        uint256 shares = vault.balanceOf(alice) / 10;
        vm.prank(alice);
        vault.requestRedeem(shares, alice);
        _close(0, 0);
        uint256 claim = shares / 1e12;
        shortfall = bound(shortfall, 1, claim - 1);
        stdstore.target(address(vault)).sig("reservedAssets()").checked_write(claim - shortfall);

        uint256 before = usdc.balanceOf(alice);
        vault.claimAssets(alice);

        assertEq(usdc.balanceOf(alice) - before, claim - shortfall);
        assertEq(vault.claimableAssets(alice), shortfall);
        assertEq(vault.reservedAssets(), 0);
    }

    function testFuzz_RevertWhen_NothingIsReservedForTheClaim(uint256 deposit) external {
        vault.setLockupPeriod(0);
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        _depositAndClaim(alice, deposit);
        uint256 shares = vault.balanceOf(alice) / 10;
        vm.prank(alice);
        vault.requestRedeem(shares, alice);
        _close(0, 0);
        stdstore.target(address(vault)).sig("reservedAssets()").checked_write(uint256(0));

        vm.expectRevert(ShareVault.ShareVault__ZeroAmount.selector);
        vault.claimAssets(alice);
        (, uint256 owed) = vault.pendingClaims(alice);
        assertGt(owed, 0);
    }

    function testFuzz_GivenSeveralRedeemersAndAPartialFill_ClaimsAndCarriesNeverExceedTheAggregate(
        uint256 depositA,
        uint256 depositB,
        uint256 depositC,
        uint256 gain,
        uint256 epochs
    ) external {
        vault.setLockupPeriod(0);
        vault.setPerformanceFeeBps(0);
        vault.setMaxPriceMoveBps(5000);
        depositA = bound(depositA, 1000e6, MAX_DEPOSIT);
        depositB = bound(depositB, 1000e6, MAX_DEPOSIT);
        depositC = bound(depositC, 1000e6, MAX_DEPOSIT);
        gain = bound(gain, 1, (depositA + depositB + depositC) / 5);
        epochs = bound(epochs, 1, 4);
        address carol = makeAddr("carol");
        usdc.mint(carol, depositC);
        vm.prank(carol);
        usdc.approve(address(vault), type(uint256).max);
        _deposit(alice, depositA);
        _deposit(bob, depositB);
        _deposit(carol, depositC);
        _close(0, 0);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vault.claimShares(users[i]);
            uint256 shares = vault.balanceOf(users[i]);
            vm.prank(users[i]);
            vault.requestRedeem(shares, users[i]);
        }

        for (uint256 e; e < epochs; ++e) {
            _close(e == 0 ? gain : 0, 0);
            uint256 carried;
            uint256 claims;
            for (uint256 i; i < 3; ++i) {
                vault.advanceRedeem(users[i], type(uint256).max);
                (, uint192 remaining) = vault.redeemRequests(users[i]);
                carried += remaining;
                claims += vault.claimableAssets(users[i]);
            }
            assertLe(carried, vault.epochRedeemShares(vault.currentEpoch()));
            assertLe(claims, vault.reservedAssets());
        }
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
