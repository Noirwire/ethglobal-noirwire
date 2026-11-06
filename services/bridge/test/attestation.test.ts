import { readFileSync } from "node:fs";
import { keccak256, recoverAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AttestationTimeout, IrisClient, LocalAttester, parseIrisResponse, pollAttestation, type Attester } from "../src/iris.ts";
import { buildBurnMessage } from "./helpers.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/iris-complete.json", import.meta.url), "utf8")) as unknown;

describe("Iris response parsing", () => {
  it("parses a complete message from the documented V2 shape", () => {
    const parsed = parseIrisResponse(fixture);
    expect(parsed.status).toBe("complete");
    expect(parsed.message).toBe("0x00000001000000050000001a");
    expect(parsed.attestation?.startsWith("0x6edd90f4")).toBe(true);
    expect(parsed.decoded).toMatchObject({ sourceDomain: 5, destinationDomain: 26, amount: "5000000", hookData: "0x01" });
    expect(parsed.forward).toBeUndefined();
  });

  it("treats the PENDING attestation placeholder and pending_confirmations as pending", () => {
    const pending = parseIrisResponse({
      messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations", eventNonce: "1" }],
    });
    expect(pending.status).toBe("pending");
    expect(pending.attestation).toBeUndefined();
    expect(pending.message).toBeUndefined();
  });

  it("treats an empty message list as pending", () => {
    expect(parseIrisResponse({ messages: [] }).status).toBe("pending");
  });

  it("reads the forwarder state and mint tx", () => {
    const parsed = parseIrisResponse({
      messages: [
        {
          message: "0x00",
          attestation: "0x11",
          status: "complete",
          forwardState: "COMPLETE",
          forwardTxHash: "0xaa",
          destinationMintTxHash: "0xbb",
        },
      ],
    });
    expect(parsed.forward).toEqual({ state: "COMPLETE", txHash: "0xaa", mintTxHash: "0xbb" });
  });

  it("rejects a malformed body", () => {
    expect(() => parseIrisResponse({ nope: true })).toThrow();
  });
});

describe("IrisClient", () => {
  const fetchOf = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("builds the V2 URL and maps 404 to pending", async () => {
    let seen = "";
    const client = new IrisClient("https://iris.example", (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ error: "Message not found for provided parameters" }), { status: 404 });
    }) as unknown as typeof fetch);
    const result = await client.fetchAttestation({ sourceDomain: 26, txHash: "0xabc" });
    expect(seen).toBe("https://iris.example/v2/messages/26?transactionHash=0xabc");
    expect(result.status).toBe("pending");
  });

  it("throws on server errors", async () => {
    const client = new IrisClient("https://iris.example", fetchOf(500, {}));
    await expect(client.fetchAttestation({ sourceDomain: 26, txHash: "0x1" })).rejects.toThrow(/500/);
  });

  it("labels itself circle-iris", () => {
    expect(new IrisClient().label).toBe("circle-iris");
  });
});

describe("LocalAttester", () => {
  const keys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
  const message = buildBurnMessage();

  it("signs keccak256(message) so every signature recovers to a signer", async () => {
    const attester = new LocalAttester([keys[0] as Hex]);
    const attestation = await attester.attest(message);
    expect((attestation.length - 2) / 2).toBe(65);
    const r = `0x${attestation.slice(2, 66)}` as Hex;
    const s = `0x${attestation.slice(66, 130)}` as Hex;
    const v = parseInt(attestation.slice(130, 132), 16);
    expect([27, 28]).toContain(v);
    const recovered = await recoverAddress({ hash: keccak256(message), signature: { r, s, v: BigInt(v) } });
    expect(recovered).toBe(privateKeyToAccount(keys[0] as Hex).address);
  });

  it("concatenates multiple signatures sorted ascending by signer address", async () => {
    const attester = new LocalAttester(keys);
    const attestation = await attester.attest(message);
    expect((attestation.length - 2) / 2).toBe(65 * 3);
    const recovered: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const signature = `0x${attestation.slice(2 + i * 130, 2 + (i + 1) * 130)}` as Hex;
      recovered.push(BigInt(await recoverAddress({ hash: keccak256(message), signature })));
    }
    expect(recovered).toEqual([...recovered].sort((a, b) => (a < b ? -1 : 1)));
    expect(new Set(recovered).size).toBe(3);
    expect(recovered.map((r) => r.toString(16).padStart(40, "0")).sort()).toEqual(
      attester.signers().map((a) => a.slice(2).toLowerCase()).sort(),
    );
  });

  it("labels itself local-test-attester and stays pending without message bytes", async () => {
    const attester = new LocalAttester([keys[0] as Hex]);
    expect(attester.label).toBe("local-test-attester");
    expect((await attester.fetchAttestation({ sourceDomain: 5, txHash: "0x1" })).status).toBe("pending");
  });
});

describe("pollAttestation", () => {
  const fakeTime = () => {
    let t = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => t,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
    };
  };

  it("backs off and returns once complete", async () => {
    const time = fakeTime();
    let calls = 0;
    const attester: Attester = {
      label: "circle-iris",
      async fetchAttestation() {
        calls++;
        if (calls < 4) return { status: "pending" };
        return { status: "complete", attestation: "0x11", message: "0x22" };
      },
    };
    const result = await pollAttestation(attester, { sourceDomain: 5, txHash: "0x1" }, { ...time, intervalMs: 100, maxIntervalMs: 250 });
    expect(result.status).toBe("complete");
    expect(time.waits).toEqual([100, 200, 250]);
  });

  it("times out with AttestationTimeout and survives transient errors", async () => {
    const time = fakeTime();
    const attester: Attester = {
      label: "circle-iris",
      async fetchAttestation() {
        throw new Error("network down");
      },
    };
    await expect(
      pollAttestation(attester, { sourceDomain: 5, txHash: "0x1" }, { ...time, intervalMs: 100, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(AttestationTimeout);
  });
});
