import { parseAbi } from "viem";

export const hedgeGuardAbi = parseAbi([
  "constructor(address router, address wbtc, address usdc, address initialOwner, address initialHedger, (address feed, uint32 maxAge, uint16 maxDeviationBps) initialOracle)",
  "function setTarget(address maker, bytes32 targetId, uint8 direction, uint64 size, uint64 minPriceE8, uint64 maxPriceE8, uint40 expiry)",
  "function clearTarget(address maker)",
  "function setOracle(address feed, uint32 maxAge, uint16 maxDeviationBps)",
  "function targetOf(address maker) view returns ((uint8 direction, uint64 remaining, uint64 minPriceE8, uint64 maxPriceE8, uint40 expiry) target)",
  "function oraclePriceE8() view returns (uint256 priceE8)",
  "function oracleConfig() view returns (address feed, uint32 maxAge, uint16 maxDeviationBps)",
  "function hedger() view returns (address)",
  "event HedgeFilled(address indexed maker, bytes32 indexed orderHash, address taker, uint256 btcAmount, uint256 priceE8, uint64 remaining)",
  "error HedgeGuard__OnlyHedger()",
  "error HedgeGuard__OnlyRouter()",
  "error HedgeGuard__ZeroAddress()",
  "error HedgeGuard__InvalidTarget()",
  "error HedgeGuard__InvalidOracleConfig()",
  "error HedgeGuard__TargetIdConflict(bytes32 targetId)",
  "error HedgeGuard__TargetNotSet(address maker)",
  "error HedgeGuard__TargetExpired(uint40 expiry)",
  "error HedgeGuard__AmountsNotComputed()",
  "error HedgeGuard__WrongDirection(address tokenIn, address tokenOut)",
  "error HedgeGuard__SizeExceedsRemaining(uint256 requested, uint64 remaining)",
  "error HedgeGuard__PriceOutsideBand(uint256 priceE8, uint64 minPriceE8, uint64 maxPriceE8)",
  "error HedgeGuard__OracleInvalid(int256 answer)",
  "error HedgeGuard__OracleStale(uint256 updatedAt, uint256 maxAge)",
  "error HedgeGuard__PriceFarFromOracle(uint256 priceE8, uint256 oracleE8, uint16 maxDeviationBps)",
]);

export const testAggregatorAbi = parseAbi([
  "constructor(address updater, int256 initialAnswer)",
  "function setAnswer(int256 newAnswer)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

export const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const aquaAbi = parseAbi([
  "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
]);
