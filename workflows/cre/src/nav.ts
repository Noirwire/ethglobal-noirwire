import { encodeAbiParameters, keccak256, parseAbiParameters, toHex } from "viem";
import {
  NAV_LEG_CODES,
  SETTLED_TRANSFER_STATES,
  TRUST_CODES,
  fromBaseUnits,
  type BridgeTransfer,
  type NavLeg,
  type NavSnapshot,
  type NavSource,
  type TopUpIntent,
  type TransferRoute,
} from "./shared.ts";

export type IntentReason = TopUpIntent["reason"];

export interface MarginBands {
  lowBps: number;
  urgentBps: number;
  surplusBps: number;
  targetBps: number;
  maxIntentUsdc6: string;
}

export interface Readings {
  vaultCash: { account: string; usdc6: bigint; observedAt: Date; blockOrSlot?: string };
  maker: { account: string; equityUsdc6: bigint; observedAt: Date };
  hyperliquid: { account: string; accountValueUsdc6: bigint; observedAt: Date };
  aqua: { account: string; usdc6: bigint; wbtcE8: bigint; btcUsdE8: bigint; observedAt: Date };
  transfers: { account: string; items: BridgeTransfer[]; observedAt: Date };
  shareSupply18: bigint;
}

export const LEG_ORDER: NavLeg[] = ["arc-vault-cash", "solana-maker", "hyperliquid", "aqua", "in-transit"];

const UINT16_MAX = 65535n;
const E18 = 10n ** 18n;

export function parseDecimalToUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error(`not a decimal: ${value}`);
  const negative = trimmed.startsWith("-");
  const [whole = "0", fraction = ""] = trimmed.replace(/^-/, "").split(".");
  const units = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
  return negative ? -units : units;
}

export function valueWbtcInUsdc6(wbtcE8: bigint, btcUsdE8: bigint): bigint {
  return (wbtcE8 * btcUsdE8) / 10n ** 10n;
}

export function transferValue(transfer: BridgeTransfer): bigint {
  return BigInt(transfer.netMinted ?? transfer.grossAmount);
}

export function selectInTransit(transfers: BridgeTransfer[]): BridgeTransfer[] {
  const latest = new Map<string, BridgeTransfer>();
  for (const transfer of transfers) {
    const seen = latest.get(transfer.transferId);
    if (!seen || Date.parse(transfer.updatedAt) >= Date.parse(seen.updatedAt)) latest.set(transfer.transferId, transfer);
  }
  return [...latest.values()]
    .filter((transfer) => transfer.state !== "requested" && !SETTLED_TRANSFER_STATES.has(transfer.state))
    .sort((a, b) => (a.transferId < b.transferId ? -1 : a.transferId > b.transferId ? 1 : 0));
}

function assertReadableTimes(readings: Readings): void {
  const times: [string, Date][] = [
    ["arc-vault-cash", readings.vaultCash.observedAt],
    ["solana-maker", readings.maker.observedAt],
    ["hyperliquid", readings.hyperliquid.observedAt],
    ["aqua", readings.aqua.observedAt],
    ["in-transit", readings.transfers.observedAt],
  ];
  for (const [label, time] of times) {
    if (Number.isNaN(time.getTime())) throw new Error(`unreadable timestamp on ${label}`);
  }
}

export function buildSources(readings: Readings): { sources: NavSource[]; inTransit: BridgeTransfer[] } {
  assertReadableTimes(readings);
  const inTransit = selectInTransit(readings.transfers.items);
  const inTransitTotal = inTransit.reduce((sum, transfer) => sum + transferValue(transfer), 0n);
  const aquaAssets = readings.aqua.usdc6 + valueWbtcInUsdc6(readings.aqua.wbtcE8, readings.aqua.btcUsdE8);

  const sources: NavSource[] = [
    {
      leg: "arc-vault-cash",
      account: readings.vaultCash.account,
      assets: readings.vaultCash.usdc6.toString(),
      liabilities: "0",
      observedAt: readings.vaultCash.observedAt.toISOString(),
      ...(readings.vaultCash.blockOrSlot ? { blockOrSlot: readings.vaultCash.blockOrSlot } : {}),
      trust: "onchain",
    },
    {
      leg: "solana-maker",
      account: readings.maker.account,
      assets: readings.maker.equityUsdc6.toString(),
      liabilities: "0",
      observedAt: readings.maker.observedAt.toISOString(),
      trust: "operator-supplied",
    },
    {
      leg: "hyperliquid",
      account: readings.hyperliquid.account,
      assets: readings.hyperliquid.accountValueUsdc6.toString(),
      liabilities: "0",
      observedAt: readings.hyperliquid.observedAt.toISOString(),
      trust: "venue-api",
    },
    {
      leg: "aqua",
      account: readings.aqua.account,
      assets: aquaAssets.toString(),
      liabilities: "0",
      btcPosition: readings.aqua.wbtcE8.toString(),
      valuationPrice: fromBaseUnits(readings.aqua.btcUsdE8, 8),
      observedAt: readings.aqua.observedAt.toISOString(),
      trust: "operator-supplied",
    },
    {
      leg: "in-transit",
      account: readings.transfers.account,
      assets: inTransitTotal.toString(),
      liabilities: "0",
      observedAt: readings.transfers.observedAt.toISOString(),
      trust: "operator-supplied",
    },
  ];
  return { sources, inTransit };
}

export function assertFresh(label: string, observedAt: Date, now: Date, maxAgeSec: number): void {
  const observed = observedAt.getTime();
  if (Number.isNaN(observed)) throw new Error(`unreadable timestamp on ${label}`);
  const ageSec = (now.getTime() - observed) / 1000;
  if (ageSec > maxAgeSec) throw new Error(`stale source ${label}: ${Math.floor(ageSec)}s old, limit ${maxAgeSec}s`);
}

export function assertSourcesUsable(sources: NavSource[], now: Date, maxSourceAgeSec: number): void {
  for (const leg of LEG_ORDER) {
    if (!sources.some((source) => source.leg === leg)) throw new Error(`missing source: ${leg}`);
  }
  for (const source of sources) assertFresh(source.leg, new Date(source.observedAt), now, maxSourceAgeSec);
}

export function oldestObservedAtSec(sources: NavSource[]): bigint {
  const oldest = Math.min(...sources.map((source) => Date.parse(source.observedAt)));
  return BigInt(Math.floor(oldest / 1000));
}

export function sharePriceE18(netAssets6: bigint, shareSupply18: bigint): bigint {
  if (shareSupply18 === 0n) return E18;
  return (netAssets6 * 10n ** 12n * E18) / shareSupply18;
}

const SOURCE_RECORD_PARAMS = [
  {
    type: "tuple[]",
    components: [
      { name: "leg", type: "uint8" },
      { name: "account", type: "bytes32" },
      { name: "assets", type: "uint256" },
      { name: "liabilities", type: "uint256" },
      { name: "observedAt", type: "uint64" },
      { name: "trust", type: "uint8" },
    ],
  },
] as const;

export function accountHash(account: string): `0x${string}` {
  return keccak256(toHex(account));
}

export function sourcesHash(sources: NavSource[]): `0x${string}` {
  const records = sources
    .map((source) => ({
      leg: NAV_LEG_CODES[source.leg],
      account: accountHash(source.account),
      assets: BigInt(source.assets),
      liabilities: BigInt(source.liabilities),
      observedAt: BigInt(Math.floor(Date.parse(source.observedAt) / 1000)),
      trust: TRUST_CODES[source.trust],
    }))
    .sort((a, b) => (a.leg !== b.leg ? a.leg - b.leg : a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return keccak256(encodeAbiParameters(SOURCE_RECORD_PARAMS, [records]));
}

export function buildSnapshot(input: {
  closeId: number;
  readings: Readings;
  now: Date;
  maxSourceAgeSec: number;
}): NavSnapshot {
  const { sources, inTransit } = buildSources(input.readings);
  assertSourcesUsable(sources, input.now, input.maxSourceAgeSec);

  const totalAssets = sources.reduce((sum, source) => sum + BigInt(source.assets), 0n);
  const totalLiabilities = sources.reduce((sum, source) => sum + BigInt(source.liabilities), 0n);
  const netAssets = totalAssets - totalLiabilities;
  if (netAssets < 0n) throw new Error("liabilities exceed assets");

  return {
    closeId: input.closeId,
    totalAssets: totalAssets.toString(),
    totalLiabilities: totalLiabilities.toString(),
    netAssets: netAssets.toString(),
    shareSupply: input.readings.shareSupply18.toString(),
    sharePriceE18: sharePriceE18(netAssets, input.readings.shareSupply18).toString(),
    sources,
    sourcesHash: sourcesHash(sources),
    inTransitTransferIds: inTransit.map((transfer) => transfer.transferId),
    takenAt: input.now.toISOString(),
  };
}

export function marginRatioBps(accountValueUsdc6: bigint, marginUsedUsdc6: bigint): bigint | null {
  if (marginUsedUsdc6 <= 0n) return null;
  return (accountValueUsdc6 * 10000n) / marginUsedUsdc6;
}

const ROUTE_CODE: Record<TransferRoute, number> = {
  "arc-hypercore": 0,
  "hypercore-arc": 1,
  "arc-solana": 2,
  "solana-arc": 3,
};

const REASON_CODE: Record<IntentReason, number> = {
  "margin-low": 0,
  "margin-urgent": 1,
  "surplus-return": 2,
  "solana-rebalance": 3,
};

export const routeCode = (route: TransferRoute): number => ROUTE_CODE[route];
export const reasonCode = (reason: IntentReason): number => REASON_CODE[reason];

export function intentId(closeId: number, route: TransferRoute, amount: bigint, reason: IntentReason): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint64 closeId, uint8 route, uint256 amount, uint8 reason"), [
      BigInt(closeId),
      ROUTE_CODE[route],
      amount,
      REASON_CODE[reason],
    ]),
  );
}

export function planTopUp(input: {
  closeId: number;
  accountValueUsdc6: bigint;
  marginUsedUsdc6: bigint;
  bands: MarginBands;
}): TopUpIntent | null {
  const { accountValueUsdc6, marginUsedUsdc6, bands, closeId } = input;
  const ratio = marginRatioBps(accountValueUsdc6, marginUsedUsdc6);
  if (ratio === null) return null;

  const targetBps = BigInt(bands.targetBps);
  let route: TransferRoute;
  let reason: IntentReason;
  let amount: bigint;

  if (ratio < BigInt(bands.lowBps)) {
    route = "arc-hypercore";
    reason = ratio < BigInt(bands.urgentBps) ? "margin-urgent" : "margin-low";
    amount = (targetBps * marginUsedUsdc6 + 9999n) / 10000n - accountValueUsdc6;
  } else if (ratio > BigInt(bands.surplusBps)) {
    route = "hypercore-arc";
    reason = "surplus-return";
    amount = accountValueUsdc6 - (targetBps * marginUsedUsdc6) / 10000n;
  } else {
    return null;
  }

  const maxAmount = BigInt(bands.maxIntentUsdc6);
  if (amount > maxAmount) amount = maxAmount;
  if (amount <= 0n) return null;

  return {
    intentId: intentId(closeId, route, amount, reason),
    closeId,
    route,
    amount: amount.toString(),
    reason,
    marginRatioBps: Number(ratio > UINT16_MAX ? UINT16_MAX : ratio),
  };
}
