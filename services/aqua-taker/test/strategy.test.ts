import { type Hex, encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildDockCall,
  buildOrder,
  buildProgram,
  buildQuoteCall,
  buildShipCall,
  buildSwapCall,
  slippageFloor,
  strategyHash,
  takerTraits,
  usdcVirtualBalance,
} from "../src/strategy.ts";

const MAKER = "0x1206FDb9838E5f74Bc1e2636462483fae6658bd5";
const GUARD = "0xfec063a3be6bbdb768321a626ef7618a8ebc84db";
const ROUTER = "0x111111338c5091e8440b67b168bae16a668ac0de";
const AQUA = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SALT = 0x0102030405060708n;
const USE_AQUA_FLAG = 1n << 254n;

describe("program encoding", () => {
  it("is curve, then HedgeGuard extruction, then salt", () => {
    const program = buildProgram({ hedgeGuard: GUARD, salt: SALT }).toString();
    expect(program).toBe(`0x1100${"2014"}${GUARD.slice(2)}${"1408"}0102030405060708`);
  });

  it("puts the optional taker gate first", () => {
    const gate = "0x00000000000000000000000000000000000000aa";
    const program = buildProgram({ hedgeGuard: GUARD, salt: SALT, takerGateToken: gate }).toString();
    expect(program.startsWith(`0x0e14${gate.slice(2)}1100`)).toBe(true);
  });

  it("keeps different salts on different strategy hashes", () => {
    const a = strategyHash(buildOrder({ maker: MAKER, hedgeGuard: GUARD, salt: 1n }));
    const b = strategyHash(buildOrder({ maker: MAKER, hedgeGuard: GUARD, salt: 2n }));
    expect(a).not.toBe(b);
  });
});

describe("order and call encoding", () => {
  const order = buildOrder({ maker: MAKER, hedgeGuard: GUARD, salt: SALT });

  it("uses Aqua balances instead of a signature", () => {
    expect(order.build().traits).toBe(USE_AQUA_FLAG);
  });

  it("hashes the ABI encoded order", () => {
    const built = order.build();
    const encoded = encodeAbiParameters(parseAbiParameters("(address maker, uint256 traits, bytes data) order"), [
      { maker: built.maker as Hex, traits: built.traits, data: built.data },
    ]);
    expect(strategyHash(order)).toBe(keccak256(encoded));
  });

  it("targets the official registry for ship and dock", () => {
    const ship = buildShipCall({
      strategy: order,
      router: ROUTER,
      aqua: AQUA,
      wbtc: WBTC,
      usdc: USDC,
      wbtcInventory8: 100_000_000n,
      referencePriceE8: 7_500_000_000_000n,
    });
    expect(ship.to.toLowerCase()).toBe(AQUA);
    expect(ship.data.startsWith(toFunctionSelector("ship(address,bytes,address[],uint256[])"))).toBe(true);

    const dock = buildDockCall({ strategy: order, router: ROUTER, aqua: AQUA, wbtc: WBTC, usdc: USDC });
    expect(dock.to.toLowerCase()).toBe(AQUA);
    expect(dock.data.startsWith(toFunctionSelector("dock(address,bytes32,address[])"))).toBe(true);
  });

  it("targets the official router for quote and swap with the v1.0 selectors", () => {
    const params = { order, router: ROUTER, tokenIn: USDC, tokenOut: WBTC, amountIn: 1_000_000n };
    const quote = buildQuoteCall(params);
    const swap = buildSwapCall(params);
    const orderTuple = "(address,uint256,bytes)";
    expect(quote.to.toLowerCase()).toBe(ROUTER);
    expect(quote.data.startsWith(toFunctionSelector(`quote(${orderTuple},address,address,uint256,bytes)`))).toBe(true);
    expect(swap.data.startsWith(toFunctionSelector(`swap(${orderTuple},address,address,uint256,bytes)`))).toBe(true);
  });

  it("encodes exact-in taker traits that transfer from the taker and push into Aqua", () => {
    expect(takerTraits().encode().toString()).toBe("0x00000000000000000000000000000000000000000041");
  });

  it("values the USDC side of the virtual balance at the reference price", () => {
    expect(usdcVirtualBalance(100_000_000n, 7_500_000_000_000n)).toBe(75_000_000_000n);
    expect(usdcVirtualBalance(0n, 7_500_000_000_000n)).toBe(0n);
  });

  it("floors the minimum output by the slippage bound", () => {
    expect(slippageFloor(10_000n, 100n)).toBe(9_900n);
    expect(slippageFloor(0n, 100n)).toBe(0n);
  });
});
