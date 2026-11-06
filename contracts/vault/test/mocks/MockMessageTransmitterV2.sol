// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MockUSDC} from "test/mocks/MockUSDC.sol";

/// @notice Mirrors the CCTP V2 MessageTransmitter receive path and Attestable signature rules. The
/// attestation is the concatenation of 65 byte (r, s, v) signatures over keccak256(message), signers
/// strictly ascending by address, exactly `signatureThreshold` of them, each an enabled attester.
/// Minting goes directly to the burn message's mint recipient (net of feeExecuted), standing in for
/// the token messenger.
contract MockMessageTransmitterV2 is Ownable {
    uint256 public constant SIGNATURE_LENGTH = 65;
    uint32 public constant VERSION = 1;
    uint256 internal constant MIN_MESSAGE_LENGTH = 148 + 228;

    MockUSDC public immutable USDC;
    uint32 public immutable LOCAL_DOMAIN;
    address public immutable FEE_SINK;

    uint256 public signatureThreshold = 1;
    mapping(address attester => bool enabled) public isEnabledAttester;
    mapping(bytes32 nonce => bool used) public usedNonces;

    error MockMessageTransmitterV2__InvalidThreshold();
    error MockMessageTransmitterV2__InvalidAttestationLength();
    error MockMessageTransmitterV2__InvalidSignatureOrderOrDupe();
    error MockMessageTransmitterV2__NotAttester();
    error MockMessageTransmitterV2__MessageTooShort();
    error MockMessageTransmitterV2__InvalidVersion();
    error MockMessageTransmitterV2__InvalidDestinationDomain();
    error MockMessageTransmitterV2__InvalidCaller();
    error MockMessageTransmitterV2__NonceAlreadyUsed();

    constructor(MockUSDC usdc_, address attester_, uint32 localDomain_, address feeSink_, address owner_)
        Ownable(owner_)
    {
        USDC = usdc_;
        LOCAL_DOMAIN = localDomain_;
        FEE_SINK = feeSink_;
        isEnabledAttester[attester_] = true;
        usedNonces[bytes32(0)] = true;
    }

    function setAttester(address attester, bool enabled) external onlyOwner {
        isEnabledAttester[attester] = enabled;
    }

    function setSignatureThreshold(uint256 threshold) external onlyOwner {
        if (threshold == 0) revert MockMessageTransmitterV2__InvalidThreshold();
        signatureThreshold = threshold;
    }

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool) {
        _verifyAttestationSignatures(message, attestation);
        if (message.length < MIN_MESSAGE_LENGTH) revert MockMessageTransmitterV2__MessageTooShort();
        if (uint32(bytes4(message[0:4])) != VERSION) revert MockMessageTransmitterV2__InvalidVersion();
        if (uint32(bytes4(message[8:12])) != LOCAL_DOMAIN) revert MockMessageTransmitterV2__InvalidDestinationDomain();

        bytes32 destinationCaller = bytes32(message[108:140]);
        if (destinationCaller != bytes32(0) && destinationCaller != bytes32(uint256(uint160(msg.sender)))) {
            revert MockMessageTransmitterV2__InvalidCaller();
        }

        bytes32 nonce = bytes32(message[12:44]);
        if (usedNonces[nonce]) revert MockMessageTransmitterV2__NonceAlreadyUsed();
        usedNonces[nonce] = true;

        address mintRecipient = address(uint160(uint256(bytes32(message[148 + 36:148 + 68]))));
        uint256 amount = uint256(bytes32(message[148 + 68:148 + 100]));
        uint256 feeExecuted = uint256(bytes32(message[148 + 164:148 + 196]));
        USDC.mint(mintRecipient, amount - feeExecuted);
        if (feeExecuted > 0) USDC.mint(FEE_SINK, feeExecuted);
        return true;
    }

    function _verifyAttestationSignatures(bytes calldata message, bytes calldata attestation) internal view {
        uint256 threshold = signatureThreshold;
        if (attestation.length != SIGNATURE_LENGTH * threshold) {
            revert MockMessageTransmitterV2__InvalidAttestationLength();
        }
        bytes32 digest = keccak256(message);
        address latest;
        for (uint256 i; i < threshold; ++i) {
            address signer = ECDSA.recover(digest, attestation[i * SIGNATURE_LENGTH:(i + 1) * SIGNATURE_LENGTH]);
            if (signer <= latest) revert MockMessageTransmitterV2__InvalidSignatureOrderOrDupe();
            if (!isEnabledAttester[signer]) revert MockMessageTransmitterV2__NotAttester();
            latest = signer;
        }
    }
}
