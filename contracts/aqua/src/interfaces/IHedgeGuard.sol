// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IExtruction} from "src/interfaces/ISwapVmExtruction.sol";

interface IHedgeGuard is IExtruction {
    enum Direction {
        None,
        MakerSellsBtc,
        MakerBuysBtc
    }

    struct Target {
        Direction direction;
        uint64 remaining;
        uint64 minPriceE8;
        uint64 maxPriceE8;
        uint40 expiry;
    }

    struct OracleConfig {
        address feed;
        uint32 maxAge;
        uint16 maxDeviationBps;
    }

    /// @notice Sets a maker's target. Re-sending the current `targetId` with the same direction, size and band is a
    /// no-op that keeps the remaining size; different terms under that id revert. A new id replaces the target.
    function setTarget(
        address maker,
        bytes32 targetId,
        Direction direction,
        uint64 size,
        uint64 minPriceE8,
        uint64 maxPriceE8,
        uint40 expiry
    ) external;

    function clearTarget(address maker) external;

    function setOracle(address feed, uint32 maxAge, uint16 maxDeviationBps) external;

    function setHedger(address newHedger) external;

    function targetOf(address maker) external view returns (Target memory target);
}
