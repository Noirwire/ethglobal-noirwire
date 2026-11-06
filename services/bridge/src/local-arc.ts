import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CCTP_DOMAINS, contractAddresses, type BridgeTransfer, type ContractAddresses, type TopUpIntent } from "@noirwire/shared";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import type { DeliverResult, RouteAdapter, RoutePolicy } from "./executor.ts";
import { EvmDriver, hookExecutorAbi } from "./evm.ts";
import { encodeVaultHookData, VAULT_HOOK_DEADLINE_SECONDS } from "./hooks.ts";
import { LocalAttester } from "./iris.ts";
import { ViemVaultChain, VaultTreasury } from "./vault.ts";
import {
  addressToBytes32,
  BURN_BODY_VERSION,
  encodeBurnBody,
  encodeMessage,
  FINALITY_FAST,
  MESSAGE_VERSION,
} from "./message.ts";

const VAULT_DIR = fileURLToPath(new URL("../../../contracts/vault/", import.meta.url));
export const LOCAL_DEPLOYMENT = `${VAULT_DIR}deployments/local.json`;

export const LOCAL_FEE = 500n;
export const DEFAULT_DEV_DEPOSIT = 7_500_000n;

const transmitterAbi = parseAbi([
  "function isEnabledAttester(address) view returns (bool)",
  "function setAttester(address attester, bool enabled)",
  "function owner() view returns (address)",
]);
const vaultAbi = parseAbi(["function depositRequests(address user) view returns (uint64 epoch, uint192 assets)"]);

type Artifact = { abi: Abi; bytecode: { object: Hex } };

function artifact(file: string, name: string): Artifact {
  const path = `${VAULT_DIR}out/${file}.sol/${name}.json`;
  if (!existsSync(path)) throw new Error(`missing ${path}; run forge build in contracts/vault`);
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}

export type LocalDeployment = {
  chainId: number;
  usdc: Hex;
  shareVault?: Hex;
  navReceiver?: Hex;
  creForwarder?: Hex;
  hookExecutor?: Hex;
  messageTransmitterV2?: Hex;
};

function readLocalDeployment(): LocalDeployment | undefined {
  if (!existsSync(LOCAL_DEPLOYMENT)) return undefined;
  const parsed: ContractAddresses = contractAddresses.parse(JSON.parse(readFileSync(LOCAL_DEPLOYMENT, "utf8")));
  return {
    chainId: parsed.chainId,
    usdc: parsed.usdc as Hex,
    shareVault: parsed.shareVault as Hex | undefined,
    navReceiver: parsed.navReceiver as Hex | undefined,
    creForwarder: parsed.creForwarder as Hex | undefined,
    hookExecutor: parsed.hookExecutor as Hex | undefined,
    messageTransmitterV2: parsed.messageTransmitterV2 as Hex | undefined,
  };
}

export const LOCAL_HYPERCORE_SINK: Hex = "0x00000000000000000000000000000000c0ffee19";
const LOCAL_MOVE_CAP = 1_000_000_000_000n;
const LOCAL_POLL_MS = 100;

export async function localChainReachable(rpcUrl: string): Promise<boolean> {
  try {
    await createPublicClient({ transport: http(rpcUrl, { timeout: 1500, retryCount: 0 }) }).getChainId();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class LocalSolanaArcAdapter implements RouteAdapter {
  private readonly messages = new Map<string, Hex>();
  private burns = 0;

  constructor(
    private readonly evm: EvmDriver,
    private readonly buildMessage: (amount: bigint, nonce: Hex) => Hex,
    private readonly stepDelayMs = 0,
  ) {}

  async burn(transfer: BridgeTransfer): Promise<{ burnTx: string }> {
    const message = this.buildMessage(BigInt(transfer.grossAmount), keccak256(toHex(`local-nonce-${++this.burns}-${transfer.transferId}`)));
    const burnTx = `local-burn-${keccak256(message).slice(2, 18)}`;
    this.messages.set(burnTx, message);
    return { burnTx };
  }

  async messageFor(transfer: BridgeTransfer): Promise<Hex | undefined> {
    await sleep(this.stepDelayMs);
    return this.messages.get(transfer.burnTx as string);
  }

  async deliver(_transfer: BridgeTransfer, message: Hex, attestation: Hex): Promise<DeliverResult> {
    await sleep(this.stepDelayMs);
    const tx = await this.evm.relayThroughHookExecutor(message, attestation);
    return { status: "done", state: "hook-executed", tx };
  }

  async hookOutcome(transfer: BridgeTransfer): Promise<"vault-credited" | "claimable"> {
    await sleep(this.stepDelayMs);
    return this.evm.creditedHookOutcome(transfer.mintTx as Hex);
  }
}

class LocalHypercoreAdapter implements RouteAdapter {
  constructor(
    private readonly evm: EvmDriver,
    private readonly buildMessage: (amount: bigint, nonce: Hex) => Hex,
    private readonly stepDelayMs = 0,
  ) {}

  async burn(transfer: BridgeTransfer): Promise<{ burnTx: string }> {
    const hash = await this.evm.walletClient.writeContract({
      address: this.evm.addresses.usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [LOCAL_HYPERCORE_SINK, BigInt(transfer.grossAmount)],
    });
    const receipt = await this.evm.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`local burn ${hash} reverted`);
    return { burnTx: hash };
  }

  async messageFor(transfer: BridgeTransfer): Promise<Hex | undefined> {
    await sleep(this.stepDelayMs);
    return this.buildMessage(BigInt(transfer.grossAmount), keccak256(toHex(`local-hypercore-${transfer.transferId}`)));
  }

  async deliver(transfer: BridgeTransfer): Promise<DeliverResult> {
    await sleep(this.stepDelayMs);
    return { status: "done", state: "forwarded", tx: `local-forward-${transfer.transferId}` };
  }

  destinationBalance(): Promise<bigint> {
    return this.evm.publicClient.readContract({
      address: this.evm.addresses.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [LOCAL_HYPERCORE_SINK],
    });
  }
}

async function deployFromArtifacts(
  rpcUrl: string,
  deployer: Hex,
  transmitterOwner: Hex,
  attester: Hex,
): Promise<LocalDeployment> {
  const publicClient = createPublicClient({ transport: http(rpcUrl), pollingInterval: LOCAL_POLL_MS });
  const walletClient = createWalletClient({ account: deployer, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  const deploy = async (item: Artifact, args: unknown[]): Promise<Hex> => {
    const hash = await walletClient.deployContract({
      abi: item.abi,
      bytecode: item.bytecode.object,
      args,
      chain: null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("deployment produced no address");
    return receipt.contractAddress;
  };
  const usdc = await deploy(artifact("MockUSDC", "MockUSDC"), []);
  const transmitter = await deploy(artifact("MockMessageTransmitterV2", "MockMessageTransmitterV2"), [
    usdc,
    attester,
    CCTP_DOMAINS.arc,
    deployer,
    transmitterOwner,
  ]);
  const vaultArtifact = artifact("ShareVault", "ShareVault");
  const vault = await deploy(vaultArtifact, [usdc, deployer, deployer]);
  const creForwarder = await deploy(artifact("MockForwarder", "MockForwarder"), []);
  const navReceiver = await deploy(artifact("NavReceiver", "NavReceiver"), [vault, creForwarder, deployer]);
  const configureVault = async (functionName: string, args: unknown[]) => {
    const hash = await walletClient.writeContract({ address: vault, abi: vaultArtifact.abi, functionName, args, chain: null });
    await publicClient.waitForTransactionReceipt({ hash });
  };
  await configureVault("setNavReceiver", [navReceiver]);
  await configureVault("setOperator", [deployer]);
  await configureVault("setDestinationAllowed", [deployer, true]);
  await configureVault("setMoveCaps", [LOCAL_MOVE_CAP, LOCAL_MOVE_CAP]);
  const messenger = addressToBytes32("0x00000000000000000000000000000000000000a1");
  const burnToken = addressToBytes32("0x00000000000000000000000000000000000000b2");
  const local = addressToBytes32("0x00000000000000000000000000000000000000c3");
  const hookExecutor = await deploy(artifact("HookExecutor", "HookExecutor"), [
    transmitter,
    usdc,
    vault,
    messenger,
    burnToken,
    local,
    deployer,
  ]);
  return {
    chainId,
    usdc,
    shareVault: vault,
    navReceiver,
    creForwarder,
    hookExecutor,
    messageTransmitterV2: transmitter,
  };
}

type LocalArcOptions = {
  deployIfMissing: boolean;
  stepDelayMs?: number;
};

export type LocalArc = {
  chainId: number;
  attester: LocalAttester;
  adapter: LocalSolanaArcAdapter;
  hookExecutor: Hex;
  beneficiary: Hex;
  route: RoutePolicy;
  hypercore: { adapter: RouteAdapter; route: RoutePolicy };
  vault: VaultTreasury;
  addresses: LocalDeployment;
  publicClient: PublicClient;
  treasury: Hex;
  depositIntent(amount: bigint): TopUpIntent;
  vaultPosition(): Promise<bigint>;
};

export async function setupLocalArc(rpcUrl: string, options: LocalArcOptions): Promise<LocalArc> {
  const bare = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await bare.getChainId();
  const chain = defineChain({
    id: chainId,
    name: "Arc Local",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(), pollingInterval: LOCAL_POLL_MS });
  const [operator, beneficiary] = await createWalletClient({ transport: http(rpcUrl) }).getAddresses();
  if (!operator || !beneficiary) throw new Error("the local node exposes no unlocked accounts");

  const attester = new LocalAttester([generatePrivateKey()]);
  const signerAddress = attester.signers()[0] as Hex;
  let addresses = readLocalDeployment();
  if (addresses && addresses.chainId !== chainId) {
    throw new Error(`${LOCAL_DEPLOYMENT} is for chain ${addresses.chainId} but the node reports chain ${chainId}`);
  }
  const deployedHere =
    addresses?.hookExecutor !== undefined && (await publicClient.getCode({ address: addresses.hookExecutor })) !== undefined;
  if (!addresses || !deployedHere) {
    if (!options.deployIfMissing) {
      throw new Error(`no local deployment on ${rpcUrl} (chain ${chainId}); run make deploy-local`);
    }
    addresses = await deployFromArtifacts(rpcUrl, operator, operator, signerAddress);
  }
  const { usdc, hookExecutor, messageTransmitterV2, shareVault } = addresses;
  if (!hookExecutor || !shareVault) throw new Error("local deployment lacks hookExecutor or shareVault");

  const walletClient = createWalletClient({ account: operator, chain, transport: http(rpcUrl) });
  const transmitter =
    messageTransmitterV2 ??
    (await publicClient.readContract({ address: hookExecutor, abi: hookExecutorAbi, functionName: "TRANSMITTER" }));
  const enabled = await publicClient.readContract({
    address: transmitter,
    abi: transmitterAbi,
    functionName: "isEnabledAttester",
    args: [signerAddress],
  });
  if (!enabled) {
    const owner = await publicClient.readContract({ address: transmitter, abi: transmitterAbi, functionName: "owner" });
    const ownerClient = createWalletClient({ account: owner, transport: http(rpcUrl) });
    const hash = await ownerClient.writeContract({
      address: transmitter,
      abi: transmitterAbi,
      functionName: "setAttester",
      args: [signerAddress, true],
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const read = <T extends "sourceTokenMessenger" | "sourceBurnToken" | "localTokenMessenger">(functionName: T) =>
    publicClient.readContract({ address: hookExecutor, abi: hookExecutorAbi, functionName });
  const [sender, burnToken, recipient] = await Promise.all([
    read("sourceTokenMessenger"),
    read("sourceBurnToken"),
    read("localTokenMessenger"),
  ]);

  const executorWord = addressToBytes32(hookExecutor);
  const solanaDepositor: Hex = `0x${"cd".repeat(32)}`;
  const buildMessage = (amount: bigint, nonce: Hex): Hex =>
    encodeMessage({
      version: MESSAGE_VERSION,
      sourceDomain: CCTP_DOMAINS.solana,
      destinationDomain: CCTP_DOMAINS.arc,
      nonce,
      sender,
      recipient,
      destinationCaller: executorWord,
      minFinalityThreshold: FINALITY_FAST,
      finalityThresholdExecuted: FINALITY_FAST,
      body: encodeBurnBody({
        version: BURN_BODY_VERSION,
        burnToken,
        mintRecipient: executorWord,
        amount,
        messageSender: solanaDepositor,
        maxFee: LOCAL_FEE,
        feeExecuted: LOCAL_FEE,
        expirationBlock: 0n,
        hookData: encodeVaultHookData({
          beneficiary,
          solanaDepositor,
          deadline: BigInt(Math.floor(Date.now() / 1000) + VAULT_HOOK_DEADLINE_SECONDS),
        }),
      }),
    });

  const sinkWord = addressToBytes32(LOCAL_HYPERCORE_SINK);
  const buildHypercoreMessage = (amount: bigint, nonce: Hex): Hex =>
    encodeMessage({
      version: MESSAGE_VERSION,
      sourceDomain: CCTP_DOMAINS.arc,
      destinationDomain: CCTP_DOMAINS.hyperEvm,
      nonce,
      sender: sinkWord,
      recipient: sinkWord,
      destinationCaller: sinkWord,
      minFinalityThreshold: FINALITY_FAST,
      finalityThresholdExecuted: FINALITY_FAST,
      body: encodeBurnBody({
        version: BURN_BODY_VERSION,
        burnToken: sinkWord,
        mintRecipient: sinkWord,
        amount,
        messageSender: addressToBytes32(operator),
        maxFee: LOCAL_FEE,
        feeExecuted: LOCAL_FEE,
        expirationBlock: 0n,
        hookData: "0x",
      }),
    });

  const evm = new EvmDriver(publicClient, walletClient, {
    usdc,
    tokenMessenger: hookExecutor,
    messageTransmitter: transmitter,
    hookExecutor,
  });
  return {
    chainId,
    attester,
    adapter: new LocalSolanaArcAdapter(evm, buildMessage, options.stepDelayMs),
    hookExecutor,
    beneficiary,
    route: { destination: hookExecutor, maxFee: LOCAL_FEE, beneficiary },
    hypercore: {
      adapter: new LocalHypercoreAdapter(evm, buildHypercoreMessage, options.stepDelayMs),
      route: { destination: LOCAL_HYPERCORE_SINK, maxFee: LOCAL_FEE },
    },
    vault: new VaultTreasury(shareVault, operator, new ViemVaultChain(publicClient, walletClient, shareVault)),
    addresses,
    publicClient,
    treasury: operator,
    depositIntent: (amount) => ({
      intentId: keccak256(toHex(`local-deposit-${Date.now()}-${Math.random()}`)),
      closeId: 1,
      route: "solana-arc",
      amount: amount.toString(),
      reason: "solana-rebalance",
      marginRatioBps: 0,
    }),
    vaultPosition: async () => {
      const [, assets] = await publicClient.readContract({
        address: shareVault,
        abi: vaultAbi,
        functionName: "depositRequests",
        args: [beneficiary],
      });
      return assets;
    },
  };
}
