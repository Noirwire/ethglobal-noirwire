import { NAV_LEG_CODES, TRUST_CODES, type NavSource } from "./schemas.ts";

export const SOURCE_RECORD_PARAMS = [
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

export function toSourceRecords(sources: NavSource[], hashAccount: (account: string) => `0x${string}`) {
  return sources
    .map((source) => ({
      leg: NAV_LEG_CODES[source.leg],
      account: hashAccount(source.account),
      assets: BigInt(source.assets),
      liabilities: BigInt(source.liabilities),
      observedAt: BigInt(Math.floor(Date.parse(source.observedAt) / 1000)),
      trust: TRUST_CODES[source.trust],
    }))
    .sort((a, b) => (a.leg !== b.leg ? a.leg - b.leg : a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}
