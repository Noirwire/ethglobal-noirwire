import { NAV_LEG_CODES, TRUST_CODES, type NavSource } from "@noirwire/shared";
import { encodeAbiParameters, keccak256, toHex } from "viem";

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

export function computeSourcesHash(sources: NavSource[]): `0x${string}` {
  const records = sources
    .map((source) => ({
      leg: NAV_LEG_CODES[source.leg],
      account: keccak256(toHex(source.account)),
      assets: BigInt(source.assets),
      liabilities: BigInt(source.liabilities),
      observedAt: BigInt(Math.floor(Date.parse(source.observedAt) / 1000)),
      trust: TRUST_CODES[source.trust],
    }))
    .sort((a, b) => (a.leg !== b.leg ? a.leg - b.leg : a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return keccak256(encodeAbiParameters(SOURCE_RECORD_PARAMS, [records]));
}
