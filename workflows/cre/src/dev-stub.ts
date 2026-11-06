export type Scenario = "healthy" | "margin-low";

const DEFAULT_PORT = 8787;

function secondsAgo(now: Date, seconds: number): string {
  return new Date(now.getTime() - seconds * 1000).toISOString();
}

export function makerEquity(now: Date) {
  return { equityUsdc6: "12000000000", observedAt: secondsAgo(now, 20) };
}

export function aquaInventory(now: Date) {
  return { usdc6: "3000000000", wbtcE8: "2000000", observedAt: secondsAgo(now, 30) };
}

export function inFlightTransfers(now: Date) {
  const base = {
    sourceDomain: 26,
    destinationDomain: 5,
    maxFee: "10000",
    attester: "local-test-attester",
  };
  return [
    {
      ...base,
      transferId: "t-burned-1",
      route: "arc-solana",
      grossAmount: "250000000",
      state: "burned",
      updatedAt: secondsAgo(now, 90),
    },
    {
      ...base,
      transferId: "t-burned-1",
      route: "arc-solana",
      grossAmount: "250000000",
      state: "requested",
      updatedAt: secondsAgo(now, 180),
    },
    {
      ...base,
      transferId: "t-minted-2",
      route: "solana-arc",
      grossAmount: "100000000",
      netMinted: "99990000",
      state: "minted",
      updatedAt: secondsAgo(now, 60),
    },
    {
      ...base,
      transferId: "t-credited-3",
      route: "arc-hypercore",
      grossAmount: "500000000",
      state: "credited",
      updatedAt: secondsAgo(now, 45),
    },
  ];
}

export function hyperliquidState(now: Date, scenario: Scenario) {
  const margin = scenario === "margin-low" ? { accountValue: "1500.0", totalMarginUsed: "1000.0" } : { accountValue: "62.804826", totalMarginUsed: "0.0" };
  return { marginSummary: margin, time: now.getTime() - 5000 };
}

function readScenario(argv: string[]): Scenario {
  const index = argv.indexOf("--scenario");
  const value = index >= 0 ? argv[index + 1] : "healthy";
  if (value !== "healthy" && value !== "margin-low") throw new Error(`unknown scenario: ${value}`);
  return value;
}

export function startStub(scenario: Scenario, port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const now = new Date();
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/maker/equity") return Response.json(makerEquity(now));
      if (request.method === "GET" && url.pathname === "/v1/aqua/inventory") return Response.json(aquaInventory(now));
      if (request.method === "GET" && url.pathname === "/v1/transfers") return Response.json(inFlightTransfers(now));
      if (request.method === "POST" && url.pathname === "/info") return Response.json(hyperliquidState(now, scenario));
      return new Response(null, { status: 404 });
    },
  });
}

if (import.meta.main) {
  const scenario = readScenario(process.argv);
  startStub(scenario, DEFAULT_PORT);
  console.log(`dev stub on http://127.0.0.1:${DEFAULT_PORT}, scenario ${scenario}`);
}
