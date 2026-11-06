import type { Order } from "@1inch/swap-vm-sdk";
import { type Address, type Hex, encodeFunctionData } from "viem";
import { aquaAbi, hedgeGuardAbi } from "./abis.js";
import { type DirectionCode, type HedgeTarget, bandAround } from "./band.js";
import type { ForkClients } from "./chain.js";
import type { Deployment } from "./fork-setup.js";
import { buildDockCall, buildOrder, buildShipCall, strategyHash } from "./strategy.js";
import { type SentTx, approveMax, sendCall } from "./tx.js";

const TARGET_BAND_HALF_WIDTH_BPS = 500n;

export interface ShippedStrategy {
  order: Order;
  strategyHash: Hex;
  ship: SentTx;
  approvals: SentTx[];
}

export interface TargetRequest {
  direction: DirectionCode;
  size8: bigint;
  ttlSeconds: bigint;
}

export class AquaMaker {
  constructor(
    private readonly clients: ForkClients,
    private readonly deployment: Deployment,
  ) {}

  get address(): Address {
    return this.clients.address("maker");
  }

  async oraclePriceE8(): Promise<bigint> {
    return this.clients.publicClient.readContract({
      address: this.deployment.hedgeGuard,
      abi: hedgeGuardAbi,
      functionName: "oraclePriceE8",
    });
  }

  async ship(params: {
    wbtcInventory8: bigint;
    salt: bigint;
    takerGateToken?: string;
  }): Promise<ShippedStrategy> {
    const approvals = await approveMax(
      this.clients,
      "maker",
      [this.deployment.wbtc, this.deployment.usdc],
      this.deployment.aqua,
    );

    const order = buildOrder({
      maker: this.address,
      hedgeGuard: this.deployment.hedgeGuard,
      salt: params.salt,
      takerGateToken: params.takerGateToken,
    });
    const ship = await sendCall(
      this.clients,
      "maker",
      buildShipCall({
        strategy: order,
        router: this.deployment.router,
        aqua: this.deployment.aqua,
        wbtc: this.deployment.wbtc,
        usdc: this.deployment.usdc,
        wbtcInventory8: params.wbtcInventory8,
        referencePriceE8: await this.oraclePriceE8(),
      }),
    );
    return { order, strategyHash: strategyHash(order), ship, approvals };
  }

  async setTarget(request: TargetRequest): Promise<{ tx: SentTx; target: HedgeTarget }> {
    const oracleE8 = await this.oraclePriceE8();
    const { minPriceE8, maxPriceE8 } = bandAround(oracleE8, TARGET_BAND_HALF_WIDTH_BPS);
    const latest = await this.clients.publicClient.getBlock();
    const expiry = latest.timestamp + request.ttlSeconds;
    const tx = await sendCall(this.clients, "hedger", {
      to: this.deployment.hedgeGuard,
      data: encodeFunctionData({
        abi: hedgeGuardAbi,
        functionName: "setTarget",
        args: [this.address, request.direction, request.size8, minPriceE8, maxPriceE8, Number(expiry)],
      }),
      value: 0n,
    });
    return {
      tx,
      target: { direction: request.direction, remaining: request.size8, minPriceE8, maxPriceE8, expiry },
    };
  }

  async clearTarget(): Promise<SentTx> {
    return sendCall(this.clients, "hedger", {
      to: this.deployment.hedgeGuard,
      data: encodeFunctionData({ abi: hedgeGuardAbi, functionName: "clearTarget", args: [this.address] }),
      value: 0n,
    });
  }

  async dock(order: Order): Promise<SentTx> {
    return sendCall(
      this.clients,
      "maker",
      buildDockCall({
        strategy: order,
        router: this.deployment.router,
        aqua: this.deployment.aqua,
        wbtc: this.deployment.wbtc,
        usdc: this.deployment.usdc,
      }),
    );
  }

  async virtualBalance(strategy: Hex, token: Address): Promise<bigint> {
    const [balance] = await this.clients.publicClient.readContract({
      address: this.deployment.aqua,
      abi: aquaAbi,
      functionName: "rawBalances",
      args: [this.address, this.deployment.router, strategy, token],
    });
    return balance;
  }
}
