import { z } from "zod";

const httpUrl = z.string().regex(/^https?:\/\/\S+$/);
const evmAddress =z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const configSchema = z.object({
  schedule: z.string(),
  maxSourceAgeSec: z.number().int().positive(),
  maxPriceAgeSec: z.number().int().positive(),
  readAt: z.enum(["finalized", "latest"]),
  arc: z.object({
    chainName: z.string(),
    shareVault: evmAddress,
    navReceiver: evmAddress,
    gasLimit: z.string().regex(/^\d+$/),
  }),
  hyperliquid: z.object({ infoUrl: httpUrl, user: evmAddress }),
  maker: z.object({ apiUrl: httpUrl, account: z.string().min(1) }),
  bridge: z.object({ apiUrl: httpUrl, account: z.string().min(1) }),
  aqua: z.object({
    apiUrl: httpUrl,
    account: z.string().min(1),
    feedChainName: z.string(),
    btcUsdFeed: evmAddress,
  }),
  bands: z.object({
    lowBps: z.number().int(),
    urgentBps: z.number().int(),
    surplusBps: z.number().int(),
    targetBps: z.number().int(),
    maxIntentUsdc6: z.string().regex(/^\d+$/),
  }),
});

export type Config = z.infer<typeof configSchema>;
