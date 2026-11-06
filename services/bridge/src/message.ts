import { concatHex, hexToBigInt, keccak256, numberToHex, padHex, size, slice, type Hex } from "viem";

export const MESSAGE_VERSION = 1;
export const BURN_BODY_VERSION = 1;
export const HEADER_LENGTH = 148;
export const BURN_BODY_FIXED_LENGTH = 228;

export const FINALITY_FAST = 1000;
export const FINALITY_STANDARD = 2000;

export type CctpMessageFields = {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: Hex;
};

export type BurnBodyFields = {
  version: number;
  burnToken: Hex;
  mintRecipient: Hex;
  amount: bigint;
  messageSender: Hex;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: Hex;
};

const u32 = (value: number): Hex => numberToHex(value, { size: 4 });
const u256 = (value: bigint): Hex => numberToHex(value, { size: 32 });

export function addressToBytes32(address: Hex): Hex {
  return padHex(address.toLowerCase() as Hex, { size: 32 });
}

export function encodeBurnBody(body: BurnBodyFields): Hex {
  return concatHex([
    u32(body.version),
    body.burnToken,
    body.mintRecipient,
    u256(body.amount),
    body.messageSender,
    u256(body.maxFee),
    u256(body.feeExecuted),
    u256(body.expirationBlock),
    body.hookData,
  ]);
}

export function decodeBurnBody(body: Hex): BurnBodyFields {
  if (size(body) < BURN_BODY_FIXED_LENGTH) throw new Error("burn message body too short");
  return {
    version: Number(hexToBigInt(slice(body, 0, 4))),
    burnToken: slice(body, 4, 36),
    mintRecipient: slice(body, 36, 68),
    amount: hexToBigInt(slice(body, 68, 100)),
    messageSender: slice(body, 100, 132),
    maxFee: hexToBigInt(slice(body, 132, 164)),
    feeExecuted: hexToBigInt(slice(body, 164, 196)),
    expirationBlock: hexToBigInt(slice(body, 196, 228)),
    hookData: size(body) > BURN_BODY_FIXED_LENGTH ? slice(body, BURN_BODY_FIXED_LENGTH) : "0x",
  };
}

export function encodeMessage(message: CctpMessageFields): Hex {
  return concatHex([
    u32(message.version),
    u32(message.sourceDomain),
    u32(message.destinationDomain),
    message.nonce,
    message.sender,
    message.recipient,
    message.destinationCaller,
    u32(message.minFinalityThreshold),
    u32(message.finalityThresholdExecuted),
    message.body,
  ]);
}

export function decodeMessage(message: Hex): CctpMessageFields {
  if (size(message) < HEADER_LENGTH) throw new Error("CCTP message shorter than the header");
  return {
    version: Number(hexToBigInt(slice(message, 0, 4))),
    sourceDomain: Number(hexToBigInt(slice(message, 4, 8))),
    destinationDomain: Number(hexToBigInt(slice(message, 8, 12))),
    nonce: slice(message, 12, 44),
    sender: slice(message, 44, 76),
    recipient: slice(message, 76, 108),
    destinationCaller: slice(message, 108, 140),
    minFinalityThreshold: Number(hexToBigInt(slice(message, 140, 144))),
    finalityThresholdExecuted: Number(hexToBigInt(slice(message, 144, 148))),
    body: slice(message, 148),
  };
}

export function messageHash(message: Hex): Hex {
  return keccak256(message);
}
