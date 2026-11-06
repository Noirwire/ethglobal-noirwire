import { toBaseUnits } from "@noirwire/shared";

export interface WebEnv {
  hedgerUrl: string;
  bridgeUrl: string;
  arcRpcUrl: string;
  navReceiverAddress: string | null;
  navSnapshotUrl: string | null;
  navFromBlock: bigint;
  bandBtc8: bigint;
}

function read(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadEnv(): WebEnv {
  const address = read("NAV_RECEIVER_ADDRESS");
  const from = read("NAV_FROM_BLOCK");
  return {
    hedgerUrl: trimSlash(read("HEDGER_URL") ?? "http://127.0.0.1:8701"),
    bridgeUrl: trimSlash(read("BRIDGE_URL") ?? "http://127.0.0.1:8702"),
    arcRpcUrl: read("ARC_RPC_URL") ?? "http://127.0.0.1:8545",
    navReceiverAddress: address && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : null,
    navSnapshotUrl: read("NAV_SNAPSHOT_URL"),
    navFromBlock: from && /^\d+$/.test(from) ? BigInt(from) : 0n,
    bandBtc8: toBaseUnits(read("RESIDUAL_BAND_BTC") ?? "0.01", 8),
  };
}
