// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {HedgeGuard} from "src/HedgeGuard.sol";
import {IAggregatorV3} from "src/interfaces/IAggregatorV3.sol";
import {IHedgeGuard} from "src/interfaces/IHedgeGuard.sol";
import {SwapQuery, SwapRegisters} from "src/interfaces/ISwapVmExtruction.sol";
import {ForkBase} from "test/utils/ForkBase.sol";

contract HedgeGuardTest is ForkBase {
    uint64 internal constant SIZE = 5e8;

    function _direction(bool sells) internal pure returns (IHedgeGuard.Direction direction) {
        direction = sells ? IHedgeGuard.Direction.MakerSellsBtc : IHedgeGuard.Direction.MakerBuysBtc;
    }

    function _mockFeed(int256 answer, uint256 updatedAt, uint8 feedDecimals) internal {
        vm.mockCall(
            CHAINLINK_BTC_USD,
            abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(uint80(1), answer, updatedAt, updatedAt, uint80(1))
        );
        vm.mockCall(
            CHAINLINK_BTC_USD, abi.encodeWithSelector(IAggregatorV3.decimals.selector), abi.encode(feedDecimals)
        );
    }

    /*//////////////////////////////////////////////////////////////
                               EXTRUCTION
    //////////////////////////////////////////////////////////////*/

    function testFuzz_QuoteEqualsSwap(bool sells, uint256 btc, int256 deviationBps) public {
        IHedgeGuard.Direction direction = _direction(sells);
        btc = bound(btc, MIN_FILL, SIZE);
        deviationBps = bound(deviationBps, -250, 250);
        _setTarget(direction, SIZE);
        SwapQuery memory query = _query(direction);
        SwapRegisters memory registers = _registers(direction, btc, _priceAt(deviationBps));

        (bool ok, bytes memory quoted) = _quote(query, registers);
        assertTrue(ok);
        assertEq(guard.targetOf(maker).remaining, SIZE);

        (uint256 nextPC, uint256 chopped, SwapRegisters memory out) = _swapAsRouter(query, registers);
        assertEq(quoted, abi.encode(nextPC, chopped, out));
        assertEq(nextPC, 7);
        assertEq(chopped, 0);
        assertEq(out.amountIn, registers.amountIn);
        assertEq(out.amountOut, registers.amountOut);
        assertEq(guard.targetOf(maker).remaining, SIZE - btc);
    }

    function testFuzz_RevertWhen_WrongDirection(bool sells, uint256 btc) public {
        IHedgeGuard.Direction direction = _direction(sells);
        IHedgeGuard.Direction reversed = _direction(!sells);
        btc = bound(btc, MIN_FILL, SIZE);
        _setTarget(direction, SIZE);
        SwapQuery memory wrongQuery = _query(reversed);
        SwapRegisters memory registers = _registers(reversed, btc, _priceAt(0));

        bytes memory expected = abi.encodeWithSelector(
            HedgeGuard.HedgeGuard__WrongDirection.selector, wrongQuery.tokenIn, wrongQuery.tokenOut
        );
        (bool ok, bytes memory data) = _quote(wrongQuery, registers);
        assertFalse(ok);
        assertEq(data, expected);

        vm.expectRevert(expected);
        _swapAsRouter(wrongQuery, registers);
    }

    function testFuzz_RevertWhen_UnrelatedTokenPair(bool sells, address tokenIn, address tokenOut) public {
        IHedgeGuard.Direction direction = _direction(sells);
        _setTarget(direction, SIZE);
        SwapQuery memory query = _query(direction);
        vm.assume(tokenIn != query.tokenIn || tokenOut != query.tokenOut);
        query.tokenIn = tokenIn;
        query.tokenOut = tokenOut;
        SwapRegisters memory registers = _registers(direction, 1e8, _priceAt(0));

        vm.expectRevert(abi.encodeWithSelector(HedgeGuard.HedgeGuard__WrongDirection.selector, tokenIn, tokenOut));
        _swapAsRouter(query, registers);
    }

    function testFuzz_RevertWhen_Overfill(bool sells, uint256 extra) public {
        IHedgeGuard.Direction direction = _direction(sells);
        extra = bound(extra, 1, 1e8);
        _setTarget(direction, SIZE);
        SwapRegisters memory registers = _registers(direction, SIZE + extra, _priceAt(0));
        bytes memory expected =
            abi.encodeWithSelector(HedgeGuard.HedgeGuard__SizeExceedsRemaining.selector, SIZE + extra, SIZE);

        (bool ok, bytes memory data) = _quote(_query(direction), registers);
        assertFalse(ok);
        assertEq(data, expected);

        vm.expectRevert(expected);
        _swapAsRouter(_query(direction), registers);
    }

    function testFuzz_PartialFillsDecrementRemaining(bool sells, uint256 first, uint256 second) public {
        IHedgeGuard.Direction direction = _direction(sells);
        first = bound(first, MIN_FILL, SIZE - MIN_FILL);
        second = bound(second, MIN_FILL, SIZE - first);
        _setTarget(direction, SIZE);
        SwapQuery memory query = _query(direction);

        _swapAsRouter(query, _registers(direction, first, _priceAt(0)));
        assertEq(guard.targetOf(maker).remaining, SIZE - first);

        _swapAsRouter(query, _registers(direction, second, _priceAt(0)));
        uint64 remaining = guard.targetOf(maker).remaining;
        assertEq(remaining, SIZE - first - second);

        if (remaining < type(uint64).max) {
            SwapRegisters memory tooMuch = _registers(direction, uint256(remaining) + 1, _priceAt(0));
            vm.expectRevert(
                abi.encodeWithSelector(
                    HedgeGuard.HedgeGuard__SizeExceedsRemaining.selector, uint256(remaining) + 1, remaining
                )
            );
            _swapAsRouter(query, tooMuch);
        }
    }

    function testFuzz_RevertWhen_TargetExpired(bool sells, uint256 lateBy) public {
        IHedgeGuard.Direction direction = _direction(sells);
        lateBy = bound(lateBy, 1, 30 minutes);
        uint40 expiry = uint40(block.timestamp + 10 minutes);
        _setTargetWithExpiry(direction, SIZE, expiry);
        vm.warp(expiry + lateBy);
        _mockFeed(int256(oracleE8), block.timestamp, 8);
        SwapRegisters memory registers = _registers(direction, 1e8, _priceAt(0));

        vm.expectRevert(abi.encodeWithSelector(HedgeGuard.HedgeGuard__TargetExpired.selector, expiry));
        _swapAsRouter(_query(direction), registers);
    }

    function testFuzz_RevertWhen_FillAtExpiryBoundary(bool sells) public {
        IHedgeGuard.Direction direction = _direction(sells);
        uint40 expiry = uint40(block.timestamp + 10 minutes);
        _setTargetWithExpiry(direction, SIZE, expiry);
        vm.warp(expiry);
        _mockFeed(int256(oracleE8), block.timestamp, 8);

        vm.expectRevert(abi.encodeWithSelector(HedgeGuard.HedgeGuard__TargetExpired.selector, expiry));
        _swapAsRouter(_query(direction), _registers(direction, 1e8, _priceAt(0)));
    }

    function testFuzz_FillOneSecondBeforeExpirySucceeds(bool sells) public {
        IHedgeGuard.Direction direction = _direction(sells);
        uint40 expiry = uint40(block.timestamp + 10 minutes);
        _setTargetWithExpiry(direction, SIZE, expiry);
        vm.warp(expiry - 1);
        _mockFeed(int256(oracleE8), block.timestamp, 8);

        _swapAsRouter(_query(direction), _registers(direction, 1e8, _priceAt(0)));
        assertEq(guard.targetOf(maker).remaining, SIZE - 1e8);
    }

    function testFuzz_RevertWhen_FeedStale(bool sells, uint256 extraAge) public {
        IHedgeGuard.Direction direction = _direction(sells);
        extraAge = bound(extraAge, 1, 30 days);
        _setTarget(direction, SIZE);
        uint256 updatedAt = block.timestamp - MAX_AGE - extraAge;
        _mockFeed(int256(oracleE8), updatedAt, 8);
        SwapRegisters memory registers = _registers(direction, 1e8, _priceAt(0));
        bytes memory expected = abi.encodeWithSelector(HedgeGuard.HedgeGuard__OracleStale.selector, updatedAt, MAX_AGE);

        (bool ok, bytes memory data) = _quote(_query(direction), registers);
        assertFalse(ok);
        assertEq(data, expected);

        vm.expectRevert(expected);
        _swapAsRouter(_query(direction), registers);
    }

    function testFuzz_FeedAtExactMaxAgeIsFresh(bool sells) public {
        IHedgeGuard.Direction direction = _direction(sells);
        _setTarget(direction, SIZE);
        _mockFeed(int256(oracleE8), block.timestamp - MAX_AGE, 8);

        _swapAsRouter(_query(direction), _registers(direction, 1e8, _priceAt(0)));
        assertEq(guard.targetOf(maker).remaining, SIZE - 1e8);
    }

    function testFuzz_RevertWhen_FeedAnswerNotPositive(bool sells, uint256 magnitude) public {
        IHedgeGuard.Direction direction = _direction(sells);
        int256 answer = -int256(bound(magnitude, 0, uint256(type(int256).max)));
        _setTarget(direction, SIZE);
        _mockFeed(answer, block.timestamp, 8);

        vm.expectRevert(abi.encodeWithSelector(HedgeGuard.HedgeGuard__OracleInvalid.selector, answer));
        _swapAsRouter(_query(direction), _registers(direction, 1e8, _priceAt(0)));
    }

    function testFuzz_FeedDecimalsAreScaledToE8(uint8 feedDecimals) public {
        feedDecimals = uint8(bound(feedDecimals, 2, 24));
        int256 answer = feedDecimals >= 8
            ? int256(oracleE8 * 10 ** (feedDecimals - 8))
            : int256(oracleE8 / 10 ** (8 - feedDecimals));
        _mockFeed(answer, block.timestamp, feedDecimals);

        uint256 expected =
            feedDecimals >= 8 ? oracleE8 : (oracleE8 / 10 ** (8 - feedDecimals)) * 10 ** (8 - feedDecimals);
        assertEq(guard.oraclePriceE8(), expected);
    }

    function testFuzz_ScaledFeedStillGatesFills(bool sells, uint8 feedDecimals) public {
        IHedgeGuard.Direction direction = _direction(sells);
        feedDecimals = uint8(bound(feedDecimals, 8, 24));
        _setTarget(direction, SIZE);
        _mockFeed(int256(oracleE8 * 10 ** (feedDecimals - 8)), block.timestamp, feedDecimals);

        _swapAsRouter(_query(direction), _registers(direction, 1e8, _priceAt(0)));
        assertEq(guard.targetOf(maker).remaining, SIZE - 1e8);
    }

    function testFuzz_RevertWhen_PriceOutsideBand(bool sells, bool tooHigh, uint256 beyondBps) public {
        IHedgeGuard.Direction direction = _direction(sells);
        beyondBps = bound(beyondBps, 600, 5000);
        _setTarget(direction, SIZE);
        int256 deviation = tooHigh ? int256(beyondBps) : -int256(beyondBps);
        SwapRegisters memory registers = _registers(direction, 1e8, _priceAt(deviation));

        (bool ok, bytes memory data) = _quote(_query(direction), registers);
        assertFalse(ok);
        assertEq(bytes4(data), HedgeGuard.HedgeGuard__PriceOutsideBand.selector);

        vm.expectPartialRevert(HedgeGuard.HedgeGuard__PriceOutsideBand.selector);
        _swapAsRouter(_query(direction), registers);
    }

    function testFuzz_RevertWhen_PriceFarFromOracleButInsideBand(bool sells, uint256 farBps) public {
        IHedgeGuard.Direction direction = _direction(sells);
        farBps = bound(farBps, uint256(MAX_DEVIATION_BPS) + 20, 450);
        _setTarget(direction, SIZE);
        SwapRegisters memory registers = _registers(direction, 1e8, _priceAt(int256(farBps)));

        vm.expectPartialRevert(HedgeGuard.HedgeGuard__PriceFarFromOracle.selector);
        _swapAsRouter(_query(direction), registers);
    }

    function testFuzz_RevertWhen_OracleMovesAwayFromFill(bool sells, uint256 movedBps) public {
        IHedgeGuard.Direction direction = _direction(sells);
        movedBps = bound(movedBps, 400, 900);
        _setTarget(direction, SIZE);
        _mockFeed(int256(oracleE8 * (BPS + movedBps) / BPS), block.timestamp, 8);

        vm.expectPartialRevert(HedgeGuard.HedgeGuard__PriceFarFromOracle.selector);
        _swapAsRouter(_query(direction), _registers(direction, 1e8, _priceAt(0)));
    }

    function testFuzz_RevertWhen_CancelRace(bool sells, uint256 btc) public {
        IHedgeGuard.Direction direction = _direction(sells);
        btc = bound(btc, MIN_FILL, SIZE);
        _setTarget(direction, SIZE);
        SwapQuery memory query = _query(direction);
        SwapRegisters memory registers = _registers(direction, btc, _priceAt(0));

        (bool quoted,) = _quote(query, registers);
        assertTrue(quoted);

        vm.prank(hedger);
        guard.clearTarget(maker);

        bytes memory expected = abi.encodeWithSelector(HedgeGuard.HedgeGuard__TargetNotSet.selector, maker);
        (bool ok, bytes memory data) = _quote(query, registers);
        assertFalse(ok);
        assertEq(data, expected);
        vm.expectRevert(expected);
        _swapAsRouter(query, registers);
    }

    function testFuzz_RevertWhen_AmountsNotComputed(bool sells, bool zeroIn) public {
        IHedgeGuard.Direction direction = _direction(sells);
        _setTarget(direction, SIZE);
        SwapRegisters memory registers = _registers(direction, 1e8, _priceAt(0));
        if (zeroIn) {
            registers.amountIn = 0;
        } else {
            registers.amountOut = 0;
        }

        vm.expectRevert(HedgeGuard.HedgeGuard__AmountsNotComputed.selector);
        _swapAsRouter(_query(direction), registers);
    }

    function testFuzz_RevertWhen_SwapCallerIsNotRouter(address caller) public {
        vm.assume(caller != ROUTER);
        _setTarget(IHedgeGuard.Direction.MakerSellsBtc, SIZE);
        SwapQuery memory query = _query(IHedgeGuard.Direction.MakerSellsBtc);
        SwapRegisters memory registers = _registers(IHedgeGuard.Direction.MakerSellsBtc, 1e8, _priceAt(0));

        vm.prank(caller);
        vm.expectRevert(HedgeGuard.HedgeGuard__OnlyRouter.selector);
        guard.extruction(false, 0, query, registers, "", "");
        assertEq(guard.targetOf(maker).remaining, SIZE);
    }

    function testFuzz_RevertWhen_TargetNeverSet(address otherMaker) public {
        vm.assume(otherMaker != maker);
        SwapQuery memory query = _query(IHedgeGuard.Direction.MakerSellsBtc);
        query.maker = otherMaker;
        SwapRegisters memory registers = _registers(IHedgeGuard.Direction.MakerSellsBtc, 1e8, _priceAt(0));

        vm.expectRevert(abi.encodeWithSelector(HedgeGuard.HedgeGuard__TargetNotSet.selector, otherMaker));
        _swapAsRouter(query, registers);
    }

    /*//////////////////////////////////////////////////////////////
                                SETTERS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_RevertWhen_SetTargetByNonHedger(address caller) public {
        vm.assume(caller != hedger);
        vm.prank(caller);
        vm.expectRevert(HedgeGuard.HedgeGuard__OnlyHedger.selector);
        guard.setTarget(
            maker, keccak256("id"), IHedgeGuard.Direction.MakerSellsBtc, SIZE, 1, 2, uint40(block.timestamp + 1)
        );
    }

    function testFuzz_RevertWhen_ClearTargetByNonHedger(address caller) public {
        vm.assume(caller != hedger);
        vm.prank(caller);
        vm.expectRevert(HedgeGuard.HedgeGuard__OnlyHedger.selector);
        guard.clearTarget(maker);
    }

    function testFuzz_RevertWhen_SetTargetInvalid(uint64 size, uint64 minPrice, uint64 maxPrice, uint40 expiry) public {
        bool valid = size != 0 && minPrice != 0 && minPrice <= maxPrice && expiry > block.timestamp;
        vm.assume(!valid);
        vm.prank(hedger);
        vm.expectRevert(HedgeGuard.HedgeGuard__InvalidTarget.selector);
        guard.setTarget(maker, keccak256("id"), IHedgeGuard.Direction.MakerSellsBtc, size, minPrice, maxPrice, expiry);
    }

    function test_RevertWhen_SetTargetDirectionNone() public {
        vm.prank(hedger);
        vm.expectRevert(HedgeGuard.HedgeGuard__InvalidTarget.selector);
        guard.setTarget(maker, keccak256("id"), IHedgeGuard.Direction.None, SIZE, 1, 2, uint40(block.timestamp + 1));
    }

    function testFuzz_SetTargetOverwritesRemaining(uint64 firstSize, uint64 secondSize) public {
        firstSize = uint64(bound(firstSize, 1, type(uint64).max));
        secondSize = uint64(bound(secondSize, 1, type(uint64).max));
        _setTarget(IHedgeGuard.Direction.MakerSellsBtc, firstSize);
        _setTarget(IHedgeGuard.Direction.MakerBuysBtc, secondSize);

        IHedgeGuard.Target memory target = guard.targetOf(maker);
        assertEq(target.remaining, secondSize);
        assertEq(uint8(target.direction), uint8(IHedgeGuard.Direction.MakerBuysBtc));
    }

    function test_RetryingSetTargetAfterPartialFillKeepsRemaining() public {
        IHedgeGuard.Direction direction = IHedgeGuard.Direction.MakerSellsBtc;
        _setTarget(direction, SIZE);
        _swapAsRouter(_query(direction), _registers(direction, 2e8, _priceAt(0)));
        assertEq(guard.targetOf(maker).remaining, SIZE - 2e8);

        _setTargetWithId(_currentId(), direction, SIZE, uint40(block.timestamp + 2 days));
        IHedgeGuard.Target memory target = guard.targetOf(maker);
        assertEq(target.remaining, SIZE - 2e8);
        assertEq(target.expiry, block.timestamp + 1 days);
    }

    function _expectConflictOnCurrentId(uint64 size, uint64 minPriceE8) internal {
        vm.prank(hedger);
        vm.expectRevert(abi.encodeWithSelector(HedgeGuard.HedgeGuard__TargetIdConflict.selector, _currentId()));
        guard.setTarget(
            maker,
            _currentId(),
            IHedgeGuard.Direction.MakerSellsBtc,
            size,
            minPriceE8,
            uint64(oracleE8 * 105 / 100),
            uint40(block.timestamp + 1 days)
        );
    }

    function test_RevertWhen_SameTargetIdWithDifferentSize() public {
        _setTarget(IHedgeGuard.Direction.MakerSellsBtc, SIZE);
        _expectConflictOnCurrentId(SIZE + 1, uint64(oracleE8 * 95 / 100));
    }

    function test_RevertWhen_SameTargetIdWithDifferentBand() public {
        _setTarget(IHedgeGuard.Direction.MakerSellsBtc, SIZE);
        _expectConflictOnCurrentId(SIZE, uint64(oracleE8 * 90 / 100));
    }

    function test_NewTargetIdRefillsAfterPartialFill() public {
        IHedgeGuard.Direction direction = IHedgeGuard.Direction.MakerSellsBtc;
        _setTarget(direction, SIZE);
        _swapAsRouter(_query(direction), _registers(direction, 2e8, _priceAt(0)));

        _setTargetWithId(keccak256("refill"), direction, SIZE, uint40(block.timestamp + 1 days));
        assertEq(guard.targetOf(maker).remaining, SIZE);
    }

    function test_RevertWhen_SetTargetZeroId() public {
        vm.prank(hedger);
        vm.expectRevert(HedgeGuard.HedgeGuard__InvalidTarget.selector);
        guard.setTarget(maker, bytes32(0), IHedgeGuard.Direction.MakerSellsBtc, SIZE, 1, 2, uint40(block.timestamp + 1));
    }

    function testFuzz_RevertWhen_OracleConfigByNonOwner(address caller) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert();
        guard.setOracle(CHAINLINK_BTC_USD, MAX_AGE, MAX_DEVIATION_BPS);
    }

    function testFuzz_OwnerConfiguresOracle(address feed, uint32 maxAge, uint16 maxDeviationBps) public {
        vm.assume(feed != address(0) && maxAge != 0 && maxDeviationBps != 0 && maxDeviationBps <= 10_000);
        vm.prank(owner);
        guard.setOracle(feed, maxAge, maxDeviationBps);

        (address storedFeed, uint32 storedAge, uint16 storedDeviation) = guard.oracleConfig();
        assertEq(storedFeed, feed);
        assertEq(storedAge, maxAge);
        assertEq(storedDeviation, maxDeviationBps);
    }

    function testFuzz_RevertWhen_OracleConfigInvalid(address feed, uint32 maxAge, uint16 maxDeviationBps) public {
        vm.assume(feed == address(0) || maxAge == 0 || maxDeviationBps == 0 || maxDeviationBps > 10_000);
        vm.prank(owner);
        vm.expectRevert(HedgeGuard.HedgeGuard__InvalidOracleConfig.selector);
        guard.setOracle(feed, maxAge, maxDeviationBps);
    }

    function testFuzz_OwnerRotatesHedger(address newHedger) public {
        vm.assume(newHedger != address(0) && newHedger != hedger);
        vm.prank(owner);
        guard.setHedger(newHedger);

        vm.prank(hedger);
        vm.expectRevert(HedgeGuard.HedgeGuard__OnlyHedger.selector);
        guard.clearTarget(maker);

        vm.prank(newHedger);
        guard.clearTarget(maker);
    }

    function test_RevertWhen_HedgerRotatedToZero() public {
        vm.prank(owner);
        vm.expectRevert(HedgeGuard.HedgeGuard__ZeroAddress.selector);
        guard.setHedger(address(0));
    }

    function testFuzz_OwnershipTransferIsTwoStep(address newOwner) public {
        vm.assume(newOwner != address(0) && newOwner != owner);
        vm.prank(owner);
        guard.transferOwnership(newOwner);
        assertEq(guard.owner(), owner);

        vm.prank(newOwner);
        guard.acceptOwnership();
        assertEq(guard.owner(), newOwner);
    }

    function test_RevertWhen_ConstructedWithZeroAddress() public {
        IHedgeGuard.OracleConfig memory config =
            IHedgeGuard.OracleConfig({feed: CHAINLINK_BTC_USD, maxAge: MAX_AGE, maxDeviationBps: MAX_DEVIATION_BPS});
        vm.expectRevert(HedgeGuard.HedgeGuard__ZeroAddress.selector);
        new HedgeGuard(address(0), WBTC, USDC, owner, hedger, config);
        vm.expectRevert(HedgeGuard.HedgeGuard__ZeroAddress.selector);
        new HedgeGuard(ROUTER, address(0), USDC, owner, hedger, config);
        vm.expectRevert(HedgeGuard.HedgeGuard__ZeroAddress.selector);
        new HedgeGuard(ROUTER, WBTC, address(0), owner, hedger, config);
        vm.expectRevert(HedgeGuard.HedgeGuard__ZeroAddress.selector);
        new HedgeGuard(ROUTER, WBTC, USDC, owner, address(0), config);
    }
}
