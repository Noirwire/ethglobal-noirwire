// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {HedgeGuard} from "src/HedgeGuard.sol";
import {IAggregatorV3} from "src/interfaces/IAggregatorV3.sol";
import {IHedgeGuard} from "src/interfaces/IHedgeGuard.sol";
import {SwapQuery, SwapRegisters} from "src/interfaces/ISwapVmExtruction.sol";

abstract contract ForkBase is Test {
    address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address internal constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
    address internal constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant CHAINLINK_BTC_USD = 0x6ce185860a4963106506C203335A2910413708e9;

    uint32 internal constant MAX_AGE = 3600;
    uint16 internal constant MAX_DEVIATION_BPS = 300;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MIN_FILL = 1e5;
    uint256 internal constant PRICE_TO_USDC = 1e10;

    address internal owner = makeAddr("owner");
    address internal hedger = makeAddr("hedger");
    address internal maker = makeAddr("maker");
    address internal taker = makeAddr("taker");

    HedgeGuard internal guard;
    uint256 internal oracleE8;
    uint256 internal targetNonce;

    function setUp() public virtual {
        vm.createSelectFork(vm.envOr("AQUA_FORK_RPC", string("http://127.0.0.1:8546")));
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(CHAINLINK_BTC_USD).latestRoundData();
        vm.warp(updatedAt + 60);
        oracleE8 = uint256(answer);
        guard = new HedgeGuard(
            ROUTER,
            WBTC,
            USDC,
            owner,
            hedger,
            IHedgeGuard.OracleConfig({feed: CHAINLINK_BTC_USD, maxAge: MAX_AGE, maxDeviationBps: MAX_DEVIATION_BPS})
        );
    }

    function _setTarget(IHedgeGuard.Direction direction, uint64 size) internal {
        _setTargetWithExpiry(direction, size, uint40(block.timestamp + 1 days));
    }

    function _setTargetWithExpiry(IHedgeGuard.Direction direction, uint64 size, uint40 expiry) internal {
        ++targetNonce;
        _setTargetWithId(_currentId(), direction, size, expiry);
    }

    function _currentId() internal view returns (bytes32 targetId) {
        targetId = keccak256(abi.encode(targetNonce));
    }

    function _setTargetWithId(bytes32 targetId, IHedgeGuard.Direction direction, uint64 size, uint40 expiry) internal {
        vm.prank(hedger);
        guard.setTarget(
            maker, targetId, direction, size, uint64(oracleE8 * 95 / 100), uint64(oracleE8 * 105 / 100), expiry
        );
    }

    function _priceAt(int256 deviationBps) internal view returns (uint256 priceE8) {
        priceE8 = uint256(int256(oracleE8) * (int256(BPS) + deviationBps) / int256(BPS));
    }

    function _query(IHedgeGuard.Direction direction) internal view returns (SwapQuery memory query) {
        bool sells = direction == IHedgeGuard.Direction.MakerSellsBtc;
        query = SwapQuery({
            orderHash: keccak256("order"),
            maker: maker,
            taker: taker,
            tokenIn: sells ? USDC : WBTC,
            tokenOut: sells ? WBTC : USDC,
            isExactIn: true
        });
    }

    function _registers(IHedgeGuard.Direction direction, uint256 btc, uint256 priceE8)
        internal
        pure
        returns (SwapRegisters memory registers)
    {
        uint256 usdc = btc * priceE8;
        bool sells = direction == IHedgeGuard.Direction.MakerSellsBtc;
        usdc = sells ? (usdc + PRICE_TO_USDC - 1) / PRICE_TO_USDC : usdc / PRICE_TO_USDC;
        registers = SwapRegisters({
            balanceIn: 1e18,
            balanceOut: 1e18,
            amountIn: sells ? usdc : btc,
            amountOut: sells ? btc : usdc,
            amountNetPulled: 0
        });
    }

    function _swapAsRouter(SwapQuery memory query, SwapRegisters memory registers)
        internal
        returns (uint256 nextPC, uint256 chopped, SwapRegisters memory out)
    {
        vm.prank(ROUTER);
        (nextPC, chopped, out) = guard.extruction(false, 7, query, registers, "", "");
    }

    function _quote(SwapQuery memory query, SwapRegisters memory registers)
        internal
        view
        returns (bool ok, bytes memory data)
    {
        (ok, data) = address(guard).staticcall(abi.encodeCall(guard.extruction, (true, 7, query, registers, "", "")));
    }
}
