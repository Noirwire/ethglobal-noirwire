import {
  ConsensusAggregationByFields,
  CronCapability,
  EVMClient,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  Runner,
  TxStatus,
  bytesToHex,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  identical,
  median,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, parseAbi, stringToHex, zeroAddress, type Hex } from "viem";
import { configSchema, type Config } from "../src/config.ts";
import { assertFresh, buildSnapshot, planTopUp } from "../src/nav.ts";
import { encodeNavReport, encodeTopUpReport } from "../src/report.ts";
import { parseAquaInventory, parseHyperliquid, parseMakerEquity, parseTransfers } from "../src/sources.ts";

interface MakerFlat {
  equityUsdc6: bigint;
  observedAtMs: number;
}

interface AquaFlat {
  usdc6: bigint;
  wbtcE8: bigint;
  observedAtMs: number;
}

interface HyperliquidFlat {
  accountValueUsdc6: bigint;
  marginUsedUsdc6: bigint;
  observedAtMs: number;
}

interface TransfersFlat {
  json: string;
}

const ERC20_BALANCE = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const FEED = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

const bodyText = (body: Uint8Array): string => new TextDecoder().decode(body);

function expectOk(statusCode: number, label: string): void {
  if (statusCode !== 200) throw new Error(`${label} returned HTTP ${statusCode}`);
}

const fetchMaker = (requester: HTTPSendRequester, url: string): MakerFlat => {
  const response = requester.sendRequest({ url: `${url}/v1/maker/equity`, method: "GET" }).result();
  expectOk(response.statusCode, "maker equity");
  return parseMakerEquity(bodyText(response.body));
};

const fetchAqua = (requester: HTTPSendRequester, url: string): AquaFlat => {
  const response = requester.sendRequest({ url: `${url}/v1/aqua/inventory`, method: "GET" }).result();
  expectOk(response.statusCode, "aqua inventory");
  return parseAquaInventory(bodyText(response.body));
};

const fetchHyperliquid = (requester: HTTPSendRequester, url: string, user: string): HyperliquidFlat => {
  const response = requester
    .sendRequest({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: hexToBase64(stringToHex(JSON.stringify({ type: "clearinghouseState", user }))),
    })
    .result();
  expectOk(response.statusCode, "hyperliquid");
  return parseHyperliquid(bodyText(response.body));
};

const fetchTransfers = (requester: HTTPSendRequester, url: string): TransfersFlat => {
  const response = requester.sendRequest({ url: `${url}/v1/transfers?state=in-flight`, method: "GET" }).result();
  expectOk(response.statusCode, "bridge transfers");
  const transfers = parseTransfers(bodyText(response.body)).sort((a, b) => (a.transferId < b.transferId ? -1 : 1));
  return { json: JSON.stringify(transfers) };
};

function functionNameOf(abi: ReturnType<typeof parseAbi>): string {
  const entry = abi[0] as { name: string };
  return entry.name;
}

function evmClientFor(chainName: string): EVMClient {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: chainName });
  if (!network) throw new Error(`unknown chain name: ${chainName}`);
  return new EVMClient(network.chainSelector.selector);
}

function readContract<T>(
  runtime: Runtime<Config>,
  client: EVMClient,
  to: string,
  abi: ReturnType<typeof parseAbi>,
  functionName: string,
  args: unknown[] = [],
): T {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const reply = client
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: to as Hex, data }),
      blockNumber: runtime.config.readAt === "latest" ? LATEST_BLOCK_NUMBER : LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  return decodeFunctionResult({ abi, functionName, data: bytesToHex(reply.data) } as never) as T;
}

function writeReport(runtime: Runtime<Config>, client: EVMClient, payload: Hex): string {
  const report = runtime
    .report({ encodedPayload: hexToBase64(payload), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
    .result();
  const result = client
    .writeReport(runtime, {
      receiver: runtime.config.arc.navReceiver,
      report,
      gasConfig: { gasLimit: runtime.config.arc.gasLimit },
    })
    .result();
  if (result.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`report write failed with status ${result.txStatus}: ${result.errorMessage ?? ""}`);
  }
  return bytesToHex(result.txHash ?? new Uint8Array(32));
}

const onCron = (runtime: Runtime<Config>): string => {
  const config = runtime.config;
  const now = runtime.now();
  const http = new HTTPClient();

  const arc = evmClientFor(config.arc.chainName);
  const vaultUsdc = readContract<bigint>(runtime, arc, config.arc.usdc, ERC20_BALANCE, "balanceOf", [config.arc.shareVault]);
  const epochAbi = parseAbi([config.arc.epochAbiFragment]);
  const closeId = Number(readContract<bigint>(runtime, arc, config.arc.shareVault, epochAbi, functionNameOf(epochAbi)));
  const supplyAbi = parseAbi([config.arc.supplyAbiFragment]);
  const shareSupply = readContract<bigint>(runtime, arc, config.arc.shareVault, supplyAbi, functionNameOf(supplyAbi));

  const feedClient = evmClientFor(config.aqua.feedChainName);
  const round = readContract<readonly [bigint, bigint, bigint, bigint, bigint]>(
    runtime,
    feedClient,
    config.aqua.btcUsdFeed,
    FEED,
    "latestRoundData",
  );
  if (round[1] <= 0n) throw new Error("BTC/USD feed returned a non-positive answer");
  assertFresh("btc-usd-feed", new Date(Number(round[3]) * 1000), now, config.maxPriceAgeSec);

  const maker = http
    .sendRequest(
      runtime,
      fetchMaker,
      ConsensusAggregationByFields<MakerFlat>({ equityUsdc6: median, observedAtMs: median }),
    )(config.maker.apiUrl)
    .result();
  const aqua = http
    .sendRequest(
      runtime,
      fetchAqua,
      ConsensusAggregationByFields<AquaFlat>({ usdc6: median, wbtcE8: median, observedAtMs: median }),
    )(config.aqua.apiUrl)
    .result();
  const hyperliquid = http
    .sendRequest(
      runtime,
      fetchHyperliquid,
      ConsensusAggregationByFields<HyperliquidFlat>({
        accountValueUsdc6: median,
        marginUsedUsdc6: median,
        observedAtMs: median,
      }),
    )(config.hyperliquid.infoUrl, config.hyperliquid.user)
    .result();
  const transfers = http
    .sendRequest(
      runtime,
      fetchTransfers,
      ConsensusAggregationByFields<TransfersFlat>({ json: identical }),
    )(config.bridge.apiUrl)
    .result();

  const snapshot = buildSnapshot({
    closeId,
    now,
    maxSourceAgeSec: config.maxSourceAgeSec,
    readings: {
      vaultCash: { account: `arc:${config.arc.shareVault.toLowerCase()}`, usdc6: vaultUsdc, observedAt: now },
      maker: {
        account: config.maker.account,
        equityUsdc6: maker.equityUsdc6,
        observedAt: new Date(maker.observedAtMs),
      },
      hyperliquid: {
        account: `hyperliquid:${config.hyperliquid.user.toLowerCase()}`,
        accountValueUsdc6: hyperliquid.accountValueUsdc6,
        observedAt: new Date(hyperliquid.observedAtMs),
      },
      aqua: {
        account: config.aqua.account,
        usdc6: aqua.usdc6,
        wbtcE8: aqua.wbtcE8,
        btcUsdE8: round[1],
        observedAt: new Date(aqua.observedAtMs),
      },
      transfers: { account: config.bridge.account, items: JSON.parse(transfers.json), observedAt: now },
      shareSupply18: shareSupply,
    },
  });

  runtime.log(
    `nav closeId=${snapshot.closeId} assets=${snapshot.totalAssets} liabilities=${snapshot.totalLiabilities} ` +
      `sharePriceE18=${snapshot.sharePriceE18} sourcesHash=${snapshot.sourcesHash} ` +
      `inTransit=${snapshot.inTransitTransferIds.length}`,
  );
  for (const source of snapshot.sources) {
    runtime.log(`source ${source.leg} assets=${source.assets} trust=${source.trust} observedAt=${source.observedAt}`);
  }

  const navTx = writeReport(runtime, arc, encodeNavReport(snapshot));
  runtime.log(`kind 1 NavReport written, tx ${navTx}`);

  const intent = planTopUp({
    closeId,
    accountValueUsdc6: hyperliquid.accountValueUsdc6,
    marginUsedUsdc6: hyperliquid.marginUsedUsdc6,
    bands: config.bands,
  });
  if (!intent) {
    runtime.log("margin within bands, no top-up intent");
    return `nav ${snapshot.totalAssets} closeId ${closeId}`;
  }
  runtime.log(
    `intent ${intent.reason} route=${intent.route} amount=${intent.amount} marginRatioBps=${intent.marginRatioBps} id=${intent.intentId}`,
  );
  const intentTx = writeReport(runtime, arc, encodeTopUpReport(intent));
  runtime.log(`kind 2 TopUpIntent written, tx ${intentTx}`);
  return `nav ${snapshot.totalAssets} closeId ${closeId} intent ${intent.reason} ${intent.amount}`;
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run((config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)]);
}
