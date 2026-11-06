# syntax=docker/dockerfile:1

# The Hyperliquid hedger. Build it from the root of the repository, because the
# service depends on the workspace's shared package:
#
#   docker build -f services/hedger/Dockerfile -t noirwire-hedger .
#
# Nothing secret is in the image. The agent key is mounted as a file named by
# HL_AGENT_PRIVATE_KEY_FILE; every other setting is an environment variable, as
# in the service's README.

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
COPY services/hedger/package.json services/hedger/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@noirwire/hedger..." \
  && pnpm store prune

COPY packages/shared packages/shared
COPY packages/typescript-config packages/typescript-config
COPY services/hedger services/hedger
COPY --chmod=0755 services/hedger/docker-entrypoint.sh /usr/local/bin/noirwire-hedger

# The journal, the event log and the tape cursor live in /data, which is
# mounted writable.
ENV NODE_ENV=production \
  HEDGER_MODE=testnet \
  FILL_SOURCE=tape \
  HTTP_PORT=8701 \
  JOURNAL_FILE=/data/hedger-journal.ndjson \
  EVENTS_FILE=/data/hedger-events.ndjson \
  CURSOR_FILE=/data/tape-cursor.json

RUN mkdir /data && chown node:node /data
WORKDIR /app/services/hedger
USER node
EXPOSE 8701
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HTTP_PORT || 8701) + '/status').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/noirwire-hedger"]
