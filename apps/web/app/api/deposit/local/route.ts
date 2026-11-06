import { json, localSimulation } from "../../../../lib/server/deposit";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return json(await localSimulation(request));
}
