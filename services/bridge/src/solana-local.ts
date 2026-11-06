import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { CCTP_DOMAINS, NETWORKS } from "@noirwire/shared";
import { bytesToHex, hexToBytes, keccak256, padHex, toHex, type Hex } from "viem";
import { ARC_TESTNET_USDC } from "./addresses.ts";
import { encodeVaultHookData } from "./hooks.ts";
import { LocalAttester } from "./iris.ts";
import {
  BURN_BODY_VERSION,
  encodeBurnBody,
  encodeMessage,
  FINALITY_FAST,
  MESSAGE_VERSION,
  ZERO_BYTES32,
} from "./message.ts";
import {
  ANCHOR_DISCRIMINATOR_BYTES,
  SOLANA_DEVNET_USDC,
  SOLANA_PROGRAMS,
  SolanaDriver,
  derivePdas,
  readFeeRecipient,
  tokenPairPda,
} from "./solana.ts";
import { generatePrivateKey } from "viem/accounts";

const ARC_USDC_WORD = padHex(ARC_TESTNET_USDC, { size: 32 });
const ATTESTER_THRESHOLD_OFFSET = ANCHOR_DISCRIMINATOR_BYTES + 32 * 4 + 1 + 4 + 4;
const ATTESTER_VEC_OFFSET = ATTESTER_THRESHOLD_OFFSET + 4;
const REMOTE_TOKEN_MESSENGER_ADDRESS_OFFSET = ANCHOR_DISCRIMINATOR_BYTES + 4;
const MESSAGE_SENT_LENGTH_OFFSET = ANCHOR_DISCRIMINATOR_BYTES + 32 + 8;

type CloneSetup = { stop: () => void; connection: Connection; rpcUrl: string };

function accountJson(address: PublicKey, info: { lamports: number; data: Buffer; owner: PublicKey; executable: boolean }) {
  return {
    pubkey: address.toBase58(),
    account: {
      lamports: info.lamports,
      data: [info.data.toString("base64"), "base64"],
      owner: info.owner.toBase58(),
      executable: info.executable,
      rentEpoch: 0,
      space: info.data.length,
    },
  };
}

export function patchMessageTransmitter(data: Buffer, attesterAddresses: Hex[]): Buffer {
  const patched = Buffer.from(data);
  patched.writeUInt32LE(1, ATTESTER_THRESHOLD_OFFSET);
  const count = patched.readUInt32LE(ATTESTER_VEC_OFFSET);
  if (attesterAddresses.length > count) throw new Error("the cloned account has fewer attester slots than requested");
  for (let slot = 0; slot < count; slot++) {
    const address = attesterAddresses[Math.min(slot, attesterAddresses.length - 1)] as Hex;
    patched.set(hexToBytes(padHex(address, { size: 32 })), ATTESTER_VEC_OFFSET + 4 + slot * 32);
  }
  return patched;
}

export async function startClonedValidator(options: {
  attesterAddress: Hex;
  rpcPort?: number;
  faucetPort?: number;
  devnetRpc?: string;
}): Promise<CloneSetup> {
  const rpcPort = options.rpcPort ?? 8901;
  const faucetPort = options.faucetPort ?? 9901;
  const devnetRpc = options.devnetRpc ?? NETWORKS.solanaDevnet.rpcUrl;
  const devnet = new Connection(devnetRpc, "confirmed");
  const usdc = SOLANA_DEVNET_USDC;
  const pdas = derivePdas(usdc, CCTP_DOMAINS.arc);
  const arcPair = tokenPairPda(CCTP_DOMAINS.arc, ARC_USDC_WORD);

  const dir = mkdtempSync(join(tmpdir(), "bridge-solana-"));
  const transmitter = await devnet.getAccountInfo(pdas.messageTransmitter);
  if (!transmitter) throw new Error("devnet MessageTransmitter state not found");
  const overrideFile = join(dir, "message-transmitter.json");
  writeFileSync(
    overrideFile,
    JSON.stringify(
      accountJson(pdas.messageTransmitter, {
        lamports: transmitter.lamports,
        owner: transmitter.owner,
        executable: false,
        data: patchMessageTransmitter(transmitter.data, [options.attesterAddress]),
      }),
    ),
  );

  const cloned = [pdas.tokenMessenger, pdas.tokenMinter, pdas.localToken, pdas.remoteTokenMessenger, pdas.custody, arcPair, usdc];
  const args = [
    "--reset",
    "--quiet",
    "--ledger",
    join(dir, "ledger"),
    "--rpc-port",
    String(rpcPort),
    "--faucet-port",
    String(faucetPort),
    "--url",
    devnetRpc,
    "--clone-upgradeable-program",
    SOLANA_PROGRAMS.messageTransmitterV2.toBase58(),
    "--clone-upgradeable-program",
    SOLANA_PROGRAMS.tokenMessengerMinterV2.toBase58(),
    ...cloned.flatMap((address) => ["--clone", address.toBase58()]),
    "--account",
    pdas.messageTransmitter.toBase58(),
    overrideFile,
  ];
  const child: ChildProcess = spawn("solana-test-validator", args, {
    stdio: process.env.SOLANA_VALIDATOR_LOG ? "inherit" : "ignore",
  });
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const connection = new Connection(rpcUrl, "confirmed");
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await connection.getSlot();
      return { stop: () => child.kill(), connection, rpcUrl };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  child.kill();
  throw new Error("solana-test-validator did not become ready");
}

export async function runSolanaLocalReceive(
  setup: CloneSetup,
  attester: LocalAttester,
): Promise<{
  minted: bigint;
  signature: string;
  burnSignature: string;
  burnMessage: Hex;
  balanceAfterBurn: bigint;
}> {
  const { connection } = setup;
  const usdc = SOLANA_DEVNET_USDC;
  const payer = Keypair.generate();
  const airdrop = await connection.requestAirdrop(payer.publicKey, 5_000_000_000);
  await connection.confirmTransaction(airdrop, "confirmed");

  const pdas = derivePdas(usdc, CCTP_DOMAINS.arc);
  const remote = await connection.getAccountInfo(pdas.remoteTokenMessenger);
  if (!remote) throw new Error("remote token messenger missing on the local validator");
  const arcTokenMessenger = bytesToHex(
    remote.data.subarray(REMOTE_TOKEN_MESSENGER_ADDRESS_OFFSET, REMOTE_TOKEN_MESSENGER_ADDRESS_OFFSET + 32),
  );

  const recipient = getAssociatedTokenAddressSync(usdc, payer.publicKey);
  const feeRecipient = await readFeeRecipient(connection, usdc);
  const feeRecipientToken = getAssociatedTokenAddressSync(usdc, feeRecipient, true);
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, recipient, payer.publicKey, usdc),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, feeRecipientToken, feeRecipient, usdc),
    ),
    [payer],
  );

  const amount = 3_000_000n;
  const message = encodeMessage({
    version: MESSAGE_VERSION,
    sourceDomain: CCTP_DOMAINS.arc,
    destinationDomain: CCTP_DOMAINS.solana,
    nonce: keccak256(toHex(`solana-local-${Date.now()}`)),
    sender: arcTokenMessenger,
    recipient: bytesToHex(SOLANA_PROGRAMS.tokenMessengerMinterV2.toBytes()),
    destinationCaller: ZERO_BYTES32,
    minFinalityThreshold: FINALITY_FAST,
    finalityThresholdExecuted: FINALITY_FAST,
    body: encodeBurnBody({
      version: BURN_BODY_VERSION,
      burnToken: ARC_USDC_WORD,
      mintRecipient: bytesToHex(recipient.toBytes()),
      amount,
      messageSender: `0x${"ab".repeat(32)}`,
      maxFee: 0n,
      feeExecuted: 0n,
      expirationBlock: 0n,
      hookData: "0x",
    }),
  });
  const attestation = await attester.attest(message);
  const driver = new SolanaDriver(connection, payer, usdc);
  const signature = await driver.receive({ message, attestation, remoteToken: ARC_USDC_WORD });
  const minted = await driver.usdcBalance();

  const executor = padHex("0x00000000000000000000000000000000000000ee", { size: 32 });
  const hookData = encodeVaultHookData({
    beneficiary: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    solanaDepositor: bytesToHex(payer.publicKey.toBytes()),
    deadline: 1_900_000_000n,
  });
  const burn = await driver.burn({
    transferId: "local-burn",
    amount: 1_000_000n,
    destinationDomain: CCTP_DOMAINS.arc,
    mintRecipient: executor,
    destinationCaller: executor,
    maxFee: 0n,
    minFinalityThreshold: FINALITY_FAST,
    hookData,
  });
  const event = await connection.getAccountInfo(burn.messageSentEventData);
  if (!event) throw new Error("MessageSent event account missing after the burn");
  const messageLength = event.data.readUInt32LE(MESSAGE_SENT_LENGTH_OFFSET);
  const burnMessage = bytesToHex(event.data.subarray(MESSAGE_SENT_LENGTH_OFFSET + 4, MESSAGE_SENT_LENGTH_OFFSET + 4 + messageLength));
  return { minted, signature, burnSignature: burn.signature, burnMessage, balanceAfterBurn: await driver.usdcBalance() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const attester = new LocalAttester([generatePrivateKey()]);
  const setup = await startClonedValidator({ attesterAddress: attester.signers()[0] as Hex });
  try {
    const result = await runSolanaLocalReceive(setup, attester);
    const ok = result.minted === 3_000_000n && result.balanceAfterBurn === 2_000_000n;
    console.log(JSON.stringify({ ok, minted: String(result.minted), balanceAfterBurn: String(result.balanceAfterBurn), signature: result.signature, burnSignature: result.burnSignature }));
  } finally {
    setup.stop();
  }
}
