import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import type { WebEnv } from "../env";
import { addressUrl, txUrl } from "../explorers";
import { computeSourcesHash } from "../nav-hash";
import { parseNavSnapshot } from "../parse";
import type { Down, PublicNav } from "../view-types";
import { describeError, REQUEST_TIMEOUT_MS } from "./request";

const reportEvent = parseAbiItem(
  "event NavReportReceived(uint64 indexed closeId, uint64 observedAt, uint256 totalAssets, uint256 totalLiabilities, bytes32 sourcesHash)",
);
const settledEvent = parseAbiItem(
  "event EpochSettled(uint64 indexed epoch, uint256 price, uint256 depositAssets, uint256 redeemShares, uint256 redeemFilledShares, uint256 feeShares)",
);
const receiverAbi = parseAbi(["function VAULT() view returns (address)"]);

const NAME = "NAV (Arc)";

async function readSnapshot(url: string, report: { closeId: number; sourcesHash: string }): Promise<PublicNav["sources"]> {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      console.error(`NAV snapshot: HTTP ${response.status}`);
      return { published: false, reason: "NAV snapshot source not connected" };
    }
    const parsed = parseNavSnapshot(await response.json());
    if (!parsed.ok) {
      console.error(`NAV snapshot: invalid document (${parsed.reason})`);
      return { published: false, reason: "NAV snapshot source returned an invalid document" };
    }
    const snapshot = parsed.data;
    if (snapshot.closeId !== report.closeId) {
      return { published: false, reason: `Published snapshot is for close ${snapshot.closeId}, the latest onchain report is close ${report.closeId}` };
    }
    const recomputedHash = computeSourcesHash(snapshot.sources);
    return {
      published: true,
      recomputedHash,
      hashMatches: recomputedHash.toLowerCase() === report.sourcesHash.toLowerCase(),
      rows: snapshot.sources.map((source) => ({
        leg: source.leg,
        account: source.account,
        accountHref: source.trust === "onchain" ? addressUrl(source.account) : null,
        assets: source.assets,
        liabilities: source.liabilities,
        observedAt: source.observedAt,
        trust: source.trust,
      })),
    };
  } catch (error) {
    console.error(`NAV snapshot unreachable (${describeError(error)})`);
    return { published: false, reason: "NAV snapshot source not connected" };
  }
}

export async function readNav(env: WebEnv): Promise<({ ok: true; report: PublicNav }) | Down> {
  if (!env.navReceiverAddress) {
    return { ok: false, source: NAME, reason: "not configured" };
  }
  const receiver = env.navReceiverAddress as `0x${string}`;
  const client = createPublicClient({ transport: http(env.arcRpcUrl, { timeout: REQUEST_TIMEOUT_MS, retryCount: 0 }) });
  try {
    const logs = await client.getLogs({ address: receiver, event: reportEvent, fromBlock: env.navFromBlock, toBlock: "latest" });
    const latest = logs.at(-1);
    if (!latest) return { ok: false, source: NAME, reason: "no NAV report has been written to the receiver yet" };
    const { closeId, observedAt, totalAssets, totalLiabilities, sourcesHash } = latest.args;
    if (closeId === undefined || observedAt === undefined || totalAssets === undefined || totalLiabilities === undefined || !sourcesHash) {
      return { ok: false, source: NAME, reason: "NAV report log is missing fields" };
    }

    let sharePriceE18: string | null = null;
    try {
      const vault = await client.readContract({ address: receiver, abi: receiverAbi, functionName: "VAULT" });
      const settled = await client.getLogs({
        address: vault,
        event: settledEvent,
        args: { epoch: closeId },
        fromBlock: env.navFromBlock,
        toBlock: "latest",
      });
      const price = settled.at(-1)?.args.price;
      sharePriceE18 = price === undefined ? null : price.toString();
    } catch {
      sharePriceE18 = null;
    }

    const base = { closeId: Number(closeId), sourcesHash };
    const sources: PublicNav["sources"] = env.navSnapshotUrl
      ? await readSnapshot(env.navSnapshotUrl, base)
      : { published: false, reason: "The per-source breakdown is not published" };
    const reportTx = latest.transactionHash;
    return {
      ok: true,
      report: {
        closeId: Number(closeId),
        totalAssets: totalAssets.toString(),
        totalLiabilities: totalLiabilities.toString(),
        observedAt: new Date(Number(observedAt) * 1000).toISOString(),
        sourcesHash,
        reportTx,
        reportTxHref: /\/\/(127\.0\.0\.1|localhost)/.test(env.arcRpcUrl) ? null : txUrl("arc", reportTx),
        sharePriceE18,
        sources,
      },
    };
  } catch (error) {
    console.error(`Arc RPC unreachable (${describeError(error)})`);
    return { ok: false, source: NAME, reason: "no response from the service" };
  }
}
