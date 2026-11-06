import { json } from "../../../../../lib/server/deposit";
import { evmSubmitted } from "../../../../../lib/server/evm-deposit";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return json(await evmSubmitted(request));
}
