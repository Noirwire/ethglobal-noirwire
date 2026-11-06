// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {ShareVault} from "src/ShareVault.sol";
import {NavReceiver} from "src/NavReceiver.sol";
import {HookExecutor} from "src/HookExecutor.sol";
import {IMessageTransmitterV2} from "src/interfaces/IMessageTransmitterV2.sol";
import {MockUSDC} from "test/mocks/MockUSDC.sol";
import {MockForwarder} from "test/mocks/MockForwarder.sol";
import {MockMessageTransmitterV2} from "test/mocks/MockMessageTransmitterV2.sol";

/// @notice Deploys the vault stack with mocks to a local anvil and writes deployments/local.json.
/// Run: forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --account <keystore> --sender <address>
/// The admin is the broadcasting account; on a local chain that is acceptable.
contract DeployLocal is Script {
    uint32 internal constant ARC_DOMAIN = 26;
    uint256 internal constant DEFAULT_MOVE_CAP = 1_000_000e6;
    string internal constant OUT_FILE = "deployments/local.json";

    /// @dev Public anvil account #1 address, used as the local test attester unless ATTESTER_ADDRESS is set.
    address internal constant DEFAULT_LOCAL_ATTESTER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    function run() external returns (ShareVault vault, NavReceiver receiver, HookExecutor executor) {
        address attester = vm.envOr("ATTESTER_ADDRESS", DEFAULT_LOCAL_ATTESTER);
        address operator = vm.envOr("OPERATOR", msg.sender);
        address treasury = vm.envOr("TREASURY_EXECUTOR", msg.sender);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", msg.sender);
        bytes32 solanaTokenMessenger = vm.envOr("SOLANA_TOKEN_MESSENGER", keccak256("noirwire.local.solana.tokenMessenger"));
        bytes32 solanaUsdcMint = vm.envOr("SOLANA_USDC_MINT", keccak256("noirwire.local.solana.usdcMint"));
        address tokenMessenger = address(uint160(uint256(keccak256("noirwire.local.arc.tokenMessengerV2"))));

        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        MockForwarder forwarder = new MockForwarder();
        MockMessageTransmitterV2 transmitter =
            new MockMessageTransmitterV2(usdc, attester, ARC_DOMAIN, feeRecipient, msg.sender);

        vault = new ShareVault(usdc, msg.sender, feeRecipient);
        receiver = new NavReceiver(vault, address(forwarder), msg.sender);
        executor = new HookExecutor(
            IMessageTransmitterV2(address(transmitter)),
            usdc,
            vault,
            solanaTokenMessenger,
            solanaUsdcMint,
            bytes32(uint256(uint160(tokenMessenger))),
            msg.sender
        );

        vault.setNavReceiver(address(receiver));
        vault.setOperator(operator);
        vault.setDestinationAllowed(treasury, true);
        vault.setMoveCaps(DEFAULT_MOVE_CAP, DEFAULT_MOVE_CAP);
        vm.stopBroadcast();

        _writeAddresses(usdc, vault, receiver, executor, transmitter, tokenMessenger, forwarder);
        console2.log("ShareVault", address(vault));
        console2.log("NavReceiver", address(receiver));
        console2.log("HookExecutor", address(executor));
    }

    function _writeAddresses(
        MockUSDC usdc,
        ShareVault vault,
        NavReceiver receiver,
        HookExecutor executor,
        MockMessageTransmitterV2 transmitter,
        address tokenMessenger,
        MockForwarder forwarder
    ) internal {
        string memory key = "local";
        vm.serializeString(key, "network", "arc-local");
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "usdc", address(usdc));
        vm.serializeAddress(key, "shareVault", address(vault));
        vm.serializeAddress(key, "navReceiver", address(receiver));
        vm.serializeAddress(key, "hookExecutor", address(executor));
        vm.serializeAddress(key, "messageTransmitterV2", address(transmitter));
        vm.serializeAddress(key, "tokenMessengerV2", tokenMessenger);
        string memory json = vm.serializeAddress(key, "creForwarder", address(forwarder));
        vm.writeJson(json, OUT_FILE);
    }
}
