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

    function setTarget(
        address maker,
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
