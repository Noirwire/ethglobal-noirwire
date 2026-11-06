// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Chainlink CRE consumer interface: the forwarder calls onReport with workflow metadata
/// and the workflow's report bytes.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
