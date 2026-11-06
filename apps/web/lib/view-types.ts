import type { TrustLabel } from "@noirwire/shared";
import type { PublicBucket } from "./privacy";
import type { HedgerStatus } from "./residual";
import type { Rail } from "./transfers";
import type { TransferRoute, TransferState } from "@noirwire/shared";

export interface Down {
  ok: false;
  source: string;
  reason: string;
}

export interface PublicState {
  status: HedgerStatus;
  hedgeEnabled: boolean;
  market: string;
  band: string;
  latencySeconds: number | null;
  buckets: PublicBucket[];
}

export interface PublicTransfer {
  id: string;
  route: TransferRoute;
  state: TransferState;
  gross: string;
  netMinted: string | null;
  fee: string | null;
  attester: "circle-iris" | "local-test-attester";
  updatedAt: string;
  rail: Rail;
}

export interface PublicNavSource {
  leg: string;
  account: string;
  accountHref: string | null;
  assets: string;
  liabilities: string;
  observedAt: string;
  trust: TrustLabel;
}

export interface PublicNav {
  closeId: number;
  totalAssets: string;
  totalLiabilities: string;
  observedAt: string;
  sourcesHash: string;
  reportTx: string;
  reportTxHref: string | null;
  sharePriceE18: string | null;
  sources:
    | { published: true; rows: PublicNavSource[]; recomputedHash: string; hashMatches: boolean }
    | { published: false; reason: string };
}

export type Section<T> = ({ ok: true } & T) | Down;

export interface PublicView {
  privacy: { bucketSeconds: number; roundBtc: string; delaySeconds: number };
  hedger: Section<{ state: PublicState }>;
  bridge: Section<{ transfers: PublicTransfer[] }>;
  nav: Section<{ report: PublicNav }>;
}
