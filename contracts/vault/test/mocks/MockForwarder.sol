// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IReceiver} from "src/interfaces/IReceiver.sol";

contract MockForwarder {
    function deliver(
        address receiver,
        bytes32 workflowId,
        bytes10 workflowName,
        address workflowOwner,
        bytes calldata report
    ) external {
        bytes memory metadata = abi.encodePacked(workflowId, workflowName, workflowOwner, bytes2(0x0001));
        IReceiver(receiver).onReport(metadata, report);
    }
}
