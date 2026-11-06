// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {ShareVault} from "src/ShareVault.sol";

contract ShareVaultSettleEpochTest is Base {
    function testFuzz_RevertWhen_TheCallerIsNotTheNavReceiver(address caller) external {
        vm.assume(caller != address(receiver));
        vm.prank(caller);
        vm.expectRevert(ShareVault.ShareVault__NotNavReceiver.selector);
        vault.settleEpoch(1, 0, 0, uint64(block.timestamp));
    }

    function testFuzz_RevertWhen_TheCloseIdIsNotTheCurrentEpoch(uint64 closeId, uint64 settledFirst) external {
        settledFirst = uint64(bound(settledFirst, 0, 3));
        for (uint64 i; i < settledFirst; ++i) {
            _close(0, 0);
        }
        uint64 epoch = vault.currentEpoch();
        vm.assume(closeId != epoch);

        bytes memory report = _navReport(closeId, uint64(block.timestamp), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.ShareVault__WrongCloseId.selector, epoch, closeId));
        _deliver(report);
    }

    function testFuzz_RevertWhen_ObservedAtIsInTheFuture(uint64 ahead) external {
        ahead = uint64(bound(ahead, 1, 365 days));
        bytes memory report = _navReport(1, uint64(block.timestamp) + ahead, 0, 0);
        vm.expectRevert(ShareVault.ShareVault__ReportFromFuture.selector);
        _deliver(report);
    }

    function testFuzz_RevertWhen_ObservedAtIsOlderThanTheMaxReportAge(uint64 extra) external {
        extra = uint64(bound(extra, 1, 300 days));
        bytes memory report = _navReport(1, uint64(block.timestamp - vault.maxReportAge() - extra), 0, 0);
        vm.expectRevert(ShareVault.ShareVault__ReportTooOld.selector);
        _deliver(report);
    }

    function testFuzz_ObservedAtExactlyAtTheMaxAgeIsAccepted(uint64 age) external {
        age = uint64(bound(age, 0, vault.maxReportAge()));
        vm.warp(block.timestamp + vault.maxReportAge());
        _deliver(_navReport(1, uint64(block.timestamp) - age, 0, 0));
        assertEq(vault.currentEpoch(), 2);
    }

    function testFuzz_RevertWhen_ObservedAtIsNotAfterTheLastSettlement(uint64 gap, uint64 back) external {
        gap = uint64(bound(gap, 0, 30 minutes));
        back = uint64(bound(back, 0, 20 minutes));
        vm.warp(block.timestamp + 1);
        _close(0, 0);
        uint64 settledAt = vault.lastSettledAt();
        vm.warp(block.timestamp + gap);

        bytes memory report = _navReport(2, settledAt - back, 0, 0);
        vm.expectRevert(ShareVault.ShareVault__ReportNotNewer.selector);
        _deliver(report);
    }

    function test_RevertWhen_TheFirstReportIsNotAfterTheDeployment() external {
        vm.warp(block.timestamp + 1);
        bytes memory report = _navReport(1, vault.lastSettledAt(), 0, 0);
        vm.expectRevert(ShareVault.ShareVault__ReportNotNewer.selector);
        _deliver(report);
    }

    function testFuzz_ObservedAtJustAfterTheLastSettlementIsAccepted(uint64 gap) external {
        gap = uint64(bound(gap, 1, 30 minutes));
        vm.warp(block.timestamp + 1);
        _close(0, 0);
        uint64 settledAt = vault.lastSettledAt();
        vm.warp(block.timestamp + gap);

        _deliver(_navReport(2, settledAt + 1, 0, 0));
        assertEq(vault.currentEpoch(), 3);
    }

    function testFuzz_GivenAcknowledgedDeviation_RequestsStayPausedUntilTheNextSettlement(uint256 deposit) external {
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        _depositAndClaim(alice, deposit);
        _closeAt(deposit / 2);
        assertTrue(vault.requestsPaused());

        vault.acknowledgeDeviation();
        assertTrue(vault.deviationAcknowledged());
        assertTrue(vault.requestsPaused());
        vm.prank(bob);
        vm.expectRevert(ShareVault.ShareVault__RequestsPaused.selector);
        vault.requestDeposit(deposit, bob);

        _closeAt(deposit / 2);
        assertFalse(vault.requestsPaused());
        _deposit(bob, deposit);
    }

    function testFuzz_GivenResidualAssetsAtZeroSupply_TheNextDepositorDoesNotReceiveThem(
        uint256 deposit,
        uint256 next,
        uint256 residual
    ) external {
        vault.setLockupPeriod(0);
        vault.setMaxRedeemBps(10_000);
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        next = bound(next, 1000e6, MAX_DEPOSIT);
        residual = bound(residual, 1e6, next / 20);
        _depositAndClaim(alice, deposit);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestRedeem(aliceShares, alice);
        _close(0, 0);
        vault.claimAssets(alice);
        assertEq(vault.totalSupply(), 0);

        usdc.mint(address(vault), residual);
        vm.prank(operator);
        vault.acknowledgeReturn(residual);
        _deposit(bob, next);
        _close(0, 0);
        vault.claimShares(bob);
        _close(0, 0);

        assertEq(vault.balanceOf(bob), next * 1e12);
        assertEq(vault.balanceOf(feeRecipient), residual * 1e12);
        assertEq(_valueOf(bob), next);
        assertEq(_valueOf(feeRecipient), residual);
    }

    function testFuzz_RevertWhen_TheLiabilitiesConsumeAllAssets(uint256 assets, uint256 extra) external {
        _depositAndClaim(alice, 1000e6);
        assets = bound(assets, 0, 1e15);
        extra = bound(extra, 0, 1e15);
        vm.warp(block.timestamp + 1);
        bytes memory report = _navReport(2, uint64(block.timestamp), assets, assets + extra);
        vm.expectRevert(ShareVault.ShareVault__SharePriceZero.selector);
        _deliver(report);
    }

    function testFuzz_GivenDeviation_NotAcknowledged_PausesWithoutSettling(uint256 deposit, uint256 crashPct) external {
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        crashPct = bound(crashPct, 12, 90);
        _depositAndClaim(alice, deposit);
        uint64 epoch = vault.currentEpoch();
        uint256 priceBefore = vault.lastPrice();

        _closeAt(deposit * (100 - crashPct) / 100);

        assertTrue(vault.requestsPaused());
        assertEq(vault.currentEpoch(), epoch);
        assertEq(vault.lastPrice(), priceBefore);
    }

    function testFuzz_GivenDeviation_Acknowledged_SettlesAndClearsAcknowledgement(uint256 deposit, uint256 crashPct)
        external
    {
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        crashPct = bound(crashPct, 12, 90);
        _depositAndClaim(alice, deposit);
        uint64 epoch = vault.currentEpoch();
        uint256 navAfter = deposit * (100 - crashPct) / 100;
        _closeAt(navAfter);

        vault.acknowledgeDeviation();
        assertTrue(vault.requestsPaused());
        _closeAt(navAfter);

        assertEq(vault.currentEpoch(), epoch + 1);
        assertEq(vault.lastPrice(), navAfter * 1e30 / (deposit * 1e12));
        assertFalse(vault.deviationAcknowledged());
        assertFalse(vault.requestsPaused());
    }

    function testFuzz_GivenDeviation_LaterReportBackInsideBound_SettlesAndUnpauses(uint256 deposit) external {
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        _depositAndClaim(alice, deposit);
        _closeAt(deposit / 2);
        assertTrue(vault.requestsPaused());

        _closeAt(deposit);
        assertFalse(vault.requestsPaused());
        assertEq(vault.currentEpoch(), 3);
    }

    function testFuzz_GivenZeroSupply_PricesAtTheOpeningPrice(uint256 assets, uint256 venue) external {
        assets = bound(assets, 1, MAX_DEPOSIT);
        venue = bound(venue, 0, 1e15);
        _deposit(alice, assets);
        _close(venue, 0);

        assertEq(vault.lastPrice(), vault.INITIAL_PRICE());
        vault.claimShares(alice);
        assertEq(vault.balanceOf(alice), assets * 1e12);
    }

    function testFuzz_GivenALoss_LateDepositorDoesNotCaptureIt(uint256 early, uint256 late, uint256 lossPct) external {
        vault.setMaxPriceMoveBps(5000);
        early = bound(early, 1000e6, MAX_DEPOSIT);
        late = bound(late, 1000e6, MAX_DEPOSIT);
        lossPct = bound(lossPct, 1, 40);
        _depositAndClaim(alice, early);
        vm.prank(operator);
        vault.moveToVenue(treasury, early);
        _deposit(bob, late);

        uint256 venue = early * (100 - lossPct) / 100;
        _close(venue, 0);
        vault.claimShares(bob);

        assertApproxEqAbs(_valueOf(alice), venue, 2);
        assertApproxEqAbs(_valueOf(bob), late, 2);
        assertLe(_valueOf(bob), late);
    }

    function testFuzz_GivenAGain_LateDepositorDoesNotCaptureIt(uint256 early, uint256 late, uint256 gainPct) external {
        vault.setPerformanceFeeBps(0);
        vault.setMaxPriceMoveBps(5000);
        early = bound(early, 1000e6, MAX_DEPOSIT);
        late = bound(late, 1000e6, MAX_DEPOSIT);
        gainPct = bound(gainPct, 1, 40);
        _depositAndClaim(alice, early);
        _deposit(bob, late);

        uint256 gain = early * gainPct / 100;
        _close(gain, 0);
        vault.claimShares(bob);

        assertApproxEqAbs(_valueOf(alice), early + gain, 2);
        assertApproxEqAbs(_valueOf(bob), late, 2);
        assertLe(_valueOf(bob), late);
    }

    function testFuzz_GivenARedemptionWithinTheCap_PaysAtTheClosePrice(
        uint256 deposit,
        uint256 sharesSeed,
        uint256 gainPct
    ) external {
        vault.setPerformanceFeeBps(0);
        vault.setMaxPriceMoveBps(5000);
        vault.setLockupPeriod(0);
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        gainPct = bound(gainPct, 0, 40);
        _depositAndClaim(alice, deposit);
        uint256 shares = bound(sharesSeed, 1e12, vault.balanceOf(alice) / 4);

        vm.prank(alice);
        vault.requestRedeem(shares, alice);
        _close(deposit * gainPct / 100, 0);

        uint256 expected = shares * vault.lastPrice() / 1e30;
        uint256 before = usdc.balanceOf(alice);
        vault.claimAssets(alice);
        assertEq(usdc.balanceOf(alice) - before, expected);
        assertGe(expected, shares / 1e12);
    }

    function testFuzz_GivenRedemptionsBeyondTheCap_FillProRataAndRoll(uint256 depositA, uint256 depositB) external {
        vault.setLockupPeriod(0);
        depositA = bound(depositA, 1000e6, MAX_DEPOSIT);
        depositB = bound(depositB, 1000e6, MAX_DEPOSIT);
        _deposit(alice, depositA);
        _deposit(bob, depositB);
        _close(0, 0);
        vault.claimShares(alice);
        vault.claimShares(bob);
        uint256 sharesA = vault.balanceOf(alice);
        uint256 sharesB = vault.balanceOf(bob);
        vm.prank(alice);
        vault.requestRedeem(sharesA, alice);
        vm.prank(bob);
        vault.requestRedeem(sharesB, bob);
        _close(0, 0);

        (uint64 settledAt, uint192 requested, uint256 price, uint256 filled) = vault.settlements(2);
        assertEq(settledAt, block.timestamp);
        assertEq(price, 1e18);
        assertEq(requested, (depositA + depositB) * 1e12);
        assertApproxEqAbs(filled, (depositA + depositB) * 1e12 / 4, 2e12);
        assertEq(vault.epochRedeemShares(3), requested - filled);

        (, uint256 assetsA) = vault.pendingClaims(alice);
        (, uint256 assetsB) = vault.pendingClaims(bob);
        assertApproxEqRel(assetsA * depositB, assetsB * depositA, 1e12);
        assertLe(assetsA + assetsB, vault.reservedAssets());
        assertApproxEqAbs(vault.reservedAssets(), (depositA + depositB) / 4, 2);

        _close(0, 0);
        (, uint256 assetsA2) = vault.pendingClaims(alice);
        assertGt(assetsA2, assetsA);
    }

    function testFuzz_GivenRedemptionsBeyondTheCashOnArc_TheFillIsCappedByCash(uint256 deposit, uint256 movedPct)
        external
    {
        vault.setLockupPeriod(0);
        vault.setMaxRedeemBps(10_000);
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        movedPct = bound(movedPct, 10, 90);
        _depositAndClaim(alice, deposit);
        uint256 moved = deposit * movedPct / 100;
        vm.prank(operator);
        vault.moveToVenue(treasury, moved);
        uint256 allShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestRedeem(allShares, alice);

        _close(moved, 0);

        (, uint256 assets) = vault.pendingClaims(alice);
        assertApproxEqAbs(assets, deposit - moved, 1);
        assertLe(assets, deposit - moved);
    }

    function testFuzz_GivenPriceAboveTheHighWaterMark_MintsAPerformanceFee(uint256 deposit, uint256 gainPct) external {
        vault.setMaxPriceMoveBps(5000);
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        gainPct = bound(gainPct, 1, 40);
        _depositAndClaim(alice, deposit);
        assertEq(vault.balanceOf(feeRecipient), 0);

        uint256 gain = deposit * gainPct / 100;
        _close(gain, 0);

        uint256 supplyBefore = deposit * 1e12;
        uint256 rawPrice = (deposit + gain) * 1e30 / supplyBefore;
        uint256 expectedFee = supplyBefore * (rawPrice - 1e18) * vault.performanceFeeBps() / (rawPrice * 10_000);
        assertEq(vault.balanceOf(feeRecipient), expectedFee);
        assertGt(expectedFee, 0);
        assertEq(vault.highWaterMark(), vault.lastPrice());
        assertLt(vault.lastPrice(), rawPrice);
    }

    function testFuzz_GivenPriceBelowTheHighWaterMark_MintsNoFee(uint256 deposit, uint256 gainPct, uint256 lossPct)
        external
    {
        vault.setMaxPriceMoveBps(5000);
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        gainPct = bound(gainPct, 5, 40);
        lossPct = bound(lossPct, 1, 20);
        _depositAndClaim(alice, deposit);
        _close(deposit * gainPct / 100, 0);
        uint256 feeShares = vault.balanceOf(feeRecipient);
        uint256 hwm = vault.highWaterMark();

        _close(0, deposit * lossPct / 100);

        assertEq(vault.balanceOf(feeRecipient), feeShares);
        assertEq(vault.highWaterMark(), hwm);
        assertEq(vault.currentEpoch(), 4);
    }
}
