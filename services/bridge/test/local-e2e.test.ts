import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_DEPLOYMENT, localChainReachable } from "../src/local-arc.ts";
import { runLocalE2e } from "../src/local-e2e.ts";

const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
const vaultOut = fileURLToPath(new URL("../../../contracts/vault/out/HookExecutor.sol/HookExecutor.json", import.meta.url));
const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const hasContracts = existsSync(LOCAL_DEPLOYMENT) || existsSync(vaultOut);

describe.skipIf(!hasAnvil || !hasContracts)("local end to end, solana-arc through the HookExecutor", () => {
  let anvil: ChildProcess | undefined;

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let attempt = 0; attempt < 50 && !(await localChainReachable(RPC)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 15_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("signs with the local attester, relays through the HookExecutor and credits the vault request", async () => {
    const result = await runLocalE2e(RPC);
    expect(result.transfer.state).toBe("vault-credited");
    expect(result.transfer.attester).toBe("local-test-attester");
    expect(result.transfer.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.vaultAssets).toBe(result.expectedNet);
    expect(result.inFlightAfter).toBe(0);
  }, 60_000);
});
