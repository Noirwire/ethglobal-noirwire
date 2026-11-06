import { fromBaseUnits, USDC_DECIMALS } from "@noirwire/shared";
import { concat, encodeAbiParameters, hexToBigInt, keccak256, parseSignature, toBytes, type Hex, type LocalAccount } from "viem";

export const HYPERLIQUID_SIGNATURE_CHAIN_ID = "0xa4b1";
export const HYPERLIQUID_TOKEN = "USDC";
export const DEFAULT_RETURN_GAS_LIMIT = 200_000;

export type HyperliquidNetwork = "Mainnet" | "Testnet";
export type SourceDex = "" | "spot";

export type SendToEvmWithData = {
  hyperliquidChain: HyperliquidNetwork;
  token: string;
  amount: string;
  sourceDex: SourceDex;
  destinationRecipient: string;
  addressEncoding: "hex" | "base58";
  destinationChainId: number;
  gasLimit: number;
  data: Hex;
  nonce: number;
};

export const sendToEvmWithDataTypes = {
  "HyperliquidTransaction:SendToEvmWithData": [
    { name: "hyperliquidChain", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "sourceDex", type: "string" },
    { name: "destinationRecipient", type: "string" },
    { name: "addressEncoding", type: "string" },
    { name: "destinationChainId", type: "uint32" },
    { name: "gasLimit", type: "uint64" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export const sendToEvmWithDataDomain = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: Number(hexToBigInt(HYPERLIQUID_SIGNATURE_CHAIN_ID)),
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

const PRIMARY_TYPE = "HyperliquidTransaction:SendToEvmWithData";
const fields = sendToEvmWithDataTypes[PRIMARY_TYPE];
const typeHash = (signature: string): Hex => keccak256(toBytes(signature));

export function sendToEvmWithDataDigest(action: SendToEvmWithData): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        typeHash("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        typeHash(sendToEvmWithDataDomain.name),
        typeHash(sendToEvmWithDataDomain.version),
        BigInt(sendToEvmWithDataDomain.chainId),
        sendToEvmWithDataDomain.verifyingContract,
      ],
    ),
  );
  const values: Record<string, unknown> = action;
  const encoded = fields.map((field) => {
    const value = values[field.name];
    if (field.type === "string") return typeHash(value as string);
    if (field.type === "bytes") return keccak256(value as Hex);
    return BigInt(value as number);
  });
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, ...fields.map((field) => ({ type: field.type === "string" || field.type === "bytes" ? "bytes32" : field.type }))],
      [typeHash(`${PRIMARY_TYPE}(${fields.map((field) => `${field.type} ${field.name}`).join(",")})`), ...encoded],
    ),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

export function usdcAmountString(baseUnits: bigint): string {
  return fromBaseUnits(baseUnits, USDC_DECIMALS);
}

export type SignedExchangeRequest = {
  action: SendToEvmWithData & { type: "sendToEvmWithData"; signatureChainId: string };
  nonce: number;
  signature: { r: Hex; s: Hex; v: number };
};

export async function signSendToEvmWithData(account: LocalAccount, action: SendToEvmWithData): Promise<SignedExchangeRequest> {
  if (!account.sign) throw new Error("the HyperCore account cannot sign a raw digest");
  const signature = parseSignature(await account.sign({ hash: sendToEvmWithDataDigest(action) }));
  return {
    action: { type: "sendToEvmWithData", signatureChainId: HYPERLIQUID_SIGNATURE_CHAIN_ID, ...action },
    nonce: action.nonce,
    signature: { r: signature.r, s: signature.s, v: signature.yParity + 27 },
  };
}

export type ExchangeResponse = { status: "ok" } | { status: "err"; reason: string };

export interface HyperliquidExchange {
  post(request: SignedExchangeRequest): Promise<ExchangeResponse>;
}

export class HttpHyperliquidExchange implements HyperliquidExchange {
  constructor(
    private readonly exchangeUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async post(request: SignedExchangeRequest): Promise<ExchangeResponse> {
    const response = await this.fetchImpl(this.exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Hyperliquid exchange ${response.status}`);
    const body = (await response.json()) as { status?: unknown; response?: unknown };
    if (body.status === "ok") return { status: "ok" };
    if (body.status === "err") return { status: "err", reason: typeof body.response === "string" ? body.response : JSON.stringify(body.response) };
    throw new Error(`Hyperliquid exchange answered with an unrecognised body: ${JSON.stringify(body).slice(0, 200)}`);
  }
}
