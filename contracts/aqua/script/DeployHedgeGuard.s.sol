// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {HedgeGuard} from "src/HedgeGuard.sol";
import {IHedgeGuard} from "src/interfaces/IHedgeGuard.sol";

/**
 * @notice Deploys HedgeGuard against the official SwapVM router.
 * @dev Run with a keystore account, never a raw key:
 *   forge script script/DeployHedgeGuard.s.sol --account <keystore> --sender <address> --rpc-url <url> --broadcast
 * On the local fork, anvil's unlocked default account works: add `--unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
 * (that address is the public anvil test account, valid only on throwaway forks).
 * Any deployment beyond a local fork needs `OWNER` to be a multisig and a completed audit.
 */
contract DeployHedgeGuard is Script {
    address internal constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address internal constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
    address internal constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant CHAINLINK_BTC_USD = 0x6ce185860a4963106506C203335A2910413708e9;
    uint32 internal constant DEFAULT_MAX_AGE = 3600;
    uint16 internal constant DEFAULT_MAX_DEVIATION_BPS = 300;

    function run() external returns (HedgeGuard guard) {
        address owner = vm.envAddress("OWNER");
        address hedger = vm.envAddress("HEDGER");
        address feed = vm.envOr("ORACLE_FEED", CHAINLINK_BTC_USD);
        uint32 maxAge = uint32(vm.envOr("ORACLE_MAX_AGE", uint256(DEFAULT_MAX_AGE)));
        uint16 maxDeviationBps = uint16(vm.envOr("ORACLE_MAX_DEVIATION_BPS", uint256(DEFAULT_MAX_DEVIATION_BPS)));

        vm.startBroadcast();
        guard = new HedgeGuard(
            ROUTER,
            WBTC,
            USDC,
            owner,
            hedger,
            IHedgeGuard.OracleConfig({feed: feed, maxAge: maxAge, maxDeviationBps: maxDeviationBps})
        );
        vm.stopBroadcast();

        // solhint-disable-next-line no-console
        console2.log("HedgeGuard deployed at", address(guard));
    }
}
