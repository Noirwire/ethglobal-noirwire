import { createHash } from "node:crypto";
import { Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { bytesToHex, encodeAbiParameters, hexToBytes, padHex, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as dev } from "../../app/api/deposit/local/route";
import { POST as prepare } from "../../app/api/deposit/solana/prepare/route";
import { GET as status } from "../../app/api/deposit/solana/status/route";
import { POST as submitted } from "../../app/api/deposit/solana/submitted/route";
import { inspectPreparedDeposit, TOKEN_MESSENGER_MINTER_V2 } from "./prepared";

const owner = Keypair.generate().publicKey;
const executor = padHex("0x00000000000000000000000000000000000000ee", { size: 32 });
const beneficiary = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function burn(overrides: { amount?: bigint; depositor?: Uint8Array; domain?: number; recipient?: Hex; caller?: Hex; version?: number } = {}): string {
  const hook = hexToBytes(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }],
      [overrides.version ?? 1, beneficiary, bytesToHex(overrides.depositor ?? owner.toBytes()), 1_800_000_000n],
    ),
  );
  const head = Buffer.alloc(100);
  createHash("sha256").update("global:deposit_for_burn_with_hook").digest().copy(head, 0, 0, 8);
  head.writeBigUInt64LE(overrides.amount ?? 2_500_000n, 8);
  head.writeUInt32LE(overrides.domain ?? 26, 16);
  Buffer.from(hexToBytes(overrides.recipient ?? executor)).copy(head, 20);
  Buffer.from(hexToBytes(overrides.caller ?? executor)).copy(head, 52);
  head.writeBigUInt64LE(1000n, 84);
  head.writeUInt32LE(1000, 92);
  head.writeUInt32LE(hook.length, 96);
  const transaction = new Transaction({ feePayer: owner, blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 1 }).add(
    new TransactionInstruction({ programId: TOKEN_MESSENGER_MINTER_V2, keys: [], data: Buffer.concat([head, Buffer.from(hook)]) }),
  );
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

const expected = { owner: owner.toBase58(), amount: 2_500_000n, beneficiary };

describe("inspectPreparedDeposit", () => {
  it("accepts a burn that matches what was entered", () => {
    expect(inspectPreparedDeposit(burn(), expected)).toBeNull();
  });

  it("refuses a different amount, depositor, beneficiary, destination, recipient or hook version", () => {
    expect(inspectPreparedDeposit(burn({ amount: 9n }), expected)).toContain("amount");
    expect(inspectPreparedDeposit(burn({ depositor: Keypair.generate().publicKey.toBytes() }), expected)).toContain("depositor");
    expect(inspectPreparedDeposit(burn(), { ...expected, beneficiary: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" })).toContain("beneficiary");
    expect(inspectPreparedDeposit(burn({ domain: 6 }), expected)).toContain("Arc");
    expect(inspectPreparedDeposit(burn({ caller: padHex("0x01", { size: 32 }) }), expected)).toContain("same executor");
    expect(inspectPreparedDeposit(burn({ version: 2 }), expected)).toContain("version");
    expect(inspectPreparedDeposit(burn(), { ...expected, owner: Keypair.generate().publicKey.toBase58() })).toContain("fee payer");
    expect(inspectPreparedDeposit("not a transaction", expected)).toContain("cannot be decoded");
  });
});

describe("deposit route handlers", () => {
  afterEach(() => vi.unstubAllGlobals());

  const post = (body: unknown) => new Request("http://web.test/x", { method: "POST", body: JSON.stringify(body) });
  const stubBridge = (status: number, body: unknown) => {
    const fetchMock = vi.fn(async () => Response.json(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const input = { owner: owner.toBase58(), amount: "2500000", beneficiary };

  it("prepare forwards a verified transaction", async () => {
    const fetchMock = stubBridge(200, { transaction: burn(), deadline: 1, maxFee: "1000" });
    const response = await prepare(post(input));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { maxFee: string }).maxFee).toBe("1000");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/deposits\/solana\/prepare$/);
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it("prepare blocks a bridge transaction that does not match the request", async () => {
    stubBridge(200, { transaction: burn({ amount: 1n }) });
    const response = await prepare(post(input));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("refused before reaching your wallet");
  });

  it("prepare passes the bridge's 409 and 422 messages through and rejects bad input", async () => {
    stubBridge(409, { error: "local chain" });
    const local = await prepare(post(input));
    expect(local.status).toBe(409);
    expect(((await local.json()) as { error: string }).error).toBe("local chain");
    stubBridge(422, { error: "no USDC token account" });
    expect((await prepare(post(input))).status).toBe(422);
    const fetchMock = stubBridge(200, {});
    expect((await prepare(post({ owner: "x" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 in plain words when the bridge is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("connect ECONNREFUSED"))));
    const response = await status();
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("bridge is not connected");
  });

  it("submitted validates the signature and returns the transfer", async () => {
    const signature = "5".repeat(88);
    stubBridge(202, { transfer: { transferId: `${signature}:0` } });
    const ok = await submitted(post({ signature }));
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { transfer: { transferId: string } }).transfer.transferId).toBe(`${signature}:0`);
    expect((await submitted(post({ signature: "short" }))).status).toBe(400);
    stubBridge(404, { error: "not visible yet" });
    expect((await submitted(post({ signature }))).status).toBe(404);
  });

  it("local simulation proxies to /v1/dev/deposit and explains a non-local bridge", async () => {
    const fetchMock = stubBridge(202, { transfers: [{ transferId: "t:0" }], beneficiary });
    const ok = await dev(post({ amount: "7500000" }));
    expect(ok.status).toBe(202);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/dev\/deposit$/);
    expect(JSON.parse(init.body as string)).toEqual({ amount: "7500000" });
    stubBridge(404, { error: "not found" });
    const refused = await dev(post({ amount: "7500000" }));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("not running on a local chain");
    expect((await dev(post({ amount: "-1" }))).status).toBe(400);
  });
});
