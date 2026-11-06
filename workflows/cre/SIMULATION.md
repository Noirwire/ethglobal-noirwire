# Simulation results

CRE CLI v1.39.0, `@chainlink/cre-sdk` 1.23.0, run on 2026-11-06. No `--broadcast`, so every write is a dry run (empty tx hash `0x00..00`). Nothing was sent to any public network.

## Setup used

| Piece | Value |
| --- | --- |
| Arc testnet RPC | local `anvil` fork of `https://rpc.testnet.arc.network`, chain id 5042002, port 8650 |
| Mock forwarder | the real `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` that exists on Arc testnet |
| Vault | `0x...0fa017`, test bytecode set on the fork only: `currentEpoch()` returns 7, `totalSupply()` returns 1000e18; its USDC balance was set to 5000 USDC with `anvil_setBalance` |
| Receiver | `0x...0a11ce`, one-byte `STOP` contract set on the fork only (stands in for `NavReceiver`) |
| BTC/USD | Chainlink feed `0x56a43EB56Da12C0dc1D972ACb089c06a5dEF8e69` on Arbitrum Sepolia, read live |
| Hyperliquid | live `api.hyperliquid-testnet.xyz/info`, address `0x000...000` (62.804826 USDC, no margin used) |
| Maker, Aqua, bridge | `src/dev-stub.ts` on `127.0.0.1:8787` |

The vault, receiver and the three HTTP services are stand-ins. The mock forwarder, USDC contract, Chainlink feed and Hyperliquid API are real.

## Run 1: healthy margin, one report

```
cd workflows/cre
bun run dev:stub                         # terminal 1
~/.cre/bin/cre workflow simulate nav-attestor --target staging-settings --non-interactive --trigger-index 0
```

```
Workflow compiled
[SIMULATION] Running trigger trigger=cron-trigger@1.0.0
[USER LOG] nav closeId=7 assets=21919831834 liabilities=0 sharePriceE18=21919831834000000000 sourcesHash=0x4718b768...a6ee inTransit=2
[USER LOG] source arc-vault-cash assets=5000000000 trust=onchain
[USER LOG] source solana-maker assets=12000000000 trust=operator-supplied
[USER LOG] source hyperliquid assets=62804826 trust=venue-api
[USER LOG] source aqua assets=4507037008 trust=operator-supplied
[USER LOG] source in-transit assets=349990000 trust=operator-supplied
[USER LOG] kind 1 NavReport written, tx 0x0000...0000
[USER LOG] margin within bands, no top-up intent
Workflow Simulation Result: "nav 21919831834 closeId 7"
```

Checks by hand:
- Aqua: 3000 USDC plus 0.02 WBTC at the live feed price.
- In transit: 250.00 USDC (`burned`) plus 99.99 USDC (`minted`, `netMinted`). The stub also lists the `burned` transfer a second time as `requested` and one `credited` transfer; neither is counted again.
- Total: 5000 + 12000 + 62.804826 + 4507.037008 + 349.99 = 21919.831834 USDC.

## Run 2: margin low, two reports

Hyperliquid served by the stub with account value 1500 and margin used 1000 (15000 bps).

```
bun run dev:stub:margin
~/.cre/bin/cre workflow simulate nav-attestor --target staging-settings --non-interactive --trigger-index 0 --config ./config.margin.json
```

```
[USER LOG] kind 1 NavReport written, tx 0x0000...0000
[USER LOG] intent margin-low route=arc-hypercore amount=1500000000 marginRatioBps=15000 id=0x8fb93ec3...208c
[USER LOG] kind 2 TopUpIntent written, tx 0x0000...0000
Workflow Simulation Result: "nav 23357027008 closeId 7 intent margin-low 1500000000"
```

1500 USDC restores the ratio to exactly 30000 bps.

## Run 3: a source is down, no report

With the stub stopped:

```
workflow execution failed: Get "http://127.0.0.1:8787/v1/maker/equity": dial tcp 127.0.0.1:8787: connect: connection refused
```

The run fails before any `writeReport`, so nothing is attested from partial data.

## Not simulated

- Whether the write succeeds against the real `NavReceiver` once it exists. The simulated receiver only has to accept a call.
- A funded key is not needed for the dry run. A real broadcast on Arc would pay gas in USDC from the key's address; that was not attempted.
- Multi-node consensus. The simulator runs one node, so the median and identical aggregations are only exercised in their single-node form.
- Reads at the finalized block. The simulation config reads `latest` because the fork's finalized block predates the test contracts.
