import type { Order } from "@1inch/swap-vm-sdk";
import { type Address, type Hex, decodeEventLog, decodeFunctionResult, parseAbi } from "viem";
import { hedgeGuardAbi } from "./abis.js";
import {
  Direction,
  type DirectionCode,
  type HedgeTarget,
  allowedTokens,
  sameAddress,
  toDirectionCode,
  usdcForBtc,
} from "./band.js";
import type { ForkClients } from "./chain.js";
import type { Deployment } from "./fork-setup.js";
import { type EncodedCall, buildQuoteCall, buildSwapCall, slippageFloor } from "./strategy.js";
import { type GuardRevert, REVERTING_TX_GAS, type SentTx, approveMax, callOrExplain, sendCall } from "./tx.js";

const SLIPPAGE_BPS = 100n;

const quoteResultAbi = parseAbi([
  "function quote((address maker, uint256 traits, bytes data) order, address tokenIn, address tokenOut, uint256 amount, bytes takerData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
]);

export interface Quote {
  amountIn: bigint;
  amountOut: bigint;
  orderHash: Hex;
}

export type SwapOutcome =
  | { kind: "filled"; tx: SentTx; quote: Quote; priceE8: bigint; btc8: bigint; remaining8: bigint }
  | { kind: "rejected"; tx: SentTx | undefined; revert: GuardRevert | undefined; message: string };

export class AquaTaker {
  constructor(
    private readonly clients: ForkClients,
    private readonly deployment: Deployment,
  ) {}

  get address(): Address {
    return this.clients.address("taker");
  }

  async approveRouter(): Promise<SentTx[]> {
    return approveMax(this.clients, "taker", [this.deployment.wbtc, this.deployment.usdc], this.deployment.router);
  }

  async readTarget(maker: Address): Promise<HedgeTarget> {
    const target = await this.clients.publicClient.readContract({
      address: this.deployment.hedgeGuard,
      abi: hedgeGuardAbi,
      functionName: "targetOf",
      args: [maker],
    });
    return {
      direction: toDirectionCode(target.direction),
      remaining: target.remaining,
      minPriceE8: target.minPriceE8,
      maxPriceE8: target.maxPriceE8,
      expiry: BigInt(target.expiry),
    };
  }

  tokensFor(direction: DirectionCode): { tokenIn: Address; tokenOut: Address } {
    const tokens = allowedTokens(direction, this.deployment.wbtc, this.deployment.usdc);
    if (tokens === undefined) throw new Error("target has no direction");
    return tokens;
  }

  async quote(order: Order, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<
    { ok: true; quote: Quote } | { ok: false; revert: GuardRevert | undefined; message: string }
  > {
    const call = buildQuoteCall({ order, router: this.deployment.router, tokenIn, tokenOut, amountIn });
    const result = await callOrExplain(this.clients, this.address, call);
    if (!result.ok) return result;
    const [quotedIn, quotedOut, orderHash] = decodeFunctionResult({
      abi: quoteResultAbi,
      functionName: "quote",
      data: result.data,
    });
    return { ok: true, quote: { amountIn: quotedIn, amountOut: quotedOut, orderHash } };
  }

  async swap(order: Order, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<SwapOutcome> {
    const quoted = await this.quote(order, tokenIn, tokenOut, amountIn);
    if (!quoted.ok) {
      const call = this.swapCall(order, tokenIn, tokenOut, amountIn, 0n);
      const tx = await sendCall(this.clients, "taker", call, { gas: REVERTING_TX_GAS, allowRevert: true });
      return { kind: "rejected", tx, revert: quoted.revert, message: quoted.message };
    }
    const minOut = slippageFloor(quoted.quote.amountOut, SLIPPAGE_BPS);
    const tx = await sendCall(this.clients, "taker", this.swapCall(order, tokenIn, tokenOut, amountIn, minOut), {
      gas: REVERTING_TX_GAS,
      allowRevert: true,
    });
    if (tx.status === "reverted") {
      return { kind: "rejected", tx, revert: undefined, message: "swap transaction reverted after a passing quote" };
    }
    const fill = this.decodeFill(tx);
    return { kind: "filled", tx, quote: quoted.quote, btc8: fill.btcAmount, priceE8: fill.priceE8, remaining8: fill.remaining };
  }

  private decodeFill(tx: SentTx): { btcAmount: bigint; priceE8: bigint; remaining: bigint } {
    for (const log of tx.logs) {
      if (!sameAddress(log.address, this.deployment.hedgeGuard)) continue;
      try {
        const decoded = decodeEventLog({ abi: hedgeGuardAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (decoded.eventName === "HedgeFilled") return decoded.args;
      } catch {
        continue;
      }
    }
    throw new Error(`swap ${tx.hash} succeeded without a HedgeFilled event`);
  }

  async swapAllowedDirection(order: Order, maker: Address, btc8: bigint): Promise<SwapOutcome> {
    return this.swapAgainstTarget(order, maker, btc8, "allowed");
  }

  async swapWrongDirection(order: Order, maker: Address, btc8: bigint): Promise<SwapOutcome> {
    return this.swapAgainstTarget(order, maker, btc8, "wrong");
  }

  private async swapAgainstTarget(
    order: Order,
    maker: Address,
    btc8: bigint,
    way: "allowed" | "wrong",
  ): Promise<SwapOutcome> {
    const target = await this.readTarget(maker);
    const { tokenIn, tokenOut } = this.tokensFor(target.direction);
    const usdcAmount = usdcForBtc(btc8, (target.minPriceE8 + target.maxPriceE8) / 2n, "up");
    const makerSells = target.direction === Direction.MakerSellsBtc;
    if (way === "allowed") return this.swap(order, tokenIn, tokenOut, makerSells ? usdcAmount : btc8);
    return this.swap(order, tokenOut, tokenIn, makerSells ? btc8 : usdcAmount);
  }

  private swapCall(order: Order, tokenIn: Address, tokenOut: Address, amountIn: bigint, minOut: bigint): EncodedCall {
    return buildSwapCall({
      order,
      router: this.deployment.router,
      tokenIn,
      tokenOut,
      amountIn,
      minAmountOut: minOut,
    });
  }
}
