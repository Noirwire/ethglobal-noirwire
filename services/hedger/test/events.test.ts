import { mkdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flowEvent } from "@noirwire/shared";
import { createEventServer, EventBus } from "../src/events.ts";
import { makeFill, makeHarness } from "./harness.ts";

const SCRATCH = join(import.meta.dirname, "..", ".test-tmp", "events");

beforeAll(() => mkdirSync(SCRATCH, { recursive: true }));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("event bus", () => {
  it("writes valid flow events as ndjson and rejects invalid ones", () => {
    const file = join(SCRATCH, "events.ndjson");
    const bus = new EventBus(file);
    bus.publish({ kind: "fill", at: new Date().toISOString(), fill: makeFill("a", "buy", 1n) });
    expect(() => bus.publish({ kind: "fill" } as never)).toThrow();
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(flowEvent.safeParse(JSON.parse(lines[0]!)).success).toBe(true);
  });
});

describe("http server", () => {
  async function serve() {
    const h = makeHarness();
    h.source.push(makeFill("f1", "buy", 1_000_000n));
    await h.controller.tick();
    const server = createEventServer(h.bus, { snapshot: () => h.controller.snapshot() });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { h, server, base };
  }

  it("serves /status as json with cors for the web app and no account identifiers", async () => {
    const { server, base } = await serve();
    try {
      const response = await fetch(`${base}/status`);
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe("hedged");
      expect(body.netResidual).toBe("0");
      expect(JSON.stringify(body)).not.toMatch(/0x[0-9a-fA-F]{40}/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("streams flow events over server-sent events, replaying the backlog first", async () => {
    const { h, server, base } = await serve();
    const controller = new AbortController();
    try {
      const response = await fetch(`${base}/events`, { signal: controller.signal });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes('"kind":"hedge"')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      const datas = text.split("\n").filter((line) => line.startsWith("data: "));
      expect(datas.length).toBeGreaterThan(1);
      for (const line of datas) expect(flowEvent.safeParse(JSON.parse(line.slice(6))).success).toBe(true);
      expect(h.bus.recent().length).toBeGreaterThan(0);
    } finally {
      controller.abort();
      server.closeAllConnections();
      server.close();
    }
  });

  it("answers preflight requests and 404s unknown paths", async () => {
    const { server, base } = await serve();
    try {
      const preflight = await fetch(`${base}/events`, { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
