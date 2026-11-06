import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type AccountMeta,
} from "@solana/web3.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import messageTransmitterIdl from "../idl/message_transmitter_v2.json" with { type: "json" };
import tokenMessengerMinterIdl from "../idl/token_messenger_minter_v2.json" with { type: "json" };
import { SOLANA_DEVNET_USDC_MINT } from "./addresses.ts";
import { decodeMessage } from "./message.ts";

export const SOLANA_PROGRAMS = {
  messageTransmitterV2: new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"),
  tokenMessengerMinterV2: new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"),
} as const;

export const SOLANA_DEVNET_USDC = new PublicKey(SOLANA_DEVNET_USDC_MINT);

type IdlAccount = { name: string; writable?: boolean; signer?: boolean; address?: string };
type IdlInstruction = { name: string; discriminator: number[]; accounts: IdlAccount[] };
type Idl = { instructions: IdlInstruction[]; accounts: { name: string; discriminator: number[] }[] };

function instructionOf(idl: Idl, name: string): IdlInstruction {
  const found = idl.instructions.find((instruction) => instruction.name === name);
  if (!found) throw new Error(`instruction ${name} missing from IDL`);
  return found;
}

const burnWithHookIx = instructionOf(tokenMessengerMinterIdl as Idl, "deposit_for_burn_with_hook");
const burnIx = instructionOf(tokenMessengerMinterIdl as Idl, "deposit_for_burn");
const receiveIx = instructionOf(messageTransmitterIdl as Idl, "receive_message");

const pda = (programId: PublicKey, ...seeds: (string | Uint8Array)[]): PublicKey =>
  PublicKey.findProgramAddressSync(
    seeds.map((seed) => (typeof seed === "string" ? Buffer.from(seed) : seed)),
    programId,
  )[0];

export function derivePdas(usdcMint: PublicKey, remoteDomain: number) {
  const tmm = SOLANA_PROGRAMS.tokenMessengerMinterV2;
  const mt = SOLANA_PROGRAMS.messageTransmitterV2;
  return {
    messageTransmitter: pda(mt, "message_transmitter"),
    mtEventAuthority: pda(mt, "__event_authority"),
    tokenMessenger: pda(tmm, "token_messenger"),
    tokenMinter: pda(tmm, "token_minter"),
    tmmEventAuthority: pda(tmm, "__event_authority"),
    senderAuthority: pda(tmm, "sender_authority"),
    localToken: pda(tmm, "local_token", usdcMint.toBytes()),
    custody: pda(tmm, "custody", usdcMint.toBytes()),
    remoteTokenMessenger: pda(tmm, "remote_token_messenger", String(remoteDomain)),
    receiveAuthority: pda(mt, "message_transmitter_authority", tmm.toBytes()),
  };
}

export const denylistPda = (owner: PublicKey): PublicKey =>
  pda(SOLANA_PROGRAMS.tokenMessengerMinterV2, "denylist_account", owner.toBytes());

export const usedNoncePda = (nonce: Hex): PublicKey =>
  pda(SOLANA_PROGRAMS.messageTransmitterV2, "used_nonce", hexToBytes(nonce));

export const tokenPairPda = (remoteDomain: number, remoteToken: Hex): PublicKey =>
  pda(SOLANA_PROGRAMS.tokenMessengerMinterV2, "token_pair", String(remoteDomain), hexToBytes(remoteToken));

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function borshBytes(value: Uint8Array): Buffer {
  return Buffer.concat([u32(value.length), Buffer.from(value)]);
}

export type SolanaBurnParams = {
  owner: PublicKey;
  burnTokenAccount: PublicKey;
  messageSentEventData: PublicKey;
  usdcMint?: PublicKey;
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData?: Hex;
};

export function encodeBurnData(params: Omit<SolanaBurnParams, "owner" | "burnTokenAccount" | "messageSentEventData" | "usdcMint">): Buffer {
  const head = [
    u64(params.amount),
    u32(params.destinationDomain),
    Buffer.from(hexToBytes(params.mintRecipient)),
    Buffer.from(hexToBytes(params.destinationCaller)),
    u64(params.maxFee),
    u32(params.minFinalityThreshold),
  ];
  if (params.hookData === undefined) {
    return Buffer.concat([Buffer.from(burnIx.discriminator), ...head]);
  }
  return Buffer.concat([Buffer.from(burnWithHookIx.discriminator), ...head, borshBytes(hexToBytes(params.hookData))]);
}

export type DecodedBurnWithHook = {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: Hex;
};

const WORD_BYTES = 32;

export function decodeBurnWithHookData(data: Uint8Array): DecodedBurnWithHook | undefined {
  const buffer = Buffer.from(data);
  const discriminator = Buffer.from(burnWithHookIx.discriminator);
  if (buffer.length < 8 + 8 + 4 + 2 * WORD_BYTES + 8 + 4 + 4) return undefined;
  if (!buffer.subarray(0, 8).equals(discriminator)) return undefined;
  const hookLength = buffer.readUInt32LE(96);
  if (buffer.length !== 100 + hookLength) return undefined;
  return {
    amount: buffer.readBigUInt64LE(8),
    destinationDomain: buffer.readUInt32LE(16),
    mintRecipient: bytesToHex(buffer.subarray(20, 52)),
    destinationCaller: bytesToHex(buffer.subarray(52, 84)),
    maxFee: buffer.readBigUInt64LE(84),
    minFinalityThreshold: buffer.readUInt32LE(92),
    hookData: bytesToHex(buffer.subarray(100)),
  };
}

export const BURN_WITH_HOOK_OWNER_INDEX = burnWithHookIx.accounts.findIndex((account) => account.name === "owner");

function metasFor(instruction: IdlInstruction, resolved: Record<string, PublicKey>): AccountMeta[] {
  return instruction.accounts.map((account) => {
    const pubkey = resolved[account.name];
    if (!pubkey) throw new Error(`no address resolved for account ${account.name}`);
    if (account.address && pubkey.toBase58() !== account.address) {
      throw new Error(`account ${account.name} must be ${account.address}`);
    }
    return { pubkey, isSigner: Boolean(account.signer), isWritable: Boolean(account.writable) };
  });
}

export function buildDepositForBurnInstruction(params: SolanaBurnParams): TransactionInstruction {
  const usdcMint = params.usdcMint ?? SOLANA_DEVNET_USDC;
  const pdas = derivePdas(usdcMint, params.destinationDomain);
  const instruction = params.hookData === undefined ? burnIx : burnWithHookIx;
  const keys = metasFor(instruction, {
    owner: params.owner,
    event_rent_payer: params.owner,
    sender_authority_pda: pdas.senderAuthority,
    burn_token_account: params.burnTokenAccount,
    denylist_account: denylistPda(params.owner),
    message_transmitter: pdas.messageTransmitter,
    token_messenger: pdas.tokenMessenger,
    remote_token_messenger: pdas.remoteTokenMessenger,
    token_minter: pdas.tokenMinter,
    local_token: pdas.localToken,
    burn_token_mint: usdcMint,
    message_sent_event_data: params.messageSentEventData,
    message_transmitter_program: SOLANA_PROGRAMS.messageTransmitterV2,
    token_messenger_minter_program: SOLANA_PROGRAMS.tokenMessengerMinterV2,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
    event_authority: pdas.tmmEventAuthority,
    program: SOLANA_PROGRAMS.tokenMessengerMinterV2,
  });
  return new TransactionInstruction({
    programId: SOLANA_PROGRAMS.tokenMessengerMinterV2,
    keys,
    data: encodeBurnData(params),
  });
}

export type SolanaReceiveParams = {
  payer: PublicKey;
  message: Hex;
  attestation: Hex;
  recipientTokenAccount: PublicKey;
  feeRecipientTokenAccount: PublicKey;
  remoteToken: Hex;
  usdcMint?: PublicKey;
};

export function buildReceiveMessageInstruction(params: SolanaReceiveParams): TransactionInstruction {
  const usdcMint = params.usdcMint ?? SOLANA_DEVNET_USDC;
  const message = decodeMessage(params.message);
  const pdas = derivePdas(usdcMint, message.sourceDomain);
  const keys = metasFor(receiveIx, {
    payer: params.payer,
    caller: params.payer,
    authority_pda: pdas.receiveAuthority,
    message_transmitter: pdas.messageTransmitter,
    used_nonce: usedNoncePda(message.nonce),
    receiver: SOLANA_PROGRAMS.tokenMessengerMinterV2,
    system_program: SystemProgram.programId,
    event_authority: pdas.mtEventAuthority,
    program: SOLANA_PROGRAMS.messageTransmitterV2,
  });
  const tmm = SOLANA_PROGRAMS.tokenMessengerMinterV2;
  const remaining: AccountMeta[] = [
    { pubkey: pdas.tokenMessenger, isSigner: false, isWritable: false },
    { pubkey: pdas.remoteTokenMessenger, isSigner: false, isWritable: false },
    { pubkey: pdas.tokenMinter, isSigner: false, isWritable: true },
    { pubkey: pdas.localToken, isSigner: false, isWritable: true },
    { pubkey: tokenPairPda(message.sourceDomain, params.remoteToken), isSigner: false, isWritable: false },
    { pubkey: params.feeRecipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: params.recipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pdas.custody, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: pdas.tmmEventAuthority, isSigner: false, isWritable: false },
    { pubkey: tmm, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([
    Buffer.from(receiveIx.discriminator),
    borshBytes(hexToBytes(params.message)),
    borshBytes(hexToBytes(params.attestation)),
  ]);
  return new TransactionInstruction({
    programId: SOLANA_PROGRAMS.messageTransmitterV2,
    keys: [...keys, ...remaining],
    data,
  });
}

export const ANCHOR_DISCRIMINATOR_BYTES = 8;
const FEE_RECIPIENT_OFFSET = ANCHOR_DISCRIMINATOR_BYTES + 32 * 3 + 4 + 1;

export async function readFeeRecipient(connection: Connection, usdcMint: PublicKey = SOLANA_DEVNET_USDC): Promise<PublicKey> {
  const { tokenMessenger } = derivePdas(usdcMint, 0);
  const account = await connection.getAccountInfo(tokenMessenger);
  if (!account) throw new Error("TokenMessenger account not found; wrong cluster or programs not deployed");
  return new PublicKey(account.data.subarray(FEE_RECIPIENT_OFFSET, FEE_RECIPIENT_OFFSET + 32));
}

export class SolanaDriver {
  constructor(
    readonly connection: Connection,
    readonly signer: Keypair,
    readonly usdcMint: PublicKey = SOLANA_DEVNET_USDC,
  ) {}

  tokenAccount(owner: PublicKey = this.signer.publicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.usdcMint, owner);
  }

  async burn(params: Omit<SolanaBurnParams, "owner" | "messageSentEventData" | "burnTokenAccount" | "usdcMint">): Promise<{
    signature: string;
    messageSentEventData: PublicKey;
  }> {
    const eventAccount = Keypair.generate();
    const instruction = buildDepositForBurnInstruction({
      ...params,
      owner: this.signer.publicKey,
      burnTokenAccount: this.tokenAccount(),
      messageSentEventData: eventAccount.publicKey,
      usdcMint: this.usdcMint,
    });
    const signature = await sendAndConfirmTransaction(this.connection, new Transaction().add(instruction), [
      this.signer,
      eventAccount,
    ]);
    return { signature, messageSentEventData: eventAccount.publicKey };
  }

  async receive(params: { message: Hex; attestation: Hex; remoteToken: Hex; recipient?: PublicKey }): Promise<string> {
    const feeRecipient = await readFeeRecipient(this.connection, this.usdcMint);
    const instruction = buildReceiveMessageInstruction({
      payer: this.signer.publicKey,
      message: params.message,
      attestation: params.attestation,
      remoteToken: params.remoteToken,
      recipientTokenAccount: this.tokenAccount(params.recipient),
      feeRecipientTokenAccount: getAssociatedTokenAddressSync(this.usdcMint, feeRecipient, true),
      usdcMint: this.usdcMint,
    });
    return sendAndConfirmTransaction(this.connection, new Transaction().add(instruction), [this.signer]);
  }

  async usdcBalance(owner: PublicKey = this.signer.publicKey): Promise<bigint> {
    const balance = await this.connection.getTokenAccountBalance(this.tokenAccount(owner));
    return BigInt(balance.value.amount);
  }
}
