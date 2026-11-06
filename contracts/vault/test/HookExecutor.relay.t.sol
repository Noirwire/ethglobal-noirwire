// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Base} from "test/Base.t.sol";
import {HookExecutor} from "src/HookExecutor.sol";
import {MockMessageTransmitterV2} from "test/mocks/MockMessageTransmitterV2.sol";

contract HookExecutorRelayTest is Base {
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

    function _expectRevertRelay(Msg memory m, bytes memory expected) internal {
        bytes memory message = _encode(m);
        bytes memory attestation = _sign(message);
        vm.expectRevert(expected);
        executor.relay(message, attestation);
    }

    function testFuzz_RevertWhen_TheMessageIsShorterThanABurnMessage(bytes calldata message) external {
        vm.assume(message.length < 376);
        vm.expectRevert(HookExecutor.HookExecutor__MessageTooShort.selector);
        executor.relay(message, hex"00");
    }

    function testFuzz_RevertWhen_TheMessageVersionIsWrong(uint32 version, bytes32 nonce) external {
        vm.assume(version != 1);
        Msg memory m = _default(1e6, _hook(alice, uint64(block.timestamp + 1)), nonce);
        m.version = version;
        _expectRevertRelay(m, abi.encodeWithSelector(HookExecutor.HookExecutor__BadVersion.selector));
    }

    function testFuzz_RevertWhen_TheSourceDomainIsNotSolana(uint32 domain, bytes32 nonce) external {
        vm.assume(domain != 5);
        Msg memory m = _default(1e6, _hook(alice, uint64(block.timestamp + 1)), nonce);
        m.sourceDomain = domain;
        _expectRevertRelay(m, abi.encodeWithSelector(HookExecutor.HookExecutor__WrongSourceDomain.selector, domain));
    }

    function testFuzz_RevertWhen_TheHeaderSenderIsWrong(bytes32 sender, bytes32 nonce) external {
        vm.assume(sender != sourceMessenger);
        Msg memory m = _default(1e6, _hook(alice, uint64(block.timestamp + 1)), nonce);
        m.sender = sender;
        _expectRevertRelay(m, abi.encodeWithSelector(HookExecutor.HookExecutor__WrongSourceSender.selector));
    }

    function testFuzz_RevertWhen_TheHeaderRecipientIsWrong(bytes32 recipient, bytes32 nonce) external {
        vm.assume(recipient != localMessenger);
        Msg memory m = _default(1e6, _hook(alice, uint64(block.timestamp + 1)), nonce);
        m.recipient = recipient;
        _expectRevertRelay(m, abi.encodeWithSelector(HookExecutor.HookExecutor__WrongLocalMessenger.selector));
    }

    function testFuzz_RevertWhen_TheDestinationCallerIsNotTheExecutor(bytes32 caller, bytes32 nonce) external {
        vm.assume(caller != bytes32(uint256(uint160(address(executor)))));
        Msg memory m = _default(1e6, _hook(alice, uint64(block.timestamp + 1)), nonce);
        m.destinationCaller = caller;
        _expectRevertRelay(m, abi.encodeWithSelector(HookExecutor.HookExecutor__WrongDestinationCaller.selector));
    }

    function testFuzz_RevertWhen_TheBurnTokenIsWrong(bytes32 token, bytes32 nonce) external {
        vm.assume(token != sourceUsdcMint);
        Msg memory m = _default(1e6, _hook(alice, uint64(block.timestamp + 1)), nonce);
        m.burnToken = token;
        _expectRevertRelay(m, abi.encodeWithSelector(HookExecutor.HookExecutor__WrongBurnToken.selector));
    }

    function testFuzz_RevertWhen_TheMintRecipientIsNotTheExecutor(bytes32 recipient, bytes32 nonce) external {
        vm.assume(recipient != bytes32(uint256(uint160(address(executor)))));
        Msg memory m = _default(1e6, _hook(alice, uint64(block.timestamp + 1)), nonce);
        m.mintRecipient = recipient;
        _expectRevertRelay(m, abi.encodeWithSelector(HookExecutor.HookExecutor__WrongMintRecipient.selector));
    }

    function testFuzz_RevertWhen_TheAttestationIsInvalid(uint256 wrongKey, bytes32 nonce) external {
        wrongKey = bound(wrongKey, 1, 1e30);
        vm.assume(wrongKey != ATTESTER_KEY);
        vm.assume(nonce != bytes32(0));
        Msg memory m = _default(1e6, _hook(alice, uint64(block.timestamp + 1)), nonce);
        bytes memory message = _encode(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, keccak256(message));

        vm.expectRevert(MockMessageTransmitterV2.MockMessageTransmitterV2__NotAttester.selector);
        executor.relay(message, abi.encodePacked(r, s, v));
        assertFalse(executor.processed(nonce));
    }

    function testFuzz_RevertWhen_TheMessageWasAlreadyProcessed(bytes32 nonce, uint256 amount) external {
        vm.assume(nonce != bytes32(0));
        amount = bound(amount, 1, MAX_DEPOSIT);
        Msg memory m = _default(amount, _hook(alice, uint64(block.timestamp + 1)), nonce);
        _relay(m);
        _expectRevertRelay(m, abi.encodeWithSelector(HookExecutor.HookExecutor__AlreadyProcessed.selector, nonce));
    }

    function testFuzz_WhenValid_CreditsTheNetMintedAmountAfterTheFee(uint256 amount, uint256 fee, bytes32 nonce)
        external
    {
        vm.assume(nonce != bytes32(0));
        amount = bound(amount, 2, MAX_DEPOSIT);
        fee = bound(fee, 0, amount - 1);
        Msg memory m = _default(amount, _hook(alice, uint64(block.timestamp + 1)), nonce);
        m.feeExecuted = fee;

        vm.expectEmit(true, true, false, true, address(executor));
        emit HookExecutor.DepositForwarded(nonce, alice, DEPOSITOR, amount - fee);
        _relay(m);

        (, uint192 pending) = vault.depositRequests(alice);
        assertEq(pending, amount - fee);
        assertEq(usdc.balanceOf(address(vault)), amount - fee);
        assertEq(usdc.balanceOf(address(executor)), 0);
    }

    function testFuzz_GivenTheDeadlineHasPassed_HoldsTheUsdcAsAClaim(uint256 amount, uint64 lateBy, bytes32 nonce)
        external
    {
        vm.assume(nonce != bytes32(0));
        amount = bound(amount, 1, MAX_DEPOSIT);
        lateBy = uint64(bound(lateBy, 1, 365 days));
        Msg memory m = _default(amount, _hook(alice, uint64(block.timestamp) - lateBy), nonce);

        vm.expectEmit(true, true, false, true, address(executor));
        emit HookExecutor.DepositHeld(nonce, alice, DEPOSITOR, amount, "DEADLINE_PASSED");
        _relay(m);

        assertEq(executor.claimable(alice), amount);
        (, uint192 pending) = vault.depositRequests(alice);
        assertEq(pending, 0);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        executor.claim();
        assertEq(usdc.balanceOf(alice) - before, amount);
    }

    function testFuzz_GivenTheVaultRejectsTheDeposit_HoldsTheUsdcAsAClaim(uint256 amount, uint256 lateness, bytes32 nonce)
        external
    {
        vm.assume(nonce != bytes32(0));
        amount = bound(amount, 1, MAX_DEPOSIT);
        lateness = bound(lateness, 1, 365 days);
        vm.warp(block.timestamp + vault.maxEpochGap() + lateness);
        Msg memory m = _default(amount, _hook(bob, uint64(block.timestamp + 1 hours)), nonce);

        vm.expectEmit(true, true, false, true, address(executor));
        emit HookExecutor.DepositHeld(nonce, bob, DEPOSITOR, amount, "VAULT_REJECTED");
        _relay(m);

        assertEq(executor.claimable(bob), amount);
        assertEq(usdc.allowance(address(executor), address(vault)), 0);
        assertEq(usdc.balanceOf(address(executor)), amount);
    }

    function testFuzz_GivenTheVaultAcceptsTheDeposit_SharesAreClaimableByTheBeneficiary(uint256 amount, bytes32 nonce)
        external
    {
        vm.assume(nonce != bytes32(0));
        amount = bound(amount, 1, MAX_DEPOSIT);
        _relay(_default(amount, _hook(alice, uint64(block.timestamp + 1)), nonce));
        assertTrue(executor.processed(nonce));

        _close(0, 0);
        vault.claimShares(alice);
        assertEq(vault.balanceOf(alice), amount * 1e12);
    }

    function testFuzz_GivenMalformedHookData_QuarantinesTheUsdc(uint256 amount, bytes calldata junk, bytes32 nonce)
        external
    {
        vm.assume(nonce != bytes32(0));
        vm.assume(junk.length != 128);
        amount = bound(amount, 1, MAX_DEPOSIT);
        _relay(_default(amount, junk, nonce));
        assertEq(executor.quarantined(nonce), amount);
        assertEq(usdc.balanceOf(address(executor)), amount);
    }

    function testFuzz_GivenAZeroBeneficiaryOrWrongHookVersion_QuarantinesTheUsdc(uint8 version, bytes32 nonce)
        external
    {
        vm.assume(nonce != bytes32(0));
        _relay(_default(10e6, abi.encode(uint8(1), address(0), DEPOSITOR, uint64(block.timestamp + 1)), nonce));
        assertEq(executor.quarantined(nonce), 10e6);

        vm.assume(version != 1);
        bytes32 nonce2 = keccak256(abi.encode(nonce));
        _relay(_default(10e6, abi.encode(version, alice, DEPOSITOR, uint64(block.timestamp + 1)), nonce2));
        assertEq(executor.quarantined(nonce2), 10e6);
    }

    function testFuzz_WhenSignaturesAreRequired_ThresholdAndOrderingAreEnforced(bytes32 nonce) external {
        vm.assume(nonce != bytes32(0));
        uint256 keyB = 0xB0B;
        transmitter.setAttester(vm.addr(keyB), true);
        transmitter.setSignatureThreshold(2);
        bytes memory message = _encode(_default(1e6, _hook(alice, uint64(block.timestamp + 1)), nonce));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(ATTESTER_KEY, keccak256(message));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(keyB, keccak256(message));
        bool aFirst = vm.addr(ATTESTER_KEY) < vm.addr(keyB);
        bytes memory sorted =
            aFirst ? abi.encodePacked(r1, s1, v1, r2, s2, v2) : abi.encodePacked(r2, s2, v2, r1, s1, v1);
        bytes memory unsorted =
            aFirst ? abi.encodePacked(r2, s2, v2, r1, s1, v1) : abi.encodePacked(r1, s1, v1, r2, s2, v2);

        vm.expectRevert(MockMessageTransmitterV2.MockMessageTransmitterV2__InvalidAttestationLength.selector);
        executor.relay(message, _sign(message));
        vm.expectRevert(MockMessageTransmitterV2.MockMessageTransmitterV2__InvalidSignatureOrderOrDupe.selector);
        executor.relay(message, unsorted);
        executor.relay(message, sorted);
        assertTrue(executor.processed(nonce));
    }
}
