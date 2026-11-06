import { fileURLToPath } from "node:url";
import { LOCAL_NETWORKS, type BridgeTransfer } from "@noirwire/shared";
import type { Hex } from "viem";
import { TreasuryExecutor } from "./executor.ts";
import { DEFAULT_DEV_DEPOSIT, LOCAL_FEE, setupLocalArc } from "./local-arc.ts";
import { TransferStore } from "./transfers.ts";

export type LocalE2eResult = {
  transfer: BridgeTransfer;
  beneficiary: Hex;
  expectedNet: bigint;
  vaultAssets: bigint;
  inFlightAfter: number;
};

export async function runLocalE2e(rpcUrl: string = LOCAL_NETWORKS.arcLocal.rpcUrl): Promise<LocalE2eResult> {
  const arc = await setupLocalArc(rpcUrl, { deployIfMissing: true });
  const store = new TransferStore();
  const executor = new TreasuryExecutor(
    store,
    arc.attester,
    { "solana-arc": arc.adapter },
    {
      routes: { "solana-arc": arc.route },
      allowlist: new Set([arc.hookExecutor.toLowerCase()]),
      dailyCap: 1_000_000_000n,
      defaultPerTransferCap: 1_000_000_000n,
      stuckTimeoutMs: 60_000,
      stuckRetryMs: 5_000,
    },
  );

  const before = await arc.vaultPosition();
  const [created] = executor.submit(arc.depositIntent(DEFAULT_DEV_DEPOSIT));
  if (!created) throw new Error("no transfer created");
  await executor.advance(created.transferId);

  const transfer = store.get(created.transferId) as BridgeTransfer;
  const after = await arc.vaultPosition();
  return {
    transfer,
    beneficiary: arc.beneficiary,
    expectedNet: DEFAULT_DEV_DEPOSIT - LOCAL_FEE,
    vaultAssets: after - before,
    inFlightAfter: store.inFlight().length,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rpc = process.env.LOCAL_RPC ?? LOCAL_NETWORKS.arcLocal.rpcUrl;
  runLocalE2e(rpc)
    .then((result) => {
      const ok =
        result.transfer.state === "vault-credited" &&
        result.transfer.attester === "local-test-attester" &&
        result.vaultAssets === result.expectedNet &&
        result.inFlightAfter === 0;
      console.log(JSON.stringify({ ok, ...result, expectedNet: String(result.expectedNet), vaultAssets: String(result.vaultAssets) }, null, 2));
      process.exit(ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
