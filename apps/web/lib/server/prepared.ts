import { createHash } from "node:crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import { CCTP_DOMAINS, VAULT_HOOK_PARAMS, VAULT_HOOK_VERSION } from "@noirwire/shared";
import { bytesToHex, decodeAbiParameters, getAddress, type Hex } from "viem";

export const TOKEN_MESSENGER_MINTER_V2 = new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
const BURN_WITH_HOOK = createHash("sha256").update("global:deposit_for_burn_with_hook").digest().subarray(0, 8);
const HEAD_BYTES = 100;

interface DepositExpectation {
  owner: string;
  amount: bigint;
  beneficiary: string;
}

export function inspectPreparedDeposit(transactionBase64: string, expected: DepositExpectation): string | null {
  let transaction: Transaction;
  try {
    transaction = Transaction.from(Buffer.from(transactionBase64, "base64"));
  } catch {
    return "the bridge returned a transaction that cannot be decoded";
  }
  if (transaction.feePayer?.toBase58() !== expected.owner) return "the fee payer is not the connected wallet";
  const [instruction, ...rest] = transaction.instructions;
  if (!instruction || rest.length > 0) return "the transaction does not hold exactly one instruction";
  if (!instruction.programId.equals(TOKEN_MESSENGER_MINTER_V2)) return "the instruction is not a CCTP burn";
  const data = instruction.data;
  if (data.length < HEAD_BYTES || !data.subarray(0, 8).equals(BURN_WITH_HOOK)) return "the instruction is not a burn with a hook";
  if (data.readBigUInt64LE(8) !== expected.amount) return "the burn amount differs from the amount entered";
  if (data.readUInt32LE(16) !== CCTP_DOMAINS.arc) return "the burn does not go to Arc";
  const mintRecipient = bytesToHex(data.subarray(20, 52));
  const destinationCaller = bytesToHex(data.subarray(52, 84));
  if (mintRecipient !== destinationCaller || /^0x0+$/.test(mintRecipient)) {
    return "the mint recipient and destination caller are not the same executor";
  }
  const hookLength = data.readUInt32LE(96);
  if (data.length !== HEAD_BYTES + hookLength) return "the hook data length is wrong";
  let hook: readonly [number, string, Hex, bigint];
  try {
    hook = decodeAbiParameters(VAULT_HOOK_PARAMS, bytesToHex(data.subarray(HEAD_BYTES)));
  } catch {
    return "the hook data cannot be decoded";
  }
  const [version, beneficiary, depositor] = hook;
  if (version !== VAULT_HOOK_VERSION) return "the hook data version is not 1";
  if (getAddress(beneficiary) !== getAddress(expected.beneficiary)) return "the hook beneficiary differs from the address entered";
  if (depositor !== bytesToHex(new PublicKey(expected.owner).toBytes())) return "the hook depositor is not the connected wallet";
  return null;
}
