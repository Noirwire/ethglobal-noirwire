// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {ShareVault} from "src/ShareVault.sol";
import {NavReceiver} from "src/NavReceiver.sol";
import {HookExecutor} from "src/HookExecutor.sol";
import {IMessageTransmitterV2} from "src/interfaces/IMessageTransmitterV2.sol";
import {MockUSDC} from "test/mocks/MockUSDC.sol";
import {MockForwarder} from "test/mocks/MockForwarder.sol";
import {MockMessageTransmitterV2} from "test/mocks/MockMessageTransmitterV2.sol";

abstract contract Base is Test {
    uint256 internal constant USDC_UNIT = 1e6;
    uint256 internal constant SHARE_UNIT = 1e18;
    uint256 internal constant MAX_DEPOSIT = 500_000e6;
    uint32 internal constant ARC_DOMAIN = 26;
    uint256 internal constant ATTESTER_KEY = 0xA11CE5;
    bytes32 internal constant WORKFLOW_ID = keccak256("nav-workflow");
    bytes10 internal constant WORKFLOW_NAME = bytes10("navreport1");

    bytes32 internal constant DEPOSITOR = keccak256("solana-depositor");

    struct Msg {
        uint32 version;
        uint32 sourceDomain;
        bytes32 sender;
        bytes32 burnToken;
        bytes32 recipient;
        bytes32 destinationCaller;
        bytes32 mintRecipient;
        uint256 amount;
        uint256 feeExecuted;
        bytes hookData;
        bytes32 nonce;
    }

    MockUSDC internal usdc;
    ShareVault internal vault;
    NavReceiver internal receiver;
    MockForwarder internal forwarder;
    MockMessageTransmitterV2 internal transmitter;
    HookExecutor internal executor;

    address internal workflowOwner = makeAddr("workflowOwner");
    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal sourceMessenger = bytes32(uint256(0xBEEF));
    bytes32 internal sourceUsdcMint = bytes32(uint256(0xC0FFEE));
    bytes32 internal localMessenger = bytes32(uint256(0x5013));

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        vault = new ShareVault(usdc, address(this), feeRecipient);
        forwarder = new MockForwarder();
        receiver = new NavReceiver(vault, address(forwarder), address(this));
        receiver.setWorkflowIdentity(WORKFLOW_ID, workflowOwner, WORKFLOW_NAME);
        vault.setNavReceiver(address(receiver));
        vault.setOperator(operator);
        vault.setDestinationAllowed(treasury, true);
        vault.setMoveCaps(type(uint128).max, type(uint128).max);

        transmitter =
            new MockMessageTransmitterV2(usdc, vm.addr(ATTESTER_KEY), ARC_DOMAIN, makeAddr("feeSink"), address(this));
        executor = new HookExecutor(
            IMessageTransmitterV2(address(transmitter)),
            usdc,
            vault,
            sourceMessenger,
            sourceUsdcMint,
            localMessenger,
            address(this)
        );

        usdc.mint(alice, 10_000_000e6);
        usdc.mint(bob, 10_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.warp(block.timestamp + 1);
    }

    function _navReport(uint64 closeId, uint64 observedAt, uint256 assets, uint256 liabilities)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory body = abi.encode(uint8(1), closeId, observedAt, assets, liabilities, bytes32(uint256(1)));
        return abi.encode(uint8(1), body);
    }

    function _metadata(bytes32 id, bytes10 name, address workflowOwner_) internal pure returns (bytes memory) {
        return abi.encodePacked(id, name, workflowOwner_, bytes2(0x0001));
    }

    function _deliver(bytes memory report) internal {
        forwarder.deliver(address(receiver), WORKFLOW_ID, WORKFLOW_NAME, workflowOwner, report);
    }

    function _close(uint256 venueAssets, uint256 liabilities) internal {
        uint64 closeId = vault.currentEpoch();
        vm.warp(block.timestamp + 1);
        _deliver(_navReport(closeId, uint64(block.timestamp), vault.navCash() + venueAssets, liabilities));
    }

    function _closeAt(uint256 totalAssets) internal {
        vm.warp(block.timestamp + 1);
        _deliver(_navReport(vault.currentEpoch(), uint64(block.timestamp), totalAssets, 0));
    }

    function _deposit(address who, uint256 assets) internal {
        vm.prank(who);
        vault.requestDeposit(assets, who);
    }

    function _depositAndClaim(address who, uint256 assets) internal {
        _deposit(who, assets);
        _close(0, 0);
        vault.claimShares(who);
    }

    function _hook(address beneficiary, uint64 deadline) internal pure returns (bytes memory) {
        return abi.encode(uint8(1), beneficiary, DEPOSITOR, deadline);
    }

    function _default(uint256 amount, bytes memory hookData, bytes32 nonce) internal view returns (Msg memory m) {
        bytes32 self = bytes32(uint256(uint160(address(executor))));
        m = Msg({
            version: 1,
            sourceDomain: 5,
            sender: sourceMessenger,
            burnToken: sourceUsdcMint,
            recipient: localMessenger,
            destinationCaller: self,
            mintRecipient: self,
            amount: amount,
            feeExecuted: 0,
            hookData: hookData,
            nonce: nonce
        });
    }

    function _encode(Msg memory m) internal pure returns (bytes memory) {
        bytes memory header = abi.encodePacked(
            m.version,
            m.sourceDomain,
            ARC_DOMAIN,
            m.nonce,
            m.sender,
            m.recipient,
            m.destinationCaller,
            uint32(1000),
            uint32(2000)
        );
        bytes memory body = abi.encodePacked(
            uint32(1),
            m.burnToken,
            m.mintRecipient,
            m.amount,
            DEPOSITOR,
            uint256(0),
            m.feeExecuted,
            uint256(0),
            m.hookData
        );
        return bytes.concat(header, body);
    }

    function _sign(bytes memory message) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, keccak256(message));
        return abi.encodePacked(r, s, v);
    }

    function _relay(Msg memory m) internal {
        bytes memory message = _encode(m);
        executor.relay(message, _sign(message));
    }

    function _pendingDeposits() internal view returns (uint256) {
        return vault.epochDepositAssets(vault.currentEpoch());
    }

    function _valueOf(address who) internal view returns (uint256) {
        return vault.balanceOf(who) * vault.lastPrice() / 1e30;
    }
}
