import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  parseAbi,
  parseAbiItem,
  parseAbiParameters,
  zeroAddress,
  zeroHash,
  type Abi,
  type Hex,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TreasuryExecutor, type ExecutorConfig } from "../src/executor.ts";
import { DurableCursor, OnchainIntentWatcher, ViemIntentLogReader } from "../src/intent-watcher.ts";
import { LOCAL_DEPLOYMENT, LOCAL_HYPERCORE_SINK, localChainReachable, setupLocalArc, type LocalArc } from "../src/local-arc.ts";
import { TransferStore } from "../src/transfers.ts";
import { tempJournal, word } from "./helpers.ts";

const PORT = 8553;
const RPC = `http://127.0.0.1:${PORT}`;
const vaultOut = fileURLToPath(new URL("../../../contracts/vault/out/NavReceiver.sol/NavReceiver.json", import.meta.url));
const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const hasContracts = existsSync(LOCAL_DEPLOYMENT) || existsSync(vaultOut);

const USDC = 1_000_000n;
const DEPOSIT = 1000n * USDC;
const TOP_UP = 400n * USDC;

const vaultAbi = parseAbi([
  "function requestDeposit(uint256 assets, address receiver)",
  "function ledgerAssets() view returns (uint256)",
  "function idleAssets() view returns (uint256)",
  "function currentEpoch() view returns (uint64)",
]);
const mockUsdcAbi = parseAbi(["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)"]);
const forwarderAbi = parseAbi([
  "function deliver(address receiver, bytes32 workflowId, bytes10 workflowName, address workflowOwner, bytes report)",
]);
const movedToVenue = parseAbiItem("event MovedToVenue(address indexed to, uint256 amount)");

describe.skipIf(!hasAnvil || !hasContracts)("onchain top-up intent to an arc-hypercore transfer, on a local chain", () => {
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

  it("moves the USDC out of the vault and starts the transfer exactly once, restarts included", async () => {
    const arc: LocalArc = await setupLocalArc(RPC, { deployIfMissing: true });
    const { usdc, shareVault, navReceiver, creForwarder } = arc.addresses as Required<LocalArc["addresses"]>;
    const accounts = await createWalletClient({ transport: http(RPC) }).getAddresses();
    const depositor = accounts[2] as Hex;
    const publicClient = arc.publicClient;

    const act = async (account: Hex, request: { address: Hex; abi: Abi; functionName: string; args: unknown[] }) => {
      const hash = await createWalletClient({ account, transport: http(RPC) }).writeContract({ ...request, chain: null });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
    };
    const readVault = (functionName: "ledgerAssets" | "idleAssets" | "currentEpoch") =>
      publicClient.readContract({ address: shareVault, abi: vaultAbi, functionName });
    const balanceOf = (owner: Hex) =>
      publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    const forward = (report: Hex) =>
      act(depositor, {
        address: creForwarder,
        abi: forwarderAbi,
        functionName: "deliver",
        args: [navReceiver, zeroHash, `0x${"00".repeat(10)}`, zeroAddress, report],
      });
    const report = (kind: number, body: Hex) => encodeAbiParameters(parseAbiParameters("uint8, bytes"), [kind, body]);

    await act(accounts[0] as Hex, { address: usdc, abi: mockUsdcAbi, functionName: "mint", args: [depositor, DEPOSIT] });
    await act(depositor, { address: usdc, abi: mockUsdcAbi, functionName: "approve", args: [shareVault, DEPOSIT] });
    await act(depositor, { address: shareVault, abi: vaultAbi, functionName: "requestDeposit", args: [DEPOSIT, depositor] });

    const testClient = createTestClient({ mode: "anvil", transport: http(RPC) });
    await testClient.increaseTime({ seconds: 120 });
    await testClient.mine({ blocks: 1 });
    const observedAt = (await publicClient.getBlock()).timestamp;
    await forward(
      report(
        1,
        encodeAbiParameters(parseAbiParameters("uint8, uint64, uint64, uint256, uint256, bytes32"), [1, 1n, observedAt, DEPOSIT, 0n, zeroHash]),
      ),
    );
    expect(await readVault("currentEpoch")).toBe(2n);
    expect(await readVault("idleAssets")).toBe(DEPOSIT);

    const dir = dirname(tempJournal());
    const journal = join(dir, "transfers.ndjson");
    const cursorFile = join(dir, "cursor.json");
    const boot = () => {
      const store = new TransferStore(journal);
      const config: ExecutorConfig = {
        routes: { "arc-hypercore": arc.hypercore.route },
        allowlist: new Set([LOCAL_HYPERCORE_SINK.toLowerCase()]),
        dailyCap: 10_000n * USDC,
        defaultPerTransferCap: 1_000n * USDC,
        stuckTimeoutMs: 600_000,
        stuckRetryMs: 5_000,
        vault: arc.vault,
      };
      const executor = new TreasuryExecutor(store, arc.attester, { "arc-hypercore": arc.hypercore.adapter }, config);
      const watcher = new OnchainIntentWatcher(
        new ViemIntentLogReader(publicClient, navReceiver),
        new DurableCursor(cursorFile),
        executor,
        { confirmations: 0n },
      );
      return { store, executor, watcher };
    };

    const first = boot();
    await first.watcher.poll();

    const intentId = word(77);
    await forward(
      report(
        2,
        encodeAbiParameters(parseAbiParameters("uint8, bytes32, uint64, uint8, uint256, uint16, uint8"), [1, intentId, 2n, 0, TOP_UP, 9000, 0]),
      ),
    );
    expect((await first.watcher.poll()).submitted).toBe(1);
    expect(first.store.list().map((t) => t.state)).toEqual(["requested"]);
    expect(await readVault("ledgerAssets")).toBe(DEPOSIT);

    const afterCrash = boot();
    expect((await afterCrash.watcher.poll()).submitted).toBe(0);
    const [transfer] = afterCrash.store.list();
    expect(transfer?.state).toBe("requested");
    await afterCrash.executor.advance(transfer?.transferId as string);
    expect(afterCrash.store.get(transfer?.transferId as string)?.state).toBe("credited");

    const moves = () => publicClient.getLogs({ address: shareVault, event: movedToVenue, fromBlock: 0n });
    expect(await moves()).toHaveLength(1);
    expect(await readVault("ledgerAssets")).toBe(DEPOSIT - TOP_UP);
    expect(await balanceOf(shareVault)).toBe(DEPOSIT - TOP_UP);
    expect(await balanceOf(LOCAL_HYPERCORE_SINK)).toBe(TOP_UP);
    expect(await balanceOf(arc.treasury)).toBe(0n);

    writeFileSync(cursorFile, JSON.stringify({ nextBlock: "0" }));
    const replayed = boot();
    expect((await replayed.watcher.poll()).submitted).toBe(1);
    await replayed.executor.tick();
    expect(replayed.store.list()).toHaveLength(1);
    expect(await moves()).toHaveLength(1);
    expect(await readVault("ledgerAssets")).toBe(DEPOSIT - TOP_UP);
    expect(await balanceOf(LOCAL_HYPERCORE_SINK)).toBe(TOP_UP);
  }, 90_000);
});
