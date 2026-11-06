// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

struct SwapQuery {
    bytes32 orderHash;
    address maker;
    address taker;
    address tokenIn;
    address tokenOut;
    bool isExactIn;
}

struct SwapRegisters {
    uint256 balanceIn;
    uint256 balanceOut;
    uint256 amountIn;
    uint256 amountOut;
    uint256 amountNetPulled;
}

interface IExtruction {
    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata takerData
    ) external returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap);
}
