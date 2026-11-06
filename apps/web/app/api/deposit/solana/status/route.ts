import { json, solanaStatus } from "../../../../../lib/server/deposit";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json(await solanaStatus());
}
