import type { FlowEvent } from "@noirwire/shared";
import { SseParser } from "../parse";

const EVENT_CAP = 4000;
const RECONNECT_MS = 2000;

export class HedgerFeed {
  events: FlowEvent[] = [];
  connected = false;
  private controller: AbortController | null = null;

  constructor(private readonly url: string) {
    void this.run();
  }

  private async run(): Promise<void> {
    for (;;) {
      this.controller = new AbortController();
      try {
        const response = await fetch(`${this.url}/events`, {
          headers: { accept: "text/event-stream" },
          signal: this.controller.signal,
          cache: "no-store",
        });
        if (!response.ok || !response.body) throw new Error(`events responded ${response.status}`);
        this.events = [];
        this.connected = true;
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            this.events.push(event);
            if (this.events.length > EVENT_CAP) this.events.shift();
          }
        }
      } catch {
        // reconnect below
      }
      this.connected = false;
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  }
}

const globalFeeds = globalThis as unknown as { __noirwireFeeds?: Map<string, HedgerFeed> };

export function feedFor(url: string): HedgerFeed {
  globalFeeds.__noirwireFeeds ??= new Map();
  let feed = globalFeeds.__noirwireFeeds.get(url);
  if (!feed) {
    feed = new HedgerFeed(url);
    globalFeeds.__noirwireFeeds.set(url, feed);
  }
  return feed;
}
