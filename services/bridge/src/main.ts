import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NETWORKS, type TransferRoute } from "@noirwire/shared";
import { bytesToHex, createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_USDC, CIRCLE_TESTNET, SOLANA_DEVNET_USDC_MINT } from "./addresses.ts";
import { ArcHypercoreAdapter, ArcSolanaAdapter, SolanaArcAdapter } from "./adapters.ts";
import { EvmDriver } from "./evm.ts";
import { TreasuryExecutor, type ExecutorConfig, type RouteAdapter } from "./executor.ts";
import { HyperliquidInfoReader } from "./hyperliquid.ts";
import { IrisClient } from "./iris.ts";
import { BRIDGE_PORT, createBridgeServer, IntentFileWatcher } from "./server.ts";
import { SolanaDriver } from "./solana.ts";
import { TransferStore } from "./transfers.ts";

const TICK_INTERVAL_MS = 5000;
const STUCK_TIMEOUT_MS = 30 * 60_000;
const STUCK_RETRY_MS = 60_000;
const VAULT_HOOK_DEADLINE_SECONDS = 3600;
const DEFAULT_DAILY_CAP = "5000000000";
const DEFAULT_PER_TRANSFER_CAP = "1000000000";
const DEFAULT_HYPERCORE_MAX_FEE = "300000";
const DEFAULT_SOLANA_MAX_FEE = "100000";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function required(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const store = new TransferStore(env("BRIDGE_JOURNAL") ?? "./data/transfers.ndjson");
const iris = new IrisClient(env("IRIS_URL"));

const arcChain = defineChain({
  id: NETWORKS.arcTestnet.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [env("ARC_RPC_URL") ?? NETWORKS.arcTestnet.rpcUrl] } },
});

const arcOperator = privateKeyToAccount(required("ARC_OPERATOR_KEY") as Hex);
const hookExecutor = env("HOOK_EXECUTOR") as Hex | undefined;
const evm = new EvmDriver(
  createPublicClient({ chain: arcChain, transport: http() }),
  createWalletClient({ account: arcOperator, chain: arcChain, transport: http() }),
  {
    usdc: (env("ARC_USDC") as Hex | undefined) ?? ARC_TESTNET_USDC,
    tokenMessenger: CIRCLE_TESTNET.tokenMessengerV2,
    messageTransmitter: CIRCLE_TESTNET.messageTransmitterV2,
    hookExecutor,
  },
);

const adapters: Partial<Record<TransferRoute, RouteAdapter>> = {};
const config: ExecutorConfig = {
  routes: {},
  allowlist: new Set((env("DESTINATION_ALLOWLIST") ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)),
  dailyCap: BigInt(env("DAILY_CAP") ?? DEFAULT_DAILY_CAP),
  defaultPerTransferCap: BigInt(env("PER_TRANSFER_CAP") ?? DEFAULT_PER_TRANSFER_CAP),
  stuckTimeoutMs: STUCK_TIMEOUT_MS,
  stuckRetryMs: STUCK_RETRY_MS,
};

const hyperCoreRecipient = env("HYPERCORE_RECIPIENT") as Hex | undefined;
if (hyperCoreRecipient) {
  adapters["arc-hypercore"] = new ArcHypercoreAdapter(evm, iris, {
    forwarder: CIRCLE_TESTNET.hyperEvmCctpForwarder,
    recipient: hyperCoreRecipient,
    reader: new HyperliquidInfoReader(NETWORKS.hyperliquidTestnetApi.infoUrl),
  });
  config.routes["arc-hypercore"] = {
    destination: hyperCoreRecipient,
    maxFee: BigInt(env("HYPERCORE_MAX_FEE") ?? DEFAULT_HYPERCORE_MAX_FEE),
  };
}

const solanaKeyPath = env("SOLANA_KEYPAIR_PATH");
if (solanaKeyPath) {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(solanaKeyPath, "utf8")) as number[]));
  const solana = new SolanaDriver(
    new Connection(env("SOLANA_RPC_URL") ?? NETWORKS.solanaDevnet.rpcUrl, "confirmed"),
    keypair,
    new PublicKey(SOLANA_DEVNET_USDC_MINT),
  );
  const makerTokenAccount = solana.tokenAccount();
  adapters["arc-solana"] = new ArcSolanaAdapter(evm, solana, { makerTokenAccount });
  config.routes["arc-solana"] = { destination: makerTokenAccount.toBase58(), maxFee: BigInt(env("SOLANA_MAX_FEE") ?? DEFAULT_SOLANA_MAX_FEE) };
  if (hookExecutor) {
    const beneficiary = (env("RETURN_BENEFICIARY") as Hex | undefined) ?? arcOperator.address;
    adapters["solana-arc"] = new SolanaArcAdapter(solana, evm, {
      hookExecutor,
      beneficiary,
      solanaDepositor: bytesToHex(keypair.publicKey.toBytes()),
      deadlineSeconds: VAULT_HOOK_DEADLINE_SECONDS,
    });
    config.routes["solana-arc"] = {
      destination: hookExecutor,
      maxFee: BigInt(env("SOLANA_ARC_MAX_FEE") ?? DEFAULT_SOLANA_MAX_FEE),
    };
  }
}

const executor = new TreasuryExecutor(store, iris, adapters, config);
const server = createBridgeServer(store, executor);
server.listen(BRIDGE_PORT, () => console.log(`bridge listening on ${BRIDGE_PORT}`));

const intentFile = env("INTENT_FILE");
const watcher = intentFile ? new IntentFileWatcher(intentFile, executor) : undefined;
setInterval(() => {
  watcher?.poll();
  void executor.tick();
}, TICK_INTERVAL_MS);
