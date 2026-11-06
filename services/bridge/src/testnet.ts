import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NETWORKS, type TransferRoute } from "@noirwire/shared";
import { bytesToHex, createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_USDC, CIRCLE_TESTNET, SOLANA_DEVNET_USDC_MINT } from "./addresses.ts";
import { ArcHypercoreAdapter, ArcSolanaAdapter, SolanaArcAdapter } from "./adapters.ts";
import { EvmDriver } from "./evm.ts";
import type { ExecutorConfig, RouteAdapter, TreasuryExecutor } from "./executor.ts";
import { VAULT_HOOK_DEADLINE_SECONDS } from "./hooks.ts";
import { HyperliquidInfoReader } from "./hyperliquid.ts";
import { DurableCursor, OnchainIntentWatcher, ViemIntentLogReader, watcherSettings } from "./intent-watcher.ts";
import type { IrisClient } from "./iris.ts";
import { VaultTreasury, ViemVaultChain } from "./vault.ts";
import { SolanaDriver } from "./solana.ts";
import { ConnectionReader, SolanaDeposits, type SolanaDepositApi } from "./solana-deposit.ts";

const DEFAULT_HYPERCORE_MAX_FEE = "300000";
const DEFAULT_SOLANA_MAX_FEE = "100000";

export function wireTestnet(
  env: (name: string) => string | undefined,
  iris: IrisClient,
  adapters: Partial<Record<TransferRoute, RouteAdapter>>,
  config: ExecutorConfig,
): {
  solanaDeposits?: (executor: TreasuryExecutor) => SolanaDepositApi;
  intentWatcher?: { build: (executor: TreasuryExecutor) => OnchainIntentWatcher; pollMs: number };
} {
  let solanaDeposits: ((executor: TreasuryExecutor) => SolanaDepositApi) | undefined;
  let intentWatcher: { build: (executor: TreasuryExecutor) => OnchainIntentWatcher; pollMs: number } | undefined;
  const operatorKey = env("ARC_OPERATOR_KEY");
  if (!operatorKey) throw new Error("ARC_OPERATOR_KEY is required");

  const arcChain = defineChain({
    id: NETWORKS.arcTestnet.chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [env("ARC_RPC_URL") ?? NETWORKS.arcTestnet.rpcUrl] } },
  });

  const arcOperator = privateKeyToAccount(operatorKey as Hex);
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

  const shareVault = env("SHARE_VAULT") as Hex | undefined;
  const navReceiver = env("NAV_RECEIVER") as Hex | undefined;
  if (navReceiver && !shareVault) throw new Error("NAV_RECEIVER needs SHARE_VAULT so intents can release funds from the vault");
  if (shareVault) {
    config.vault = new VaultTreasury(shareVault, arcOperator.address, new ViemVaultChain(evm.publicClient, evm.walletClient, shareVault));
  }
  if (navReceiver) {
    const settings = watcherSettings(env);
    intentWatcher = {
      pollMs: settings.pollMs,
      build: (executor) =>
        new OnchainIntentWatcher(
          new ViemIntentLogReader(evm.publicClient, navReceiver),
          new DurableCursor(settings.cursorFile),
          executor,
          settings.options,
        ),
    };
  }

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
      const maxFee = BigInt(env("SOLANA_ARC_MAX_FEE") ?? DEFAULT_SOLANA_MAX_FEE);
      config.routes["solana-arc"] = { destination: hookExecutor, maxFee };
      solanaDeposits = (executor) =>
        new SolanaDeposits(new ConnectionReader(solana.connection), executor, {
          hookExecutor,
          usdcMint: solana.usdcMint,
          maxFee,
          deadlineSeconds: VAULT_HOOK_DEADLINE_SECONDS,
        });
    }
  }
  return { solanaDeposits, intentWatcher };
}
