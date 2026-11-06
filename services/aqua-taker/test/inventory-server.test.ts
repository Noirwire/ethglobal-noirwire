import { describe, expect, it } from "vitest";
import { parseAquaInventory } from "../../../workflows/cre/src/sources.ts";
import { INVENTORY_PATH, handleInventoryRequest } from "../src/inventory-server.ts";

const reading = { usdc6: 1_234_567_890n, wbtcE8: 150_000_000n, observedAtSeconds: 1_793_900_000n };

describe("aqua inventory handler", () => {
  it("returns exactly the shape the NAV workflow parses, stamped with the block time", async () => {
    const result = await handleInventoryRequest("GET", INVENTORY_PATH, async () => reading);
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(["observedAt", "usdc6", "wbtcE8"]);
    const parsed = parseAquaInventory(JSON.stringify(result.body));
    expect(parsed).toEqual({ usdc6: 1_234_567_890n, wbtcE8: 150_000_000n, observedAtMs: 1_793_900_000_000 });
  });

  it("answers 503 with an error and no balances when the chain read fails", async () => {
    const result = await handleInventoryRequest("GET", INVENTORY_PATH, async () => {
      throw new Error("missing trie node");
    });
    expect(result).toEqual({ status: 503, body: { error: "missing trie node" } });
  });

  it("answers 404 for other paths and 405 for other methods without reading the chain", async () => {
    const read = async () => {
      throw new Error("must not be called");
    };
    expect((await handleInventoryRequest("GET", "/", read)).status).toBe(404);
    expect((await handleInventoryRequest("POST", INVENTORY_PATH, read)).status).toBe(405);
  });
});
