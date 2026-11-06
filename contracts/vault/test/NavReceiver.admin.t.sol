// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {NavReceiver} from "src/NavReceiver.sol";
import {ShareVault} from "src/ShareVault.sol";
import {IReceiver} from "src/interfaces/IReceiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract NavReceiverAdminTest is Base {
    function test_RevertWhen_TheConstructorGetsZeroAddresses() external {
        vm.expectRevert(NavReceiver.NavReceiver__ZeroAddress.selector);
        new NavReceiver(ShareVault(address(0)), address(forwarder), address(this));
        vm.expectRevert(NavReceiver.NavReceiver__ZeroAddress.selector);
        new NavReceiver(vault, address(0), address(this));
    }

    function test_WhenTheArgumentsAreValid_StoresThem() external view {
        assertEq(address(receiver.VAULT()), address(vault));
        assertEq(receiver.forwarder(), address(forwarder));
    }

    function testFuzz_RevertWhen_SetForwarderCallerIsNotTheOwner(address caller) external {
        vm.assume(caller != address(this));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        receiver.setForwarder(caller);
    }

    function test_RevertWhen_TheForwarderIsZero() external {
        vm.expectRevert(NavReceiver.NavReceiver__ZeroAddress.selector);
        receiver.setForwarder(address(0));
    }

    function testFuzz_WhenTheForwarderIsValid_SwapsTheAcceptedCaller(address newForwarder) external {
        vm.assume(newForwarder != address(0) && newForwarder != address(forwarder));
        receiver.setForwarder(newForwarder);

        vm.expectRevert(NavReceiver.NavReceiver__NotForwarder.selector);
        _deliver(_navReport(1, uint64(block.timestamp), 0, 0));

        bytes memory metadata = abi.encodePacked(WORKFLOW_ID, WORKFLOW_NAME, workflowOwner, bytes2(0x0001));
        vm.prank(newForwarder);
        receiver.onReport(metadata, _navReport(1, uint64(block.timestamp), 0, 0));
        assertEq(vault.currentEpoch(), 2);
    }

    function testFuzz_RevertWhen_SetWorkflowIdentityCallerIsNotTheOwner(address caller) external {
        vm.assume(caller != address(this));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        receiver.setWorkflowIdentity(bytes32(0), address(0), bytes10(0));
    }

    function testFuzz_WhenTheCallerIsTheOwner_StoresTheIdentity(bytes32 id, address workflowOwner_, bytes10 name)
        external
    {
        receiver.setWorkflowIdentity(id, workflowOwner_, name);
        assertEq(receiver.expectedWorkflowId(), id);
        assertEq(receiver.expectedWorkflowOwner(), workflowOwner_);
        assertEq(receiver.expectedWorkflowName(), name);
    }

    function test_WhenTheIdIsIReceiverOrIERC165_ReturnsTrue() external view {
        assertTrue(receiver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId));
    }

    function testFuzz_WhenTheIdIsAnythingElse_ReturnsFalse(bytes4 interfaceId) external view {
        vm.assume(interfaceId != type(IReceiver).interfaceId && interfaceId != type(IERC165).interfaceId);
        assertFalse(receiver.supportsInterface(interfaceId));
    }
}
