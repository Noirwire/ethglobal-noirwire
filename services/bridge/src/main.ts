import { LOCAL_NETWORKS, type TransferRoute } from "@noirwire/shared";
import { TreasuryExecutor, type ExecutorConfig, type RouteAdapter } from "./executor.ts";
import { IrisClient, type Attester } from "./iris.ts";
import { DEFAULT_DEV_DEPOSIT, setupLocalArc } from "./local-arc.ts";
import { intentWatcherWiring, type IntentWatcherWiring } from "./intent-watcher.ts";
import { createBridgeServer, DEFAULT_BRIDGE_PORT, IntentFileWatcher, resolveApiToken, type DevDeposit } from "./server.ts";
import { UnavailableDeposits, type SolanaDepositApi } from "./solana-deposit.ts";
import { AcceptingFundingVerifier, RebalanceBook } from "./rebalance.ts";
import { wireTestnet, type RebalanceWiring } from "./testnet.ts";
import { TransferStore } from "./transfers.ts";

const TICK_INTERVAL_MS = 5000;
const STUCK_TIMEOUT_MS = 30 * 60_000;
const STUCK_RETRY_MS = 60_000;
const DEFAULT_DAILY_CAP = "5000000000";
const DEFAULT_PER_TRANSFER_CAP = "1000000000";
const DEFAULT_LOCAL_STEP_MS = "1000";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

const network = env("BRIDGE_NETWORK") ?? "testnet";
if (network !== "testnet" && network !== "local") throw new Error(`BRIDGE_NETWORK must be testnet or local, got ${network}`);

const apiToken = resolveApiToken(network, env("BRIDGE_API_TOKEN"));
const store = new TransferStore(env("BRIDGE_JOURNAL") ?? "./data/transfers.ndjson");
const adapters: Partial<Record<TransferRoute, RouteAdapter>> = {};
const config: ExecutorConfig = {
  routes: {},
  allowlist: new Set((env("DESTINATION_ALLOWLIST") ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)),
  dailyCap: BigInt(env("DAILY_CAP") ?? DEFAULT_DAILY_CAP),
  defaultPerTransferCap: BigInt(env("PER_TRANSFER_CAP") ?? DEFAULT_PER_TRANSFER_CAP),
  stuckTimeoutMs: STUCK_TIMEOUT_MS,
  stuckRetryMs: STUCK_RETRY_MS,
};

let attester: Attester;
let devDeposit: DevDeposit | undefined;
let executor: TreasuryExecutor;
let buildSolanaDeposits: ((executor: TreasuryExecutor) => SolanaDepositApi) | undefined;
let intentWatcher: IntentWatcherWiring | undefined;
let buildRebalance: RebalanceWiring | undefined;
const rebalanceToken = resolveApiToken("local", env("REBALANCE_API_TOKEN"), "REBALANCE_API_TOKEN");
const LOCAL_DEPOSIT_REASON = "The bridge runs on a local chain, so there is no Solana burn to sign. Use the local simulation instead.";

if (network === "local") {
  const rpcUrl = env("ARC_RPC_URL") ?? LOCAL_NETWORKS.arcLocal.rpcUrl;
  const arc = await setupLocalArc(rpcUrl, {
    deployIfMissing: false,
    stepDelayMs: Number(env("BRIDGE_LOCAL_STEP_MS") ?? DEFAULT_LOCAL_STEP_MS),
  });
  attester = arc.attester;
  adapters["solana-arc"] = arc.adapter;
  config.routes["solana-arc"] = arc.route;
  adapters["arc-hypercore"] = arc.hypercore.adapter;
  config.routes["arc-hypercore"] = arc.hypercore.route;
  config.vault = arc.vault;
  adapters["solana-hypercore"] = arc.rebalance.out.adapter;
  config.routes["solana-hypercore"] = arc.rebalance.out.route;
  adapters["hypercore-solana"] = arc.rebalance.in.adapter;
  config.routes["hypercore-solana"] = arc.rebalance.in.route;
  config.allowlist = new Set([
    ...config.allowlist,
    arc.hookExecutor.toLowerCase(),
    arc.hypercore.route.destination.toLowerCase(),
    arc.rebalance.in.route.destination.toLowerCase(),
  ]);
  buildRebalance = {
    token: rebalanceToken,
    build: (executor, store) =>
      new RebalanceBook(executor, store, {
        bridgeAta: arc.rebalance.bridgeAta,
        verifier: new AcceptingFundingVerifier(),
        journalPath: env("REBALANCE_JOURNAL"),
      }),
  };
  const navReceiver = arc.addresses.navReceiver;
  if (navReceiver) {
    intentWatcher = intentWatcherWiring(env, arc.publicClient, navReceiver);
  }
  devDeposit = (amount) => {
    const transfers = executor.submit(arc.depositIntent(amount ?? DEFAULT_DEV_DEPOSIT));
    for (const transfer of transfers) void executor.advance(transfer.transferId);
    return { transfers, beneficiary: arc.beneficiary };
  };
  console.log(`bridge local mode: chain ${arc.chainId} at ${rpcUrl}, HookExecutor ${arc.hookExecutor}, attester local-test-attester`);
} else {
  const iris = new IrisClient(env("IRIS_URL"));
  attester = iris;
  const wired = wireTestnet(env, iris, adapters, config);
  buildSolanaDeposits = wired.solanaDeposits;
  intentWatcher = wired.intentWatcher;
  buildRebalance = wired.rebalance;
}

executor = new TreasuryExecutor(store, attester, adapters, config);
const solanaDeposits =
  network === "local"
    ? new UnavailableDeposits("local", LOCAL_DEPOSIT_REASON)
    : (buildSolanaDeposits?.(executor) ??
      new UnavailableDeposits("testnet", "Solana deposits need SOLANA_KEYPAIR_PATH and HOOK_EXECUTOR on the bridge"));
const port = Number(env("BRIDGE_PORT") ?? DEFAULT_BRIDGE_PORT);
const rebalanceBook = buildRebalance?.build(executor, store);
const server = createBridgeServer(
  store,
  executor,
  devDeposit,
  solanaDeposits,
  apiToken,
  rebalanceBook && { book: rebalanceBook, token: buildRebalance?.token },
);
server.listen(port, () => {
  console.log(`bridge listening on ${port}`);
  if (!apiToken) console.log("BRIDGE_API_TOKEN is unset: POST routes accept unauthenticated requests (local mode only)");
});

const intentFile = env("INTENT_FILE");
if (intentFile && network !== "local") console.error("INTENT_FILE is ignored outside local mode: testnet intents come only from the onchain NavReceiver and the authenticated API");
const watcher = intentFile && network === "local" ? new IntentFileWatcher(intentFile, executor) : undefined;
setInterval(() => {
  watcher?.poll();
  void (rebalanceBook?.tick() ?? Promise.resolve()).then(() => executor.tick());
}, TICK_INTERVAL_MS);

if (intentWatcher) {
  const onchain = intentWatcher.build(executor);
  const pollOnchain = () => {
    onchain
      .poll()
      .then((result) => {
        if (result.submitted + result.refused + result.malformed > 0) {
          console.log(`onchain intents: ${result.submitted} submitted, ${result.refused} refused, ${result.malformed} malformed`);
          void executor.tick();
        }
      })
      .catch((error) => console.error("onchain intent poll failed:", error instanceof Error ? error.message : error));
  };
  pollOnchain();
  setInterval(pollOnchain, intentWatcher.pollMs);
  console.log(`watching NavReceiver for top-up intents every ${intentWatcher.pollMs} ms`);
}
