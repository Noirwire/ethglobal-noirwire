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
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  stringToHex,
  zeroAddress,
  type Abi,
  type Hex,
} from "viem";
import { configSchema, type Config } from "../src/config.ts";
import { assertFresh, buildSnapshot, planTopUp } from "../src/nav.ts";
import { encodeNavReport, encodeTopUpReport } from "../src/report.ts";
import {
  parseAquaInventory,
  parseHyperliquid,
  parseMakerEquity,
  parseTransfers,
  type AquaInventory,
  type HyperliquidAccount,
  type MakerEquity,
} from "../src/sources.ts";

interface TransfersFlat {
  json: string;
}

type HttpRequest = Parameters<HTTPSendRequester["sendRequest"]>[0];

const MS_PER_SEC = 1000;
const HTTP_OK = 200;

const SHARE_VAULT = parseAbi([
  "function navCash() view returns (uint256)",
  "function currentEpoch() view returns (uint64)",
  "function totalSupply() view returns (uint256)",
]);
const FEED = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

const bodyText = (body: Uint8Array): string => new TextDecoder().decode(body);

function fetchText(requester: HTTPSendRequester, request: HttpRequest, label: string): string {
  const response = requester.sendRequest(request).result();
  if (response.statusCode !== HTTP_OK) throw new Error(`${label} returned HTTP ${response.statusCode}`);
  return bodyText(response.body);
}

const fetchMaker = (requester: HTTPSendRequester, url: string): MakerEquity =>
  parseMakerEquity(fetchText(requester, { url: `${url}/v1/maker/equity`, method: "GET" }, "maker equity"));

const fetchAqua = (requester: HTTPSendRequester, url: string): AquaInventory =>
  parseAquaInventory(fetchText(requester, { url: `${url}/v1/aqua/inventory`, method: "GET" }, "aqua inventory"));

const fetchHyperliquid = (requester: HTTPSendRequester, url: string, user: string): HyperliquidAccount =>
  parseHyperliquid(
    fetchText(
      requester,
      {
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: hexToBase64(stringToHex(JSON.stringify({ type: "clearinghouseState", user }))),
      },
      "hyperliquid",
    ),
  );

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const fetchTransfers = (requester: HTTPSendRequester, url: string): TransfersFlat => {
  const text = fetchText(requester, { url: `${url}/v1/transfers?state=in-flight`, method: "GET" }, "bridge transfers");
  const transfers = parseTransfers(text).sort((a, b) => compareIds(a.transferId, b.transferId));
  return { json: JSON.stringify(transfers) };
};

function evmClientFor(chainName: string): EVMClient {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: chainName });
  if (!network) throw new Error(`unknown chain name: ${chainName}`);
  return new EVMClient(network.chainSelector.selector);
}

function readContract<T>(
  runtime: Runtime<Config>,
  client: EVMClient,
  to: string,
  abi: Abi,
  functionName: string,
): T {
  const data = encodeFunctionData({ abi, functionName });
  const reply = client
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: to as Hex, data }),
      blockNumber: runtime.config.readAt === "latest" ? LATEST_BLOCK_NUMBER : LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  return decodeFunctionResult({ abi, functionName, data: bytesToHex(reply.data) }) as T;
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
  const vault = config.arc.shareVault;
  const vaultUsdc = readContract<bigint>(runtime, arc, vault, SHARE_VAULT, "navCash");
  const closeId = Number(readContract<bigint>(runtime, arc, vault, SHARE_VAULT, "currentEpoch"));
  const shareSupply = readContract<bigint>(runtime, arc, vault, SHARE_VAULT, "totalSupply");

  const feedClient = evmClientFor(config.aqua.feedChainName);
  const round = readContract<readonly [bigint, bigint, bigint, bigint, bigint]>(
    runtime,
    feedClient,
    config.aqua.btcUsdFeed,
    FEED,
    "latestRoundData",
  );
  if (round[1] <= 0n) throw new Error("BTC/USD feed returned a non-positive answer");
  assertFresh("btc-usd-feed", new Date(Number(round[3]) * MS_PER_SEC), now, config.maxPriceAgeSec);

  const maker = http
    .sendRequest(
      runtime,
      fetchMaker,
      ConsensusAggregationByFields<MakerEquity>({ equityUsdc6: median, observedAtMs: median }),
    )(config.maker.apiUrl)
    .result();
  const aqua = http
    .sendRequest(
      runtime,
      fetchAqua,
      ConsensusAggregationByFields<AquaInventory>({ usdc6: median, wbtcE8: median, observedAtMs: median }),
    )(config.aqua.apiUrl)
    .result();
  const hyperliquid = http
    .sendRequest(
      runtime,
      fetchHyperliquid,
      ConsensusAggregationByFields<HyperliquidAccount>({
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
