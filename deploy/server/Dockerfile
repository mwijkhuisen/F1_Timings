# Server image: every role of apps/server (A§3, A§4; P1f). Built on node:26
# trixie-slim, run on distroless nodejs26 as uid 62532. Bases are pinned by
# digest. Build context: the repository root, through the allowlist in
# /.dockerignore:
#   docker build -f deploy/server/Dockerfile --build-arg F1_REVISION=<sha> .
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
# The `migrate` role runs the dbmate release binary, checked against its pinned
# sha256 (the same pin as .github/workflows/ci.yml).
ARG DBMATE_VERSION=2.36.0
ADD --checksum=sha256:47e284b3d8cbad1ba5f090495aa05afd1bbd5f35e2ed5577aad06da74ce780ce \
  https://github.com/amacneil/dbmate/releases/download/v${DBMATE_VERSION}/dbmate-linux-amd64 \
  /tmp/dbmate
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# pnpm 12 is a native binary: the sha512-pinned script, never corepack.
RUN scripts/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
# `tsc -b apps/server` also builds packages/contracts to its dist/ (a project
# reference); `pnpm deploy` copies the "files" (dist) of the workspace
# packages into the output's node_modules.
RUN pnpm install --frozen-lockfile \
  && node_modules/.bin/tsc -b apps/server \
  && pnpm --filter @f1/server deploy --prod /out/apps/server \
  && mkdir -p /out/db \
  && cp -r db/migrations /out/db/migrations \
  && chmod 0755 /tmp/dbmate

# Layout: node runs /app/apps/server/dist/main.js; migrate.ts resolves
# ../../../../db/migrations from dist/db/migrate.js to /app/db/migrations; the
# dbmate binary is on the distroless PATH (/usr/local/bin is in it).
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531
WORKDIR /app
COPY --from=build /out /app
COPY --from=build --chmod=0755 /tmp/dbmate /usr/local/bin/dbmate
# The workspace packages resolve to their compiled dist/ (Node does not strip
# types inside node_modules); dev and tests keep running from src/.
ENV NODE_OPTIONS=--conditions=f1-dist
# The git commit of the release (CI passes it); `dev` for any other build.
ARG F1_REVISION=dev
# Not a secret (it is also the public label below): the api reports it as `F1-Revision` and checks a request's `v` (A§10).
ENV F1_REVISION=${F1_REVISION}
LABEL org.opencontainers.image.source=https://github.com/mwijkhuisen/F1_Timings \
  org.opencontainers.image.revision=${F1_REVISION}
USER 62532:62532
ENTRYPOINT ["/nodejs/bin/node", "/app/apps/server/dist/main.js"]
