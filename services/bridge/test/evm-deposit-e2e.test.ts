import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CCTP_DOMAINS, EVM_FUNDING_SOURCES } from "@noirwire/shared";
import { keccak256, toHex, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TreasuryExecutor } from "../src/executor.ts";
import { EVM_DEPOSIT_ROUTES, EvmArcAdapter, EvmDeposits, type EvmSourceReader, type ObservedBurn } from "../src/evm-deposit.ts";
import type { Attestation, AttestationQuery, Attester } from "../src/iris.ts";
import { LOCAL_DEPLOYMENT, LOCAL_FEE, localChainReachable, setupLocalArc, type LocalArc } from "../src/local-arc.ts";
import { decodeMessage, encodeMessage } from "../src/message.ts";
import { TransferStore } from "../src/transfers.ts";
import { sourceMessage, SOURCES } from "./evm-fixtures.ts";

const PORT = 8558;
const RPC = `http://127.0.0.1:${PORT}`;
const vaultOut = fileURLToPath(new URL("../../../contracts/vault/out/HookExecutor.sol/HookExecutor.json", import.meta.url));
const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const hasContracts = existsSync(LOCAL_DEPLOYMENT) || existsSync(vaultOut);
const AMOUNT = 4_000_000n;

class SourceChains implements EvmSourceReader {
  readonly burns = new Map<string, Hex>();

  async burnTransaction(domain: number, txHash: Hex): Promise<ObservedBurn | null> {
    const message = this.burns.get(`${domain}:${txHash}`);
    return message ? { failed: false, messages: [message] } : null;
  }
}

class IrisStandIn implements Attester {
  readonly label = "local-test-attester" as const;

  constructor(
    private readonly arc: LocalArc,
    private readonly chains: SourceChains,
  ) {}

  async fetchAttestation(query: AttestationQuery): Promise<Attestation> {
    const source = this.chains.burns.get(`${query.sourceDomain}:${query.txHash}`);
    if (!source) return { status: "pending" };
    const header = decodeMessage(source);
    const message = encodeMessage({
      ...header,
      nonce: keccak256(toHex(`iris-nonce-${query.sourceDomain}-${query.txHash}`)),
      finalityThresholdExecuted: 1000,
      body: header.body,
    });
    return { status: "complete", message, attestation: await this.arc.attester.attest(message) };
  }
}

async function settled(store: TransferStore, id: string): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = store.get(id)?.state;
    if (state === "vault-credited" || state === "claimable" || state === "failed") return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`transfer ${id} did not settle`);
}

describe.skipIf(!hasAnvil || !hasContracts)("local end to end, EVM burn to Arc through the HookExecutor", () => {
  let anvil: ChildProcess | undefined;

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let attempt = 0; attempt < 50 && !(await localChainReachable(RPC)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 15_000);

  afterAll(() => {
    if (anvil?.pid) process.kill(anvil.pid);
  });

  it("relays a burn from each source domain, credits the vault once and stays idempotent", async () => {
    const arc = await setupLocalArc(RPC, { deployIfMissing: true });
    const chains = new SourceChains();
    const store = new TransferStore();
    const routes = Object.values(EVM_DEPOSIT_ROUTES);
    const executor = new TreasuryExecutor(
      store,
      new IrisStandIn(arc, chains),
      Object.fromEntries(routes.map((route) => [route, new EvmArcAdapter(arc.evm)])),
      {
        routes: Object.fromEntries(routes.map((route) => [route, { destination: arc.hookExecutor, maxFee: 1_000_000n }])),
        allowlist: new Set([arc.hookExecutor.toLowerCase()]),
        dailyCap: 1_000_000_000n,
        defaultPerTransferCap: 1_000_000_000n,
        stuckTimeoutMs: 60_000,
        stuckRetryMs: 5_000,
      },
    );
    const deposits = new EvmDeposits(chains, executor, store, {
      hookExecutor: arc.hookExecutor,
      localTokenMessenger: arc.localTokenMessenger,
      sources: SOURCES,
    });

    const domains = Object.values(EVM_FUNDING_SOURCES).map((source) => source.cctpDomain);
    expect(domains.sort()).toEqual([CCTP_DOMAINS.ethereum, CCTP_DOMAINS.arbitrum, CCTP_DOMAINS.base].sort());
    for (const [index, domain] of domains.entries()) {
      const txHash = keccak256(toHex(`source-burn-${domain}`));
      chains.burns.set(
        `${domain}:${txHash}`,
        sourceMessage(domain, { hookExecutor: arc.hookExecutor, localTokenMessenger: arc.localTokenMessenger, beneficiary: arc.beneficiary, amount: AMOUNT, feeExecuted: LOCAL_FEE }),
      );
      const before = await arc.vaultPosition();
      const transfer = await deposits.register(domain, txHash);
      expect(await settled(store, transfer.transferId)).toBe("vault-credited");
      expect(await arc.vaultPosition()).toBe(before + AMOUNT - LOCAL_FEE);

      const final = store.get(transfer.transferId)!;
      expect(final.route).toBe(EVM_DEPOSIT_ROUTES[domain]);
      expect(final.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(final.cctpNonce).toBe(keccak256(toHex(`iris-nonce-${domain}-${txHash}`)));
      expect(final.netMinted).toBe((AMOUNT - LOCAL_FEE).toString());

      const again = await deposits.register(domain, txHash);
      await executor.tick();
      expect(again.transferId).toBe(transfer.transferId);
      expect(await arc.vaultPosition()).toBe(before + AMOUNT - LOCAL_FEE);
      expect(store.list()).toHaveLength(index + 1);
    }
    expect(store.inFlight()).toHaveLength(0);
  }, 90_000);
});
