import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { CCTP_DOMAINS, type BridgeTransfer } from "@noirwire/shared";
import { bytesToHex, isAddress, type Hex } from "viem";
import type { TreasuryExecutor } from "./executor.ts";
import { decodeVaultHookData, encodeVaultHookData, VAULT_HOOK_VERSION } from "./hooks.ts";
import { addressToBytes32, FINALITY_FAST } from "./message.ts";
import {
  BURN_WITH_HOOK_OWNER_INDEX,
  buildDepositForBurnInstruction,
  decodeBurnWithHookData,
  SOLANA_PROGRAMS,
} from "./solana.ts";

export class DepositUnavailable extends Error {}
export class DepositRefused extends Error {}
export class TransactionNotFound extends Error {}

export type ObservedTransaction = {
  failed: boolean;
  instructions: { programId: PublicKey; accounts: PublicKey[]; data: Uint8Array }[];
};

export interface SolanaReader {
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  tokenBalance(account: PublicKey): Promise<bigint | null>;
  burnTransaction(signature: string): Promise<ObservedTransaction | null>;
}

export class ConnectionReader implements SolanaReader {
  constructor(private readonly connection: Connection) {}

  latestBlockhash() {
    return this.connection.getLatestBlockhash("confirmed");
  }

  async tokenBalance(account: PublicKey): Promise<bigint | null> {
    if (!(await this.connection.getAccountInfo(account))) return null;
    const balance = await this.connection.getTokenAccountBalance(account);
    return BigInt(balance.value.amount);
  }

  async burnTransaction(signature: string): Promise<ObservedTransaction | null> {
    const response = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!response) return null;
    const { message } = response.transaction;
    const keys = message.getAccountKeys({ accountKeysFromLookups: response.meta?.loadedAddresses });
    return {
      failed: response.meta?.err != null,
      instructions: message.compiledInstructions.map((instruction) => ({
        programId: keys.get(instruction.programIdIndex) as PublicKey,
        accounts: instruction.accountKeyIndexes.map((index) => keys.get(index) as PublicKey),
        data: instruction.data,
      })),
    };
  }
}

type PreparedDeposit = {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  deadline: number;
  maxFee: string;
};

type DepositStatus = { mode: "local" | "testnet"; available: boolean; reason?: string };

export interface SolanaDepositApi {
  status(): DepositStatus;
  prepare(input: { owner: string; amount: bigint; beneficiary: string }): Promise<PreparedDeposit>;
  register(signature: string): Promise<BridgeTransfer>;
}

export class UnavailableDeposits implements SolanaDepositApi {
  constructor(
    private readonly mode: DepositStatus["mode"],
    private readonly reason: string,
  ) {}

  status(): DepositStatus {
    return { mode: this.mode, available: false, reason: this.reason };
  }

  async prepare(): Promise<PreparedDeposit> {
    throw new DepositUnavailable(this.reason);
  }

  async register(): Promise<BridgeTransfer> {
    throw new DepositUnavailable(this.reason);
  }
}

type SolanaDepositOptions = {
  hookExecutor: Hex;
  usdcMint: PublicKey;
  maxFee: bigint;
  deadlineSeconds: number;
  now?: () => Date;
};

const ROUTE = "solana-arc" as const;

function parseOwner(owner: string): PublicKey {
  try {
    const key = new PublicKey(owner);
    if (key.toBase58() !== owner) throw new Error("not canonical");
    return key;
  } catch {
    throw new DepositRefused("owner is not a Solana address");
  }
}

export class SolanaDeposits implements SolanaDepositApi {
  private readonly now: () => Date;

  constructor(
    private readonly reader: SolanaReader,
    private readonly executor: TreasuryExecutor,
    private readonly options: SolanaDepositOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  status(): DepositStatus {
    return { mode: "testnet", available: true };
  }

  async prepare(input: { owner: string; amount: bigint; beneficiary: string }): Promise<PreparedDeposit> {
    const owner = parseOwner(input.owner);
    if (!isAddress(input.beneficiary)) throw new DepositRefused("beneficiary must be an Arc address");
    this.executor.checkDeposit(ROUTE, input.amount);

    const tokenAccount = getAssociatedTokenAddressSync(this.options.usdcMint, owner);
    const balance = await this.reader.tokenBalance(tokenAccount);
    if (balance === null) {
      throw new DepositRefused("This wallet has no USDC token account on Solana devnet. Get devnet USDC from Circle's faucet first.");
    }
    if (balance < input.amount) {
      throw new DepositRefused(`This wallet holds ${balance} USDC base units on Solana devnet, less than the ${input.amount} requested.`);
    }

    const deadline = Math.floor(this.now().getTime() / 1000) + this.options.deadlineSeconds;
    const executorWord = addressToBytes32(this.options.hookExecutor);
    const eventAccount = Keypair.generate();
    const instruction = buildDepositForBurnInstruction({
      owner,
      burnTokenAccount: tokenAccount,
      messageSentEventData: eventAccount.publicKey,
      usdcMint: this.options.usdcMint,
      amount: input.amount,
      destinationDomain: CCTP_DOMAINS.arc,
      mintRecipient: executorWord,
      destinationCaller: executorWord,
      maxFee: this.options.maxFee,
      minFinalityThreshold: FINALITY_FAST,
      hookData: encodeVaultHookData({
        beneficiary: input.beneficiary as Hex,
        solanaDepositor: bytesToHex(owner.toBytes()),
        deadline: BigInt(deadline),
      }),
    });
    const { blockhash, lastValidBlockHeight } = await this.reader.latestBlockhash();
    const transaction = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(instruction);
    transaction.partialSign(eventAccount);
    return {
      transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      blockhash,
      lastValidBlockHeight,
      deadline,
      maxFee: this.options.maxFee.toString(),
    };
  }

  async register(signature: string): Promise<BridgeTransfer> {
    const observed = await this.reader.burnTransaction(signature);
    if (!observed) throw new TransactionNotFound("The transaction is not visible on Solana devnet yet. Try again in a few seconds.");
    if (observed.failed) throw new DepositRefused("The transaction failed on Solana, nothing was burned.");

    const executorWord = addressToBytes32(this.options.hookExecutor);
    for (const instruction of observed.instructions) {
      if (!instruction.programId.equals(SOLANA_PROGRAMS.tokenMessengerMinterV2)) continue;
      const burn = decodeBurnWithHookData(instruction.data);
      if (!burn) continue;
      const owner = instruction.accounts[BURN_WITH_HOOK_OWNER_INDEX];
      if (
        !owner ||
        burn.destinationDomain !== CCTP_DOMAINS.arc ||
        burn.mintRecipient !== executorWord ||
        burn.destinationCaller !== executorWord
      ) {
        continue;
      }
      let hook: ReturnType<typeof decodeVaultHookData>;
      try {
        hook = decodeVaultHookData(burn.hookData);
      } catch {
        continue;
      }
      if (hook.version !== VAULT_HOOK_VERSION || hook.solanaDepositor !== bytesToHex(owner.toBytes())) continue;
      return this.executor.adoptAndAdvance({ route: ROUTE, burnTx: signature, amount: burn.amount, beneficiary: hook.beneficiary });
    }
    throw new DepositRefused("This transaction is not a deposit into the NoirWire vault, so the bridge will not relay it.");
  }
}
