# @noirwire/bridge

Treasury bridge and executor. Moves USDC between the Arc vault, the Solana maker account and the Hyperliquid hedge account with Circle CCTP V2, and publishes every transfer with its attester so the NAV attestor can count funds in transit.

```
pnpm --filter @noirwire/bridge test          # unit + local integration (needs anvil + forge build output)
pnpm --filter @noirwire/bridge check-types
pnpm --filter @noirwire/bridge start         # HTTP API on :8702 (testnet wiring, env below)
pnpm --filter @noirwire/bridge local-e2e     # anvil run: solana-arc through HookExecutor
BRIDGE_SOLANA_CLONE=1 pnpm --filter @noirwire/bridge exec vitest run test/solana-local.test.ts
```

## Routes

| Route | Source | Destination | How funds land |
| --- | --- | --- | --- |
| `solana-arc` | Solana (5) | Arc (26) | `depositForBurnWithHook`, mintRecipient and destinationCaller are the Arc `HookExecutor`; we call `HookExecutor.relay(message, attestation)`. Result is `vault-credited` or `claimable`. |
| `arc-solana` | Arc (26) | Solana (5) | EVM `depositForBurn`, then `receive_message` on Solana. Credited when the Solana mint confirms. |
| `arc-hypercore` | Arc (26) | HyperEVM (19) then HyperCore | Burn to the Circle `CctpForwarder` with the `cctp-forward` hook; Circle's forwarding service mints and forwards. `forwarded` is set from the Iris `forwardState`, `credited` only after a Hyperliquid info API read shows the balance rose by the net amount. |
| `hypercore-arc` | HyperCore | Arc | One user-signed `sendToEvmWithData` action (`src/hyperliquid-withdraw.ts`, `src/hypercore-arc.ts`) POSTed to the Hyperliquid exchange with `data` `0x`, so Circle's forwarding service mints on Arc to the `ShareVault`; the generic return step then calls `acknowledgeReturn`. Needs `HYPERCORE_ACCOUNT_KEY` and `SHARE_VAULT`. |

`hypercore-arc` signs the EIP-712 digest directly because viem rejects the primary type name `HyperliquidTransaction:SendToEvmWithData` (it contains a colon). Before the POST the nonce is journaled durably (`withdraw` step: `armed`, then `sent`, then `done` once the HyperEVM `DepositForBurn` log is found). On restart an `armed` record is looked up in the HyperCore ledger first; if absent the same nonce is sent again, which Hyperliquid de-duplicates, and a new nonce is never chosen automatically. An error answer to a re-sent action stays pending.

Unconfirmed until one live run: the forwarding fee quote (Iris `forwardFee.med`), the ledger `type` of the debit (`HYPERCORE_DEBIT_LEDGER_TYPES`) and of the credit (`HYPERCORE_CREDIT_LEDGER_TYPES`, default `spotTransfer` from `HYPERCORE_CREDIT_COUNTERPARTY`, default the CoreDepositWallet), the amount tolerance (`HYPERCORE_AMOUNT_TOLERANCE`, default 1 USDC), the gas limit (`HYPERCORE_RETURN_GAS_LIMIT`, 200000), the source dex (`HYPERCORE_SOURCE_DEX`, `spot` or perps by default), and the `DepositForBurn` mint recipient (the bridge accepts the vault in `mintRecipient` or in `hookData`). `HYPERCORE_RECIPIENT` defaults to the address of `HYPERCORE_ACCOUNT_KEY`. Add the `ShareVault` to `DESTINATION_ALLOWLIST`.

`arc-hypercore` credit is confirmed by a matching ledger entry; an `accountValue` rise alone only changes the pending reason. This is pending one live confirmation of the ledger type.

Routes that release from the vault (`arc-hypercore` while `SHARE_VAULT` is set) accept intents only from the onchain watcher: `POST /v1/intents` answers 403 and `INTENT_FILE` lines are skipped. `INTENT_FILE` is read in local mode only.

## Automatic rebalancing

The loop from the Chainlink workflow to the money moving needs no operator.

1. The workflow writes a kind 2 report; `NavReceiver` emits `TopUpIntentRecorded`.
2. The onchain intent watcher (`src/intent-watcher.ts`) polls the receiver's logs from a cursor file, only up to `head - INTENT_CONFIRMATIONS`, and submits each decoded event to the executor. The cursor is written to a temp file, fsynced, renamed and the directory fsynced, and only after the page of events has been handled. A first run with no cursor starts at the current head (or `INTENT_START_BLOCK`); a corrupt cursor stops the watcher instead of guessing.
3. The executor keys every transfer on its `intentId` (`<intentId>:<chunk>`), so a replayed log, a restart or the same event seen twice returns the transfers that already exist and moves nothing again. A malformed log is skipped and counted. An intent the bridge cannot serve (no adapter for the route, a cap, the allowlist) is recorded as a `failed` transfer with the reason, for example `route not available: route hypercore-arc is not supported`, so it is visible and a replay does not retry it. Refused records do not use up the daily cap.
4. For `arc-hypercore`, before each chunk is burned the bridge calls `ShareVault.moveToVenue(<bridge Arc treasury>, amount)` (`src/vault.ts`). The treasury address is the address of `ARC_OPERATOR_KEY`, which must be the vault's operator and be on its destination allowlist. If the simulation shows the vault would revert (per-call cap, per-epoch cap, not enough idle assets, not allowlisted), the transfer goes to `failed` with `vault refused the release: <reason>`, it is logged, nothing is burned and it is never retried. Later chunks of a split intent are released only when their turn comes.
5. For a transfer whose route destination is the vault address, the last step after `minted` is `ShareVault.acknowledgeReturn(net amount)`, then `credited`. It is generic: a new return adapter only has to mint to the vault and set the route destination to the vault address. The `hypercore-arc` adapter itself is not built here, so intents on it end as `route not available`.

### Crash safety

Each vault call is journaled as `armed` (fsynced, with the block number) before the transaction is sent, then as `sent` with the tx hash (fsynced), then `done` after the receipt. On restart, `armed` without a hash is resolved by checking that the operator has no pending transactions and then looking for the `MovedToVenue` or `ReturnAcknowledged` event since the armed block that no other transfer has claimed: found means it is adopted, not found means it never left and is sent now. `sent` is resolved from the receipt of the recorded hash. A failure to learn the outcome is reported as pending and retried on the next tick, never guessed.

### Money in flight

`moveToVenue` lowers the vault ledger and the NAV vault cash leg at once, while the USDC sits in the bridge wallet until the burn. For vault funded routes the transfer endpoint therefore adds `released: true|false` to each transfer. The NAV workflow counts a transfer that is `requested` and `released` as in transit, never one that is `released: false`, so the sum vault cash + in transit + destination is the same at every step. The flag is absent on routes that do not release from the vault, where the old rule (not counted until burned) applies. `test/rebalance.test.ts` checks the sum after every step.

## States

`requested` -> `burned` -> `attested` -> `minted` | `hook-executed` | `forwarded` -> `vault-credited` | `claimable` | `credited`; any open state can go to `stuck` (timeout) or `failed`. Legal transitions per route live in `src/transfers.ts`.

- The journal is append-only NDJSON (`BRIDGE_JOURNAL`, default `./data/transfers.ndjson`) and is replayed on start. A torn last line is ignored.
- Transfers are idempotent by `transferId` (`<intentId>:<index>`). Once attested a transfer is bound to its CCTP message hash, and a hash cannot belong to two transfers.
- `inFlight()` is every transfer not in `SETTLED_TRANSFER_STATES`, each counted once. A stuck transfer stays in flight.
- Burns are armed in the journal before the transaction is sent. A transfer that has a burn tx, or whose burn outcome is unknown after a crash, is never burned again; it is re-polled, or reported pending for the operator to check on chain.
- A stuck transfer resumes in the state it timed out in (`stuckRetryMs`).
- HyperCore credit never infers success from silence: no balance rise means it stays `forwarded` and shows up in the executor's pending list. HyperCore chunks are sent one at a time so one deposit cannot credit two transfers.

## Trust labels

Every transfer carries `attester`: `circle-iris` when the Iris client signs off, `local-test-attester` when `LocalAttester` signed it (65 byte r,s,v signatures over keccak256(message), signers ascending by address). A transfer signed locally is never shown as a Circle transfer.

## HTTP API (port 8702)

- `GET /v1/transfers?state=in-flight` array of `BridgeTransfer` (the NAV attestor reads this), with `released` on vault funded routes; other `state` values filter, none lists all
- `GET /v1/transfers/:id`
- `POST /v1/intents` body is a `TopUpIntent`; 202 with the created transfers, 400 invalid, 422 rejected by policy
- `GET /events` server-sent `FlowEvent` of kind `transfer`

Every POST requires `Authorization: Bearer <BRIDGE_API_TOKEN>` (constant-time compare, 401 otherwise); GETs stay public. Testnet mode refuses to start without `BRIDGE_API_TOKEN` (at least 32 characters). Local mode allows it unset, in which case POSTs are open and the startup log says so. The web server sends the same value from its own `BRIDGE_API_TOKEN` env; never expose it to the browser.

Intents also arrive from a FlowEvent NDJSON file (`INTENT_FILE`), polled every 5 s; only `kind: "intent"` lines are used.

## Policy

Per-transfer cap (HyperCore hard max 1000 USDC, larger amounts are split), daily cap (UTC day, all or nothing, derived from the journal so it survives restarts), and a destination allowlist (`DESTINATION_ALLOWLIST`, comma separated, case insensitive). An intent that breaks a rule creates nothing.

## Local mode

`BRIDGE_NETWORK=local pnpm start` (or `make bridge-up`) runs the HTTP service against a local anvil that already holds the `make deploy-local` deployment. The `solana-arc` route and a local `arc-hypercore` route are wired; the local `arc-hypercore` burn is an ERC-20 transfer to a fixed sink address, and the vault release and the `NavReceiver` watcher use the addresses in `deployments/local.json`. The attester is the generated `LocalAttester` (registered on the mock transmitter at start), so every transfer is labelled `local-test-attester`. Testnet is the default and is unchanged.

| Env | Meaning |
| --- | --- |
| `BRIDGE_NETWORK` | `testnet` (default) or `local` |
| `ARC_RPC_URL` | local node, default `http://127.0.0.1:8545`; the chain id is read from the node and must match `contracts/vault/deployments/local.json` |
| `BRIDGE_PORT` | HTTP port, default 8702 (both modes) |
| `INTENT_CONFIRMATIONS`, `INTENT_POLL_MS`, `INTENT_CURSOR_FILE`, `INTENT_START_BLOCK` | watcher settings, see the testnet table (both modes) |
| `BRIDGE_LOCAL_STEP_MS` | pause per step so a transfer is visibly walking, default 1000 |

`POST /v1/dev/deposit` (local mode only, 404 otherwise) with an optional body `{"amount": "<base units>"}` (default 7500000) simulates one Solana to Arc deposit and returns 202 with the transfer and the credited beneficiary. Poll `GET /v1/transfers` to watch `burned`, `attested`, `hook-executed`, `vault-credited`.

## Local vs testnet

Local (no network writes):

- EVM: `src/local-e2e.ts` uses `contracts/vault/deployments/local.json` when it exists and has code on the node, otherwise deploys MockUSDC, MockMessageTransmitterV2, ShareVault and HookExecutor from `contracts/vault/out` onto the local anvil (default `:8545`, `LOCAL_RPC` to change). It builds a Solana-sourced burn message, signs it with a generated `LocalAttester` key (registered on the mock transmitter by its owner), relays through `HookExecutor`, and asserts the vault holds the deposit request for the beneficiary. The vitest wrapper starts its own anvil on `:8548`. The source burn is synthesized, because there is no local Solana burn feeding an EVM mock.
- Solana: `src/solana-local.ts` starts `solana-test-validator` with `--clone-upgradeable-program` for both CCTP V2 programs and `--clone` for their state PDAs from devnet (read-only), overrides the MessageTransmitter state with `--account` so the enabled attester is a local key, then runs a real `receive_message` (mints USDC) and a real `deposit_for_burn_with_hook`, and decodes the emitted message. Needs outbound read access to the devnet RPC and takes about 5 s. Gated by `BRIDGE_SOLANA_CLONE=1`.

Testnet (the operator's first real burn): nothing in the test suite sends to a public network. `src/main.ts` wires the real adapters from env.

| Env | Meaning |
| --- | --- |
| `ARC_OPERATOR_KEY` | EVM key for burns and relays on Arc (required) |
| `ARC_RPC_URL`, `ARC_USDC`, `HOOK_EXECUTOR` | Arc RPC (default `https://rpc.testnet.arc.network`), USDC (default `0x3600...0000`), deployed HookExecutor |
| `SOLANA_KEYPAIR_PATH`, `SOLANA_RPC_URL` | JSON keypair file for the Solana maker, devnet RPC |
| `SHARE_VAULT` | Arc `ShareVault`. Set it and `arc-hypercore` chunks are released from the vault before the burn. `ARC_OPERATOR_KEY` must be the vault operator and its address must be allowlisted on the vault with non-zero caps |
| `NAV_RECEIVER` | Arc `NavReceiver`. Set it (requires `SHARE_VAULT`) to start the onchain intent watcher |
| `INTENT_CONFIRMATIONS` | blocks to wait before reading a log, default 2 |
| `INTENT_POLL_MS` | poll interval, default 10000 |
| `INTENT_CURSOR_FILE` | durable cursor, default `./data/intent-cursor.json` |
| `INTENT_START_BLOCK` | first block on a run with no cursor file, default the current head |
| `HYPERCORE_RECIPIENT` | HyperCore account (EVM address) that receives margin |
| `RETURN_BENEFICIARY` | Arc address credited on `solana-arc` returns |
| `DESTINATION_ALLOWLIST`, `DAILY_CAP`, `PER_TRANSFER_CAP`, `BRIDGE_JOURNAL`, `INTENT_FILE`, `IRIS_URL` | policy and plumbing |

### Vault setup for automatic top-ups

`contracts/vault/script/DeployArcTestnet.s.sol` allowlists `TREASURY_EXECUTOR` on the vault, so set it to the address of `ARC_OPERATOR_KEY`, and set `OPERATOR` to the same address. `MOVE_CAP_PER_CALL` and `MOVE_CAP_PER_EPOCH` (USDC base units) set the vault's move caps; left unset they are zero and the vault releases nothing, so every top-up is refused with the cap reason.

### What the operator must fund

- Arc operator account: USDC on Arc testnet. Arc uses USDC as the gas token, so the same balance pays gas and is the burn source for `arc-solana` and `arc-hypercore`. Get it from Circle's faucet.
- Solana operator account: devnet SOL for fees and event-account rent (about 0.01 SOL per burn), plus a USDC token account holding devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) for `solana-arc`. The ATA must exist before the first Arc to Solana receive.
- HyperCore recipient: must already exist on HyperCore mainnet, receives at most 1000 testnet USDC per transfer, and needs 1 USDC for its first outbound action. A failed forward can be silent; the executor keeps such transfers `forwarded` and pending.
- `maxFee` for `arc-hypercore` must cover Circle's forwarding fee. The sandbox returned 228705 to 253826 base units (0.23 to 0.25 USDC) for 26 to 19 on 2026-11-06, so the default is 300000. The docs example says 200000, which is too low today. Check `GET /v2/burn/USDC/fees/26/19?forward=true&hyperCoreDeposit=true` before burning.

## Circle addresses and sources

EVM testnet, identical on every listed chain including Arc Testnet (domain 26) and HyperEVM Testnet (domain 19). Source: https://developers.circle.com/cctp/references/contract-addresses

| Contract | Address |
| --- | --- |
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| TokenMinterV2 | `0xb43db544E2c27092c107639Ad201b3dEfAbcF192` |
| MessageV2 | `0xbaC0179bB358A8936169a63408C8481D582390C4` |

HyperCore, source: https://developers.circle.com/cctp/references/hypercore-contract-addresses (the page notes the testnet addresses have no explorer link)

| Contract | Chain | Address |
| --- | --- | --- |
| CctpForwarder | HyperEVM Testnet (19) | `0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2` |
| CoreDepositWallet | HyperEVM Testnet (19) | `0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206` |

Solana programs, same ids on devnet and mainnet. Source: https://developers.circle.com/cctp/references/solana-programs

| Program | Id |
| --- | --- |
| MessageTransmitterV2 | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` |
| TokenMessengerMinterV2 | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` |

Other facts used:

- Arc testnet RPC `https://rpc.testnet.arc.network`, chain 5042002, USDC `0x3600000000000000000000000000000000000000` (6 decimals), supplied by the team.
- Solana devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`: https://github.com/circlefin/solana-cctp-contracts/blob/master/examples/v2/solana.ts
- Iris sandbox: `https://iris-api-sandbox.circle.com`, messages at `GET /v2/messages/{sourceDomainId}?transactionHash=` (https://developers.circle.com/api-reference/cctp/all/get-messages-v2), fees at `GET /v2/burn/USDC/fees/{src}/{dst}` (https://developers.circle.com/api-reference/cctp/all/get-burn-usdc-fees). A missing message returns 404 `{"error":"Message not found for provided parameters"}`.
- CctpForwarder hookData layout (56 bytes: `cctp-forward` padded to 24 bytes, uint32 version 0, uint32 length 24, recipient, uint32 dex with 0 perps and 0xFFFFFFFF spot): https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore
- Vendored Solana IDLs in `idl/`, from https://raw.githubusercontent.com/circlefin/solana-cctp-contracts/master/examples/target/idl/message_transmitter_v2.json and https://raw.githubusercontent.com/circlefin/solana-cctp-contracts/master/examples/target/idl/token_messenger_minter_v2.json (repo https://github.com/circlefin/solana-cctp-contracts). The instruction builders read discriminators and account order from them.
- V2 message and burn body offsets match `HookExecutor` (header 148 bytes, burn body fixed part 228 bytes); the vault hookData encoding is in `docs/interfaces.md`.

## Not verified against a public network

- No testnet burn has been sent. The first real Arc to Solana, Solana to Arc and Arc to HyperCore transfers are the operator's.
- The Iris fixture in `test/fixtures` follows the documented response shape; it is not a recorded response.
- The `forwardFee` field in the live sandbox uses the key `med`, while the docs example shows `medium`; the client only types the finality and minimum fee fields.
- Whether the Circle forwarding service accepts an Arc source for HyperCore deposits on testnet, and Arc's availability of Fast Transfer, are untested.
