// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {HedgeGuard} from "src/HedgeGuard.sol";
import {IHedgeGuard} from "src/interfaces/IHedgeGuard.sol";
import {ForkBase} from "test/utils/ForkBase.sol";

contract HedgeGuardHandler is ForkBase {
    uint256 public increasesWithoutSetter;
    uint256 public wrongWayFillsAccepted;
    uint256 public fillsAboveRemaining;
    uint256 public acceptedFills;
    uint64 public lastSetSize;

    function init(HedgeGuard deployedGuard, uint256 oracle) external {
        guard = deployedGuard;
        oracleE8 = oracle;
    }

    function setTarget(bool sells, uint64 size) external {
        size = uint64(bound(size, 1, 100e8));
        IHedgeGuard.Direction direction =
            sells ? IHedgeGuard.Direction.MakerSellsBtc : IHedgeGuard.Direction.MakerBuysBtc;
        _setTarget(direction, size);
        lastSetSize = size;
    }

    function clearTarget() external {
        vm.prank(hedger);
        guard.clearTarget(maker);
    }

    function fill(bool sells, uint256 btc, int256 deviationBps) external {
        IHedgeGuard.Direction direction =
            sells ? IHedgeGuard.Direction.MakerSellsBtc : IHedgeGuard.Direction.MakerBuysBtc;
        btc = bound(btc, MIN_FILL, 120e8);
        deviationBps = bound(deviationBps, -250, 250);
        uint64 before = guard.targetOf(maker).remaining;
        IHedgeGuard.Direction targetDirection = guard.targetOf(maker).direction;

        vm.prank(ROUTER);
        try guard.extruction(false, 0, _query(direction), _registers(direction, btc, _priceAt(deviationBps)), "", "") {
            ++acceptedFills;
            if (direction != targetDirection) {
                ++wrongWayFillsAccepted;
            }
            if (btc > before) {
                ++fillsAboveRemaining;
            }
            if (guard.targetOf(maker).remaining > before) {
                ++increasesWithoutSetter;
            }
        } catch {}
    }
}

contract HedgeGuardInvariantTest is StdInvariant, ForkBase {
    HedgeGuardHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new HedgeGuardHandler();
        handler.init(guard, oracleE8);
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = HedgeGuardHandler.setTarget.selector;
        selectors[1] = HedgeGuardHandler.clearTarget.selector;
        selectors[2] = HedgeGuardHandler.fill.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function test_HandlerReachesAnAcceptedFillAndAWrongWayAttempt() public {
        handler.setTarget(true, 10e8);
        handler.fill(true, 1e8, 0);
        assertEq(handler.acceptedFills(), 1);
        assertEq(guard.targetOf(maker).remaining, 9e8);

        handler.fill(false, 1e8, 0);
        assertEq(handler.acceptedFills(), 1);
        assertEq(guard.targetOf(maker).remaining, 9e8);
    }

    function invariant_RemainingNeverIncreasesOutsideSetter() public view {
        assertEq(handler.increasesWithoutSetter(), 0);
    }

    function invariant_NoWrongWayFillSucceeds() public view {
        assertEq(handler.wrongWayFillsAccepted(), 0);
    }

    function invariant_NoFillAboveRemainingSucceeds() public view {
        assertEq(handler.fillsAboveRemaining(), 0);
    }

    function invariant_RemainingNeverExceedsLastAuthorizedSize() public view {
        assertLe(guard.targetOf(maker).remaining, handler.lastSetSize());
    }
}
