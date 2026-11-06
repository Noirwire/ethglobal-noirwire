import { concatHex, hexToBigInt, keccak256, numberToHex, padHex, size, slice, type Hex } from "viem";

export const MESSAGE_VERSION = 1;
export const BURN_BODY_VERSION = 1;
export const HEADER_LENGTH = 148;
export const BURN_BODY_FIXED_LENGTH = 228;

export const FINALITY_FAST = 1000;

export const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

const UINT32_BYTES = 4;
export const WORD_BYTES = 32;

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

const u32 = (value: number): Hex => numberToHex(value, { size: UINT32_BYTES });
const u256 = (value: bigint): Hex => numberToHex(value, { size: WORD_BYTES });

export function addressToBytes32(address: Hex): Hex {
  return padHex(address.toLowerCase() as Hex, { size: WORD_BYTES });
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

function fieldReader(data: Hex) {
  let offset = 0;
  const take = (length: number): Hex => {
    const field = slice(data, offset, offset + length);
    offset += length;
    return field;
  };
  return {
    uint32: () => Number(hexToBigInt(take(UINT32_BYTES))),
    word: () => take(WORD_BYTES),
    uint256: () => hexToBigInt(take(WORD_BYTES)),
    rest: () => slice(data, offset),
  };
}

export function decodeBurnBody(body: Hex): BurnBodyFields {
  if (size(body) < BURN_BODY_FIXED_LENGTH) throw new Error("burn message body too short");
  const read = fieldReader(body);
  const fields = {
    version: read.uint32(),
    burnToken: read.word(),
    mintRecipient: read.word(),
    amount: read.uint256(),
    messageSender: read.word(),
    maxFee: read.uint256(),
    feeExecuted: read.uint256(),
    expirationBlock: read.uint256(),
  };
  return { ...fields, hookData: size(body) > BURN_BODY_FIXED_LENGTH ? read.rest() : "0x" };
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
  const read = fieldReader(message);
  return {
    version: read.uint32(),
    sourceDomain: read.uint32(),
    destinationDomain: read.uint32(),
    nonce: read.word(),
    sender: read.word(),
    recipient: read.word(),
    destinationCaller: read.word(),
    minFinalityThreshold: read.uint32(),
    finalityThresholdExecuted: read.uint32(),
    body: read.rest(),
  };
}

export function messageHash(message: Hex): Hex {
  return keccak256(message);
}
