// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {ShareVault} from "src/ShareVault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ShareVaultAdminTest is Base {
    function testFuzz_RevertWhen_TheCallerIsNotTheOwner(address caller) external {
        vm.assume(caller != address(this));
        bytes memory expected = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller);
        vm.startPrank(caller);
        vm.expectRevert(expected);
        vault.acknowledgeDeviation();
        vm.expectRevert(expected);
        vault.setNavReceiver(caller);
        vm.expectRevert(expected);
        vault.setOperator(caller);
        vm.expectRevert(expected);
        vault.setFeeRecipient(caller);
        vm.expectRevert(expected);
        vault.setDestinationAllowed(caller, true);
        vm.expectRevert(expected);
        vault.setMoveCaps(1, 1);
        vm.expectRevert(expected);
        vault.setMaxReportAge(1 hours);
        vm.expectRevert(expected);
        vault.setMaxPriceMoveBps(1000);
        vm.expectRevert(expected);
        vault.setMaxEpochGap(1 days);
        vm.expectRevert(expected);
        vault.setMaxRedeemBps(1000);
        vm.expectRevert(expected);
        vault.setLockupPeriod(1 days);
        vm.expectRevert(expected);
        vault.setPerformanceFeeBps(1000);
        vm.stopPrank();
    }

    function testFuzz_RevertWhen_ParametersAreOutsideTheirBounds(uint32 value32, uint16 value16) external {
        value32 = uint32(bound(value32, 0, type(uint32).max));
        if (value32 < vault.MIN_REPORT_AGE() || value32 > vault.MAX_REPORT_AGE()) {
            vm.expectRevert(ShareVault.ShareVault__OutOfBounds.selector);
            vault.setMaxReportAge(value32);
        }
        if (value32 < vault.MIN_EPOCH_GAP() || value32 > vault.MAX_EPOCH_GAP()) {
            vm.expectRevert(ShareVault.ShareVault__OutOfBounds.selector);
            vault.setMaxEpochGap(value32);
        }
        if (value32 > vault.MAX_LOCKUP()) {
            vm.expectRevert(ShareVault.ShareVault__OutOfBounds.selector);
            vault.setLockupPeriod(value32);
        }
        if (value16 < vault.MIN_PRICE_MOVE_BPS() || value16 > vault.MAX_PRICE_MOVE_BPS()) {
            vm.expectRevert(ShareVault.ShareVault__OutOfBounds.selector);
            vault.setMaxPriceMoveBps(value16);
        }
        if (value16 < vault.MIN_REDEEM_BPS() || value16 > vault.BPS()) {
            vm.expectRevert(ShareVault.ShareVault__OutOfBounds.selector);
            vault.setMaxRedeemBps(value16);
        }
        if (value16 > vault.MAX_PERFORMANCE_FEE_BPS()) {
            vm.expectRevert(ShareVault.ShareVault__OutOfBounds.selector);
            vault.setPerformanceFeeBps(value16);
        }
    }

    function testFuzz_WhenValuesAreInsideTheirBounds_StoresThem(
        uint32 reportAge,
        uint16 priceMove,
        uint32 epochGap,
        uint16 redeemBps,
        uint32 lockup,
        uint16 feeBps
    ) external {
        reportAge = uint32(bound(reportAge, vault.MIN_REPORT_AGE(), vault.MAX_REPORT_AGE()));
        priceMove = uint16(bound(priceMove, vault.MIN_PRICE_MOVE_BPS(), vault.MAX_PRICE_MOVE_BPS()));
        epochGap = uint32(bound(epochGap, vault.MIN_EPOCH_GAP(), vault.MAX_EPOCH_GAP()));
        redeemBps = uint16(bound(redeemBps, vault.MIN_REDEEM_BPS(), vault.BPS()));
        lockup = uint32(bound(lockup, 0, vault.MAX_LOCKUP()));
        feeBps = uint16(bound(feeBps, 0, vault.MAX_PERFORMANCE_FEE_BPS()));

        vault.setMaxReportAge(reportAge);
        vault.setMaxPriceMoveBps(priceMove);
        vault.setMaxEpochGap(epochGap);
        vault.setMaxRedeemBps(redeemBps);
        vault.setLockupPeriod(lockup);
        vault.setPerformanceFeeBps(feeBps);

        assertEq(vault.maxReportAge(), reportAge);
        assertEq(vault.maxPriceMoveBps(), priceMove);
        assertEq(vault.maxEpochGap(), epochGap);
        assertEq(vault.maxRedeemBps(), redeemBps);
        assertEq(vault.lockupPeriod(), lockup);
        assertEq(vault.performanceFeeBps(), feeBps);
    }

    function test_RevertWhen_AnAddressThatMustNotBeZeroIsZero() external {
        vm.expectRevert(ShareVault.ShareVault__ZeroAddress.selector);
        vault.setFeeRecipient(address(0));
        vm.expectRevert(ShareVault.ShareVault__ZeroAddress.selector);
        vault.setDestinationAllowed(address(0), true);
    }

    function testFuzz_WhenAddressesAreValid_StoresThem(address navReceiver, address newOperator, address recipient)
        external
    {
        vm.assume(recipient != address(0));
        vault.setNavReceiver(navReceiver);
        vault.setOperator(newOperator);
        vault.setFeeRecipient(recipient);
        assertEq(vault.navReceiver(), navReceiver);
        assertEq(vault.operator(), newOperator);
        assertEq(vault.feeRecipient(), recipient);
    }

    function test_RevertWhen_TheConstructorGetsZeroAddresses() external {
        vm.expectRevert(ShareVault.ShareVault__ZeroAddress.selector);
        new ShareVault(usdc, address(this), address(0));
    }

    function test_WhenTheArgumentsAreValid_ExposesTheShareMetadata() external view {
        assertEq(vault.name(), "NoirWire Maker Vault Share");
        assertEq(vault.decimals(), 18);
        assertEq(address(vault.USDC()), address(usdc));
    }

    function testFuzz_OwnershipTransferNeedsAcceptance(address newOwner) external {
        vm.assume(newOwner != address(0) && newOwner != address(this));
        vault.transferOwnership(newOwner);
        assertEq(vault.owner(), address(this));
        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), newOwner);
    }
}
