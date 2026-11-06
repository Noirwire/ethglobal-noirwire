// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IMessageTransmitterV2} from "src/interfaces/IMessageTransmitterV2.sol";
import {ShareVault} from "src/ShareVault.sol";

/**
 * @title HookExecutor
 * @notice Receives Solana deposits through CCTP V2. The Solana burn names this contract as both
 * mint recipient and destination caller, so only this contract can deliver the message. The net
 * minted USDC is forwarded into the vault as a deposit request, or held as a claim when the
 * deadline passed or the vault refuses it. Hook data that cannot be decoded is quarantined for the
 * owner to release, because reverting would leave the attested message undeliverable forever.
 * @custom:security-contact security@noirwire.com
 */
contract HookExecutor is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                             STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    uint32 public constant SOLANA_DOMAIN = 5;
    uint32 public constant MESSAGE_VERSION = 1;
    uint8 public constant HOOK_VERSION = 1;

    uint256 internal constant HEADER_VERSION = 0;
    uint256 internal constant HEADER_SOURCE_DOMAIN = 4;
    uint256 internal constant HEADER_NONCE = 12;
    uint256 internal constant HEADER_SENDER = 44;
    uint256 internal constant HEADER_RECIPIENT = 76;
    uint256 internal constant HEADER_DESTINATION_CALLER = 108;
    uint256 internal constant BODY = 148;
    uint256 internal constant BODY_VERSION = BODY;
    uint256 internal constant BODY_BURN_TOKEN = BODY + 4;
    uint256 internal constant BODY_MINT_RECIPIENT = BODY + 36;
    uint256 internal constant BODY_AMOUNT = BODY + 68;
    uint256 internal constant BODY_FEE_EXECUTED = BODY + 164;
    uint256 internal constant BODY_HOOK_DATA = BODY + 228;
    uint256 internal constant WORD_SIZE = 32;
    uint256 internal constant HOOK_DATA_LENGTH = 128;
    uint256 internal constant HOOK_BENEFICIARY = 32;
    uint256 internal constant HOOK_DEPOSITOR = 64;
    uint256 internal constant HOOK_DEADLINE = 96;

    IMessageTransmitterV2 public immutable TRANSMITTER;
    IERC20 public immutable USDC;
    ShareVault public immutable VAULT;

    bytes32 public sourceTokenMessenger;
    bytes32 public sourceBurnToken;
    bytes32 public localTokenMessenger;

    mapping(bytes32 nonce => bool done) public processed;
    mapping(address beneficiary => uint256 amount) public claimable;
    mapping(bytes32 nonce => uint256 amount) public quarantined;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event DepositForwarded(bytes32 indexed nonce, address indexed beneficiary, bytes32 solanaDepositor, uint256 amount);
    event DepositHeld(
        bytes32 indexed nonce, address indexed beneficiary, bytes32 solanaDepositor, uint256 amount, bytes32 reason
    );
    event DepositQuarantined(bytes32 indexed nonce, uint256 amount);
    event QuarantineReleased(bytes32 indexed nonce, address indexed to, uint256 amount);
    event Claimed(address indexed beneficiary, uint256 amount);
    event SourceConfigUpdated(bytes32 sourceTokenMessenger, bytes32 sourceBurnToken, bytes32 localTokenMessenger);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error HookExecutor__AlreadyProcessed(bytes32 nonce);
    error HookExecutor__MessageTooShort();
    error HookExecutor__BadVersion();
    error HookExecutor__WrongSourceDomain(uint32 domain);
    error HookExecutor__WrongSourceSender();
    error HookExecutor__WrongBurnToken();
    error HookExecutor__WrongMintRecipient();
    error HookExecutor__WrongDestinationCaller();
    error HookExecutor__WrongLocalMessenger();
    error HookExecutor__ReceiveFailed();
    error HookExecutor__MintMismatch(uint256 expected, uint256 received);
    error HookExecutor__NothingToClaim();
    error HookExecutor__NothingQuarantined();
    error HookExecutor__ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                               FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    constructor(
        IMessageTransmitterV2 transmitter_,
        IERC20 usdc_,
        ShareVault vault_,
        bytes32 sourceTokenMessenger_,
        bytes32 sourceBurnToken_,
        bytes32 localTokenMessenger_,
        address owner_
    ) Ownable(owner_) {
        if (address(transmitter_) == address(0) || address(usdc_) == address(0) || address(vault_) == address(0)) {
            revert HookExecutor__ZeroAddress();
        }
        TRANSMITTER = transmitter_;
        USDC = usdc_;
        VAULT = vault_;
        sourceTokenMessenger = sourceTokenMessenger_;
        sourceBurnToken = sourceBurnToken_;
        localTokenMessenger = localTokenMessenger_;
    }

    /*//////////////////////////////////////////////////////////////
                    USER-FACING STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function relay(bytes calldata message, bytes calldata attestation) external nonReentrant {
        if (message.length < BODY_HOOK_DATA) revert HookExecutor__MessageTooShort();
        bytes32 nonce = _word(message, HEADER_NONCE);
        if (processed[nonce]) revert HookExecutor__AlreadyProcessed(nonce);
        processed[nonce] = true;

        _validateRoute(message);
        uint256 expectedNet = _uint(message, BODY_AMOUNT) - _uint(message, BODY_FEE_EXECUTED);

        uint256 balanceBefore = USDC.balanceOf(address(this));
        if (!TRANSMITTER.receiveMessage(message, attestation)) revert HookExecutor__ReceiveFailed();
        uint256 received = USDC.balanceOf(address(this)) - balanceBefore;
        if (received != expectedNet) revert HookExecutor__MintMismatch(expectedNet, received);

        _dispatch(nonce, message[BODY_HOOK_DATA:], received);
    }

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert HookExecutor__NothingToClaim();
        claimable[msg.sender] = 0;
        USDC.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function releaseQuarantined(bytes32 nonce, address to) external nonReentrant onlyOwner {
        if (to == address(0)) revert HookExecutor__ZeroAddress();
        uint256 amount = quarantined[nonce];
        if (amount == 0) revert HookExecutor__NothingQuarantined();
        quarantined[nonce] = 0;
        USDC.safeTransfer(to, amount);
        emit QuarantineReleased(nonce, to, amount);
    }

    function setSourceConfig(bytes32 sourceTokenMessenger_, bytes32 sourceBurnToken_, bytes32 localTokenMessenger_)
        external
        onlyOwner
    {
        sourceTokenMessenger = sourceTokenMessenger_;
        sourceBurnToken = sourceBurnToken_;
        localTokenMessenger = localTokenMessenger_;
        emit SourceConfigUpdated(sourceTokenMessenger_, sourceBurnToken_, localTokenMessenger_);
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _dispatch(bytes32 nonce, bytes calldata hookData, uint256 amount) internal {
        (bool valid, address beneficiary, bytes32 depositor, uint64 deadline) = _decodeHook(hookData);
        if (!valid) {
            quarantined[nonce] = amount;
            emit DepositQuarantined(nonce, amount);
            return;
        }
        if (block.timestamp > deadline) {
            _hold(nonce, beneficiary, depositor, amount, "DEADLINE_PASSED");
            return;
        }

        USDC.forceApprove(address(VAULT), amount);
        try VAULT.requestDeposit(amount, beneficiary) {
            emit DepositForwarded(nonce, beneficiary, depositor, amount);
        } catch {
            USDC.forceApprove(address(VAULT), 0);
            _hold(nonce, beneficiary, depositor, amount, "VAULT_REJECTED");
        }
    }

    function _hold(bytes32 nonce, address beneficiary, bytes32 depositor, uint256 amount, bytes32 reason) internal {
        claimable[beneficiary] += amount;
        emit DepositHeld(nonce, beneficiary, depositor, amount, reason);
    }

    /*//////////////////////////////////////////////////////////////
                     INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _validateRoute(bytes calldata message) internal view {
        if (_uint32(message, HEADER_VERSION) != MESSAGE_VERSION || _uint32(message, BODY_VERSION) != MESSAGE_VERSION) {
            revert HookExecutor__BadVersion();
        }
        uint32 sourceDomain = _uint32(message, HEADER_SOURCE_DOMAIN);
        if (sourceDomain != SOLANA_DOMAIN) revert HookExecutor__WrongSourceDomain(sourceDomain);
        bytes32 self = _toBytes32(address(this));
        if (_word(message, HEADER_SENDER) != sourceTokenMessenger) revert HookExecutor__WrongSourceSender();
        if (_word(message, HEADER_RECIPIENT) != localTokenMessenger) revert HookExecutor__WrongLocalMessenger();
        if (_word(message, HEADER_DESTINATION_CALLER) != self) revert HookExecutor__WrongDestinationCaller();
        if (_word(message, BODY_BURN_TOKEN) != sourceBurnToken) revert HookExecutor__WrongBurnToken();
        if (_word(message, BODY_MINT_RECIPIENT) != self) revert HookExecutor__WrongMintRecipient();
    }

    function _decodeHook(bytes calldata hookData)
        internal
        pure
        returns (bool valid, address beneficiary, bytes32 depositor, uint64 deadline)
    {
        if (hookData.length != HOOK_DATA_LENGTH) return (false, address(0), 0, 0);
        uint256 versionWord = _uint(hookData, 0);
        uint256 beneficiaryWord = _uint(hookData, HOOK_BENEFICIARY);
        uint256 deadlineWord = _uint(hookData, HOOK_DEADLINE);
        if (
            versionWord != HOOK_VERSION || beneficiaryWord == 0 || beneficiaryWord > type(uint160).max
                || deadlineWord > type(uint64).max
        ) {
            return (false, address(0), 0, 0);
        }
        return (true, address(uint160(beneficiaryWord)), _word(hookData, HOOK_DEPOSITOR), uint64(deadlineWord));
    }

    function _uint32(bytes calldata data, uint256 offset) internal pure returns (uint32 value) {
        value = uint32(bytes4(data[offset:offset + 4]));
    }

    function _word(bytes calldata data, uint256 offset) internal pure returns (bytes32 word) {
        word = bytes32(data[offset:offset + WORD_SIZE]);
    }

    function _uint(bytes calldata data, uint256 offset) internal pure returns (uint256 value) {
        value = uint256(_word(data, offset));
    }

    function _toBytes32(address value) internal pure returns (bytes32 word) {
        word = bytes32(uint256(uint160(value)));
    }
}
