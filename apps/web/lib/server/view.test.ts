import { afterEach, describe, expect, it, vi } from "vitest";
import { cached, resetCache } from "./cache";
import { frameFor } from "./sse";
import { buildPublicView } from "./view";

afterEach(() => {
  resetCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("down reasons", () => {
  it("never echo service URLs or upstream error text", async () => {
    vi.stubEnv("HEDGER_URL", "http://127.0.0.1:8799");
    vi.stubEnv("BRIDGE_URL", "http://127.0.0.1:8798");
    vi.stubEnv("ARC_RPC_URL", "http://127.0.0.1:8797");
    vi.stubEnv("NAV_RECEIVER_ADDRESS", `0x${"11".repeat(20)}`);
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1")));
    const view = await buildPublicView();
    const downs = [view.hedger, view.bridge, view.nav].flatMap((section) => (section.ok ? [] : [section]));
    expect(downs).toHaveLength(3);
    expect(JSON.stringify(downs)).not.toMatch(/127\.0\.0\.1|8799|8798|8797|fetch failed|ECONNREFUSED|http/i);
    expect(downs.map((down) => down.source)).toEqual(["Hedger", "Bridge", "NAV (Arc)"]);
  });
});

describe("cache", () => {
  it("does not keep a rejected load", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return "ok";
    };
    await expect(cached("k", 60_000, load)).rejects.toThrow("boom");
    await expect(cached("k", 60_000, load)).resolves.toBe("ok");
    await expect(cached("k", 60_000, load)).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("stream frames", () => {
  it("sends data for a new view, a ping for an unchanged one", () => {
    expect(frameFor("{}", "")).toBe("data: {}\n\n");
    expect(frameFor("{}", "{}")).toBe(": ping\n\n");
  });

  it("flags a failed build as stale instead of staying silent", () => {
    expect(frameFor(null, "{}")).toBe("event: stale\ndata: {}\n\n");
  });
});
