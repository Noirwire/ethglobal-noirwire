export const REQUEST_TIMEOUT_MS = 3000;

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? "request failed" : "request failed";
}
