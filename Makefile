SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT     := $(CURDIR)
RUN      := $(ROOT)/.run

ARC_PORT  ?= 8545
FORK_PORT ?= 8546
ARC_RPC   ?= http://127.0.0.1:$(ARC_PORT)
FORK_RPC  ?= http://127.0.0.1:$(FORK_PORT)
ARBITRUM_RPC_URL ?= https://arb1.arbitrum.io/rpc
FORK_BLOCK ?= 521856925
HEDGER_PORT ?= 8701
BRIDGE_PORT ?= 8702
AQUA_HTTP_PORT ?= 8703
WEB_PORT    ?= 3000

# Anvil's published default account #0. Valid on throwaway local chains only.
ANVIL_KEY  := 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ANVIL_ADDR := 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

LOCAL_DEPLOYMENT = contracts/vault/deployments/local.json
LOCAL_HOOK_EXECUTOR = $(shell sed -n 's/.*"hookExecutor": "\(0x[0-9a-fA-F]*\)".*/\1/p' $(LOCAL_DEPLOYMENT) 2>/dev/null)
LOCAL_USDC = $(shell sed -n 's/.*"usdc": "\(0x[0-9a-fA-F]*\)".*/\1/p' $(LOCAL_DEPLOYMENT) 2>/dev/null)

CRE_BIN ?= $(HOME)/.cre/bin/cre

KEYCHAIN_SERVICE ?= noirwire-ethglobal
export KEYCHAIN_SERVICE
KEYS := bash $(ROOT)/scripts/keychain.sh

CHAIN_ID_CALL = curl -s -m 3 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}'

# spawn <name> <dir> <command>: run a command in the background, record its PID and log under .run/.
define spawn
@mkdir -p $(RUN); \
if [ -f $(RUN)/$(1).pid ] && kill -0 $$(cat $(RUN)/$(1).pid) 2>/dev/null; then \
  echo "$(1) already running (pid $$(cat $(RUN)/$(1).pid))"; \
else \
  cd $(2); \
  nohup sh -c "exec env $(3)" > $(RUN)/$(1).log 2>&1 & echo $$! > $(RUN)/$(1).pid; \
  echo "$(1) started (pid $$(cat $(RUN)/$(1).pid), log .run/$(1).log)"; \
fi
endef

# start_anvil <name> <port> <expected chain id hex> <anvil args>: start anvil, or reuse a node already on the port.
define start_anvil
@mkdir -p $(RUN); \
got=$$($(CHAIN_ID_CALL) http://127.0.0.1:$(2) | sed -n 's/.*"result":"\([^"]*\)".*/\1/p'); \
if [ -n "$$got" ]; then \
  if [ "$$got" = "$(3)" ]; then echo "$(1): port $(2) already answers with chain $(3), reusing it (not managed by make down)"; exit 0; fi; \
  echo "$(1): port $(2) answers with chain $$got, expected $(3). Free the port or set the port variable."; exit 1; \
fi; \
cd $(ROOT); \
nohup sh -c "exec anvil --port $(2) $(4)" > $(RUN)/$(1).log 2>&1 & echo $$! > $(RUN)/$(1).pid; \
for i in $$(seq 1 120); do \
  got=$$($(CHAIN_ID_CALL) http://127.0.0.1:$(2) | sed -n 's/.*"result":"\([^"]*\)".*/\1/p'); \
  if [ "$$got" = "$(3)" ]; then echo "$(1): up on $(2) (pid $$(cat $(RUN)/$(1).pid))"; exit 0; fi; \
  kill -0 $$(cat $(RUN)/$(1).pid) 2>/dev/null || { echo "$(1): anvil exited, see .run/$(1).log"; tail -5 $(RUN)/$(1).log; rm -f $(RUN)/$(1).pid; exit 1; }; \
  sleep 0.5; \
done; \
echo "$(1): not answering after 60s, see .run/$(1).log"; exit 1
endef

.PHONY: help install build test check contracts-build chains-up solana-up deploy-local \
	hedger-up bridge-up aqua-up web-up up down status demo cre-simulate \
	deploy-arc-testnet hedger-testnet-up bridge-testnet-up _require-testnet \
	keys-init keys-addresses keys-migrate

help: ## Show this list
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-20s %s\n", $$1, $$2}'

install: ## pnpm install for the whole workspace
	pnpm install

build: ## turbo build (all packages, contracts and web)
	pnpm exec turbo run build

test: ## turbo test (unit tests everywhere, no fork needed)
	pnpm exec turbo run test

contracts-build: ## forge build for contracts/vault and contracts/aqua
	cd contracts/vault && forge build
	cd contracts/aqua && forge build

check: ## Types + lint (turbo), forge fmt --check, forge test (aqua fork tests only if the fork is up)
	pnpm exec turbo run check-types lint --continue
	cd contracts/vault && forge fmt --check && forge test
	cd contracts/aqua && forge fmt --check
	@if $(CHAIN_ID_CALL) $(FORK_RPC) | grep -q 0xa4b1; then \
	  echo "aqua fork answers on $(FORK_RPC): running forge test"; \
	  cd contracts/aqua && AQUA_FORK_RPC=$(FORK_RPC) forge test; \
	else \
	  echo "SKIPPED contracts/aqua forge test: no fork on $(FORK_RPC) (run make chains-up first)"; \
	fi

chains-up: ## Start arc-local anvil (8545, chain 31337) and the Arbitrum One fork (8546, chain 42161); reuses either if already up
	$(call start_anvil,anvil-arc,$(ARC_PORT),0x7a69,--chain-id 31337)
	$(call start_anvil,anvil-fork,$(FORK_PORT),0xa4b1,--chain-id 42161 --fork-url $(ARBITRUM_RPC_URL) $(if $(FORK_BLOCK),--fork-block-number $(FORK_BLOCK)))

solana-up: ## Cloned CCTP V2 Solana validator via the bridge test (reads devnet, sends nothing; stops itself when done)
	cd services/bridge && BRIDGE_SOLANA_CLONE=1 pnpm exec vitest run test/solana-local.test.ts

deploy-local: ## Deploy vault contracts to arc-local (writes contracts/vault/deployments/local.json); build aqua artifacts for the fork setup
	@test -n "$$($(CHAIN_ID_CALL) $(ARC_RPC))" || { echo "no node on $(ARC_RPC): run make chains-up"; exit 1; }
	cd contracts/vault && forge script script/DeployLocal.s.sol --rpc-url $(ARC_RPC) --broadcast \
		--private-key $(ANVIL_KEY) --sender $(ANVIL_ADDR)
	cd contracts/aqua && forge build
	@echo "aqua: HedgeGuard is deployed onto the fork by services/aqua-taker (make aqua-up or make demo); nothing is written to disk"

hedger-up: ## Hedger in mock mode with its HTTP server kept alive (port 8701)
	$(call spawn,hedger,$(ROOT)/services/hedger,HEDGER_MODE=mock FILL_SOURCE=replay KEEP_ALIVE=1 HTTP_PORT=$(HEDGER_PORT) node_modules/.bin/tsx src/main.ts)

bridge-up: ## Bridge HTTP API (8702, override BRIDGE_PORT) in local mode: arc-local deployment, local test attester, POST /v1/dev/deposit; needs deploy-local
	@test -f contracts/vault/deployments/local.json || { echo "run make deploy-local first"; exit 1; }
	@mkdir -p $(RUN)
	$(call spawn,bridge,$(ROOT)/services/bridge,BRIDGE_NETWORK=local ARC_RPC_URL=$(ARC_RPC) BRIDGE_PORT=$(BRIDGE_PORT) BRIDGE_JOURNAL=$(RUN)/bridge-transfers.ndjson node_modules/.bin/tsx src/main.ts)

aqua-up: ## Aqua taker bot against the fork (ship, then fill in chunks) plus the inventory API (8703, override AQUA_HTTP_PORT)
	$(call spawn,aqua,$(ROOT)/services/aqua-taker,AQUA_FORK_RPC=$(FORK_RPC) node_modules/.bin/tsx src/cli.ts bot)
	$(call spawn,aqua-api,$(ROOT)/services/aqua-taker,AQUA_FORK_RPC=$(FORK_RPC) AQUA_HTTP_PORT=$(AQUA_HTTP_PORT) node_modules/.bin/tsx src/cli.ts serve)

web-up: ## Next.js dev server for apps/web (port 3000, override with WEB_PORT)
	$(call spawn,web,$(ROOT)/apps/web,node_modules/.bin/next dev --port $(WEB_PORT))

up: chains-up deploy-local hedger-up bridge-up aqua-up web-up ## Everything local: chains, deploy, all services
	@echo "stack started; make status to check it, make down to stop what make started"

down: ## Stop exactly the PIDs recorded under .run/ (and their children); never touches other processes
	@killtree() { for c in $$(pgrep -P $$1 2>/dev/null); do killtree $$c; done; kill $$1 2>/dev/null; }; \
	for f in $(RUN)/*.pid; do \
	  [ -e "$$f" ] || continue; \
	  n=$$(basename $$f .pid); p=$$(cat $$f); \
	  if kill -0 $$p 2>/dev/null; then killtree $$p; echo "stopped $$n (pid $$p)"; else echo "$$n already exited (pid $$p)"; fi; \
	  rm -f $$f; \
	done; \
	sleep 1; true

status: ## Which recorded PIDs are alive and which ports answer
	@echo "processes started by make:"; \
	found=0; for f in $(RUN)/*.pid; do \
	  [ -e "$$f" ] || continue; found=1; \
	  n=$$(basename $$f .pid); p=$$(cat $$f); \
	  if kill -0 $$p 2>/dev/null; then echo "  $$n  pid $$p  alive"; else echo "  $$n  pid $$p  exited"; fi; \
	done; [ $$found = 1 ] || echo "  none"; \
	echo "ports:"; \
	rpc() { got=$$($(CHAIN_ID_CALL) http://127.0.0.1:$$2 | sed -n 's/.*"result":"\([^"]*\)".*/\1/p'); if [ -n "$$got" ]; then echo "  $$1 :$$2  up (chain $$got)"; else echo "  $$1 :$$2  down"; fi; }; \
	http() { code=$$(curl -s -o /dev/null -m 2 -w '%{http_code}' $$3); if [ "$$code" != 000 ]; then echo "  $$1 :$$2  up (http $$code)"; else echo "  $$1 :$$2  down"; fi; }; \
	rpc arc-local $(ARC_PORT); rpc aqua-fork $(FORK_PORT); \
	http hedger $(HEDGER_PORT) http://127.0.0.1:$(HEDGER_PORT)/status; \
	http bridge $(BRIDGE_PORT) http://127.0.0.1:$(BRIDGE_PORT)/; \
	http web $(WEB_PORT) http://127.0.0.1:$(WEB_PORT)/

demo: chains-up contracts-build ## Offline end-to-end: hedger mock, bridge local e2e, aqua fork demo, CRE compile. Prints PASS/FAIL per step
	@mkdir -p $(RUN); fail=0; \
	run() { name=$$1; shift; if "$$@" > $(RUN)/demo-$$name.log 2>&1; then echo "PASS  $$name"; else echo "FAIL  $$name (log: .run/demo-$$name.log)"; fail=1; fi; }; \
	run hedger-mock env HEDGER_MODE=mock FILL_SOURCE=replay KEEP_ALIVE=0 EVENTS_FILE=$(RUN)/demo-hedger-events.ndjson pnpm --filter @noirwire/hedger start; \
	run bridge-local-e2e env LOCAL_RPC=$(ARC_RPC) pnpm --filter @noirwire/bridge local-e2e; \
	run aqua-fork-demo env AQUA_FORK_RPC=$(FORK_RPC) pnpm --filter @noirwire/aqua-taker demo; \
	run cre-compile pnpm --filter @noirwire/cre-workflow exec cre-compile nav-attestor/main.ts $(RUN)/nav-attestor.wasm; \
	if [ $$fail = 0 ]; then echo "demo: all steps passed"; else echo "demo: FAILED"; fi; \
	exit $$fail

cre-simulate: ## CRE nav-attestor simulation (needs cre login and the Arc fork on 8650, see workflows/cre/SIMULATION.md; no --broadcast)
	@test -x $(CRE_BIN) || { echo "cre CLI not found at $(CRE_BIN)"; exit 1; }
	pnpm --filter @noirwire/cre-workflow simulate

_require-testnet:
	@test "$(CONFIRM)" = "testnet" || { echo "refusing: this target touches a public testnet. Re-run with CONFIRM=testnet"; exit 1; }

deploy-arc-testnet: _require-testnet ## TESTNET (CONFIRM=testnet): dry run of the Arc testnet deploy with the Keychain deployer key; add BROADCAST=1 to send. The key is on forge's argv for the run
	$(KEYS) run -e DEPLOYER_KEY=deployer -- bash -c 'cd contracts/vault && exec forge script script/DeployArcTestnet.s.sol --rpc-url https://rpc.testnet.arc.network --private-key "$$DEPLOYER_KEY" $(if $(BROADCAST),--broadcast)'

hedger-testnet-up: _require-testnet ## TESTNET (CONFIRM=testnet): hedger against Hyperliquid testnet, agent key from the Keychain (hl-agent); needs HL_ACCOUNT_ADDRESS, BOOK_API_URL in the environment
	$(call spawn,hedger-testnet,$(ROOT)/services/hedger,$(KEYS) run -e HL_AGENT_PRIVATE_KEY=hl-agent -- env HEDGER_MODE=testnet FILL_SOURCE=tape HEDGE_ENABLED=$${HEDGE_ENABLED:-0} node_modules/.bin/tsx src/main.ts)

bridge-testnet-up: _require-testnet ## TESTNET (CONFIRM=testnet): bridge against Arc testnet and Solana devnet, keys from the Keychain (operator, solana-operator); needs HOOK_EXECUTOR in the environment
	$(call spawn,bridge-testnet,$(ROOT)/services/bridge,$(KEYS) run -e ARC_OPERATOR_KEY=operator -e HYPERCORE_ACCOUNT_KEY=operator -f SOLANA_KEYPAIR_PATH=solana-operator -- node_modules/.bin/tsx src/main.ts)

keys-init: ## Generate a fresh key per role (deployer operator relayer hl-agent taker solana-operator solana-depositor) into the login Keychain; prints role and address only; FORCE=1 replaces. The key is on security's argv for a moment
	$(KEYS) init

keys-addresses: ## Print role and public address for every Keychain key (never the key)
	$(KEYS) addresses

keys-migrate: ## One time: import the legacy .keys/ files into the Keychain under the same roles, then print addresses; FORCE=1 replaces
	$(KEYS) migrate
