# web

Public, read-only status page for the market maker: residual exposure (`/`), money movement (`/flow`) and NAV proof (`/nav`).

```sh
cp .env.example .env.local
pnpm --filter web dev
pnpm --filter web test
```

The browser never talks to a service. The Next.js server reads the hedger, the bridge and the Arc RPC (see `.env.example`), validates every response with the `@noirwire/shared` schemas, and pushes a privacy-reduced view to the page over `/api/stream` (server-sent events).

Privacy contract, enforced in `lib/privacy.ts`: fills and hedges are grouped into 10 second buckets, BTC sizes are rounded to 0.01, hedges are netted per bucket, and a bucket is published only once it is 20 seconds old. A source that is down renders as "not connected", never as zeros.
