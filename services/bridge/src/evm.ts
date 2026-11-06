import {
  erc20Abi,
  parseAbi,
  parseEventLogs,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

export const tokenMessengerV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

export const messageTransmitterV2Abi = parseAbi([
  "event MessageSent(bytes message)",
]);

export const hookExecutorAbi = parseAbi([
  "function relay(bytes message, bytes attestation)",
  "function TRANSMITTER() view returns (address)",
  "function sourceTokenMessenger(uint32 domain) view returns (bytes32)",
  "function sourceBurnToken(uint32 domain) view returns (bytes32)",
  "function localTokenMessenger() view returns (bytes32)",
  "event DepositForwarded(bytes32 indexed nonce, address indexed beneficiary, bytes32 solanaDepositor, uint256 amount)",
  "event DepositHeld(bytes32 indexed nonce, address indexed beneficiary, bytes32 solanaDepositor, uint256 amount, bytes32 reason)",
  "event DepositQuarantined(bytes32 indexed nonce, uint256 amount)",
]);

export type EvmBurnParams = {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData?: Hex;
};

export type EvmAddresses = {
  usdc: Hex;
  tokenMessenger: Hex;
  messageTransmitter: Hex;
  hookExecutor?: Hex;
};

type Wallet = WalletClient<Transport, Chain, Account>;

export class EvmDriver {
  constructor(
    readonly publicClient: PublicClient,
    readonly walletClient: Wallet,
    readonly addresses: EvmAddresses,
  ) {}

  async depositForBurn(params: EvmBurnParams): Promise<Hex> {
    await this.ensureAllowance(params.amount);
    const common = [
      params.amount,
      params.destinationDomain,
      params.mintRecipient,
      this.addresses.usdc,
      params.destinationCaller,
      params.maxFee,
      params.minFinalityThreshold,
    ] as const;
    if (params.hookData) {
      return this.walletClient.writeContract({
        address: this.addresses.tokenMessenger,
        abi: tokenMessengerV2Abi,
        functionName: "depositForBurnWithHook",
        args: [...common, params.hookData],
      });
    }
    return this.walletClient.writeContract({
      address: this.addresses.tokenMessenger,
      abi: tokenMessengerV2Abi,
      functionName: "depositForBurn",
      args: common,
    });
  }

  async messageFromBurn(txHash: Hex): Promise<Hex> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`burn ${txHash} reverted`);
    return extractMessageSent(receipt.logs, this.addresses.messageTransmitter);
  }

  async relayThroughHookExecutor(message: Hex, attestation: Hex): Promise<Hex> {
    const executor = this.addresses.hookExecutor;
    if (!executor) throw new Error("no HookExecutor configured");
    const hash = await this.walletClient.writeContract({
      address: executor,
      abi: hookExecutorAbi,
      functionName: "relay",
      args: [message, attestation],
    });
    await this.expectSuccess(hash);
    return hash;
  }

  async hookOutcome(txHash: Hex): Promise<"vault-credited" | "claimable" | "quarantined"> {
    const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({ abi: hookExecutorAbi, logs: receipt.logs });
    for (const log of logs) {
      if (log.eventName === "DepositForwarded") return "vault-credited";
      if (log.eventName === "DepositHeld") return "claimable";
      if (log.eventName === "DepositQuarantined") return "quarantined";
    }
    throw new Error(`no HookExecutor outcome event in ${txHash}`);
  }

  async creditedHookOutcome(txHash: Hex): Promise<"vault-credited" | "claimable"> {
    const outcome = await this.hookOutcome(txHash);
    if (outcome === "quarantined") throw new Error("deposit quarantined by the HookExecutor, owner action needed");
    return outcome;
  }

  private async ensureAllowance(amount: bigint): Promise<void> {
    const owner = this.walletClient.account.address;
    const allowance = await this.publicClient.readContract({
      address: this.addresses.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, this.addresses.tokenMessenger],
    });
    if (allowance >= amount) return;
    const hash = await this.walletClient.writeContract({
      address: this.addresses.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.addresses.tokenMessenger, amount],
    });
    await this.expectSuccess(hash);
  }

  private async expectSuccess(hash: Hex): Promise<void> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  }
}

export function extractMessageSent(logs: Parameters<typeof parseEventLogs>[0]["logs"], transmitter: Hex): Hex {
  const parsed = parseEventLogs({ abi: messageTransmitterV2Abi, eventName: "MessageSent", logs });
  const own = parsed.find((log) => log.address.toLowerCase() === transmitter.toLowerCase());
  if (!own) throw new Error("no MessageSent log from the message transmitter");
  return own.args.message;
}
