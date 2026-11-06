# Interfaces

The contract between the packages in this repo. TypeScript shapes live in `packages/shared` (`@noirwire/shared`); this page fixes the onchain encodings and the local ports. Change both together.

## Units

| Quantity | Scale | Notes |
| --- | --- | --- |
| USDC | 6 decimals | Same on Arc, HyperEVM, Solana, Arbitrum |
| BTC size | 8 decimals | Same as WBTC; Hyperliquid sizes are converted at the edge |
| Price | decimal string | USD per BTC; contracts use 8-decimal fixed point (Chainlink scale) |
| Share | 18 decimals | Vault share token |
| Share price | 1e18 = 1 USD | USD value of one whole share (1e18 share units), scaled by 1e18 |

All amounts cross package boundaries as integer strings in base units. Sizes and amounts are unsigned; only positions and residual exposure (`signedBtc8`) and PnL (`signedUsdc6`) carry a sign, long positive.

Share price at a close, rounding down:

```
sharePriceE18 = netAssets6 * 1e12 * 1e18 / shareSupply18
```

With zero supply the price is 1e18 (one share per USD). Shares minted for a deposit round down; assets paid for a redemption round down. Both favour the vault.

A maker fill on side `buy` makes the maker longer, so its hedge is a `sell` (`hedgeSideFor` in `packages/shared`).

## Local chains

| Name | Command | Port | Chain id |
| --- | --- | --- | --- |
| arc-local | `anvil` | 8545 | 31337 |
| aqua-fork | `anvil --fork-url $ARBITRUM_RPC_URL --fork-block-number <pinned>` | 8546 | 42161 |
| solana-local | `solana-test-validator` | 8899 | n/a |

## CRE report (Chainlink to `NavReceiver` on Arc)

CRE delivers through the `KeystoneForwarder`, which calls `onReport(bytes metadata, bytes report)` on the receiver. The forwarder passes the workflow's bytes through unchanged; the format below is ours. The `report` bytes are:

```solidity
abi.encode(uint8 kind, bytes body)
```

where `body` is `abi.encode(NavReport)` for kind 1 and `abi.encode(TopUpIntent)` for kind 2, each struct encoded as a tuple with fields in exactly the order listed. The receiver accepts only the configured forwarder as `msg.sender` and, when the metadata carries them, only the configured workflow id and workflow owner. Golden vectors live in the CRE workflow tests.

`kind = 1`, NAV report:

```solidity
struct NavReport {
    uint8 version;          // 1
    uint64 closeId;         // epoch being closed
    uint64 observedAt;      // unix seconds, oldest source timestamp; must be after the previous settlement
    uint256 totalAssets;    // USDC 6 dp, all legs incl. in-transit
    uint256 totalLiabilities; // USDC 6 dp, pending redemptions excluded (the vault tracks those)
    bytes32 sourcesHash;    // see "Sources hash" below
}
```

### Sources hash

`sourcesHash = keccak256(abi.encode(SourceRecord[]))` with the records sorted by `leg` code, then by `account`:

```solidity
struct SourceRecord {
    uint8 leg;              // NAV_LEG_CODES in packages/shared
    bytes32 account;        // keccak256(utf8 account identifier)
    uint256 assets;         // USDC 6 dp
    uint256 liabilities;    // USDC 6 dp
    uint64 observedAt;      // unix seconds
    uint8 trust;            // TRUST_CODES in packages/shared
}
```

Anyone holding the published `NavSnapshot` can recompute the hash and compare it with the onchain report.

`kind = 2`, top-up intent:

```solidity
struct TopUpIntent {
    uint8 version;          // 1
    bytes32 intentId;
    uint64 closeId;
    uint8 route;            // 0 arc-hypercore, 1 hypercore-arc, 2 arc-solana, 3 solana-arc
    uint256 amount;         // USDC 6 dp
    uint16 marginRatioBps;  // hedge margin / required margin, in bps
    uint8 reason;           // 0 margin-low, 1 margin-urgent, 2 surplus-return, 3 solana-rebalance
}
```

The receiver records an intent and emits an event. It moves no funds; the treasury executor performs the CCTP steps and reports completion separately.

## CCTP hook data (Solana deposit into the Arc vault)

The Solana burn sets `mintRecipient` and `destinationCaller` to the Arc `HookExecutor`. Only that contract can deliver the message, so the share owner cannot be chosen by whoever relays the attestation. `hookData` is:

```solidity
abi.encode(
    uint8 version,          // 1
    address beneficiary,    // Arc address that receives the vault position
    bytes32 solanaDepositor,// Solana pubkey of the depositor; must equal the burn message sender
    uint64 deadline         // unix seconds; after it the deposit becomes claimable instead
)
```

CCTP mints and carries `hookData`; it does not execute it. Execution is `HookExecutor.relay(message, attestation)`: it calls `MessageTransmitterV2.receiveMessage` itself, decodes the attested burn message and hook, measures the net minted amount by balance delta, and calls the vault. If the vault call fails or the deadline has passed, the net minted USDC is held as a claim for `beneficiary`. Hook data that does not decode, or whose `solanaDepositor` differs from the attested burn's `messageSender`, is quarantined for the owner to release.

Transfer states (`TransferState`): `requested`, `burned`, `attested`, `minted`, then by route either `hook-executed` and `vault-credited` (or `claimable`) for deposits into the vault, or `forwarded` and `credited` for HyperCore. `credited` on HyperCore is set only after the Hyperliquid account balance is observed to rise. A transfer is keyed by its CCTP message hash once attested, so a retry never counts twice.

## Aqua inventory

The Aqua leg runs on a local fork of Arbitrum One with seeded WBTC and USDC in the maker wallet. Aqua tracks virtual balances while tokens stay in that wallet, so NAV reads the maker wallet's token balances plus the strategy's virtual balances from the official registry.

## Flow events

Services publish `FlowEvent` (see `packages/shared/src/schemas.ts`) as newline-delimited JSON, one event per line. The web app reads them over server-sent events.

## Trust labels

Every number shown in the app carries its source: `onchain`, `venue-api`, or `operator-supplied`. Every bridge transfer carries its attester: `circle-iris` or `local-test-attester`. A transfer signed by the local test attester is never shown as a Circle transfer.
