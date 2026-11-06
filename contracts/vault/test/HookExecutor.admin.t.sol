// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {HookExecutor} from "src/HookExecutor.sol";
import {ShareVault} from "src/ShareVault.sol";
import {IMessageTransmitterV2} from "src/interfaces/IMessageTransmitterV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract HookExecutorAdminTest is Base {
    function test_RevertWhen_TheConstructorGetsAZeroAddress() external {
        IMessageTransmitterV2 t = IMessageTransmitterV2(address(transmitter));
        vm.expectRevert(HookExecutor.HookExecutor__ZeroAddress.selector);
        new HookExecutor(IMessageTransmitterV2(address(0)), usdc, vault, bytes32(0), bytes32(0), bytes32(0), address(this));
        vm.expectRevert(HookExecutor.HookExecutor__ZeroAddress.selector);
        new HookExecutor(t, IERC20(address(0)), vault, bytes32(0), bytes32(0), bytes32(0), address(this));
        vm.expectRevert(HookExecutor.HookExecutor__ZeroAddress.selector);
        new HookExecutor(t, usdc, ShareVault(address(0)), bytes32(0), bytes32(0), bytes32(0), address(this));
    }

    function test_WhenTheArgumentsAreValid_StoresThem() external view {
        assertEq(address(executor.TRANSMITTER()), address(transmitter));
        assertEq(address(executor.USDC()), address(usdc));
        assertEq(address(executor.VAULT()), address(vault));
        assertEq(executor.sourceTokenMessenger(), sourceMessenger);
        assertEq(executor.sourceBurnToken(), sourceUsdcMint);
        assertEq(executor.localTokenMessenger(), localMessenger);
    }

    function testFuzz_RevertWhen_TheCallerHasNoClaim(address caller) external {
        vm.prank(caller);
        vm.expectRevert(HookExecutor.HookExecutor__NothingToClaim.selector);
        executor.claim();
    }

    function testFuzz_WhenTheCallerHasAClaim_PaysItOnce(uint256 amount) external {
        amount = bound(amount, 1, MAX_DEPOSIT);
        _relayExpired(alice, amount, bytes32(uint256(1)));

        vm.startPrank(alice);
        uint256 before = usdc.balanceOf(alice);
        executor.claim();
        assertEq(usdc.balanceOf(alice) - before, amount);
        vm.expectRevert(HookExecutor.HookExecutor__NothingToClaim.selector);
        executor.claim();
        vm.stopPrank();
    }

    function testFuzz_RevertWhen_ReleaseCallerIsNotTheOwner(address caller) external {
        vm.assume(caller != address(this));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        executor.releaseQuarantined(bytes32(0), caller);
    }

    function test_RevertWhen_TheReleaseDestinationIsZero() external {
        vm.expectRevert(HookExecutor.HookExecutor__ZeroAddress.selector);
        executor.releaseQuarantined(bytes32(0), address(0));
    }

    function testFuzz_RevertWhen_NothingIsQuarantinedUnderTheNonce(bytes32 nonce) external {
        vm.expectRevert(HookExecutor.HookExecutor__NothingQuarantined.selector);
        executor.releaseQuarantined(nonce, alice);
    }

    function testFuzz_WhenUsdcIsQuarantined_SendsItOnce(uint256 amount, address destination) external {
        vm.assume(destination != address(0) && destination != address(executor));
        amount = bound(amount, 1, MAX_DEPOSIT);
        bytes32 nonce = bytes32(uint256(7));
        _relay(hex"1234", amount, nonce);
        assertEq(executor.quarantined(nonce), amount);

        uint256 before = usdc.balanceOf(destination);
        executor.releaseQuarantined(nonce, destination);
        assertEq(usdc.balanceOf(destination) - before, amount);
        vm.expectRevert(HookExecutor.HookExecutor__NothingQuarantined.selector);
        executor.releaseQuarantined(nonce, destination);
    }

    function testFuzz_RevertWhen_SourceConfigCallerIsNotTheOwner(address caller) external {
        vm.assume(caller != address(this));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        executor.setSourceConfig(bytes32(0), bytes32(0), bytes32(0));
    }

    function testFuzz_WhenTheCallerIsTheOwner_StoresTheNewRoute(bytes32 a, bytes32 b, bytes32 c) external {
        executor.setSourceConfig(a, b, c);
        assertEq(executor.sourceTokenMessenger(), a);
        assertEq(executor.sourceBurnToken(), b);
        assertEq(executor.localTokenMessenger(), c);
    }

    function _relayExpired(address beneficiary, uint256 amount, bytes32 nonce) internal {
        _relay(abi.encode(uint8(1), beneficiary, bytes32(0), uint64(block.timestamp - 1)), amount, nonce);
    }

    function _relay(bytes memory hookData, uint256 amount, bytes32 nonce) internal {
        bytes32 self = bytes32(uint256(uint160(address(executor))));
        bytes memory header = abi.encodePacked(
            uint32(1), uint32(5), ARC_DOMAIN, nonce, sourceMessenger, localMessenger, self, uint32(1000), uint32(2000)
        );
        bytes memory body = abi.encodePacked(
            uint32(1), sourceUsdcMint, self, amount, bytes32(0), uint256(0), uint256(0), uint256(0), hookData
        );
        bytes memory message = bytes.concat(header, body);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, keccak256(message));
        executor.relay(message, abi.encodePacked(r, s, v));
    }
}
