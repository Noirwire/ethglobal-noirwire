# @noirwire/hedger

Keeps a house market maker's net BTC exposure near zero. The maker quotes `NBTC-PERP` on a private order book; every fill moves its position. The hedger trades the opposite side of the BTC perp on Hyperliquid (testnet coin `BTC`) with IOC limit orders, each carrying a 16 byte client order id (cloid).

```
net exposure = makerPosition + hyperliquidPosition + aquaInventory
target hedge = -(makerPosition + aquaInventory)
delta        = target hedge - hyperliquidPosition
```

All sizes are integer BTC base units (8 decimals, bigint internally). Positions are signed, long is positive. A maker `buy` fill adds to the maker position, so the hedge is a sell (`hedgeSideFor` in `@noirwire/shared`).

## Run the local demo (no network)

```sh
pnpm install
pnpm --filter @noirwire/hedger start
```

`HEDGER_MODE=mock` and `FILL_SOURCE=replay` are the defaults. A scripted sequence of eight maker fills runs against the deterministic mock venue, with injected faults: a half filled order, a margin rejection, an order that filled while the call timed out and the cancel failed, and stale position reads. It prints each event, then the final status, and exits. Set `KEEP_ALIVE=1` to keep the HTTP server up afterwards. Events are appended to `data/hedger-events.ndjson` (override with `EVENTS_FILE`).

HTTP on port 8701 (CORS for `http://localhost:3000`): `GET /status` returns the status JSON, `GET /events` streams `FlowEvent` objects as server-sent events (backlog first). No account identifiers are published.

## Tests

```sh
pnpm --filter @noirwire/hedger test
pnpm --filter @noirwire/hedger check-types
HL_TESTNET_READ=1 pnpm --filter @noirwire/hedger test   # adds a read-only call to the testnet info endpoint
```

## Status model

| Status | Meaning |
| --- | --- |
| `hedged` | A fresh venue read showed unhedged notional below the soft limit within `CONFIRM_MAX_AGE_MS` |
| `lagging` | Venue is readable but the last confirmation is older than that, or exposure is between the soft and hard limits |
| `blind` | No venue read (or no fill source poll) for `BLIND_AFTER_MS`, including before the first read at startup |
| `halted` | Unhedged notional at or above the hard limit, a manual `halt()`, or the reference price expired |

Rules that matter:

- The confirmation time is refreshed on any tick where a fresh venue read shows unhedged notional below the soft limit, whatever the decision was. Holding an order because it is below the venue minimum size does not turn the status stale.
- The reference price used for notional expires after `REFERENCE_MAX_AGE_MS`. While expired, exposure is treated as exactly the hard limit (status `halted`). By default the reference is the venue mark, so it only expires when the venue is unreachable.
- Margin room for a hedge is computed at the venue mark from the same tick's account read, never at the reference price.

`makerQuotePolicy(status, makerPosition)` (exported from `src/policy.ts`) is what the maker should obey:

| Status | Flat maker | Maker with a position |
| --- | --- | --- |
| `hedged` | normal | normal |
| `lagging` | thin (25% size) | thin |
| `blind` | quote normally but thin | reduce-only |
| `halted` | stop quoting | reduce-only |

## Order flow and reconciliation

Each tick, in this order: read venue position and account, THEN poll the fill source and apply fills to the maker position (so a fill landing between the reads is reflected), read Aqua inventory, reconcile unresolved orders, compute status, decide.

1. Compute the delta. Hold if `|delta|` is below `max(deadband, venue minimum size)`.
2. Limit price is the venue mark moved by `PRICE_BAND_BPS` in the aggressive direction, rounded to Hyperliquid rules (5 significant figures, at most `6 - szDecimals` decimals, integers always valid; buys round up, sells round down). Sizes round down to `szDecimals`.
3. Size is capped by `MAX_ORDER_BTC8`, halved when the margin ratio is urgent, halved again after each margin rejection, and limited so gross notional at the mark stays within 5x account value. The part of an order that reduces the position is never capped.
4. The intent (cloid, side, size, price, position before) is appended to the journal and fsynced BEFORE the order is sent. Then the outcome is journaled.
5. If `placeIoc` throws, the outcome is unknown. The order is marked `unresolved`, a cancel is attempted, and the venue is asked via `orderStatusByCloid` (then `fillsSince`). A final status settles it. An order still `open` whose cancel failed stays `unresolved`. An order the venue does not know stays `unresolved` until `UNKNOWN_ORDER_GRACE_MS` has passed since the intent, then it is settled as not placed. Nothing is ever resent with the same delta while any order is unresolved: unresolved orders block all new orders.
6. After a fill the controller expects the venue position to become `positionBefore + filled`. If a read still shows `positionBefore` (stale), it trades on the expected value and places nothing until the read confirms, for up to `staleReadTolerance` (3) reads, then trusts the read.
7. Rejections and no-match results back off exponentially (`backoffBaseMs` doubling to `backoffMaxMs`); margin rejections also halve the order cap until fills succeed again.

On startup the journal is replayed (maker position is the sum of journaled fills plus `INITIAL_MAKER_POSITION_BTC8`), and every unresolved cloid is reconciled against the venue before any order is placed. A partially written final journal line is ignored.

Fills for any market other than the configured one are ignored. Duplicate fill ids are applied once.

## Margin bands

`marginRatioBps = accountValue / totalMarginUsed * 10000`. A `TopUpIntent` `FlowEvent` is published on entering a band and at most every 5 minutes while it persists:

- under 20000: `margin-low`, route `arc-hypercore`
- under 13000: `margin-urgent`, same route, and the max order size is also halved
- over 40000: `surplus-return`, route `hypercore-arc`, capped at withdrawable

Amounts aim for an account value that gives the hedge leverage target (`HEDGE_LEVERAGE_TARGET`, 3 to 5, default 4) on the current position, and at least a 30000 bps ratio. `closeId` is the hour bucket of the wall clock and `intentId` is a keccak of reason, route, bucket and amount.

## Guards

- The controller refuses to construct for any market that is not `BTC-PERP` or `NBTC-PERP`, and any venue coin other than `BTC`.
- `HEDGE_ENABLED` must be exactly `0` or `1`. In testnet mode it has no default. `0` observes only (fills, venue reads, status, events; no orders). `1` in testnet mode without `HL_ACCOUNT_ADDRESS` and `HL_AGENT_PRIVATE_KEY` fails at start with a clear message.

## Configuration

See `.env.example`. Keys only come from the environment; this service never reads key files. Key variables: `HEDGER_MODE` (`mock|testnet`), `FILL_SOURCE` (`replay|tape`), `HEDGE_ENABLED`, `BOOK_MARKET`, `BOOK_API_URL`, `HL_ACCOUNT_ADDRESS`, `HL_AGENT_PRIVATE_KEY`, `DEADBAND_BTC8`, `MAX_ORDER_BTC8`, `PRICE_BAND_BPS`, `SOFT_LIMIT_USD`, `HARD_LIMIT_USD`, `HTTP_PORT`.

The tape source polls `GET {BOOK_API_URL}/v1/tape?market=NBTC-PERP&since=<cursor>` and persists the cursor in `CURSOR_FILE`. The row shape is isolated in `mapTapeRow` (`src/sources/tape.ts`).

## Running against Hyperliquid testnet

1. A Hyperliquid testnet account funded with testnet USDC (the master account that holds the funds).
2. An API (agent) wallet approved by that account. The agent key can trade but cannot withdraw. Export it, never commit it:
   `export HL_AGENT_PRIVATE_KEY=0x...` and `export HL_ACCOUNT_ADDRESS=0x<master account>`.
3. `HEDGER_MODE=testnet HEDGE_ENABLED=1 FILL_SOURCE=tape BOOK_API_URL=... pnpm --filter @noirwire/hedger start`.

Order signing uses the agent key; positions, fills and order status are read for the master account address. The first live order has not been exercised by this code; all order paths are covered against the mock venue and a fake client for the Hyperliquid mapping.

## Layout

- `src/controller.ts` decision loop, reconciliation, status
- `src/venue/` `MockVenue` and `HyperliquidVenue`
- `src/sources/` tape and replay fill sources
- `src/journal.ts` append-only NDJSON journal and replay
- `src/hl-rules.ts` price and size rounding
- `src/margin.ts`, `src/policy.ts`, `src/events.ts`, `src/aqua.ts`
