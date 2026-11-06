# Interfaces

The contract between the packages in this repo. TypeScript shapes live in `packages/shared` (`@noirwire/shared`); this page fixes the onchain encodings and the local ports. Change both together.

## Units

| Quantity | Scale | Notes |
| --- | --- | --- |
| USDC | 6 decimals | Same on Arc, HyperEVM, Solana, Arbitrum |
| BTC size | 8 decimals | Same as WBTC; Hyperliquid sizes are converted at the edge |
| Price | decimal string | USD per BTC; contracts use 8-decimal fixed point (Chainlink scale) |
| Share price | 18 decimals | USDC base units per share, scaled by 1e18 |

All amounts cross package boundaries as integer strings in base units.

## Local chains

| Name | Command | Port | Chain id |
| --- | --- | --- | --- |
| arc-local | `anvil` | 8545 | 31337 |
| aqua-fork | `anvil --fork-url $ARBITRUM_RPC_URL --fork-block-number <pinned>` | 8546 | 42161 |
| solana-local | `solana-test-validator` | 8899 | n/a |

## CRE report (Chainlink to `NavReceiver` on Arc)

CRE delivers through the `KeystoneForwarder`, which calls `onReport(bytes metadata, bytes report)` on the receiver. The `report` bytes are:

```solidity
abi.encode(uint8 kind, bytes body)
```

`kind = 1`, NAV report:

```solidity
struct NavReport {
    uint8 version;          // 1
    uint64 closeId;         // epoch being closed
    uint64 observedAt;      // unix seconds, oldest source timestamp
    uint256 totalAssets;    // USDC 6 dp, all legs incl. in-transit
    uint256 totalLiabilities; // USDC 6 dp, pending redemptions excluded (the vault tracks those)
    bytes32 sourcesHash;    // keccak256 of the canonical JSON NavSnapshot.sources
}
```

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
    bytes32 solanaDepositor,// Solana pubkey of the depositor, for the record
    uint64 deadline         // unix seconds; after it the deposit becomes claimable instead
)
```

If the vault call fails or the deadline has passed, the net minted USDC is held as a claim for `beneficiary`.

## Flow events

Services publish `FlowEvent` (see `packages/shared/src/schemas.ts`) as newline-delimited JSON, one event per line. The web app reads them over server-sent events.

## Trust labels

Every number shown in the app carries its source: `onchain`, `venue-api`, or `operator-supplied`. Every bridge transfer carries its attester: `circle-iris` or `local-test-attester`. A transfer signed by the local test attester is never shown as a Circle transfer.
