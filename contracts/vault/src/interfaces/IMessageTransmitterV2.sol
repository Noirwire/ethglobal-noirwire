// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice The receive entry point of Circle's CCTP V2 MessageTransmitterV2.
interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);
}
