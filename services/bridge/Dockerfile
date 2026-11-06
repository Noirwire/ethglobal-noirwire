# syntax=docker/dockerfile:1

# The treasury bridge. Build it from the root of the repository, because the
# service depends on the workspace's shared package:
#
#   docker build -f services/bridge/Dockerfile -t noirwire-bridge .
#
# Nothing secret is in the image. The keys are mounted as files and named by
# ARC_OPERATOR_KEY_FILE and HYPERCORE_ACCOUNT_KEY_FILE; the Solana keypair is
# a file named by SOLANA_KEYPAIR_PATH. Every other setting is an environment
# variable, as in the service's README.

# The same Node major and base image digest as the order book operator image,
# so a build that holds keys at run time never picks up a base image nobody
# looked at.
ARG NODE_VERSION=26
ARG NODE_DIGEST=sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe
FROM node:${NODE_VERSION}-bookworm-slim@${NODE_DIGEST}

# pnpm is the version the workspace pins in package.json. Node no longer ships
# corepack, so it is installed from the registry, without install scripts.
RUN npm install --global --ignore-scripts pnpm@11.25.0 && npm cache clean --force

WORKDIR /app

# Dependencies first, from the manifests and the lockfile only, so the layer
# is reused until one of them changes. No install scripts: nothing the service
# needs is built at install time.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY services/bridge/package.json services/bridge/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@noirwire/bridge..." \
  && pnpm store prune

COPY packages/shared packages/shared
COPY packages/typescript-config packages/typescript-config
COPY services/bridge services/bridge
COPY --chmod=0755 services/bridge/docker-entrypoint.sh /usr/local/bin/noirwire-bridge

# The journals and the intent cursor live in /data, which is mounted writable.
ENV NODE_ENV=production \
  BRIDGE_NETWORK=testnet \
  BRIDGE_PORT=8702 \
  BRIDGE_JOURNAL=/data/transfers.ndjson \
  REBALANCE_JOURNAL=/data/rebalance.ndjson \
  INTENT_CURSOR_FILE=/data/intent-cursor.json

RUN mkdir /data && chown node:node /data
WORKDIR /app/services/bridge
USER node
EXPOSE 8702
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.BRIDGE_PORT || 8702) + '/v1/transfers').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/noirwire-bridge"]
