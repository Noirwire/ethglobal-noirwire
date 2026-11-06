import { concatHex, decodeAbiParameters, encodeAbiParameters, isAddress, numberToHex, stringToHex, type Hex } from "viem";

export const VAULT_HOOK_VERSION = 1;
export const VAULT_HOOK_DEADLINE_SECONDS = 3600;

export type VaultHook = {
  beneficiary: Hex;
  solanaDepositor: Hex;
  deadline: bigint;
};

const vaultHookParams = [
  { type: "uint8" },
  { type: "address" },
  { type: "bytes32" },
  { type: "uint64" },
] as const;

export function encodeVaultHookData(hook: VaultHook): Hex {
  if (!isAddress(hook.beneficiary)) throw new Error("beneficiary must be an EVM address");
  return encodeAbiParameters(vaultHookParams, [
    VAULT_HOOK_VERSION,
    hook.beneficiary,
    hook.solanaDepositor,
    hook.deadline,
  ]);
}

export function decodeVaultHookData(data: Hex): VaultHook & { version: number } {
  const [version, beneficiary, solanaDepositor, deadline] = decodeAbiParameters(vaultHookParams, data);
  return { version, beneficiary, solanaDepositor, deadline };
}

export const HYPERCORE_DEX = { perps: 0, spot: 0xffffffff } as const;
const FORWARD_MAGIC = stringToHex("cctp-forward", { size: 24 });
const FORWARD_HOOK_VERSION = 0;
const FORWARD_PAYLOAD_LENGTH = 24;
const UINT32_BYTES = 4;

export function encodeForwardHookData(recipient: Hex, dex: number = HYPERCORE_DEX.perps): Hex {
  if (!isAddress(recipient)) throw new Error("HyperCore recipient must be an EVM address");
  return concatHex([
    FORWARD_MAGIC,
    numberToHex(FORWARD_HOOK_VERSION, { size: UINT32_BYTES }),
    numberToHex(FORWARD_PAYLOAD_LENGTH, { size: UINT32_BYTES }),
    recipient.toLowerCase() as Hex,
    numberToHex(dex, { size: UINT32_BYTES }),
  ]);
}
