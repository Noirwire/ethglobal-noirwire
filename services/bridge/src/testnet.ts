import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { EVM_FUNDING_SOURCES, NETWORKS, type EvmFundingSourceId, type TransferRoute } from "@noirwire/shared";
import { EVM_DEPOSIT_ROUTES, EvmArcAdapter, EvmDeposits, ViemSourceReader, type EvmDepositApi, type EvmDepositSource } from "./evm-deposit.ts";
import { bytesToHex, createPublicClient, createWalletClient, defineChain, erc20Abi, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_USDC, CIRCLE_TESTNET, CORE_DEPOSIT_WALLET_TESTNET, SOLANA_DEVNET_USDC_MINT } from "./addresses.ts";
import { HypercoreArcAdapter, HypercoreSolanaAdapter, IrisReturnFees, ViemHyperEvmBurns } from "./hypercore-arc.ts";
import { DEFAULT_RETURN_GAS_LIMIT, HttpHyperliquidExchange } from "./hyperliquid-withdraw.ts";
import { ArcHypercoreAdapter, ArcSolanaAdapter, SolanaArcAdapter, SolanaHypercoreAdapter } from "./adapters.ts";
import { RebalanceBook, SolanaFundingVerifier } from "./rebalance.ts";
import { resolveApiToken } from "./server.ts";
import type { TransferStore } from "./transfers.ts";
import { EvmDriver } from "./evm.ts";
import type { ExecutorConfig, RouteAdapter, TreasuryExecutor } from "./executor.ts";
import { VAULT_HOOK_DEADLINE_SECONDS } from "./hooks.ts";
import { DEFAULT_LEDGER_MATCH, HyperliquidInfoReader, HyperliquidLedgerReader, type LedgerMatchConfig } from "./hyperliquid.ts";
import { intentWatcherWiring, type IntentWatcherWiring } from "./intent-watcher.ts";
import { IRIS_SANDBOX_URL, type IrisClient } from "./iris.ts";
import { VaultTreasury, ViemVaultChain } from "./vault.ts";
import { SolanaDriver } from "./solana.ts";
import { ConnectionReader, SolanaDeposits, type SolanaDepositApi } from "./solana-deposit.ts";

export type RebalanceWiring = { token?: string; build: (executor: TreasuryExecutor, store: TransferStore) => RebalanceBook };

const DEFAULT_HYPERCORE_MAX_FEE = "300000";
const DEFAULT_SOLANA_MAX_FEE = "100000";
const DEFAULT_RETURN_MAX_FEE = "300000";
const DEFAULT_EVM_ARC_MAX_FEE = 1_000_000n;

const EVM_RPC_ENV: Record<EvmFundingSourceId, string> = {
  ethereumSepolia: "ETHEREUM_SEPOLIA_RPC_URL",
  baseSepolia: "BASE_SEPOLIA_RPC_URL",
  arbitrumSepolia: "ARBITRUM_SEPOLIA_RPC_URL",
};

function listEnv(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

export function assertSameHyperCoreAccount(recipient: string | undefined, signer: string | undefined): void {
  if (recipient && signer && recipient.toLowerCase() !== signer.toLowerCase()) {
    throw new Error("HYPERCORE_RECIPIENT must be the address of HYPERCORE_ACCOUNT_KEY, otherwise top-ups fund one account and returns sign for another");
  }
}

export function wireTestnet(
  env: (name: string) => string | undefined,
  iris: IrisClient,
  adapters: Partial<Record<TransferRoute, RouteAdapter>>,
  config: ExecutorConfig,
): {
  solanaDeposits?: (executor: TreasuryExecutor) => SolanaDepositApi;
  evmDeposits?: (executor: TreasuryExecutor, store: TransferStore) => EvmDepositApi;
  intentWatcher?: IntentWatcherWiring;
  rebalance?: RebalanceWiring;
} {
  let rebalance: RebalanceWiring | undefined;
  let solanaDeposits: ((executor: TreasuryExecutor) => SolanaDepositApi) | undefined;
  let evmDeposits: ((executor: TreasuryExecutor, store: TransferStore) => EvmDepositApi) | undefined;
  let intentWatcher: IntentWatcherWiring | undefined;
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

  if (hookExecutor) {
    for (const route of Object.values(EVM_DEPOSIT_ROUTES)) {
      adapters[route] = new EvmArcAdapter(evm);
      config.routes[route] = { destination: hookExecutor, maxFee: DEFAULT_EVM_ARC_MAX_FEE };
    }
    const rpcUrls: Record<number, string> = {};
    const transmitters: Record<number, Hex> = {};
    const sources: Record<number, EvmDepositSource> = {};
    for (const [id, source] of Object.entries(EVM_FUNDING_SOURCES)) {
      rpcUrls[source.cctpDomain] = env(EVM_RPC_ENV[id as EvmFundingSourceId]) ?? source.rpcUrl;
      transmitters[source.cctpDomain] = CIRCLE_TESTNET.messageTransmitterV2;
      sources[source.cctpDomain] = {
        label: source.label,
        tokenMessenger: CIRCLE_TESTNET.tokenMessengerV2,
        messageTransmitter: CIRCLE_TESTNET.messageTransmitterV2,
        usdc: source.usdc,
      };
    }
    evmDeposits = (executor, transferStore) =>
      new EvmDeposits(new ViemSourceReader(rpcUrls, transmitters), executor, transferStore, {
        hookExecutor,
        localTokenMessenger: CIRCLE_TESTNET.tokenMessengerV2,
        sources,
      });
  }

  const shareVault = env("SHARE_VAULT") as Hex | undefined;
  const navReceiver = env("NAV_RECEIVER") as Hex | undefined;
  if (navReceiver && !shareVault) throw new Error("NAV_RECEIVER needs SHARE_VAULT so intents can release funds from the vault");
  if (shareVault) {
    config.vault = new VaultTreasury(shareVault, arcOperator.address, new ViemVaultChain(evm.publicClient, evm.walletClient, shareVault));
  }
  if (navReceiver) {
    intentWatcher = intentWatcherWiring(env, evm.publicClient, navReceiver);
  }

  const accountKey = env("HYPERCORE_ACCOUNT_KEY");
  const hyperCoreAccount = accountKey ? privateKeyToAccount(accountKey as Hex) : undefined;
  const configuredRecipient = env("HYPERCORE_RECIPIENT") as Hex | undefined;
  assertSameHyperCoreAccount(configuredRecipient, hyperCoreAccount?.address);
  const hyperCoreRecipient = configuredRecipient ?? hyperCoreAccount?.address;
  const coreDepositWallet = (env("CORE_DEPOSIT_WALLET") as Hex | undefined) ?? CORE_DEPOSIT_WALLET_TESTNET;
  const ledger = new HyperliquidLedgerReader(NETWORKS.hyperliquidTestnetApi.infoUrl);
  const match: LedgerMatchConfig = {
    debitTypes: listEnv(env("HYPERCORE_DEBIT_LEDGER_TYPES")) ?? DEFAULT_LEDGER_MATCH.debitTypes,
    creditTypes: listEnv(env("HYPERCORE_CREDIT_LEDGER_TYPES")) ?? DEFAULT_LEDGER_MATCH.creditTypes,
    creditCounterparty: env("HYPERCORE_CREDIT_COUNTERPARTY") ?? coreDepositWallet,
    amountTolerance: BigInt(env("HYPERCORE_AMOUNT_TOLERANCE") ?? DEFAULT_LEDGER_MATCH.amountTolerance),
  };
  if (hyperCoreRecipient) {
    adapters["arc-hypercore"] = new ArcHypercoreAdapter(evm, iris, {
      forwarder: CIRCLE_TESTNET.hyperEvmCctpForwarder,
      recipient: hyperCoreRecipient,
      reader: new HyperliquidInfoReader(NETWORKS.hyperliquidTestnetApi.infoUrl),
      ledger,
      match,
    });
    config.routes["arc-hypercore"] = {
      destination: hyperCoreRecipient,
      maxFee: BigInt(env("HYPERCORE_MAX_FEE") ?? DEFAULT_HYPERCORE_MAX_FEE),
    };
  }
  const hyperEvm = createPublicClient({
    chain: defineChain({
      id: NETWORKS.hyperEvmTestnet.chainId,
      name: "HyperEVM Testnet",
      nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
      rpcUrls: { default: { http: [env("HYPEREVM_RPC_URL") ?? NETWORKS.hyperEvmTestnet.rpcUrl] } },
    }),
    transport: http(),
  });
  const withdrawal = hyperCoreAccount && {
    account: hyperCoreAccount,
    coreDepositWallet,
    hyperliquidChain: "Testnet" as const,
    sourceDex: env("HYPERCORE_SOURCE_DEX") === "spot" ? ("spot" as const) : ("" as const),
    gasLimit: Number(env("HYPERCORE_RETURN_GAS_LIMIT") ?? DEFAULT_RETURN_GAS_LIMIT),
    match,
    exchange: new HttpHyperliquidExchange(NETWORKS.hyperliquidTestnetApi.exchangeUrl),
    ledger,
    burns: new ViemHyperEvmBurns(hyperEvm, CIRCLE_TESTNET.tokenMessengerV2),
  };
  if (withdrawal && shareVault) {
    adapters["hypercore-arc"] = new HypercoreArcAdapter({
      ...withdrawal,
      vault: shareVault,
      fees: new IrisReturnFees(env("IRIS_URL") ?? IRIS_SANDBOX_URL),
      iris,
      vaultBalance: () =>
        evm.publicClient.readContract({ address: evm.addresses.usdc, abi: erc20Abi, functionName: "balanceOf", args: [shareVault] }),
    });
    config.routes["hypercore-arc"] = {
      destination: shareVault,
      maxFee: BigInt(env("HYPERCORE_RETURN_MAX_FEE") ?? DEFAULT_RETURN_MAX_FEE),
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
    const reader = new HyperliquidInfoReader(NETWORKS.hyperliquidTestnetApi.infoUrl);
    if (hyperCoreRecipient) {
      adapters["solana-hypercore"] = new SolanaHypercoreAdapter(solana, iris, {
        forwarder: CIRCLE_TESTNET.hyperEvmCctpForwarder,
        recipient: hyperCoreRecipient,
        reader,
        ledger,
        match,
      });
      config.routes["solana-hypercore"] = {
        destination: hyperCoreRecipient,
        maxFee: BigInt(env("SOLANA_HYPERCORE_MAX_FEE") ?? DEFAULT_HYPERCORE_MAX_FEE),
      };
    }
    const makerOwner = env("REBALANCE_MAKER_OWNER");
    if (withdrawal && makerOwner) {
      const owner = new PublicKey(makerOwner);
      adapters["hypercore-solana"] = new HypercoreSolanaAdapter({
        ...withdrawal,
        iris,
        solana,
        makerOwner: owner,
      });
      config.routes["hypercore-solana"] = {
        destination: solana.tokenAccount(owner).toBase58(),
        maxFee: BigInt(env("HYPERCORE_SOLANA_MAX_FEE") ?? DEFAULT_RETURN_MAX_FEE),
      };
    }
    if (env("REBALANCE_API_TOKEN")) {
      rebalance = {
        token: resolveApiToken("testnet", env("REBALANCE_API_TOKEN"), "REBALANCE_API_TOKEN"),
        build: (executor, store) =>
          new RebalanceBook(executor, store, {
            bridgeAta: makerTokenAccount.toBase58(),
            verifier: new SolanaFundingVerifier(solana.connection, solana.usdcMint),
            journalPath: env("REBALANCE_JOURNAL") ?? "./data/rebalance.ndjson",
          }),
      };
    }
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
  return { solanaDeposits, evmDeposits, intentWatcher, rebalance };
}
