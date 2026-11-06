import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { flowEvent, type FlowEvent } from "@noirwire/shared";

const ALLOWED_ORIGIN = "http://localhost:3000";
const BACKLOG_LIMIT = 200;

export type EventListener = (event: FlowEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly backlog: FlowEvent[] = [];

  constructor(private readonly filePath: string | null = null) {
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }

  publish(event: FlowEvent): void {
    const valid = flowEvent.parse(event);
    this.backlog.push(valid);
    if (this.backlog.length > BACKLOG_LIMIT) this.backlog.shift();
    if (this.filePath) appendFileSync(this.filePath, `${JSON.stringify(valid)}\n`);
    for (const listener of this.listeners) listener(valid);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recent(): FlowEvent[] {
    return [...this.backlog];
  }
}

export interface StatusProvider {
  snapshot(): unknown;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

function writeSse(response: ServerResponse, event: FlowEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createEventServer(bus: EventBus, status: StatusProvider): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders()).end();
      return;
    }
    if (request.method === "GET" && path === "/status") {
      response
        .writeHead(200, { ...corsHeaders(), "content-type": "application/json" })
        .end(JSON.stringify(status.snapshot(), (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
      return;
    }
    if (request.method === "GET" && path === "/events") {
      response.writeHead(200, {
        ...corsHeaders(),
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      for (const event of bus.recent()) writeSse(response, event);
      const unsubscribe = bus.subscribe((event) => writeSse(response, event));
      request.on("close", unsubscribe);
      return;
    }
    response.writeHead(404, corsHeaders()).end();
  });
}
