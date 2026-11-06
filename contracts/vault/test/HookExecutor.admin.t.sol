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
        HookExecutor.SourceRoute[] memory none = new HookExecutor.SourceRoute[](0);
        vm.expectRevert(HookExecutor.HookExecutor__ZeroAddress.selector);
        new HookExecutor(IMessageTransmitterV2(address(0)), usdc, vault, none, bytes32(0), address(this));
        vm.expectRevert(HookExecutor.HookExecutor__ZeroAddress.selector);
        new HookExecutor(t, IERC20(address(0)), vault, none, bytes32(0), address(this));
        vm.expectRevert(HookExecutor.HookExecutor__ZeroAddress.selector);
        new HookExecutor(t, usdc, ShareVault(address(0)), none, bytes32(0), address(this));
    }

    function test_RevertWhen_TheConstructorGetsAnInvalidOrDuplicateSource() external {
        IMessageTransmitterV2 t = IMessageTransmitterV2(address(transmitter));
        HookExecutor.SourceRoute[] memory sources = new HookExecutor.SourceRoute[](1);
        sources[0] = HookExecutor.SourceRoute(BASE_DOMAIN, bytes32(0), baseUsdc);
        vm.expectRevert(abi.encodeWithSelector(HookExecutor.HookExecutor__InvalidSource.selector, BASE_DOMAIN));
        new HookExecutor(t, usdc, vault, sources, localMessenger, address(this));

        sources[0] = HookExecutor.SourceRoute(BASE_DOMAIN, evmMessenger, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(HookExecutor.HookExecutor__InvalidSource.selector, BASE_DOMAIN));
        new HookExecutor(t, usdc, vault, sources, localMessenger, address(this));

        sources = new HookExecutor.SourceRoute[](2);
        sources[0] = HookExecutor.SourceRoute(BASE_DOMAIN, evmMessenger, baseUsdc);
        sources[1] = HookExecutor.SourceRoute(BASE_DOMAIN, evmMessenger, sepoliaUsdc);
        vm.expectRevert(abi.encodeWithSelector(HookExecutor.HookExecutor__DuplicateSource.selector, BASE_DOMAIN));
        new HookExecutor(t, usdc, vault, sources, localMessenger, address(this));
    }

    function test_WhenTheArgumentsAreValid_StoresThem() external view {
        assertEq(address(executor.TRANSMITTER()), address(transmitter));
        assertEq(address(executor.USDC()), address(usdc));
        assertEq(address(executor.VAULT()), address(vault));
        assertEq(executor.sourceTokenMessenger(SOLANA_DOMAIN), sourceMessenger);
        assertEq(executor.sourceBurnToken(SOLANA_DOMAIN), sourceUsdcMint);
        assertEq(executor.sourceTokenMessenger(SEPOLIA_DOMAIN), evmMessenger);
        assertEq(executor.sourceBurnToken(SEPOLIA_DOMAIN), sepoliaUsdc);
        assertEq(executor.sourceTokenMessenger(BASE_DOMAIN), evmMessenger);
        assertEq(executor.sourceBurnToken(BASE_DOMAIN), baseUsdc);
        assertEq(executor.sourceTokenMessenger(ARBITRUM_DOMAIN), evmMessenger);
        assertEq(executor.sourceBurnToken(ARBITRUM_DOMAIN), arbitrumUsdc);
        assertEq(executor.sourceTokenMessenger(99), bytes32(0));
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
        _relay(_default(amount, hex"1234", nonce));
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
        executor.setSourceConfig(BASE_DOMAIN, bytes32(0), bytes32(0));
    }

    function testFuzz_WhenTheCallerIsTheOwner_StoresTheNewRoute(uint32 domain, bytes32 a, bytes32 b) external {
        vm.assume(a != 0 && b != 0);
        executor.setSourceConfig(domain, a, b);
        assertEq(executor.sourceTokenMessenger(domain), a);
        assertEq(executor.sourceBurnToken(domain), b);
    }

    function test_WhenTheOwnerDelistsADomain_RefusesItsMessages() external {
        executor.setSourceConfig(BASE_DOMAIN, bytes32(0), bytes32(0));
        Msg memory m = _from(BASE_DOMAIN, evmMessenger, baseUsdc, 1e6, _hook(alice, uint64(block.timestamp + 1)), "n");
        bytes memory message = _encode(m);
        bytes memory attestation = _sign(message);
        vm.expectRevert(abi.encodeWithSelector(HookExecutor.HookExecutor__WrongSourceDomain.selector, BASE_DOMAIN));
        executor.relay(message, attestation);
    }

    function test_RevertWhen_OnlyOneHalfOfASourceIsSet() external {
        vm.expectRevert(abi.encodeWithSelector(HookExecutor.HookExecutor__InvalidSource.selector, BASE_DOMAIN));
        executor.setSourceConfig(BASE_DOMAIN, evmMessenger, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(HookExecutor.HookExecutor__InvalidSource.selector, BASE_DOMAIN));
        executor.setSourceConfig(BASE_DOMAIN, bytes32(0), baseUsdc);
    }

    function testFuzz_RevertWhen_LocalMessengerCallerIsNotTheOwner(address caller) external {
        vm.assume(caller != address(this));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        executor.setLocalTokenMessenger(bytes32(0));
    }

    function testFuzz_WhenTheCallerIsTheOwner_StoresTheLocalMessenger(bytes32 messenger) external {
        executor.setLocalTokenMessenger(messenger);
        assertEq(executor.localTokenMessenger(), messenger);
    }

    function _relayExpired(address beneficiary, uint256 amount, bytes32 nonce) internal {
        _relay(_default(amount, _hook(beneficiary, uint64(block.timestamp - 1)), nonce));
    }
}
