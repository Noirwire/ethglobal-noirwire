// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {NavReceiver} from "src/NavReceiver.sol";
import {ShareVault} from "src/ShareVault.sol";

contract NavReceiverOnReportTest is Base {
    function _topUp(bytes32 intentId, uint8 version, uint8 route, uint8 reason, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory body = abi.encode(version, intentId, uint64(1), route, amount, uint16(1500), reason);
        return abi.encode(uint8(2), body);
    }

    function testFuzz_RevertWhen_TheCallerIsNotTheForwarder(address caller) external {
        vm.assume(caller != address(forwarder));
        bytes memory report = _navReport(1, uint64(block.timestamp), 0, 0);
        vm.prank(caller);
        vm.expectRevert(NavReceiver.NavReceiver__NotForwarder.selector);
        receiver.onReport(_metadata(WORKFLOW_ID, WORKFLOW_NAME, workflowOwner), report);
    }

    function testFuzz_RevertWhen_TheMetadataIsShorterThanTheHeader(bytes calldata metadata) external {
        vm.assume(metadata.length < 62);
        vm.prank(address(forwarder));
        vm.expectRevert(NavReceiver.NavReceiver__BadMetadata.selector);
        receiver.onReport(metadata, _navReport(1, uint64(block.timestamp), 0, 0));
    }

    function testFuzz_RevertWhen_TheWorkflowIdDoesNotMatch(bytes32 id) external {
        vm.assume(id != WORKFLOW_ID);
        bytes memory report = _navReport(1, uint64(block.timestamp), 0, 0);
        vm.expectRevert(NavReceiver.NavReceiver__WrongWorkflowId.selector);
        forwarder.deliver(address(receiver), id, WORKFLOW_NAME, workflowOwner, report);
    }

    function testFuzz_RevertWhen_TheWorkflowOwnerDoesNotMatch(address other) external {
        vm.assume(other != workflowOwner);
        bytes memory report = _navReport(1, uint64(block.timestamp), 0, 0);
        vm.expectRevert(NavReceiver.NavReceiver__WrongWorkflowOwner.selector);
        forwarder.deliver(address(receiver), WORKFLOW_ID, WORKFLOW_NAME, other, report);
    }

    function testFuzz_RevertWhen_TheWorkflowNameDoesNotMatch(bytes10 name) external {
        vm.assume(name != WORKFLOW_NAME);
        bytes memory report = _navReport(1, uint64(block.timestamp), 0, 0);
        vm.expectRevert(NavReceiver.NavReceiver__WrongWorkflowName.selector);
        forwarder.deliver(address(receiver), WORKFLOW_ID, name, workflowOwner, report);
    }

    function testFuzz_GivenIdentityChecksDisabled_AcceptsAnyWorkflow(bytes32 id, bytes10 name, address other) external {
        receiver.setWorkflowIdentity(bytes32(0), address(0), bytes10(0));
        forwarder.deliver(address(receiver), id, name, other, _navReport(1, uint64(block.timestamp), 0, 0));
        assertEq(vault.currentEpoch(), 2);
    }

    function testFuzz_RevertWhen_TheKindIsUnknown(uint8 kind, bytes calldata body) external {
        vm.assume(kind != 1 && kind != 2);
        vm.expectRevert(abi.encodeWithSelector(NavReceiver.NavReceiver__UnknownKind.selector, kind));
        _deliver(abi.encode(kind, body));
    }

    function testFuzz_RevertWhen_TheNavVersionIsUnsupported(uint8 version) external {
        vm.assume(version != 1);
        bytes memory body = abi.encode(version, uint64(1), uint64(block.timestamp), uint256(0), uint256(0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(NavReceiver.NavReceiver__UnsupportedVersion.selector, version));
        _deliver(abi.encode(uint8(1), body));
    }

    function testFuzz_RevertWhen_TheVaultRejectsTheSettlement(uint64 closeId) external {
        vm.assume(closeId != 1);
        bytes memory report = _navReport(closeId, uint64(block.timestamp), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.ShareVault__WrongCloseId.selector, uint64(1), closeId));
        _deliver(report);
    }

    function testFuzz_WhenTheVaultAcceptsTheSettlement_SettlesAndEmits(uint256 deposit, bytes32 sourcesHash) external {
        deposit = bound(deposit, 1, MAX_DEPOSIT);
        _deposit(alice, deposit);
        bytes memory body =
            abi.encode(uint8(1), uint64(1), uint64(block.timestamp), uint256(0), uint256(0), sourcesHash);

        vm.expectEmit(true, false, false, true, address(receiver));
        emit NavReceiver.NavReportReceived(1, uint64(block.timestamp), 0, 0, sourcesHash);
        _deliver(abi.encode(uint8(1), body));

        assertEq(vault.currentEpoch(), 2);
        assertEq(vault.lastPrice(), 1e18);
    }

    function testFuzz_RevertWhen_TheTopUpVersionIsUnsupported(uint8 version) external {
        vm.assume(version != 1);
        vm.expectRevert(abi.encodeWithSelector(NavReceiver.NavReceiver__UnsupportedVersion.selector, version));
        _deliver(_topUp(bytes32(uint256(1)), version, 0, 0, 1e6));
    }

    function testFuzz_RevertWhen_TheTopUpFieldsAreInvalid(uint8 route, uint8 reason, uint256 amount) external {
        bool invalid = route > 5 || reason > 3 || amount == 0;
        vm.assume(invalid);
        vm.expectRevert(NavReceiver.NavReceiver__InvalidIntent.selector);
        _deliver(_topUp(bytes32(uint256(1)), 1, route, reason, amount));
    }

    function test_WhenTheRouteIsTheHighestKnown_RecordsIt() external {
        assertEq(receiver.MAX_ROUTE(), 5);
        _deliver(_topUp(bytes32(uint256(7)), 1, 5, 0, 1e6));
        (,,, uint8 storedRoute,,) = receiver.topUpIntents(bytes32(uint256(7)));
        assertEq(storedRoute, 5);
    }

    function test_RevertWhen_TheRouteIsPastTheHighestKnown() external {
        vm.expectRevert(NavReceiver.NavReceiver__InvalidIntent.selector);
        _deliver(_topUp(bytes32(uint256(8)), 1, 6, 0, 1e6));
    }

    function testFuzz_RevertWhen_TheIntentIdWasAlreadyRecorded(bytes32 intentId, uint256 amount) external {
        amount = bound(amount, 1, type(uint128).max);
        _deliver(_topUp(intentId, 1, 0, 0, amount));
        vm.expectRevert(abi.encodeWithSelector(NavReceiver.NavReceiver__DuplicateIntent.selector, intentId));
        _deliver(_topUp(intentId, 1, 1, 1, amount));
    }

    function testFuzz_WhenTheIntentIsNewAndValid_RecordsIt(bytes32 intentId, uint8 route, uint8 reason, uint256 amount)
        external
    {
        route = uint8(bound(route, 0, 5));
        reason = uint8(bound(reason, 0, 3));
        amount = bound(amount, 1, type(uint128).max);

        vm.expectEmit(true, false, false, true, address(receiver));
        emit NavReceiver.TopUpIntentRecorded(intentId, 1, route, amount, 1500, reason);
        _deliver(_topUp(intentId, 1, route, reason, amount));

        (uint64 closeId, uint64 recordedAt, uint16 ratio, uint8 storedRoute, uint8 storedReason, uint256 storedAmount) =
            receiver.topUpIntents(intentId);
        assertEq(closeId, 1);
        assertEq(recordedAt, block.timestamp);
        assertEq(ratio, 1500);
        assertEq(storedRoute, route);
        assertEq(storedReason, reason);
        assertEq(storedAmount, amount);
    }
}
