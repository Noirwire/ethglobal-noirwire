# Aqua hedge outlet

Powered by Aqua — © Degensoft Ltd 2025

A market maker that has accumulated BTC exposure on an order book ships part of its hedge inventory (WBTC and USDC) into a 1inch Aqua strategy on Arbitrum. Takers can trade against that inventory, but only in the direction that reduces the maker's exposure. A wrong-way fill reverts on chain.

## What is official and what is ours

| Piece | Source | Address (Arbitrum, chain id 42161) |
| --- | --- | --- |
| Aqua registry (`ship`, `dock`, virtual balances, `pull`/`push`) | Official 1inch, unmodified | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` |
| SwapVM router (`AquaSwapVMRouter`, release v1.0.2) | Official 1inch, unmodified | `0x111111338c5091e8440b67b168bae16a668ac0de` |
| Constant product curve (`xycSwapXD`), `salt`, `extruction` opcodes | Official, run by the router above | opcodes 17, 20, 32 |
| `HedgeGuard` | Ours | deployed per run |
| `TestAggregator` | Ours, labelled stand-in for the price feed (local fork only) | deployed per run |

The demo runs on a **local anvil fork of Arbitrum mainnet**, where the official contracts already live at their canonical addresses. Nothing is redeployed or modified: the deployed router's opcode table already contains the `Extruction` opcode, so the strategy calls out to `HedgeGuard` through the official mechanism. Token transfers are real ERC-20 transfers on the fork (WBTC and USDC at their mainnet addresses). No transaction is sent to a public network.

The strategy program is `xycSwapXD`, then `extruction(HedgeGuard)`, then `salt`. The curve prices the fill from the virtual balances; `HedgeGuard` then accepts or rejects it.

## How HedgeGuard decides

A hedger key sets one target per maker: a target id (nonzero `bytes32`), direction (the maker sells WBTC or buys WBTC), remaining size (8 decimals), a price band (8 decimal USD per BTC) and an expiry. Setting is idempotent per id: re-sending the current id with the same direction, size and band is a no-op that keeps the reduced remaining size, the same id with different terms reverts, and a new id replaces the target and refills it. A target is live strictly before its expiry. On every quote and swap it checks, in this order:

1. both swap amounts are computed
2. a target exists and has not expired
3. the token pair is the allowed direction (the reversed pair reverts)
4. the BTC size is within the remaining size
5. the implied price is inside the band
6. the Chainlink-scale feed answer is positive, not older than `maxAge`, and the fill price is within `maxDeviationBps` of it

Quote (a static call) and swap run the same code. Only the swap path writes state: it decrements the remaining size, emits `HedgeFilled`, and only when the caller is the SwapVM router. Clearing the target between a quote and a swap makes the swap revert.

Roles: the owner (two-step ownership, a multisig outside a local fork) sets the oracle feed, max age and max deviation, and rotates the hedger. The hedger sets and clears targets.

The feed address and max age are configurable. On a fork the real Chainlink answer stops updating, so the default demo mode deploys `TestAggregator`, seeded with the real feed's answer at the pinned block and clearly labelled as not Chainlink. `AQUA_ORACLE=chainlink` uses the real feed instead and pins the fork clock next to the fork block, so it works on a freshly started fork and goes stale once the feed's max age passes.

## The taker bot is demo demand

The taker bot in `services/aqua-taker` supplies the demand in the demo. It is not organic 1inch routing: no aggregator or third party routes through this strategy. Liquidity on a fork cannot be discovered by 1inch's solvers, so the bot reads the hedge target and swaps against it.

## Taker gating

The Aqua program set offers optional taker guards (for example `onlyTakerTokenBalanceNonZero`, which requires the taker to hold any amount of a token or NFT). They are program instructions a maker chooses to include, not a protocol-wide check, and this strategy does not include one by default. `AQUA_TAKER_GATE_TOKEN=<address>` adds the guard to the strategy, and the fork setup satisfies it by writing a balance of 1 for the taker directly into the token's storage. An integration test covers this path with WETH standing in for a gate token.

## Pinned fork

Block `521723675` on Arbitrum One (Nov 6, 2026). The free public RPC is not an archive node: it stops serving state for a pinned block after roughly an hour, and the fork then fails with `missing trie node`. For a stable pin, set `ARBITRUM_RPC_URL` to an archive-capable provider; with the public RPC, restart the fork on a recent block (`--fork-block-number <latest minus 30>`) before each session.

```
pnpm --filter @noirwire/aqua-contracts fork
```

runs `anvil --fork-url ${ARBITRUM_RPC_URL:-https://arb1.arbitrum.io/rpc} --fork-block-number 521717090 --port 8546 --chain-id 42161`. The public RPC can rate-limit forking; set `ARBITRUM_RPC_URL` to a provider URL if it does.

## Run

```
pnpm install
pnpm --filter @noirwire/aqua-contracts fork          # terminal 1, leave running
pnpm --filter @noirwire/aqua-contracts build         # produces the artifacts the TypeScript setup deploys
pnpm --filter @noirwire/aqua-taker start             # terminal 2: ship, allowed swap, wrong-way swap, dock
```

`start` prints human readable progress, transaction hashes and balance deltas to stderr and one `FlowEvent` per line (kind `hedge`, venue `aqua`) to stdout. `pnpm --filter @noirwire/aqua-taker exec tsx src/cli.ts bot` ships a strategy and lets the bot fill the target in chunks until it is exhausted.

The fork setup funds the maker and taker by writing token balances into storage, and uses the four public anvil test accounts. Those keys exist only on throwaway forks and hold no value.

Deploying `HedgeGuard` with Foundry instead of the TypeScript setup:

```
OWNER=<multisig> HEDGER=<hedger> forge script script/DeployHedgeGuard.s.sol \
  --account <keystore> --sender <address> --rpc-url http://127.0.0.1:8546 --broadcast
```

On the fork, `--unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` replaces the keystore (the public anvil account). Any deployment beyond a local fork needs a multisig owner and an audit first.

## Tests

```
forge test                  # needs the fork running on port 8546 (or AQUA_FORK_RPC)
pnpm --filter @noirwire/aqua-contracts lint
npx -y @cyfrin/aderyn@0.6.8 .
slither .
```

- `test/HedgeGuard.t.sol`: stateless fuzz tests for every branch of the guard, against the real Chainlink feed state at the pinned block (with `vm.mockCall` for stale and decimal cases).
- `test/HedgeGuard.router.t.sol`: the same guard behind the official router and registry: ship, quote equals swap, real token movement, wrong-way revert, overfill, cancel between quote and swap, dock.
- `test/HedgeGuard.invariant.t.sol`: remaining size never increases except through the hedger's setter, no wrong-way or oversized fill ever succeeds.
- `.tree` files next to the tests list the branches each suite covers.

TypeScript (`services/aqua-taker`): `pnpm test` runs unit tests; setting `AQUA_FORK_RPC=http://127.0.0.1:8546` also runs the fork integration tests.
