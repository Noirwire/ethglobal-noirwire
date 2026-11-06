import { json, solanaPrepare } from "../../../../../lib/server/deposit";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return json(await solanaPrepare(request));
}
