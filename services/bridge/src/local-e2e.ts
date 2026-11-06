import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CCTP_DOMAINS, contractAddresses, LOCAL_NETWORKS, type BridgeTransfer, type ContractAddresses } from "@noirwire/shared";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import type { DeliverResult, RouteAdapter } from "./executor.ts";
import { TreasuryExecutor } from "./executor.ts";
import { EvmDriver, hookExecutorAbi } from "./evm.ts";
import { encodeVaultHookData } from "./hooks.ts";
import { LocalAttester } from "./iris.ts";
import { addressToBytes32, encodeBurnBody, encodeMessage } from "./message.ts";
import { TransferStore } from "./transfers.ts";

const VAULT_DIR = fileURLToPath(new URL("../../../contracts/vault/", import.meta.url));
export const LOCAL_DEPLOYMENT = `${VAULT_DIR}deployments/local.json`;

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
  hookExecutor?: Hex;
  messageTransmitterV2?: Hex;
};

export function readLocalDeployment(): LocalDeployment | undefined {
  if (!existsSync(LOCAL_DEPLOYMENT)) return undefined;
  const parsed: ContractAddresses = contractAddresses.parse(JSON.parse(readFileSync(LOCAL_DEPLOYMENT, "utf8")));
  return {
    chainId: parsed.chainId,
    usdc: parsed.usdc as Hex,
    shareVault: parsed.shareVault as Hex | undefined,
    hookExecutor: parsed.hookExecutor as Hex | undefined,
    messageTransmitterV2: parsed.messageTransmitterV2 as Hex | undefined,
  };
}

export async function localChainReachable(rpcUrl: string): Promise<boolean> {
  try {
    await createPublicClient({ transport: http(rpcUrl, { timeout: 1500, retryCount: 0 }) }).getChainId();
    return true;
  } catch {
    return false;
  }
}

class LocalSolanaArcAdapter implements RouteAdapter {
  readonly messages = new Map<string, Hex>();
  private burns = 0;

  constructor(
    private readonly evm: EvmDriver,
    private readonly buildMessage: (amount: bigint, nonce: Hex) => Hex,
  ) {}

  async burn(transfer: BridgeTransfer): Promise<{ burnTx: string }> {
    const message = this.buildMessage(BigInt(transfer.grossAmount), keccak256(toHex(`local-nonce-${++this.burns}-${transfer.transferId}`)));
    const burnTx = `local-burn-${keccak256(message).slice(2, 18)}`;
    this.messages.set(burnTx, message);
    return { burnTx };
  }

  async messageFor(transfer: BridgeTransfer): Promise<Hex | undefined> {
    return this.messages.get(transfer.burnTx as string);
  }

  async deliver(_transfer: BridgeTransfer, message: Hex, attestation: Hex): Promise<DeliverResult> {
    const tx = await this.evm.relayThroughHookExecutor(message, attestation);
    return { status: "done", state: "hook-executed", tx };
  }

  async hookOutcome(transfer: BridgeTransfer): Promise<"vault-credited" | "claimable"> {
    const outcome = await this.evm.hookOutcome(transfer.mintTx as Hex);
    if (outcome === "quarantined") throw new Error("deposit quarantined");
    return outcome;
  }
}

export type LocalE2eResult = {
  transfer: BridgeTransfer;
  beneficiary: Hex;
  expectedNet: bigint;
  vaultAssets: bigint;
  inFlightAfter: number;
};

async function deployFromArtifacts(
  rpcUrl: string,
  deployer: Hex,
  transmitterOwner: Hex,
  attester: Hex,
): Promise<LocalDeployment> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
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
    26,
    deployer,
    transmitterOwner,
  ]);
  const vault = await deploy(artifact("ShareVault", "ShareVault"), [usdc, deployer, deployer]);
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
    hookExecutor,
    messageTransmitterV2: transmitter,
  };
}

export async function runLocalE2e(rpcUrl: string = LOCAL_NETWORKS.arcLocal.rpcUrl): Promise<LocalE2eResult> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const [operator, beneficiary] = await createWalletClient({ transport: http(rpcUrl) }).getAddresses();
  if (!operator || !beneficiary) throw new Error("the local node exposes no unlocked accounts");

  const attester = new LocalAttester([generatePrivateKey()]);
  const signerAddress = attester.signers()[0] as Hex;
  let addresses = readLocalDeployment();
  const deployedHere =
    addresses?.hookExecutor !== undefined && (await publicClient.getCode({ address: addresses.hookExecutor })) !== undefined;
  if (!addresses || !deployedHere) {
    addresses = await deployFromArtifacts(rpcUrl, operator, operator, signerAddress);
  }
  const { usdc, hookExecutor, messageTransmitterV2, shareVault } = addresses;
  if (!hookExecutor || !shareVault) throw new Error("local deployment lacks hookExecutor or shareVault");

  const walletClient = createWalletClient({ account: operator, chain: foundry, transport: http(rpcUrl) });
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
  const [sender, burnToken, recipient, localDomain] = await Promise.all([
    read("sourceTokenMessenger"),
    read("sourceBurnToken"),
    read("localTokenMessenger"),
    Promise.resolve(CCTP_DOMAINS.arc as number),
  ]);

  const fee = 500n;
  const executorWord = addressToBytes32(hookExecutor);
  const buildMessage = (amount: bigint, nonce: Hex): Hex =>
    encodeMessage({
      version: 1,
      sourceDomain: 5,
      destinationDomain: localDomain,
      nonce,
      sender,
      recipient,
      destinationCaller: executorWord,
      minFinalityThreshold: 1000,
      finalityThresholdExecuted: 1000,
      body: encodeBurnBody({
        version: 1,
        burnToken,
        mintRecipient: executorWord,
        amount,
        messageSender: `0x${"cd".repeat(32)}`,
        maxFee: fee,
        feeExecuted: fee,
        expirationBlock: 0n,
        hookData: encodeVaultHookData({
          beneficiary,
          solanaDepositor: `0x${"cd".repeat(32)}`,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
        }),
      }),
    });

  const evm = new EvmDriver(publicClient, walletClient, {
    usdc,
    tokenMessenger: hookExecutor,
    messageTransmitter: transmitter,
    hookExecutor,
  });
  const adapter = new LocalSolanaArcAdapter(evm, buildMessage);
  const store = new TransferStore();
  const executor = new TreasuryExecutor(
    store,
    attester,
    { "solana-arc": adapter },
    {
      routes: { "solana-arc": { destination: hookExecutor, maxFee: fee, beneficiary } },
      allowlist: new Set([hookExecutor.toLowerCase()]),
      dailyCap: 1_000_000_000n,
      defaultPerTransferCap: 1_000_000_000n,
      stuckTimeoutMs: 60_000,
      stuckRetryMs: 5_000,
    },
  );

  const amount = 7_500_000n;
  const before = await publicClient.readContract({ address: shareVault, abi: vaultAbi, functionName: "depositRequests", args: [beneficiary] });
  const intentId = keccak256(toHex(`e2e-${Date.now()}`));
  const [created] = executor.submit({
    intentId,
    closeId: 1,
    route: "solana-arc",
    amount: amount.toString(),
    reason: "solana-rebalance",
    marginRatioBps: 0,
  });
  if (!created) throw new Error("no transfer created");
  await executor.advance(created.transferId);

  const transfer = store.get(created.transferId) as BridgeTransfer;
  const after = await publicClient.readContract({ address: shareVault, abi: vaultAbi, functionName: "depositRequests", args: [beneficiary] });
  const expectedNet = amount - fee;
  return {
    transfer,
    beneficiary,
    expectedNet,
    vaultAssets: after[1] - before[1],
    inFlightAfter: store.inFlight().length,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rpc = process.env.LOCAL_RPC ?? LOCAL_NETWORKS.arcLocal.rpcUrl;
  runLocalE2e(rpc)
    .then((result) => {
      const ok =
        result.transfer.state === "vault-credited" &&
        result.transfer.attester === "local-test-attester" &&
        result.vaultAssets === result.expectedNet &&
        result.inFlightAfter === 0;
      console.log(JSON.stringify({ ok, ...result, expectedNet: String(result.expectedNet), vaultAssets: String(result.vaultAssets) }, null, 2));
      process.exit(ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
