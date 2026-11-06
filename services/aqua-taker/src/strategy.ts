import { AquaProtocolContract } from "@1inch/aqua-sdk";
import {
  Address,
  AquaProgramBuilder,
  HexString,
  MakerTraits,
  Order,
  SwapVMContract,
  TakerTraits,
  instructions,
} from "@1inch/swap-vm-sdk";
import { type Hex, isHex } from "viem";
import { BPS_DENOMINATOR, USDC_PER_BTC_TO_PRICE_E8 } from "./band.js";

export interface StrategyParams {
  maker: string;
  hedgeGuard: string;
  salt: bigint;
  takerGateToken?: string;
}

export interface ShipParams {
  strategy: Order;
  router: string;
  aqua: string;
  wbtc: string;
  usdc: string;
  wbtcInventory8: bigint;
  referencePriceE8: bigint;
}

export interface EncodedCall {
  to: Hex;
  data: Hex;
  value: bigint;
}

function hexOf(value: { toString(): string }): Hex {
  const text = value.toString();
  if (!isHex(text)) throw new Error(`expected hex, got ${text}`);
  return text;
}

function toCall(call: { to: { toString(): string }; data: { toString(): string }; value: bigint }): EncodedCall {
  return { to: hexOf(call.to), data: hexOf(call.data), value: call.value };
}

export function buildProgram(params: Pick<StrategyParams, "hedgeGuard" | "salt" | "takerGateToken">): HexString {
  const builder = new AquaProgramBuilder();
  if (params.takerGateToken !== undefined) {
    builder.onlyTakerTokenBalanceNonZero({ token: new Address(params.takerGateToken) });
  }
  builder.xycSwapXD();
  builder.add(
    instructions.extruction.extruction.createIx(
      new instructions.extruction.ExtructionArgs(new Address(params.hedgeGuard), HexString.EMPTY),
    ),
  );
  builder.salt(instructions.controls.SaltArgs.fromUint64(params.salt));
  return builder.build();
}

export function buildOrder(params: StrategyParams): Order {
  return Order.new({
    maker: new Address(params.maker),
    program: buildProgram(params),
    traits: MakerTraits.default(),
  });
}

export function strategyHash(order: Order): Hex {
  return hexOf(AquaProtocolContract.calculateStrategyHash(order.encode()));
}

export function usdcVirtualBalance(wbtcInventory8: bigint, referencePriceE8: bigint): bigint {
  return (wbtcInventory8 * referencePriceE8) / USDC_PER_BTC_TO_PRICE_E8;
}

export function buildShipCall(params: ShipParams): EncodedCall {
  const aqua = new AquaProtocolContract(new Address(params.aqua));
  return toCall(
    aqua.ship({
      app: new Address(params.router),
      strategy: params.strategy.encode(),
      amountsAndTokens: [
        { token: new Address(params.wbtc), amount: params.wbtcInventory8 },
        { token: new Address(params.usdc), amount: usdcVirtualBalance(params.wbtcInventory8, params.referencePriceE8) },
      ],
    }),
  );
}

export function buildDockCall(params: Pick<ShipParams, "strategy" | "router" | "aqua" | "wbtc" | "usdc">): EncodedCall {
  const aqua = new AquaProtocolContract(new Address(params.aqua));
  return toCall(
    aqua.dock({
      app: new Address(params.router),
      strategyHash: AquaProtocolContract.calculateStrategyHash(params.strategy.encode()),
      tokens: [new Address(params.wbtc), new Address(params.usdc)],
    }),
  );
}

export function takerTraits(thresholdAmountOutMin: bigint = 0n): TakerTraits {
  return TakerTraits.new({ exactIn: true, useTransferFromAndAquaPush: true, threshold: thresholdAmountOutMin });
}

export interface SwapCallParams {
  order: Order;
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut?: bigint;
}

function swapArgs(params: SwapCallParams) {
  return {
    order: params.order,
    tokenIn: new Address(params.tokenIn),
    tokenOut: new Address(params.tokenOut),
    amount: params.amountIn,
    takerTraits: takerTraits(params.minAmountOut ?? 0n),
  };
}

export function buildQuoteCall(params: SwapCallParams): EncodedCall {
  return toCall(new SwapVMContract(new Address(params.router)).quote(swapArgs(params)));
}

export function buildSwapCall(params: SwapCallParams): EncodedCall {
  return toCall(new SwapVMContract(new Address(params.router)).swap(swapArgs(params)));
}

export function slippageFloor(quotedOut: bigint, slippageBps: bigint): bigint {
  return (quotedOut * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
}
