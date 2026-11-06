import { frameFor } from "@/lib/server/sse";
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
          controller.enqueue(encoder.encode(frameFor(body, last)));
          last = body;
        } catch (error) {
          console.error("buildPublicView failed", error);
          controller.enqueue(encoder.encode(frameFor(null, last)));
          last = "";
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
