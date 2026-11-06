import { json } from "../../../../../lib/server/deposit";
import { evmStatus } from "../../../../../lib/server/evm-deposit";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json(await evmStatus());
}
