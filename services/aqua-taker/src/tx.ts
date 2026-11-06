import {
  type Address,
  BaseError,
  type Hex,
  RawContractError,
  decodeErrorResult,
  encodeFunctionData,
  isHex,
  maxUint256,
} from "viem";
import { erc20Abi, hedgeGuardAbi } from "./abis.js";
import type { ForkClients, ForkRole } from "./chain.js";
import type { EncodedCall } from "./strategy.js";

export const REVERTING_TX_GAS = 1_500_000n;
const ALLOWANCE_REFILL_THRESHOLD = maxUint256 / 2n;
const REVERT_SELECTOR_HEX_LENGTH = 10;

export interface SentTx {
  hash: Hex;
  status: "success" | "reverted";
  gasUsed: bigint;
}

export interface GuardRevert {
  name: string;
  args: readonly unknown[];
}

export async function sendCall(
  clients: ForkClients,
  role: ForkRole,
  call: EncodedCall,
  options: { gas?: bigint } = {},
): Promise<SentTx> {
  const wallet = clients.wallet(role);
  const hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value, gas: options.gas });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status, gasUsed: receipt.gasUsed };
}

export async function approveMax(
  clients: ForkClients,
  role: ForkRole,
  tokens: readonly Address[],
  spender: Address,
): Promise<SentTx[]> {
  const sent: SentTx[] = [];
  for (const token of tokens) {
    const allowance = await clients.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [clients.address(role), spender],
    });
    if (allowance >= ALLOWANCE_REFILL_THRESHOLD) continue;
    sent.push(
      await sendCall(clients, role, {
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }),
        value: 0n,
      }),
    );
  }
  return sent;
}

function carriesRevertData(inner: unknown): boolean {
  if (inner instanceof RawContractError) return true;
  const data: unknown = typeof inner === "object" && inner !== null ? Reflect.get(inner, "data") : undefined;
  return typeof data === "string" && isHex(data) && data.length >= REVERT_SELECTOR_HEX_LENGTH;
}

function revertDataOf(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const carrier = error.walk(carriesRevertData);
  if (carrier === null || typeof carrier !== "object") return undefined;
  const data: unknown = Reflect.get(carrier, "data");
  return typeof data === "string" && isHex(data) ? data : undefined;
}

function decodeGuardRevert(error: unknown): GuardRevert | undefined {
  const data = revertDataOf(error);
  if (data === undefined) return undefined;
  try {
    const decoded = decodeErrorResult({ abi: hedgeGuardAbi, data });
    return { name: decoded.errorName, args: decoded.args ?? [] };
  } catch {
    return undefined;
  }
}

export async function callOrExplain(
  clients: ForkClients,
  from: Hex,
  call: EncodedCall,
): Promise<{ ok: true; data: Hex } | { ok: false; revert: GuardRevert | undefined; message: string }> {
  try {
    const result = await clients.publicClient.call({ account: from, to: call.to, data: call.data, value: call.value });
    return { ok: true, data: result.data ?? "0x" };
  } catch (error) {
    return {
      ok: false,
      revert: decodeGuardRevert(error),
      message: error instanceof Error ? error.message.split("\n")[0] ?? "call failed" : "call failed",
    };
  }
}
