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
    }

    function _navReport(uint64 closeId, uint64 observedAt, uint256 assets, uint256 liabilities)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory body = abi.encode(uint8(1), closeId, observedAt, assets, liabilities, bytes32(uint256(1)));
        return abi.encode(uint8(1), body);
    }

    function _deliver(bytes memory report) internal {
        forwarder.deliver(address(receiver), WORKFLOW_ID, WORKFLOW_NAME, workflowOwner, report);
    }

    function _close(uint256 venueAssets, uint256 liabilities) internal {
        uint64 closeId = vault.currentEpoch();
        _deliver(_navReport(closeId, uint64(block.timestamp), vault.navCash() + venueAssets, liabilities));
    }

    function _closeAt(uint256 totalAssets) internal {
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

    function _valueOf(address who) internal view returns (uint256) {
        return vault.balanceOf(who) * vault.lastPrice() / 1e30;
    }
}
