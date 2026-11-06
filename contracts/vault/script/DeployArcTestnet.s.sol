// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ShareVault} from "src/ShareVault.sol";
import {NavReceiver} from "src/NavReceiver.sol";
import {HookExecutor} from "src/HookExecutor.sol";
import {IMessageTransmitterV2} from "src/interfaces/IMessageTransmitterV2.sol";

/// @notice Deploys the vault stack to Arc testnet against the real USDC, CCTP V2 and CRE forwarder.
/// Run (do not broadcast without review):
///   forge script script/DeployArcTestnet.s.sol --rpc-url https://rpc.testnet.arc.network --account <keystore> --sender <address>
/// Keys come from a Foundry keystore, never from the environment. ADMIN defaults to the broadcasting
/// EOA, which is acceptable on testnet only; a mainnet deployment must use a multisig admin and an audit.
/// TREASURY_EXECUTOR is the bridge's Arc treasury address (the address of its ARC_OPERATOR_KEY) and is
/// allowlisted as a move destination. OPERATOR must be that same address so the bridge can call
/// moveToVenue and acknowledgeReturn. MOVE_CAP_PER_CALL and MOVE_CAP_PER_EPOCH are USDC base units
/// (6 decimals); when unset they stay zero and the vault moves nothing.
contract DeployArcTestnet is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    string internal constant OUT_FILE = "deployments/arc-testnet.json";

    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant MESSAGE_TRANSMITTER_V2 = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;
    address internal constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address internal constant CRE_KEYSTONE_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    uint32 internal constant SOLANA_DOMAIN = 5;
    uint32 internal constant ETHEREUM_SEPOLIA_DOMAIN = 0;
    uint32 internal constant ARBITRUM_SEPOLIA_DOMAIN = 3;
    uint32 internal constant BASE_SEPOLIA_DOMAIN = 6;
    address internal constant ETHEREUM_SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address internal constant ARBITRUM_SEPOLIA_USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    error DeployArcTestnet__WrongChain(uint256 chainId);

    function run() external returns (ShareVault vault, NavReceiver receiver, HookExecutor executor) {
        if (block.chainid != ARC_TESTNET_CHAIN_ID) revert DeployArcTestnet__WrongChain(block.chainid);

        address admin = vm.envOr("ADMIN", msg.sender);
        address operator = vm.envOr("OPERATOR", admin);
        address treasury = vm.envAddress("TREASURY_EXECUTOR");
        address feeRecipient = vm.envOr("FEE_RECIPIENT", admin);
        address forwarder = vm.envOr("CRE_FORWARDER", CRE_KEYSTONE_FORWARDER);
        address workflowOwner = vm.envAddress("WORKFLOW_OWNER");
        bytes32 workflowId = vm.envOr("WORKFLOW_ID", bytes32(0));
        bytes10 workflowName = bytes10(vm.envOr("WORKFLOW_NAME", bytes32(0)));
        bytes32 solanaTokenMessenger = vm.envBytes32("SOLANA_TOKEN_MESSENGER");
        bytes32 solanaUsdcMint = vm.envBytes32("SOLANA_USDC_MINT");

        vm.startBroadcast();
        vault = new ShareVault(IERC20(ARC_USDC), msg.sender, feeRecipient);
        receiver = new NavReceiver(vault, forwarder, msg.sender);
        executor = new HookExecutor(
            IMessageTransmitterV2(MESSAGE_TRANSMITTER_V2),
            IERC20(ARC_USDC),
            vault,
            _sources(solanaTokenMessenger, solanaUsdcMint),
            _word(TOKEN_MESSENGER_V2),
            msg.sender
        );

        receiver.setWorkflowIdentity(workflowId, workflowOwner, workflowName);
        vault.setNavReceiver(address(receiver));
        vault.setOperator(operator);
        vault.setDestinationAllowed(treasury, true);
        vault.setMoveCaps(vm.envOr("MOVE_CAP_PER_CALL", uint256(0)), vm.envOr("MOVE_CAP_PER_EPOCH", uint256(0)));
        if (admin != msg.sender) {
            vault.transferOwnership(admin);
            receiver.transferOwnership(admin);
            executor.transferOwnership(admin);
        }
        vm.stopBroadcast();

        console2.log("ShareVault", address(vault));
        console2.log("NavReceiver", address(receiver));
        console2.log("HookExecutor", address(executor));
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) _writeAddresses(vault, receiver, executor, forwarder);
    }

    function _sources(bytes32 solanaTokenMessenger, bytes32 solanaUsdcMint)
        internal
        pure
        returns (HookExecutor.SourceRoute[] memory sources)
    {
        bytes32 evmMessenger = _word(TOKEN_MESSENGER_V2);
        sources = new HookExecutor.SourceRoute[](4);
        sources[0] = HookExecutor.SourceRoute(SOLANA_DOMAIN, solanaTokenMessenger, solanaUsdcMint);
        sources[1] = HookExecutor.SourceRoute(ETHEREUM_SEPOLIA_DOMAIN, evmMessenger, _word(ETHEREUM_SEPOLIA_USDC));
        sources[2] = HookExecutor.SourceRoute(ARBITRUM_SEPOLIA_DOMAIN, evmMessenger, _word(ARBITRUM_SEPOLIA_USDC));
        sources[3] = HookExecutor.SourceRoute(BASE_SEPOLIA_DOMAIN, evmMessenger, _word(BASE_SEPOLIA_USDC));
    }

    function _word(address value) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(value)));
    }

    function _writeAddresses(ShareVault vault, NavReceiver receiver, HookExecutor executor, address forwarder)
        internal
    {
        string memory key = "arcTestnet";
        vm.serializeString(key, "network", "arc-testnet");
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "usdc", ARC_USDC);
        vm.serializeAddress(key, "shareVault", address(vault));
        vm.serializeAddress(key, "navReceiver", address(receiver));
        vm.serializeAddress(key, "hookExecutor", address(executor));
        vm.serializeAddress(key, "messageTransmitterV2", MESSAGE_TRANSMITTER_V2);
        vm.serializeAddress(key, "tokenMessengerV2", TOKEN_MESSENGER_V2);
        string memory json = vm.serializeAddress(key, "creForwarder", forwarder);
        vm.writeJson(json, OUT_FILE);
    }
}
