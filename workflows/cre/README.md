# @noirwire/cre-workflow

Chainlink CRE workflow `nav-attestor`. Every five minutes it reads each leg of the shared market-maker vault, computes NAV and hedge margin health, and writes signed reports to the `NavReceiver` on Arc testnet.

## What it reads

| Leg | Source | Trust label |
| --- | --- | --- |
| `arc-vault-cash` | EVM read on `arc-testnet`: `IERC20(usdc).balanceOf(shareVault)` | `onchain` |
| `solana-maker` | HTTP GET `{maker.apiUrl}/v1/maker/equity` returning `{"equityUsdc6","observedAt"}` | `operator-supplied` |
| `hyperliquid` | HTTP POST `{hyperliquid.infoUrl}` `{"type":"clearinghouseState","user":...}`; `marginSummary.accountValue`, `totalMarginUsed`, `time` | `venue-api` |
| `aqua` | HTTP GET `{aqua.apiUrl}/v1/aqua/inventory` returning `{"usdc6","wbtcE8","observedAt"}`, WBTC valued with the Chainlink BTC/USD feed (EVM read) | `operator-supplied` |
| `in-transit` | HTTP GET `{bridge.apiUrl}/v1/transfers?state=in-flight`, array of the shared `BridgeTransfer` | `operator-supplied` |

Also read from the vault: `currentEpoch()` (the `closeId`) and `totalSupply()` (for the share price). Both ABI fragments are in config (`arc.epochAbiFragment`, `arc.supplyAbiFragment`), as is the block tag (`readAt`: `finalized` or `latest`).

HTTP results go through CRE consensus: numeric fields use `median`, the transfer list uses `identical`. Every node must see the same transfer list or the run fails.

## NAV rules (`src/nav.ts`, pure and unit-tested)

- A transfer counts once and only while in flight: not `requested` (the source leg still holds it) and not in `SETTLED_TRANSFER_STATES`. It is valued at `netMinted` when known, else `grossAmount`. Duplicate ids keep the latest `updatedAt`.
- `observedAt` in the report is the oldest source timestamp.
- The run refuses (throws, writes nothing) when a source is missing, unreadable, or older than `maxSourceAgeSec`; the BTC/USD feed is held to `maxPriceAgeSec`.
- `sharePriceE18 = netAssets6 * 1e12 * 1e18 / shareSupply18`, `1e18` at zero supply.
- `sourcesHash = keccak256(abi.encode(SourceRecord[]))`, records sorted by leg code then `keccak256(account)`, codes from `NAV_LEG_CODES` and `TRUST_CODES` in `@noirwire/shared`.
- Margin: `marginRatioBps = accountValue / totalMarginUsed * 10000`; no intent when margin used is zero. Below 20000 is `margin-low`, below 13000 `margin-urgent` (route `arc-hypercore`), above 40000 `surplus-return` (route `hypercore-arc`). The amount restores 30000 bps, rounded up for top-ups, capped by `bands.maxIntentUsdc6`. `intentId = keccak256(abi.encode(uint64 closeId, uint8 route, uint256 amount, uint8 reason))`.

## Report format (`src/report.ts`)

`report = abi.encode(uint8 kind, bytes body)`, where `body = abi.encode(struct)` with the fields in the order of `docs/interfaces.md`. Kind 1 is `NavReport`, kind 2 is `TopUpIntent` (written only when margin is out of band). Golden hex vectors, produced with Foundry's `cast abi-encode`, are in `src/report.test.ts`.

Known gap: `NavReport` carries no share price. The workflow computes it into the snapshot (and logs it) but the onchain report holds only assets, liabilities, `observedAt` and `sourcesHash`.

## Run it

```
pnpm install                     # at the repo root, then see "Toolchain" below
pnpm --filter @noirwire/cre-workflow test
pnpm --filter @noirwire/cre-workflow check-types
```

Simulation needs `cre login`, an Arc fork with test contracts, and the stub:

```
anvil --fork-url https://rpc.testnet.arc.network --chain-id 5042002 --port 8650
# set test code on the fork for the vault and receiver (see SIMULATION.md)
bun run dev:stub                 # or dev:stub:margin
~/.cre/bin/cre workflow simulate nav-attestor --target staging-settings --non-interactive --trigger-index 0
~/.cre/bin/cre workflow simulate nav-attestor --target staging-settings --non-interactive --trigger-index 0 --config ./config.margin.json
```

`.env` (gitignored) holds `CRE_ETH_PRIVATE_KEY` without the `0x` prefix. Never pass `--broadcast`. Real config values to fill before a deployed run: `arc.shareVault`, `arc.navReceiver`, the maker, bridge and Aqua URLs, and `hyperliquid.user`.

## Simulated versus deployed

| | Simulation | Deployed DON |
| --- | --- | --- |
| Nodes | one; consensus is a single-node pass-through | many; median and identical aggregation really apply |
| Forwarder | mock forwarder `0x6E9EE680...5eDc1` on `arc-testnet` | production `KeystoneForwarder` `0x76c9cf54...8215E62` calls `onReport` after checking DON signatures |
| Write | dry run, empty tx hash, nothing sent | real transaction submitted by the DON (Arc gas is paid in USDC) |
| Receiver checks | none | `NavReceiver` should accept only the forwarder and the expected workflow id and owner |
| Access | `cre login` | needs deploy access (`cre account access`) |

## Toolchain

Install with `pnpm install` at the repo root. `cre workflow simulate` compiles with `cre-compile`, which runs under bun (it must be on `PATH`) and needs the TypeScript 5 compiler API. The repo uses TypeScript 7 elsewhere, so `pnpm-workspace.yaml` gives `@chainlink/cre-sdk` its own `typescript: 5.9.3` through `packageExtensions`. `@chainlink/cre-sdk-javy-plugin` is a direct dev dependency so its `cre-setup` binary is linked for the postinstall step.

To check the build without a simulation: `pnpm exec cre-compile nav-attestor/main.ts <out.wasm>`.

## Layout

```
nav-attestor/main.ts      workflow entry (cron trigger, reads, writes)
nav-attestor/config.*.json   staging (live Hyperliquid) and margin (stubbed Hyperliquid)
src/nav.ts                NAV, hashing, margin bands
src/report.ts             ABI encoding and decoding
src/sources.ts            response parsers
src/config.ts             config schema
src/dev-stub.ts           local maker, Aqua, bridge and Hyperliquid stub
```
