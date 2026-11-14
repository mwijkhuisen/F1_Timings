# Web image: stock Caddy with the Caddyfile and the static apps/web build baked
# in (A§3, A§12.1; P1f). Bases pinned by digest. Build context: the repository
# root, through the allowlist in /.dockerignore:
#   docker build -f deploy/web/Dockerfile --build-arg F1_REVISION=<sha> .
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# pnpm 12 is a native binary: the sha512-pinned script, never corepack.
RUN scripts/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
# The build embeds it as the `?v=` cache key of the per-session requests (vite.config.ts, A§10).
ARG F1_REVISION=dev
RUN pnpm install --frozen-lockfile && pnpm --filter @f1/web build

FROM caddy:2.11.8-alpine@sha256:f6228111e5fafa1a5238258d0858e103f10599b8d1659a146e7726681a002bb9
# The stock binary carries a cap_net_bind_service file capability, and the
# kernel refuses to exec such a binary under cap_drop: ALL (caddy-docker#396).
# A plain copy drops the xattr. Caddy runs as uid 62532 with no capability and
# binds :80 through the container's net.ipv4.ip_unprivileged_port_start
# (compose sets the sysctl). /data and /config are tmpfs in compose.
RUN cp /usr/bin/caddy /usr/bin/caddy.plain \
  && mv /usr/bin/caddy.plain /usr/bin/caddy \
  && mkdir -p /data /config \
  && chown -R 62532:62532 /data /config
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/web/dist /srv/www
# A Caddyfile error fails the image build. validate starts no listener and makes
# no network call (admin off, auto_https off); XDG goes to /tmp so that the root
# build step leaves nothing in /data or /config.
RUN ["env", "XDG_DATA_HOME=/tmp", "XDG_CONFIG_HOME=/tmp", "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
# The git commit of the release (CI passes it); `dev` for any other build.
ARG F1_REVISION=dev
LABEL org.opencontainers.image.source=https://github.com/mwijkhuisen/F1_Timings \
  org.opencontainers.image.revision=${F1_REVISION}
USER 62532:62532
