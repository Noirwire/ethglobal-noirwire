# Maker vault contracts (Arc)

Foundry project (solc 0.8.34, OpenZeppelin v5 via soldeer). An asynchronous epoch vault where USDC deposited from Arc, or from Solana through Circle CCTP V2, buys shares of one shared maker account at one share price.

> These contracts have not been audited. Get an independent audit before deploying anywhere that holds real funds.

## Contracts

| Contract | Role |
| --- | --- |
| `ShareVault` | ERC-20 share token "NoirWire Maker Vault Share" (18 dp) over USDC (6 dp). Deposits and redemptions are requests priced at the next epoch close. |
| `NavReceiver` | Chainlink CRE consumer (`IReceiver`). Only the configured forwarder may call `onReport`. Kind 1 settles a vault epoch; kind 2 records a top-up intent and moves no funds. |
| `HookExecutor` | Delivers Solana CCTP V2 burn messages on Arc and turns the net minted USDC into a vault deposit request for the beneficiary named in the hook data. |

Encodings (CRE report, hook data, units) follow `docs/interfaces.md`.

## Epoch lifecycle

1. Users call `requestDeposit(assets, receiver)` or `requestRedeem(shares, receiver)`. USDC or shares are escrowed in the vault for the current epoch. `cancelDeposit` and `cancelRedeem` work only while the epoch is open.
2. CRE computes the NAV off-chain and writes a report. `NavReceiver` calls `settleEpoch(closeId, totalAssets, totalLiabilities, observedAt)`.
3. The vault checks: `closeId` equals the current epoch exactly, `observedAt` is not in the future and not older than `maxReportAge`, and the new price is within `maxPriceMoveBps` of the last price. A larger move pauses new requests and emits `DeviationHalt` until the owner calls `acknowledgeDeviation`; a fresh report for the same epoch then settles.
4. Price: `sharePriceE18 = netAssets6 * 1e12 * 1e18 / shareSupply`, opening price `1e18` (1 share = 1 USDC). Deposits mint shares rounding down, redemptions pay assets rounding down.
5. A performance fee (`performanceFeeBps`, default 2000) is minted as shares to `feeRecipient` on the part of the price above the high-water mark, and never on a loss epoch.
6. Redemptions paid per epoch are capped at `maxRedeemBps` of net assets and by USDC actually held. The filled fraction is the same for every request; the rest rolls into the next epoch.
7. Users call `claimShares(user)` and `claimAssets(user)`. Claims are computed lazily from per-epoch totals, so settlement never loops over users.
8. If no epoch settles within `maxEpochGap`, `requestDeposit` reverts (stale halt). Redemption requests stay open.

`navCash()` is the USDC figure the NAV report must use for the cash held in the vault: the ledger minus settled-but-unclaimed redemptions and minus pending deposits of the open epoch. Direct USDC transfers into the vault are not part of the ledger, are never counted as deposits and are not in `navCash()`; the owner can recover them with `sweepSurplus`.

The operator can move idle USDC only to owner-allowlisted destinations (the treasury executor), within a per-call and a per-epoch cap, and never reserved or pending assets. Caps start at zero, so nothing can move until the owner calls `setMoveCaps`. USDC that comes back is brought into the ledger with `acknowledgeReturn`.

Lockup: shares claimed from an epoch cannot be redeemed until `lockupPeriod` after that settlement. Transferring shares carries the lock to the recipient.

## Trust assumptions

- The NAV input for the Solana maker account, the Hyperliquid hedge account, Aqua inventory and in-transit bridge transfers is operator supplied. CRE aggregates it and signs a report; nothing on Arc can verify those legs. Holders trust the operator and the CRE workflow for that part of the NAV. The Arc cash leg comes from `navCash()` and is onchain.
- The owner (admin) sets parameters, the allowlist, the operator and the NAV receiver, and can acknowledge a price deviation. Use a multisig on any real deployment. On testnet the admin may be an EOA.
- The operator can move idle USDC to allowlisted destinations within the caps.
- Hook data that cannot be decoded is quarantined for the owner to release; reverting would leave the attested message undeliverable forever.

## Test

```
forge soldeer install
forge build
forge test
forge coverage --report summary
pnpm lint
```

Tests are stateless fuzz tests with a `.tree` file next to each test file describing the branches, plus invariant tests driven by a handler (`test/invariant`).

## Local attestation

`test/mocks/MockMessageTransmitterV2.sol` mirrors the CCTP V2 `MessageTransmitterV2.receiveMessage(bytes message, bytes attestation)` path and the `Attestable` signature rules, so the real contract can replace it.

- `attestation` is the concatenation of exactly `signatureThreshold` signatures, each 65 bytes `(r, s, v)` (r 32 bytes, s 32 bytes, v 1 byte, v is 27 or 28).
- Each signature signs `keccak256(message)` of the raw message bytes, with no prefix.
- Signers must be strictly ascending by address, so duplicates are rejected, and each signer must be an enabled attester.
- Threshold defaults to 1. The owner manages the attester set (`setAttester`) and the threshold (`setSignatureThreshold`).
- Message header (offsets in bytes): version `uint32` at 0 (must be 1), source domain `uint32` at 4, destination domain `uint32` at 8 (must equal the local domain, Arc 26), nonce `bytes32` at 12, sender `bytes32` at 44, recipient `bytes32` at 76, destination caller `bytes32` at 108 (zero, or must equal `msg.sender`), min finality threshold `uint32` at 140, finality executed `uint32` at 144, body from 148.
- Burn message body (offsets from the start of the body): version `uint32` at 0, burn token `bytes32` at 4, mint recipient `bytes32` at 36, amount `uint256` at 68, message sender `bytes32` at 100, max fee `uint256` at 132, fee executed `uint256` at 164, expiration block `uint256` at 196, hook data from 228.
- Replay is tracked by the message nonce field. The zero nonce is pre-marked as used. A used nonce reverts.
- Minting: `amount - feeExecuted` to the mint recipient and `feeExecuted` to a fee sink.
- The bridge service must label transfers it attests with this key as `local-test-attester`, never as a Circle transfer.

## Deploy locally

Start anvil on port 8545 (chain id 31337), then:

```
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

That key is anvil's published default account #0 and is only for a local chain. The script deploys the mocks and the three contracts and writes `deployments/local.json` (`network`, `chainId`, `usdc`, `shareVault`, `navReceiver`, `hookExecutor`, `messageTransmitterV2`, `tokenMessengerV2`, `creForwarder`). The local attester defaults to anvil account #1; override with `ATTESTER_ADDRESS`. Addresses are deterministic only on a fresh anvil; restart anvil before redeploying.

## Deploy to Arc testnet

`script/DeployArcTestnet.s.sol` uses the real Arc testnet USDC, the CCTP V2 MessageTransmitterV2 and TokenMessengerV2, and the CRE KeystoneForwarder. Use a Foundry keystore, never a key in the environment:

```
cast wallet import arc-deployer --interactive
forge script script/DeployArcTestnet.s.sol --rpc-url https://rpc.testnet.arc.network \
  --account arc-deployer --sender <deployer address>
```

Add `--broadcast` only after reviewing the dry run. Required environment values (none are secrets): `TREASURY_EXECUTOR`, `WORKFLOW_OWNER`, `SOLANA_TOKEN_MESSENGER`, `SOLANA_USDC_MINT`; optional: `ADMIN`, `OPERATOR`, `FEE_RECIPIENT`, `WORKFLOW_ID`, `WORKFLOW_NAME`, `CRE_FORWARDER` (set it to the simulation forwarder `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` when running `cre workflow simulate --broadcast`). If `ADMIN` differs from the deployer, ownership transfers are started and `ADMIN` must call `acceptOwnership` on each contract. On testnet the admin may be an EOA; on mainnet it must be a multisig.

Arc testnet pays gas in USDC, so the deployer needs testnet USDC and no other gas token.
