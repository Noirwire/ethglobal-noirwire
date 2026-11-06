import { json } from "../../../../../lib/server/deposit";
import { evmFee } from "../../../../../lib/server/evm-deposit";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return json(await evmFee(new URL(request.url).searchParams));
}
