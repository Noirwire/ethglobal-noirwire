# Testnet runbook

From funded testnet wallets to a running system. Follow the steps in order. Each step names what it needs and how to see that it worked.

Nothing here has been run against the live network. Steps marked **never run live** have only been tested locally or simulated. Expect the first live run to find problems, and expect the bridge to leave a transfer in `forwarded` or `stuck` instead of guessing.

The contracts are not audited. Use testnet funds only.

## Before you start

Tools: Node 24 and pnpm 11, Foundry (`forge`, `cast`), the Solana CLI (`solana-keygen`, `spl-token`), the CRE CLI at `~/.cre/bin/cre` with bun, `jq`. Run `make install` once.

Everything below runs from the repo root. Every testnet make target needs `CONFIRM=testnet`. Variables are exported in the shell you run `make` from; the targets pass them on to the process they start.

### Wallets

`make keys-addresses` prints each role and its public address, never the key. Keys live in the macOS login Keychain.

| Role | Used for | Fund it with |
| --- | --- | --- |
| `deployer` | Deploys the Arc contracts. Becomes owner of all three unless `ADMIN` is set. | Arc testnet USDC (Arc pays gas in USDC) |
| `operator` | The bridge's Arc treasury (`ARC_OPERATOR_KEY`), the vault operator, and the Hyperliquid account (`HYPERCORE_ACCOUNT_KEY`, `HL_ACCOUNT_ADDRESS`). | Arc testnet USDC for gas and burns; Hyperliquid testnet USDC for margin |
| `hl-agent` | The hedger's Hyperliquid API wallet. Trades only, cannot withdraw. | Nothing |
| `solana-operator` | The bridge's Solana keypair. Its USDC token account is the bridge's Solana account. | Devnet SOL (about 0.01 per burn) and devnet USDC in its token account |
| `solana-depositor` | A Solana wallet for test deposits. No make target reads it. | Devnet SOL and devnet USDC, if you use it |
| `relayer`, `taker` | No make target or service in this runbook reads them. The `taker` role belongs to the fork-only Aqua bot. | Nothing |

Two things must be true on Hyperliquid before anything else:

1. The `operator` address is an existing Hyperliquid account. The bridge README says it must already exist on Hyperliquid mainnet, and that it needs 1 USDC for its first outbound action. Set by the operator: how you create it.
2. The `hl-agent` address is approved as an API wallet of the `operator` account on Hyperliquid testnet. Set by the operator: approve it in the Hyperliquid testnet web app signed by the operator account. No code in this repo does it.

Useful Arc and Circle facts: Arc testnet RPC `https://rpc.testnet.arc.network`, chain 5042002, USDC `0x3600000000000000000000000000000000000000`. Faucets are Circle's (Arc USDC, Solana devnet USDC) and Hyperliquid's (testnet USDC); the repo does not script them.

### Values you will collect

Write these down as you go. Later steps use them.

| Name | Comes from |
| --- | --- |
| `OPERATOR_ADDR` | `operator` in `make keys-addresses` |
| `SOLANA_OPERATOR_PUBKEY` | `solana-operator` in `make keys-addresses` |
| `SHARE_VAULT`, `NAV_RECEIVER`, `HOOK_EXECUTOR` | Step 1 output, also `contracts/vault/deployments/arc-testnet.json` |
| `BRIDGE_ATA` | Step 2: the token account of `SOLANA_OPERATOR_PUBKEY` for devnet USDC |
| `MAKER_OWNER` | The Solana public key that owns the maker's USDC token account. Set by the operator. |
| `MAKER_ATA` | The maker's USDC token account (devnet mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). Set by the operator. |
| `BRIDGE_API_TOKEN`, `REBALANCE_API_TOKEN` | You choose two different random strings of at least 32 characters |

## 1. Deploy the Arc contracts

Reads: `contracts/vault/script/DeployArcTestnet.s.sol`. It refuses to run on any chain but 5042002.

Environment the script reads:

| Variable | Required | Value |
| --- | --- | --- |
| `TREASURY_EXECUTOR` | yes | `OPERATOR_ADDR`. Allowlisted as the vault's move destination. |
| `WORKFLOW_OWNER` | yes | The address that will deploy the CRE workflow, the same one as `workflow-owner-address` in `workflows/cre/project.yaml`. Set by the operator. |
| `SOLANA_TOKEN_MESSENGER` | yes | The Circle `TokenMessengerMinterV2` Solana program id `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` as 32 bytes of hex (see below) |
| `SOLANA_USDC_MINT` | yes | The devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` as 32 bytes of hex |
| `OPERATOR` | no, defaults to `ADMIN` | `OPERATOR_ADDR`. It must equal the bridge's `ARC_OPERATOR_KEY` address, or the bridge cannot call `moveToVenue`. |
| `MOVE_CAP_PER_CALL` | no, defaults to 0 | USDC base units (6 decimals). At 0 the vault releases nothing. Example `1000000000` is 1000 USDC. |
| `MOVE_CAP_PER_EPOCH` | no, defaults to 0 | USDC base units. Example `5000000000`. |
| `ADMIN` | no, defaults to the deployer | If different, it must call `acceptOwnership` on all three contracts |
| `FEE_RECIPIENT` | no, defaults to `ADMIN` | Address |
| `CRE_FORWARDER` | no | Defaults to the production forwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62` |
| `WORKFLOW_ID`, `WORKFLOW_NAME` | no, default to zero | Leave unset now. The workflow id exists only after step 5. Zero means the receiver does not check them. Step 5 sets them. |

Convert a Solana key to hex, from `services/bridge` (it has `@solana/web3.js`):

```sh
cd services/bridge
node -e 'console.log("0x" + Buffer.from(new (require("@solana/web3.js").PublicKey)(process.argv[1]).toBytes()).toString("hex"))' CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe
```

Do the same for the mint. Whether the program id is the right value for `SOLANA_TOKEN_MESSENGER` against a real attested message has not been checked live.

Dry run first, then send:

```sh
export TREASURY_EXECUTOR=<OPERATOR_ADDR> OPERATOR=<OPERATOR_ADDR> WORKFLOW_OWNER=<address>
export SOLANA_TOKEN_MESSENGER=0x... SOLANA_USDC_MINT=0x...
export MOVE_CAP_PER_CALL=1000000000 MOVE_CAP_PER_EPOCH=5000000000
make deploy-arc-testnet CONFIRM=testnet                 # dry run
make deploy-arc-testnet CONFIRM=testnet BROADCAST=1     # sends
```

The deployer key is on `forge`'s command line for the run. Only a broadcast writes `contracts/vault/deployments/arc-testnet.json`. The script also prints the three addresses.

**Confirm:** `cast call <SHARE_VAULT> "operator()(address)" --rpc-url https://rpc.testnet.arc.network` returns `OPERATOR_ADDR`, and `cast call <SHARE_VAULT> "maxMovePerCall()(uint256)" --rpc-url https://rpc.testnet.arc.network` returns the cap you set.

Status: **never run live.** The script has only run on a local chain (`DeployLocal`) and as a dry run.

## 2. Work out the bridge's Solana token account

The maker sends its surplus to the bridge's Solana token account, and the bridge reports it as `bridgeAta`. It is the token account of `SOLANA_OPERATOR_PUBKEY` for the devnet USDC mint:

```sh
spl-token address --verbose --token 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --owner <SOLANA_OPERATOR_PUBKEY>
```

The account must exist before the first Arc to Solana receive. Create it with `spl-token create-account` if it does not, using a wallet that pays the rent. Set by the operator.

## 3. Start the bridge

`make bridge-testnet-up` starts `services/bridge` in testnet mode. It reads two keys from the Keychain: `operator` as `ARC_OPERATOR_KEY` and `HYPERCORE_ACCOUNT_KEY`, and `solana-operator` as a `/dev/fd` keypair path. You export the rest.

Source of truth: `services/bridge/src/main.ts`, `src/testnet.ts`, `src/intent-watcher.ts`.

Required (the process throws or a route is missing without them):

| Variable | Value |
| --- | --- |
| `BRIDGE_API_TOKEN` | At least 32 characters. Testnet mode refuses to start without it. |
| `HOOK_EXECUTOR` | From step 1. Without it there is no `solana-arc` route. |
| `SHARE_VAULT` | From step 1. Enables vault release and the `hypercore-arc` route. |
| `NAV_RECEIVER` | From step 1. Starts the onchain intent watcher. Needs `SHARE_VAULT`. |
| `REBALANCE_API_TOKEN` | At least 32 characters, different from `BRIDGE_API_TOKEN`. The maker rebalance endpoints exist only when it is set. |
| `REBALANCE_MAKER_OWNER` | `MAKER_OWNER`. Without it there is no `hypercore-solana` route. |
| `DESTINATION_ALLOWLIST` | Comma separated, case insensitive. A transfer to a destination not on it is refused. Include one entry per route destination: `OPERATOR_ADDR` (HyperCore recipient), `SHARE_VAULT`, `HOOK_EXECUTOR`, `BRIDGE_ATA` and `MAKER_ATA`. The last two are base58. |

Optional, with the default in the code:

| Variable | Default |
| --- | --- |
| `BRIDGE_PORT` | 8702 |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| `ARC_USDC` | `0x3600000000000000000000000000000000000000` |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
| `HYPEREVM_RPC_URL` | the HyperEVM testnet RPC in `packages/shared` |
| `IRIS_URL` | `https://iris-api-sandbox.circle.com` |
| `HYPERCORE_RECIPIENT` | the address of `HYPERCORE_ACCOUNT_KEY`, which is `OPERATOR_ADDR` |
| `RETURN_BENEFICIARY` | `OPERATOR_ADDR`. The Arc address credited on a `solana-arc` return. |
| `CORE_DEPOSIT_WALLET` | `0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206` |
| `DAILY_CAP`, `PER_TRANSFER_CAP` | `5000000000`, `1000000000` (USDC base units) |
| `HYPERCORE_MAX_FEE`, `SOLANA_HYPERCORE_MAX_FEE` | `300000` |
| `HYPERCORE_RETURN_MAX_FEE`, `HYPERCORE_SOLANA_MAX_FEE` | `300000` |
| `SOLANA_MAX_FEE`, `SOLANA_ARC_MAX_FEE` | `100000` |
| `INTENT_CONFIRMATIONS` | 2 |
| `INTENT_POLL_MS` | 10000 |
| `INTENT_CURSOR_FILE` | `./data/intent-cursor.json` |
| `INTENT_START_BLOCK` | the current head on a first run. Set it to the deploy block of step 1 to be safe. |
| `BRIDGE_JOURNAL` | `./data/transfers.ndjson` |
| `REBALANCE_JOURNAL` | `./data/rebalance.ndjson` |
| `HYPERCORE_SOURCE_DEX` | perps. Set `spot` to withdraw from spot. |
| `HYPERCORE_RETURN_GAS_LIMIT` | 200000 |
| `HYPERCORE_DEBIT_LEDGER_TYPES`, `HYPERCORE_CREDIT_LEDGER_TYPES`, `HYPERCORE_CREDIT_COUNTERPARTY`, `HYPERCORE_AMOUNT_TOLERANCE` | see `services/bridge/README.md`. Leave the defaults for the first run, then check them against the real ledger. |

`INTENT_FILE` is ignored in testnet mode. The data files are relative to `services/bridge`.

Fund the maker side before you start: `OPERATOR_ADDR` needs Arc USDC, `solana-operator` needs devnet SOL and USDC (see the wallet table).

```sh
export BRIDGE_API_TOKEN=... REBALANCE_API_TOKEN=...
export HOOK_EXECUTOR=0x... SHARE_VAULT=0x... NAV_RECEIVER=0x...
export REBALANCE_MAKER_OWNER=<MAKER_OWNER>
export DESTINATION_ALLOWLIST=<OPERATOR_ADDR>,<SHARE_VAULT>,<HOOK_EXECUTOR>,<BRIDGE_ATA>,<MAKER_ATA>
export INTENT_START_BLOCK=<deploy block>
make bridge-testnet-up CONFIRM=testnet
```

**Confirm:**

- `.run/bridge-testnet.log` prints `bridge listening on 8702` and `watching NavReceiver for top-up intents every 10000 ms`.
- `curl -s localhost:8702/v1/transfers` returns `[]`.
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8702/v1/intents` returns `401`.
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $REBALANCE_API_TOKEN" -H 'content-type: application/json' -d '{}' localhost:8702/v1/rebalance/requests` returns `400` or `422`, not `404`. `404` means the rebalance endpoints are off.

Status: **never run live.** The watcher, vault release and rebalance API run locally against anvil. No testnet burn has been sent.

## 4. Start the hedger

`make hedger-testnet-up` starts `services/hedger` in testnet mode with the `hl-agent` key from the Keychain as `HL_AGENT_PRIVATE_KEY`.

Source of truth: `services/hedger/src/config.ts`, `README.md`, `.env.example`.

| Variable | Value |
| --- | --- |
| `HL_ACCOUNT_ADDRESS` | Required. `OPERATOR_ADDR`, the Hyperliquid master account. |
| `BOOK_API_URL` | Required. Base URL of the maker's HTTP API, which serves `/v1/maker/position` and `/v1/tape`. Set by the operator: it is the address where you host the market maker (step 6). |
| `HEDGE_ENABLED` | The make target defaults it to `0`: observe only, no orders. Export `1` to hedge. Anything but `0` or `1` is refused. |
| `HOUSE_MAKER_TAG` | Optional decimal string. Without it no fill events are published, but hedging from the polled position still works. |

Other optional settings (`BOOK_MARKET`, `HEDGE_COIN`, `DEADBAND_BTC8`, `MAX_ORDER_BTC8`, `PRICE_BAND_BPS`, `SOFT_LIMIT_USD`, `HARD_LIMIT_USD`, `HEDGE_LEVERAGE_TARGET`, `INITIAL_MAKER_POSITION_BTC8`, `HTTP_PORT` (8701), `TICK_MS`, the journal and cursor paths) are in `services/hedger/.env.example`.

Start with `HEDGE_ENABLED=0`, check the status, then restart with `1`.

```sh
export HL_ACCOUNT_ADDRESS=<OPERATOR_ADDR> BOOK_API_URL=https://...
make hedger-testnet-up CONFIRM=testnet
```

**Confirm:** `curl -s localhost:8701/status` returns JSON. With the maker running and reachable the status leaves `blind` within seconds. `blind` with `hold:maker-position-unknown` in `.run/hedger-testnet.log` means `BOOK_API_URL` is wrong or the maker is down. A margin ratio is read from the real Hyperliquid account.

Status: **never run live for orders.** The first live order has not been placed. The Hyperliquid mapping is tested against a fake client only. `HEDGE_ENABLED=0` reads the real testnet account.

### Steps 3 and 4 in one command

Once the variables for steps 3 and 4 are exported:

```sh
make testnet-up CONFIRM=testnet
```

It checks that `BRIDGE_API_TOKEN`, `REBALANCE_API_TOKEN`, `HOOK_EXECUTOR`, `SHARE_VAULT`, `NAV_RECEIVER`, `DESTINATION_ALLOWLIST`, `REBALANCE_MAKER_OWNER`, `HL_ACCOUNT_ADDRESS` and `BOOK_API_URL` are set, names any that are missing, and then runs `bridge-testnet-up` and `hedger-testnet-up`. It starts nothing if one is missing. `make status` shows the PIDs and `make down` stops what make started.

## 5. Configure and deploy the CRE workflow

Files: `workflows/cre/nav-attestor/config.staging.json`, `workflows/cre/nav-attestor/workflow.yaml`, `workflows/cre/project.yaml`, `workflows/cre/README.md`, `workflows/cre/SIMULATION.md`.

`config.staging.json` ships with placeholder addresses and `127.0.0.1` URLs. Replace:

| Field | Value |
| --- | --- |
| `arc.shareVault` | `SHARE_VAULT` |
| `arc.navReceiver` | `NAV_RECEIVER` |
| `arc.chainName` | `arc-testnet` (already set) |
| `hyperliquid.user` | `OPERATOR_ADDR`. `infoUrl` is already the testnet info API. |
| `maker.apiUrl` | A public `http(s)` URL of the maker serving `GET /v1/maker/equity`. Set by the operator. |
| `bridge.apiUrl` | A public `http(s)` URL of the bridge serving `GET /v1/transfers?state=in-flight`. Set by the operator. |
| `aqua.apiUrl` | A public `http(s)` URL serving `GET /v1/aqua/inventory`. Set by the operator. See the note below. |
| `readAt` | `finalized` for a deployed run. The simulation used `latest`. |
| `bands`, `schedule`, `maxSourceAgeSec`, `maxPriceAgeSec` | Leave unless you have a reason. |

The nodes of a DON cannot reach `127.0.0.1`. Every `apiUrl` must be reachable from the internet. Put the services behind a tunnel or a host you control, and protect them as you see fit: the bridge's GET routes are public, and the workflow sends no secret.

The Aqua leg has no testnet deployment. `services/aqua-taker` reads a local Arbitrum fork and listens on `127.0.0.1` only. For a run on testnets you must either expose that service at a public URL (a fork-backed number, not a real balance) or accept that the workflow throws at that read and writes nothing. Set by the operator.

`project.yaml` has `workflow-owner-address`. It must equal `WORKFLOW_OWNER` from step 1. Its `rpcs` block points `arc-testnet` at a local fork on `127.0.0.1:8650`, which only `cre workflow simulate` uses. Point it at `https://rpc.testnet.arc.network` to simulate against the live chain.

The CRE account key goes in `workflows/cre/.env` as `CRE_ETH_PRIVATE_KEY` without the `0x` prefix. This file is gitignored. It is not one of the Keychain roles.

Order:

1. Simulate with the real config. Never pass `--broadcast` until you mean it.
   ```sh
   cd workflows/cre
   ~/.cre/bin/cre login
   ~/.cre/bin/cre workflow simulate nav-attestor --target staging-settings --non-interactive --trigger-index 0
   ```
   Expected: `source` lines for five legs, `kind 1 NavReport written`, with a dry-run tx hash of zeros.
2. Deploy to a DON: `~/.cre/bin/cre workflow deploy nav-attestor --target staging-settings`. This needs deploy access on your CRE account (`cre account access`). Note the **workflow id** it prints.
3. Tell the receiver which workflow to trust. Run as the deployer (the contract owner):
   ```sh
   bash scripts/keychain.sh run -e DEPLOYER_KEY=deployer -- bash -c 'cast send <NAV_RECEIVER> "setWorkflowIdentity(bytes32,address,bytes10)" <WORKFLOW_ID> <WORKFLOW_OWNER> <WORKFLOW_NAME_10_BYTES> --rpc-url https://rpc.testnet.arc.network --private-key "$DEPLOYER_KEY"'
   ```
   `WORKFLOW_NAME_10_BYTES` is the 10 byte name value CRE puts in the report metadata. Set by the operator: this repo does not say how the CLI derives it. Use `0x00000000000000000000` to skip that check.

**Confirm:** after the next five minute tick, `NavReportReceived` logs appear on `NAV_RECEIVER`, for example `cast logs --address <NAV_RECEIVER> --rpc-url https://rpc.testnet.arc.network`, and the vault's `lastSettledAt()` moves once an epoch settles.

Status: **never run live.** The workflow compiles and simulates against stand-ins. It has never been deployed to a DON, never written to the real `NavReceiver`, and the multi-node consensus is untested. `cre workflow deploy` is unverified.

## 6. Run the market maker with rebalancing

The Solana market maker is a separate repository, `sim-noirwire`. This repo does not start or change it. Its README documents the rebalance feature. Read its `src/config/config.ts` for the full list.

Rebalancing is off unless `REBALANCE_URL` is set. It needs `VENUE=rollup`, and `NETWORK=mainnet` refuses to start with any `REBALANCE_*` variable set.

| Variable | Value |
| --- | --- |
| `REBALANCE_URL` | Required to turn it on. The public base URL of the bridge from step 3. |
| `REBALANCE_TOKEN` | Required. The bridge's `REBALANCE_API_TOKEN`. |
| `REBALANCE_BRIDGE_ATA` | Required. `BRIDGE_ATA` from step 2. |
| `REBALANCE_VALIDATOR` | Required. The rollup validator the transfer back to Solana names. Set by the operator. |
| `REBALANCE_STEP_USDC` | Default 25 |
| `REBALANCE_MAX_REQUEST_USDC` | Default 500 |
| `REBALANCE_URGENT_BPS`, `REBALANCE_LOW_BPS`, `REBALANCE_TARGET_BPS`, `REBALANCE_SURPLUS_BPS` | Defaults 12000, 15000, 22000, 35000. They must rise in that order. |
| `REBALANCE_COOLDOWN_MS` | Default 1800000 |
| `REBALANCE_CHECK_MS` | Default 30000 |

The maker's HTTP API (default port 4100) serves `GET /v1/maker/position` for the hedger (`BOOK_API_URL`) and `GET /v1/maker/equity` for the CRE workflow (`maker.apiUrl`). Both point at the same host.

**Confirm:** the maker logs a request id when equity crosses a band, and `curl -s localhost:8702/v1/rebalance/requests/<id>` on the bridge shows its `state`.

Status: **never run live.** A transfer in lands in the maker's own token account and reports `wallet-credited`, which the maker does not count as credited. The deposit into the order book seat is not built. Whether Circle's HyperCore path accepts Solana as a destination is unconfirmed.

## 7. Start the web app

`make web-up` runs `next dev` for `apps/web` on port 3000. Put the values in `apps/web/.env.local`; copy `apps/web/.env.example` first. The browser never calls a service; the Next.js server does.

| Variable | Value |
| --- | --- |
| `HEDGER_URL` | Hedger base URL. Default `http://127.0.0.1:8701`. |
| `BRIDGE_URL` | Bridge base URL. Default `http://127.0.0.1:8702`. |
| `BRIDGE_API_TOKEN` | Must equal the bridge's value. Server only, never `NEXT_PUBLIC`. |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.network` (the default is the local chain) |
| `NAV_RECEIVER_ADDRESS` | `NAV_RECEIVER`. Without it the proof page says "not connected". |
| `NAV_FROM_BLOCK` | The deploy block of step 1 |
| `NAV_SNAPSHOT_URL` | Optional. A URL serving the published NAV snapshot JSON. Set by the operator. |
| `RESIDUAL_BAND_BTC` | Optional, default `0.01` |
| `NEXT_PUBLIC_ARC_CHAIN_ID` | `5042002` |
| `NEXT_PUBLIC_ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| `NEXT_PUBLIC_SHARE_VAULT_ADDRESS` | `SHARE_VAULT`. Without it the Arc deposit door says it is not configured. |
| `NEXT_PUBLIC_ARC_USDC_ADDRESS` | `0x3600000000000000000000000000000000000000` |

```sh
make web-up
```

Status: the pages run locally. The Solana deposit has not been signed by a wallet on devnet.

## 8. Put USDC in the vault

The bridge can only release idle vault USDC, and only within the caps from step 1. A depositor requests a deposit with the web app's Arc door (or `ShareVault.requestDeposit` directly). The deposit becomes shares at the next settled epoch, so step 5 must be running first. Set by the operator: how much to deposit.

Status: **never run live.**

## Checklist

Tick each line in order. Do not move on while one is red.

- [ ] `make keys-addresses` shows all six roles you need as addresses, not `not set`
- [ ] Operator is a Hyperliquid account; `hl-agent` is approved as its API wallet
- [ ] Arc and Solana wallets are funded as in the wallet table
- [ ] Deploy dry run printed three addresses; broadcast wrote `contracts/vault/deployments/arc-testnet.json`
- [ ] `operator()` on the vault returns `OPERATOR_ADDR`; the move caps are non-zero
- [ ] Bridge log: `bridge listening on 8702` and `watching NavReceiver for top-up intents`
- [ ] Bridge: `POST /v1/intents` without a token returns 401; the rebalance endpoint is not 404
- [ ] Hedger: `GET :8701/status` returns JSON and is not `blind`
- [ ] Maker: `/v1/maker/position` and `/v1/maker/equity` answer from a public URL
- [ ] CRE simulation prints five sources and a `kind 1` report
- [ ] CRE workflow deployed; `setWorkflowIdentity` sent
- [ ] `NavReportReceived` appears on `NAV_RECEIVER` within ten minutes
- [ ] Web `/nav` shows the onchain totals, `/` shows the hedger, `/flow` lists bridge transfers
- [ ] A small deposit is settled into shares at the next epoch
- [ ] `HEDGE_ENABLED=1` only after the status has been stable and the account has margin
- [ ] A top-up completes. A vault route takes intents only from `NavReceiver`, so wait for the CRE workflow to see margin out of band. In `GET :8702/v1/transfers` look for `released: true`, then `credited`

## Stop

`make down` stops exactly the processes make started, including `bridge-testnet`, `hedger-testnet` and `web`. It does not touch the market maker, the CRE workflow or tunnels you started yourself. Remove a deployed CRE workflow with the CRE CLI.

## What has never run live

- The Arc testnet deploy broadcast
- Any CCTP burn from the bridge, on any of the six routes
- Circle's HyperCore forwarding, the ledger types it produces and its fee quote
- The bridge's vault release (`moveToVenue`) and return (`acknowledgeReturn`) on Arc testnet
- The first Hyperliquid order from the hedger
- The CRE workflow on a DON, and the receiver accepting its report
- The maker's rebalance requests against the live bridge
- The Aqua leg on any public network
