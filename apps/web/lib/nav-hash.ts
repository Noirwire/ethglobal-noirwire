import { SOURCE_RECORD_PARAMS, toSourceRecords, type NavSource } from "@noirwire/shared";
import { encodeAbiParameters, keccak256, toHex } from "viem";

export function computeSourcesHash(sources: NavSource[]): `0x${string}` {
  const records = toSourceRecords(sources, (account) => keccak256(toHex(account)));
  return keccak256(encodeAbiParameters(SOURCE_RECORD_PARAMS, [records]));
}
