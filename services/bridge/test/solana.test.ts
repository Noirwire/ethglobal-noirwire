import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import messageTransmitterIdl from "../idl/message_transmitter_v2.json" with { type: "json" };
import tokenMessengerMinterIdl from "../idl/token_messenger_minter_v2.json" with { type: "json" };
import { encodeVaultHookData } from "../src/hooks.ts";
import { addressToBytes32 } from "../src/message.ts";
import {
  SOLANA_DEVNET_USDC,
  SOLANA_PROGRAMS,
  buildDepositForBurnInstruction,
  buildReceiveMessageInstruction,
  denylistPda,
  derivePdas,
  encodeBurnData,
  tokenPairPda,
  usedNoncePda,
} from "../src/solana.ts";
import { buildBurnMessage, word } from "./helpers.ts";

const owner = Keypair.generate().publicKey;
const tokenAccount = Keypair.generate().publicKey;
const eventAccount = Keypair.generate().publicKey;
const executor = addressToBytes32("0x00000000000000000000000000000000000000ee");
const hookData = encodeVaultHookData({
  beneficiary: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  solanaDepositor: bytesToHex(owner.toBytes()),
  deadline: 1_800_000_000n,
});

const burnParams = {
  owner,
  burnTokenAccount: tokenAccount,
  messageSentEventData: eventAccount,
  amount: 2_500_000n,
  destinationDomain: 26,
  mintRecipient: executor,
  destinationCaller: executor,
  maxFee: 1_000n,
  minFinalityThreshold: 1000,
  hookData,
} as const;

const pda = (programId: PublicKey, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("program ids and IDL", () => {
  it("vendored IDLs carry the V2 program ids", () => {
    expect(messageTransmitterIdl.address).toBe(SOLANA_PROGRAMS.messageTransmitterV2.toBase58());
    expect(tokenMessengerMinterIdl.address).toBe(SOLANA_PROGRAMS.tokenMessengerMinterV2.toBase58());
  });
});

describe("deposit_for_burn_with_hook", () => {
  const instruction = buildDepositForBurnInstruction(burnParams);
  const names = tokenMessengerMinterIdl.instructions.find((i) => i.name === "deposit_for_burn_with_hook")!.accounts;

  it("targets TokenMessengerMinterV2 with IDL ordering and flags", () => {
    expect(instruction.programId.equals(SOLANA_PROGRAMS.tokenMessengerMinterV2)).toBe(true);
    expect(instruction.keys).toHaveLength(names.length);
    instruction.keys.forEach((key, index) => {
      const spec = names[index] as { signer?: boolean; writable?: boolean };
      expect(key.isSigner).toBe(Boolean(spec.signer));
      expect(key.isWritable).toBe(Boolean(spec.writable));
    });
  });

  it("derives the documented PDAs", () => {
    const tmm = SOLANA_PROGRAMS.tokenMessengerMinterV2;
    const mt = SOLANA_PROGRAMS.messageTransmitterV2;
    const byName = Object.fromEntries(names.map((spec, i) => [spec.name, instruction.keys[i]!.pubkey]));
    expect(byName.owner).toEqual(owner);
    expect(byName.burn_token_account).toEqual(tokenAccount);
    expect(byName.message_sent_event_data).toEqual(eventAccount);
    expect(byName.burn_token_mint).toEqual(SOLANA_DEVNET_USDC);
    expect(byName.sender_authority_pda).toEqual(pda(tmm, utf8("sender_authority")));
    expect(byName.message_transmitter).toEqual(pda(mt, utf8("message_transmitter")));
    expect(byName.token_messenger).toEqual(pda(tmm, utf8("token_messenger")));
    expect(byName.token_minter).toEqual(pda(tmm, utf8("token_minter")));
    expect(byName.local_token).toEqual(pda(tmm, utf8("local_token"), SOLANA_DEVNET_USDC.toBytes()));
    expect(byName.remote_token_messenger).toEqual(pda(tmm, utf8("remote_token_messenger"), utf8("26")));
    expect(byName.denylist_account).toEqual(pda(tmm, utf8("denylist_account"), owner.toBytes()));
    expect(byName.event_authority).toEqual(pda(tmm, utf8("__event_authority")));
    expect(byName.program).toEqual(tmm);
    expect(byName.token_program).toEqual(TOKEN_PROGRAM_ID);
    expect(byName.system_program).toEqual(SystemProgram.programId);
  });

  it("lays out the data as discriminator, params, borsh bytes", () => {
    const data = instruction.data;
    const discriminator = tokenMessengerMinterIdl.instructions.find((i) => i.name === "deposit_for_burn_with_hook")!.discriminator;
    expect([...data.subarray(0, 8)]).toEqual(discriminator);
    expect(data.readBigUInt64LE(8)).toBe(2_500_000n);
    expect(data.readUInt32LE(16)).toBe(26);
    expect(bytesToHex(data.subarray(20, 52))).toBe(executor);
    expect(bytesToHex(data.subarray(52, 84))).toBe(executor);
    expect(data.readBigUInt64LE(84)).toBe(1_000n);
    expect(data.readUInt32LE(92)).toBe(1000);
    expect(data.readUInt32LE(96)).toBe(128);
    expect(bytesToHex(data.subarray(100))).toBe(hookData);
    expect(data.length).toBe(100 + 128);
  });

  it("uses plain deposit_for_burn when there is no hook", () => {
    const { hookData: _omit, ...plain } = burnParams;
    const built = buildDepositForBurnInstruction(plain);
    const spec = tokenMessengerMinterIdl.instructions.find((i) => i.name === "deposit_for_burn")!;
    expect([...built.data.subarray(0, 8)]).toEqual(spec.discriminator);
    expect(built.data.length).toBe(8 + 8 + 4 + 32 + 32 + 8 + 4);
    expect(built.keys).toHaveLength(spec.accounts.length);
  });

  it("encodes the arc hook executor as a 32 byte left padded recipient", () => {
    expect(encodeBurnData(burnParams).subarray(20, 52).every((byte, i) => (i < 31 ? byte === 0 : byte === 0xee))).toBe(true);
  });
});

describe("receive_message", () => {
  const nonce = word(0xfeed);
  const message = buildBurnMessage({ sourceDomain: 26, destinationDomain: 5, nonce });
  const attestation = `0x${"11".repeat(65)}` as Hex;
  const recipientTokenAccount = Keypair.generate().publicKey;
  const feeRecipientTokenAccount = Keypair.generate().publicKey;
  const remoteToken = word(0x3600) as Hex;
  const payer = Keypair.generate().publicKey;
  const instruction = buildReceiveMessageInstruction({
    payer,
    message,
    attestation,
    recipientTokenAccount,
    feeRecipientTokenAccount,
    remoteToken,
  });
  const spec = messageTransmitterIdl.instructions.find((i) => i.name === "receive_message")!;

  it("targets MessageTransmitterV2 with the IDL accounts then the eleven TokenMessengerMinter accounts", () => {
    expect(instruction.programId.equals(SOLANA_PROGRAMS.messageTransmitterV2)).toBe(true);
    expect(instruction.keys).toHaveLength(spec.accounts.length + 11);
    const pdas = derivePdas(SOLANA_DEVNET_USDC, 26);
    expect(instruction.keys[2]!.pubkey).toEqual(pdas.receiveAuthority);
    expect(instruction.keys[4]!.pubkey).toEqual(usedNoncePda(nonce));
    expect(instruction.keys[4]!.isWritable).toBe(true);
    const remaining = instruction.keys.slice(spec.accounts.length).map((key) => key.pubkey);
    expect(remaining[0]).toEqual(pdas.tokenMessenger);
    expect(remaining[1]).toEqual(pdas.remoteTokenMessenger);
    expect(remaining[4]).toEqual(tokenPairPda(26, remoteToken));
    expect(remaining[5]).toEqual(feeRecipientTokenAccount);
    expect(remaining[6]).toEqual(recipientTokenAccount);
    expect(remaining[7]).toEqual(pdas.custody);
    expect(remaining[10]).toEqual(SOLANA_PROGRAMS.tokenMessengerMinterV2);
  });

  it("lays out message and attestation as borsh bytes", () => {
    const data = instruction.data;
    expect([...data.subarray(0, 8)]).toEqual(spec.discriminator);
    const messageLength = hexToBytes(message).length;
    expect(data.readUInt32LE(8)).toBe(messageLength);
    expect(bytesToHex(data.subarray(12, 12 + messageLength))).toBe(message);
    expect(data.readUInt32LE(12 + messageLength)).toBe(65);
    expect(bytesToHex(data.subarray(16 + messageLength))).toBe(attestation);
  });

  it("denylist and nonce PDAs are program derived", () => {
    expect(denylistPda(owner)).toEqual(pda(SOLANA_PROGRAMS.tokenMessengerMinterV2, utf8("denylist_account"), owner.toBytes()));
  });
});
