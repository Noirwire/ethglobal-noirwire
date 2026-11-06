export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface SolanaStatus {
  mode: "local" | "testnet";
  available: boolean;
  reason?: string;
}

export interface PreparedDeposit {
  transaction: string;
  deadline: number;
  maxFee: string;
}

async function call<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      cache: "no-store",
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    const parsed = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) return { ok: false, status: response.status, error: parsed.error ?? `Request failed (HTTP ${response.status})` };
    return { ok: true, data: parsed as T };
  } catch {
    return { ok: false, status: 0, error: "Could not reach the status page server. Check your connection and try again." };
  }
}

export const fetchSolanaStatus = () => call<SolanaStatus>("/api/deposit/solana/status");

export const prepareSolanaDeposit = (input: { owner: string; amount: string; beneficiary: string }) =>
  call<PreparedDeposit>("/api/deposit/solana/prepare", input);

export const submitSolanaBurn = (signature: string) =>
  call<{ transfer: { transferId: string } }>("/api/deposit/solana/submitted", { signature });

export const simulateLocalDeposit = (amount: string) =>
  call<{ transfers: { transferId: string }[]; beneficiary: string }>("/api/deposit/local", { amount });
