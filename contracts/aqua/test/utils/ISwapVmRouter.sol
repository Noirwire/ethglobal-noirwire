// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

interface IAqua {
    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        returns (bytes32 strategyHash);

    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;

    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount);
}

interface ISwapVmRouter {
    struct Order {
        address maker;
        uint256 traits;
        bytes data;
    }

    function quote(Order calldata order, address tokenIn, address tokenOut, uint256 amount, bytes calldata takerData)
        external
        view
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);

    function swap(Order calldata order, address tokenIn, address tokenOut, uint256 amount, bytes calldata takerData)
        external
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);
}
