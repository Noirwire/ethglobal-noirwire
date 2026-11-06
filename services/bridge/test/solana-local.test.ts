import { spawnSync } from "node:child_process";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeVaultHookData } from "../src/hooks.ts";
import { LocalAttester } from "../src/iris.ts";
import { decodeBurnBody, decodeMessage } from "../src/message.ts";
import { patchMessageTransmitter, runSolanaLocalReceive, startClonedValidator } from "../src/solana-local.ts";

const enabled = process.env.BRIDGE_SOLANA_CLONE === "1" && spawnSync("solana-test-validator", ["--version"]).status === 0;

describe("attester patch", () => {
  it("rewrites the threshold and every attester slot without changing the length", () => {
    const original = Buffer.alloc(225);
    original.writeUInt32LE(2, 145);
    original.writeUInt32LE(2, 149);
    const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const patched = patchMessageTransmitter(original, [address]);
    expect(patched.length).toBe(225);
    expect(patched.readUInt32LE(145)).toBe(1);
    expect(patched.readUInt32LE(149)).toBe(2);
    expect(patched.subarray(153 + 12, 153 + 32).toString("hex")).toBe(address.slice(2).toLowerCase());
    expect(patched.subarray(153 + 32 + 12, 153 + 64).toString("hex")).toBe(address.slice(2).toLowerCase());
  });
});

describe.skipIf(!enabled)("cloned CCTP V2 programs on a local validator (BRIDGE_SOLANA_CLONE=1)", () => {
  let stop: (() => void) | undefined;
  const attester = new LocalAttester([generatePrivateKey()]);
  let setup: Awaited<ReturnType<typeof startClonedValidator>>;

  beforeAll(async () => {
    setup = await startClonedValidator({ attesterAddress: attester.signers()[0]! });
    stop = setup.stop;
  }, 120_000);

  afterAll(() => stop?.());

  it("accepts a locally attested Arc message and emits a decodable hook burn", async () => {
    const result = await runSolanaLocalReceive(setup, attester);
    expect(result.minted).toBe(3_000_000n);
    expect(result.balanceAfterBurn).toBe(2_000_000n);
    const header = decodeMessage(result.burnMessage);
    expect(header).toMatchObject({ sourceDomain: 5, destinationDomain: 26 });
    const body = decodeBurnBody(header.body);
    expect(body.amount).toBe(1_000_000n);
    expect(decodeVaultHookData(body.hookData).beneficiary).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  }, 120_000);
});
