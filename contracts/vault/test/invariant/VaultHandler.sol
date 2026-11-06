// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {ShareVault} from "src/ShareVault.sol";
import {MockUSDC} from "test/mocks/MockUSDC.sol";
import {MockForwarder} from "test/mocks/MockForwarder.sol";

contract VaultHandler is Test {
    uint256 internal constant MAX_AMOUNT = 1_000_000e6;
    uint256 internal constant ACTOR_COUNT = 3;

    ShareVault public immutable VAULT;
    MockUSDC public immutable USDC;
    MockForwarder public immutable FORWARDER;
    address public immutable RECEIVER;
    address public immutable OPERATOR;
    address public immutable TREASURY;
    address public immutable FEE_RECIPIENT;

    address[] public actors;
    uint256 public ghostMinted;
    uint256 public ghostBurned;
    uint256 public ghostVenue;
    uint256 public settledEpochs;

    constructor(
        ShareVault vault_,
        MockUSDC usdc_,
        MockForwarder forwarder_,
        address receiver_,
        address operator_,
        address treasury_,
        address feeRecipient_
    ) {
        VAULT = vault_;
        USDC = usdc_;
        FORWARDER = forwarder_;
        RECEIVER = receiver_;
        OPERATOR = operator_;
        TREASURY = treasury_;
        FEE_RECIPIENT = feeRecipient_;
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            address actor = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(actor);
            USDC.mint(actor, 100 * MAX_AMOUNT);
            vm.prank(actor);
            USDC.approve(address(vault_), type(uint256).max);
        }
    }

    function actorCount() external pure returns (uint256 count) {
        count = ACTOR_COUNT;
    }

    function deposit(uint256 actorSeed, uint256 assets) external {
        address actor = _actor(actorSeed);
        assets = bound(assets, 1, MAX_AMOUNT);
        vm.prank(actor);
        try VAULT.requestDeposit(assets, actor) {} catch {}
    }

    function cancelDeposit(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        try VAULT.cancelDeposit() {} catch {}
    }

    function claimShares(uint256 actorSeed) external {
        try VAULT.claimShares(_actor(actorSeed)) {} catch {}
    }

    function requestRedeem(uint256 actorSeed, uint256 fractionBps) external {
        address actor = _actor(actorSeed);
        uint256 balance = VAULT.balanceOf(actor);
        if (balance == 0) return;
        uint256 shares = balance * bound(fractionBps, 1, 10_000) / 10_000;
        if (shares == 0) shares = balance;
        vm.warp(block.timestamp + VAULT.lockupPeriod());
        vm.prank(actor);
        try VAULT.requestRedeem(shares, actor) {} catch {}
    }

    function cancelRedeem(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        try VAULT.cancelRedeem() {} catch {}
    }

    function claimAssets(uint256 actorSeed) external {
        try VAULT.claimAssets(_actor(actorSeed)) {} catch {}
    }

    function moveToVenue(uint256 amount) external {
        uint256 idle = VAULT.idleAssets();
        if (idle == 0) return;
        amount = bound(amount, 1, idle);
        vm.prank(OPERATOR);
        try VAULT.moveToVenue(TREASURY, amount) {
            ghostVenue += amount;
        } catch {}
    }

    function returnFromVenue(uint256 amount) external {
        if (ghostVenue == 0) return;
        amount = bound(amount, 1, ghostVenue);
        USDC.mint(address(VAULT), amount);
        vm.prank(OPERATOR);
        VAULT.acknowledgeReturn(amount);
        ghostVenue -= amount;
    }

    function donate(uint256 amount) external {
        USDC.mint(address(VAULT), bound(amount, 1, MAX_AMOUNT));
    }

    function settle(uint256 pnlSeed, uint256 liabilitySeed) external {
        vm.warp(block.timestamp + 1 hours);
        if (VAULT.requestsPaused()) {
            vm.prank(VAULT.owner());
            VAULT.acknowledgeDeviation();
        }
        uint64 epoch = VAULT.currentEpoch();
        uint256 pnlBps = bound(pnlSeed, 7_000, 13_000);
        uint256 venueValue = ghostVenue * pnlBps / 10_000;
        uint256 assets = VAULT.navCash() + venueValue;
        uint256 liabilities = bound(liabilitySeed, 0, assets / 10);
        uint256 depositAssets = VAULT.epochDepositAssets(epoch);
        uint256 feeBefore = VAULT.balanceOf(FEE_RECIPIENT);

        bytes memory body = abi.encode(uint8(1), epoch, uint64(block.timestamp), assets, liabilities, bytes32(0));
        try FORWARDER.deliver(RECEIVER, bytes32(0), bytes10(0), address(0), abi.encode(uint8(1), body)) {}
        catch {
            return;
        }
        if (VAULT.currentEpoch() == epoch) return;

        (,, uint256 price, uint256 filled) = VAULT.settlements(epoch);
        ++settledEpochs;
        ghostBurned += filled;
        ghostMinted += VAULT.balanceOf(FEE_RECIPIENT) - feeBefore;
        ghostMinted += depositAssets * 1e30 / price;
    }

    function _actor(uint256 seed) internal view returns (address actor) {
        actor = actors[seed % ACTOR_COUNT];
    }
}
