# Web image: stock Caddy with the Caddyfile and the static apps/web build baked
# in (A§3, A§12.1; P1f). Bases pinned by digest. Build context: the repository
# root, through the allowlist in /.dockerignore:
#   docker build -f deploy/web/Dockerfile --build-arg F1_REVISION=<sha> .
FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# pnpm 12 is a native binary: the sha512-pinned script, never corepack.
RUN scripts/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
RUN pnpm install --frozen-lockfile && pnpm --filter @f1/web build

FROM caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f
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
