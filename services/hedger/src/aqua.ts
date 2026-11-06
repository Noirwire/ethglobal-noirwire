import type { AquaBand, AquaOutlet } from "./types.ts";

export class NoopAquaOutlet implements AquaOutlet {
  async setBand(_band: AquaBand | null): Promise<void> {}

  async inventory(): Promise<bigint> {
    return 0n;
  }
}
