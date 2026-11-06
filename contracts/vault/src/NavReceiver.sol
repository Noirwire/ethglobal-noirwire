// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IReceiver} from "src/interfaces/IReceiver.sol";
import {ShareVault} from "src/ShareVault.sol";

/**
 * @title NavReceiver
 * @notice Chainlink CRE consumer. Accepts reports only from the configured forwarder, checks the
 * workflow identity carried in the metadata, then settles vault epochs or records top-up intents.
 * @custom:security-contact security@noirwire.com
 */
contract NavReceiver is IReceiver, Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                             TYPE DECLARATIONS
    //////////////////////////////////////////////////////////////*/

    struct TopUpIntent {
        uint64 closeId;
        uint64 recordedAt;
        uint16 marginRatioBps;
        uint8 route;
        uint8 reason;
        uint256 amount;
    }

    /*//////////////////////////////////////////////////////////////
                             STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    uint8 public constant KIND_NAV = 1;
    uint8 public constant KIND_TOP_UP = 2;
    uint8 public constant REPORT_VERSION = 1;
    uint8 public constant MAX_ROUTE = 3;
    uint8 public constant MAX_REASON = 3;
    uint256 public constant METADATA_MIN_LENGTH = 62;
    uint256 internal constant METADATA_NAME_OFFSET = 32;
    uint256 internal constant METADATA_OWNER_OFFSET = 42;

    ShareVault public immutable VAULT;

    address public forwarder;
    bytes10 public expectedWorkflowName;
    address public expectedWorkflowOwner;
    bytes32 public expectedWorkflowId;

    mapping(bytes32 intentId => TopUpIntent intent) public topUpIntents;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event NavReportReceived(
        uint64 indexed closeId, uint64 observedAt, uint256 totalAssets, uint256 totalLiabilities, bytes32 sourcesHash
    );
    event TopUpIntentRecorded(
        bytes32 indexed intentId, uint64 closeId, uint8 route, uint256 amount, uint16 marginRatioBps, uint8 reason
    );
    event ForwarderUpdated(address forwarder);
    event WorkflowIdentityUpdated(bytes32 workflowId, address workflowOwner, bytes10 workflowName);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NavReceiver__NotForwarder();
    error NavReceiver__BadMetadata();
    error NavReceiver__WrongWorkflowId();
    error NavReceiver__WrongWorkflowOwner();
    error NavReceiver__WrongWorkflowName();
    error NavReceiver__UnknownKind(uint8 kind);
    error NavReceiver__UnsupportedVersion(uint8 version);
    error NavReceiver__DuplicateIntent(bytes32 intentId);
    error NavReceiver__InvalidIntent();
    error NavReceiver__ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                               FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    constructor(ShareVault vault_, address forwarder_, address owner_) Ownable(owner_) {
        if (address(vault_) == address(0) || forwarder_ == address(0)) revert NavReceiver__ZeroAddress();
        VAULT = vault_;
        forwarder = forwarder_;
    }

    /*//////////////////////////////////////////////////////////////
                    USER-FACING STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NavReceiver__NotForwarder();
        _checkWorkflow(metadata);

        (uint8 kind, bytes memory body) = abi.decode(report, (uint8, bytes));
        if (kind == KIND_NAV) _handleNav(body);
        else if (kind == KIND_TOP_UP) _handleTopUp(body);
        else revert NavReceiver__UnknownKind(kind);
    }

    function setForwarder(address value) external onlyOwner {
        if (value == address(0)) revert NavReceiver__ZeroAddress();
        forwarder = value;
        emit ForwarderUpdated(value);
    }

    /// @notice A zero workflow id, owner or name disables that individual check.
    function setWorkflowIdentity(bytes32 workflowId, address workflowOwner, bytes10 workflowName) external onlyOwner {
        expectedWorkflowId = workflowId;
        expectedWorkflowOwner = workflowOwner;
        expectedWorkflowName = workflowName;
        emit WorkflowIdentityUpdated(workflowId, workflowOwner, workflowName);
    }

    /*//////////////////////////////////////////////////////////////
                    USER-FACING READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool supported) {
        supported = interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _handleNav(bytes memory body) internal {
        (
            uint8 version,
            uint64 closeId,
            uint64 observedAt,
            uint256 totalAssets,
            uint256 totalLiabilities,
            bytes32 sourcesHash
        ) = abi.decode(body, (uint8, uint64, uint64, uint256, uint256, bytes32));
        _checkVersion(version);
        emit NavReportReceived(closeId, observedAt, totalAssets, totalLiabilities, sourcesHash);
        VAULT.settleEpoch(closeId, totalAssets, totalLiabilities, observedAt);
    }

    function _handleTopUp(bytes memory body) internal {
        (
            uint8 version,
            bytes32 intentId,
            uint64 closeId,
            uint8 route,
            uint256 amount,
            uint16 marginRatioBps,
            uint8 reason
        ) = abi.decode(body, (uint8, bytes32, uint64, uint8, uint256, uint16, uint8));
        _checkVersion(version);
        if (route > MAX_ROUTE || reason > MAX_REASON || amount == 0) revert NavReceiver__InvalidIntent();
        if (topUpIntents[intentId].recordedAt != 0) revert NavReceiver__DuplicateIntent(intentId);
        topUpIntents[intentId] = TopUpIntent(closeId, uint64(block.timestamp), marginRatioBps, route, reason, amount);
        emit TopUpIntentRecorded(intentId, closeId, route, amount, marginRatioBps, reason);
    }

    /*//////////////////////////////////////////////////////////////
                     INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _checkVersion(uint8 version) internal pure {
        if (version != REPORT_VERSION) revert NavReceiver__UnsupportedVersion(version);
    }

    function _checkWorkflow(bytes calldata metadata) internal view {
        if (metadata.length < METADATA_MIN_LENGTH) revert NavReceiver__BadMetadata();
        bytes32 expectedId = expectedWorkflowId;
        address expectedOwner = expectedWorkflowOwner;
        bytes10 expectedName = expectedWorkflowName;
        if (expectedId != bytes32(0) && bytes32(metadata[0:METADATA_NAME_OFFSET]) != expectedId) {
            revert NavReceiver__WrongWorkflowId();
        }
        if (expectedName != bytes10(0) && bytes10(metadata[METADATA_NAME_OFFSET:METADATA_OWNER_OFFSET]) != expectedName)
        {
            revert NavReceiver__WrongWorkflowName();
        }
        if (
            expectedOwner != address(0)
                && address(bytes20(metadata[METADATA_OWNER_OFFSET:METADATA_MIN_LENGTH])) != expectedOwner
        ) {
            revert NavReceiver__WrongWorkflowOwner();
        }
    }
}
