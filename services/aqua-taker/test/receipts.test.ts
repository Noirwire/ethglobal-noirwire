import {
  type Address,
  type Hex,
  encodeEventTopics,
  encodeAbiParameters,
  encodeFunctionResult,
  zeroHash,
} from "viem";
import { describe, expect, it } from "vitest";
import { hedgeGuardAbi, quoteResultAbi } from "../src/abis.ts";
import { Direction } from "../src/band.ts";
import type { ForkClients } from "../src/chain.ts";
import type { Deployment } from "../src/fork-setup.ts";
import { AquaMaker } from "../src/maker.ts";
import { buildOrder } from "../src/strategy.ts";
import { AquaTaker } from "../src/taker.ts";
import { TxRevertedError, approveMax, sendCall } from "../src/tx.ts";

const ADDR = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const deployment: Deployment = {
  usdc: ADDR(1),
  wbtc: ADDR(2),
  router: ADDR(3),
  aqua: ADDR(4),
  hedgeGuard: ADDR(5),
  oracle: ADDR(6),
};
const TX_HASH: Hex = `0x${"ab".repeat(32)}`;

function hedgeFilledLog(btcAmount: bigint, priceE8: bigint, remaining: bigint) {
  return {
    address: deployment.hedgeGuard,
    topics: encodeEventTopics({
      abi: hedgeGuardAbi,
      eventName: "HedgeFilled",
      args: { maker: ADDR(7), orderHash: zeroHash },
    }),
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
      [ADDR(8), btcAmount, priceE8, remaining],
    ),
  };
}

function fakeClients(options: {
  status: "success" | "reverted";
  logs?: unknown[];
  call?: () => Promise<{ data: Hex }>;
  readContract?: () => Promise<unknown>;
}): ForkClients {
  return {
    rpcUrl: "mock",
    publicClient: {
      call: options.call ?? (() => Promise.reject(new Error("unexpected call"))),
      readContract: options.readContract ?? (() => Promise.resolve(0n)),
      getBlock: () => Promise.resolve({ timestamp: 1_000n }),
      waitForTransactionReceipt: () =>
        Promise.resolve({ status: options.status, gasUsed: 1n, logs: options.logs ?? [] }),
    },
    testClient: {},
    wallet: () => ({ sendTransaction: () => Promise.resolve(TX_HASH) }),
    address: (role: string) => ADDR(role.length + 100),
  } as unknown as ForkClients;
}

const CALL = { to: ADDR(9), data: "0x" as Hex, value: 0n };

describe("sendCall", () => {
  it("throws on a reverted receipt and returns it only when the caller opts in", async () => {
    const clients = fakeClients({ status: "reverted" });
    await expect(sendCall(clients, "taker", CALL)).rejects.toBeInstanceOf(TxRevertedError);
    await expect(sendCall(clients, "taker", CALL, { allowRevert: true })).resolves.toMatchObject({
      status: "reverted",
    });
  });

  it("makes approve, setTarget and clearTarget fail loudly", async () => {
    const clients = fakeClients({ status: "reverted" });
    await expect(approveMax(clients, "maker", [deployment.wbtc], deployment.aqua)).rejects.toBeInstanceOf(
      TxRevertedError,
    );
    const maker = new AquaMaker(clients, deployment);
    await expect(maker.clearTarget()).rejects.toBeInstanceOf(TxRevertedError);
    await expect(
      maker.setTarget({ direction: Direction.MakerSellsBtc, size8: 1n, ttlSeconds: 60n }),
    ).rejects.toBeInstanceOf(TxRevertedError);
  });
});

describe("swap accounting", () => {
  it("reports the amounts the guard recorded, not the earlier quote", async () => {
    const quoted = { amountIn: 100_000n, amountOut: 1_000_000n, orderHash: zeroHash };
    const clients = fakeClients({
      status: "success",
      logs: [hedgeFilledLog(990_000n, 76_000_00000000n, 4_010_000n)],
      call: () =>
        Promise.resolve({
          data: encodeFunctionResult({
            abi: quoteResultAbi,
            functionName: "quote",
            result: [quoted.amountIn, quoted.amountOut, quoted.orderHash],
          }),
        }),
    });
    const taker = new AquaTaker(clients, deployment);
    const order = buildOrder({ maker: ADDR(7), hedgeGuard: deployment.hedgeGuard, salt: 1n });

    const outcome = await taker.swap(order, deployment.usdc, deployment.wbtc, 100_000n);
    expect(outcome.kind).toBe("filled");
    if (outcome.kind !== "filled") return;
    expect(outcome.btc8).toBe(990_000n);
    expect(outcome.priceE8).toBe(76_000_00000000n);
    expect(outcome.remaining8).toBe(4_010_000n);
  });
});
