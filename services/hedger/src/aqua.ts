import type { AquaBand, AquaOutlet } from "./types.ts";

export class NoopAquaOutlet implements AquaOutlet {
  async setBand(_band: AquaBand | null): Promise<void> {}

  async inventory(): Promise<bigint> {
    return 0n;
  }
}

export class FakeAquaOutlet implements AquaOutlet {
  bands: Array<AquaBand | null> = [];
  held8 = 0n;

  async setBand(band: AquaBand | null): Promise<void> {
    this.bands.push(band);
  }

  async inventory(): Promise<bigint> {
    return this.held8;
  }
}
