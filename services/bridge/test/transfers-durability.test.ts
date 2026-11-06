import { describe, expect, it, vi } from "vitest";

const syncs: string[] = [];
let lastWritten = "";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeSync: (fd: number, data: string) => {
      lastWritten = data;
      return actual.writeSync(fd, data);
    },
    fsyncSync: (fd: number) => {
      syncs.push(lastWritten);
      return actual.fsyncSync(fd);
    },
  };
});

const { TransferStore } = await import("../src/transfers.ts");
const { newTransfer, tempJournal } = await import("./helpers.ts");

describe("burn arming durability", () => {
  it("fsyncs the armed record before beginBurn returns, and not for ordinary appends", () => {
    const store = new TransferStore(tempJournal());
    store.create(newTransfer());
    expect(syncs).toHaveLength(0);
    store.beginBurn("t1");
    expect(syncs).toHaveLength(1);
    expect(JSON.parse(syncs[0]!).record.meta.burnAttempted).toBe(true);
    store.transition("t1", "burned", { burnTx: "0xburn" });
    expect(syncs).toHaveLength(1);
  });
});
