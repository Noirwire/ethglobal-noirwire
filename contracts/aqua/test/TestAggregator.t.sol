// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {TestAggregator} from "src/TestAggregator.sol";

contract TestAggregatorTest is Test {
    address internal updater = makeAddr("updater");

    function testFuzz_ConstructorSeedsTheFeed(int256 initial) public {
        initial = bound(initial, 1, type(int128).max);
        TestAggregator feed = new TestAggregator(updater, initial);

        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(roundId, 1);
        assertEq(answer, initial);
        assertEq(updatedAt, block.timestamp);
        assertEq(feed.decimals(), 8);
    }

    function test_DescriptionSaysItIsNotChainlink() public {
        TestAggregator feed = new TestAggregator(updater, 1);
        assertGt(bytes(feed.description()).length, 0);
        assertEq(keccak256(bytes(feed.description())), keccak256("TEST AGGREGATOR, NOT CHAINLINK: local fork only"));
    }

    function testFuzz_UpdaterRefreshesTimestampAndRound(int256 next, uint256 later) public {
        next = bound(next, 1, type(int128).max);
        later = bound(later, 1, 365 days);
        TestAggregator feed = new TestAggregator(updater, 5);
        vm.warp(block.timestamp + later);

        vm.prank(updater);
        feed.setAnswer(next);

        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(roundId, 2);
        assertEq(answer, next);
        assertEq(updatedAt, block.timestamp);
    }

    function testFuzz_RevertWhen_CallerIsNotUpdater(address caller) public {
        vm.assume(caller != updater);
        TestAggregator feed = new TestAggregator(updater, 5);
        vm.prank(caller);
        vm.expectRevert(TestAggregator.TestAggregator__OnlyUpdater.selector);
        feed.setAnswer(6);
    }

    function testFuzz_RevertWhen_AnswerNotPositive(uint256 magnitude) public {
        int256 bad = -int256(bound(magnitude, 0, uint256(type(int256).max)));
        TestAggregator feed = new TestAggregator(updater, 5);
        vm.prank(updater);
        vm.expectRevert(TestAggregator.TestAggregator__NonPositiveAnswer.selector);
        feed.setAnswer(bad);
    }

    function test_RevertWhen_UpdaterIsZero() public {
        vm.expectRevert(TestAggregator.TestAggregator__ZeroAddress.selector);
        new TestAggregator(address(0), 5);
    }
}
