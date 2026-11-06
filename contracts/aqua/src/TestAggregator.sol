// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IAggregatorV3} from "src/interfaces/IAggregatorV3.sol";

/**
 * @title TestAggregator
 * @notice NOT CHAINLINK. A labelled stand-in feed for long local-fork demo sessions, where the forked
 * Chainlink answer stops updating and would trip the staleness check. Never deploy to a public network.
 * @custom:security-contact security@noirwire.com
 */
contract TestAggregator is IAggregatorV3 {
    /*//////////////////////////////////////////////////////////////
                               STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    uint8 internal constant FEED_DECIMALS = 8;
    string internal constant LABEL = "TEST AGGREGATOR, NOT CHAINLINK: local fork only";

    address public immutable UPDATER;

    uint80 public round;
    int256 public answer;
    uint256 public updatedAt;

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event AnswerUpdated(int256 answer, uint80 round, uint256 updatedAt);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error TestAggregator__ZeroAddress();
    error TestAggregator__OnlyUpdater();
    error TestAggregator__NonPositiveAnswer();

    /*//////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address updater, int256 initialAnswer) {
        if (updater == address(0)) {
            revert TestAggregator__ZeroAddress();
        }
        UPDATER = updater;
        _update(initialAnswer);
    }

    /*//////////////////////////////////////////////////////////////
                     USER-FACING STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function setAnswer(int256 newAnswer) external {
        if (msg.sender != UPDATER) {
            revert TestAggregator__OnlyUpdater();
        }
        _update(newAnswer);
    }

    /*//////////////////////////////////////////////////////////////
                      USER-FACING READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function decimals() external pure returns (uint8 feedDecimals) {
        feedDecimals = FEED_DECIMALS;
    }

    function description() external pure returns (string memory label) {
        label = LABEL;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 latestAnswer,
            uint256 startedAt,
            uint256 latestUpdatedAt,
            uint80 answeredInRound
        )
    {
        roundId = round;
        latestAnswer = answer;
        startedAt = updatedAt;
        latestUpdatedAt = updatedAt;
        answeredInRound = round;
    }

    /*//////////////////////////////////////////////////////////////
                     INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _update(int256 newAnswer) internal {
        if (newAnswer <= 0) {
            revert TestAggregator__NonPositiveAnswer();
        }
        ++round;
        answer = newAnswer;
        updatedAt = block.timestamp;
        emit AnswerUpdated(newAnswer, round, block.timestamp);
    }
}
