import { buildPublicView } from "@/lib/server/view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUSH_MS = 2000;

export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let last = "";
      let busy = false;
      const push = async () => {
        if (busy) return;
        busy = true;
        try {
          const body = JSON.stringify(await buildPublicView());
          if (body !== last) {
            last = body;
            controller.enqueue(encoder.encode(`data: ${body}\n\n`));
          } else {
            controller.enqueue(encoder.encode(": ping\n\n"));
          }
        } catch {
          controller.enqueue(encoder.encode(": error\n\n"));
        } finally {
          busy = false;
        }
      };
      await push();
      timer = setInterval(() => void push(), PUSH_MS);
      request.signal.addEventListener("abort", () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
