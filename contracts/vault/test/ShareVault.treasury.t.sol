// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {ShareVault} from "src/ShareVault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ShareVaultTreasuryTest is Base {
    function testFuzz_RevertWhen_MoveCallerIsNotTheOperator(address caller) external {
        vm.assume(caller != operator);
        vm.prank(caller);
        vm.expectRevert(ShareVault.ShareVault__NotOperator.selector);
        vault.moveToVenue(treasury, 1);
    }

    function testFuzz_RevertWhen_TheDestinationIsNotAllowlisted(address destination, uint256 amount) external {
        vm.assume(destination != treasury);
        amount = bound(amount, 1, MAX_DEPOSIT);
        _depositAndClaim(alice, MAX_DEPOSIT);

        vm.prank(operator);
        vm.expectRevert(ShareVault.ShareVault__DestinationNotAllowed.selector);
        vault.moveToVenue(destination, amount);
    }

    function test_RevertWhen_TheMoveAmountIsZero() external {
        vm.prank(operator);
        vm.expectRevert(ShareVault.ShareVault__ZeroAmount.selector);
        vault.moveToVenue(treasury, 0);
    }

    function testFuzz_RevertWhen_TheAmountIsAboveThePerCallCap(uint256 cap, uint256 excess) external {
        cap = bound(cap, 0, 100_000e6);
        excess = bound(excess, 1, 100_000e6);
        _depositAndClaim(alice, MAX_DEPOSIT);
        vault.setMoveCaps(cap, type(uint128).max);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.ShareVault__OverPerCallCap.selector, cap));
        vault.moveToVenue(treasury, cap + excess);
    }

    function testFuzz_RevertWhen_TheAmountIsAboveThePerEpochCap(uint256 epochCap, uint256 first, uint256 second)
        external
    {
        epochCap = bound(epochCap, 2, 200_000e6);
        first = bound(first, 1, epochCap - 1);
        second = bound(second, epochCap - first + 1, epochCap + 1);
        _depositAndClaim(alice, MAX_DEPOSIT);
        vault.setMoveCaps(type(uint128).max, epochCap);

        vm.startPrank(operator);
        vault.moveToVenue(treasury, first);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.ShareVault__OverPerEpochCap.selector, epochCap - first));
        vault.moveToVenue(treasury, second);
        vm.stopPrank();
    }

    function testFuzz_GivenTheNextEpochHasStarted_ThePerEpochCapResets(uint256 epochCap) external {
        epochCap = bound(epochCap, 1, 100_000e6);
        vault.setPerformanceFeeBps(0);
        _depositAndClaim(alice, MAX_DEPOSIT);
        vault.setMoveCaps(type(uint128).max, epochCap);

        vm.prank(operator);
        vault.moveToVenue(treasury, epochCap);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.ShareVault__OverPerEpochCap.selector, 0));
        vault.moveToVenue(treasury, 1);

        _close(epochCap, 0);
        vm.prank(operator);
        vault.moveToVenue(treasury, epochCap);
        assertEq(vault.movedInEpoch(vault.currentEpoch()), epochCap);
    }

    function test_RevertWhen_CapsAreNotConfigured() external {
        ShareVault fresh = new ShareVault(usdc, address(this), feeRecipient);
        fresh.setOperator(operator);
        fresh.setDestinationAllowed(treasury, true);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.ShareVault__OverPerCallCap.selector, 0));
        fresh.moveToVenue(treasury, 1);
    }

    function testFuzz_RevertWhen_TheAmountIsAboveTheIdleAssets(uint256 deposit, uint256 pending, uint256 redeemPct)
        external
    {
        vault.setLockupPeriod(0);
        deposit = bound(deposit, 1000e6, MAX_DEPOSIT);
        pending = bound(pending, 1, MAX_DEPOSIT);
        redeemPct = bound(redeemPct, 1, 25);
        _depositAndClaim(alice, deposit);
        uint256 shares = vault.balanceOf(alice) * redeemPct / 100;
        vm.prank(alice);
        vault.requestRedeem(shares, alice);
        _close(0, 0);
        _deposit(bob, pending);

        uint256 idle = vault.idleAssets();
        assertEq(idle, deposit - vault.reservedAssets());

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.ShareVault__InsufficientIdleAssets.selector, idle));
        vault.moveToVenue(treasury, idle + 1);
        vault.moveToVenue(treasury, idle);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(vault)), vault.reservedAssets() + pending);
    }

    function testFuzz_WhenWithinEveryLimit_SendsTheUsdc(uint256 amount) external {
        amount = bound(amount, 1, MAX_DEPOSIT);
        _depositAndClaim(alice, MAX_DEPOSIT);

        vm.prank(operator);
        vault.moveToVenue(treasury, amount);

        assertEq(usdc.balanceOf(treasury), amount);
        assertEq(vault.ledgerAssets(), MAX_DEPOSIT - amount);
    }

    function testFuzz_RevertWhen_AcknowledgeCallerIsNotTheOperator(address caller) external {
        vm.assume(caller != operator);
        vm.prank(caller);
        vm.expectRevert(ShareVault.ShareVault__NotOperator.selector);
        vault.acknowledgeReturn(1);
    }

    function testFuzz_RevertWhen_TheReturnIsAboveTheSurplus(uint256 returned, uint256 excess) external {
        returned = bound(returned, 0, MAX_DEPOSIT);
        excess = bound(excess, 1, MAX_DEPOSIT);
        usdc.mint(address(vault), returned);

        vm.prank(operator);
        vm.expectRevert(ShareVault.ShareVault__ReturnNotBacked.selector);
        vault.acknowledgeReturn(returned + excess);
    }

    function testFuzz_WhenTheReturnIsBacked_BringsItIntoTheLedger(uint256 moved, uint256 returned) external {
        moved = bound(moved, 1, MAX_DEPOSIT);
        returned = bound(returned, 1, moved);
        _depositAndClaim(alice, MAX_DEPOSIT);
        vm.prank(operator);
        vault.moveToVenue(treasury, moved);
        usdc.mint(address(vault), returned);
        uint256 cashBefore = vault.navCash();

        vm.prank(operator);
        vault.acknowledgeReturn(returned);

        assertEq(vault.navCash(), cashBefore + returned);
        assertEq(vault.surplusAssets(), 0);
    }

    function test_RevertWhen_AcknowledgeAmountIsZero() external {
        vm.prank(operator);
        vm.expectRevert(ShareVault.ShareVault__ZeroAmount.selector);
        vault.acknowledgeReturn(0);
    }

    function testFuzz_RevertWhen_SweepCallerIsNotTheOwner(address caller) external {
        vm.assume(caller != address(this));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        vault.sweepSurplus(caller);
    }

    function testFuzz_RevertWhen_ThereIsNoSurplus(uint256 deposit) external {
        deposit = bound(deposit, 1, MAX_DEPOSIT);
        _deposit(alice, deposit);
        vm.expectRevert(ShareVault.ShareVault__NoSurplus.selector);
        vault.sweepSurplus(alice);
    }

    function test_RevertWhen_SweepDestinationIsTheZeroAddress() external {
        vm.expectRevert(ShareVault.ShareVault__ZeroAddress.selector);
        vault.sweepSurplus(address(0));
    }

    function testFuzz_WhenUsdcSitsOutsideTheLedger_SweepsExactlyTheSurplus(uint256 deposit, uint256 donated) external {
        deposit = bound(deposit, 1, MAX_DEPOSIT);
        donated = bound(donated, 1, MAX_DEPOSIT);
        _deposit(alice, deposit);
        vm.prank(bob);
        usdc.transfer(address(vault), donated);
        address sink = makeAddr("sink");

        vault.sweepSurplus(sink);

        assertEq(usdc.balanceOf(sink), donated);
        assertEq(usdc.balanceOf(address(vault)), deposit);
        assertEq(vault.ledgerAssets(), deposit);
    }
}
