# ADR-0004: Own Cloudflare Tunnel + Access, JWT checked at the origin

- **Status:** Accepted (owner, 2026-10-25); amended in P1c (2026-10-26), see below
- **Date:** 2026-10-25
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-10-25)

## Context

- The owner wants to reach the site from anywhere, logging in with an email one-time PIN.
- Waterheight's ADR-0021 fixes that its tunnel carries exactly one public hostname and that its `cloudflared` reaches only Waterheight's `caddy:80`.

## Decision

- Its own tunnel and its own `cloudflared` container in the `f1` project, reaching only F1's `caddy:80` over an internal network. The token is a file secret.
- A Cloudflare Access application on the F1 hostname with one allow policy: the owner's email, logging in by one-time PIN.
- The `api` verifies the `Cf-Access-Jwt-Assertion` header (signature, `aud`, `iss`) on every `/api` request, using `hono/jwk` against the team's certs endpoint.

### Amended (P1c, 2026-10-26)

- The check is our own middleware (`apps/server/src/api/access.ts`) on hono's `verifyWithJwks` and `decode`, not the `hono/jwk` middleware. In hono 4.13.13 that middleware refuses any header value that is not `Bearer <token>`, while Cloudflare sends the bare JWT in `Cf-Access-Jwt-Assertion`, so it would refuse every request; it also fetches the certs on every request. The middleware also requires `exp` (hono skips an absent one), allows `nbf` 60 s of clock skew, and does not check `iat` (A§10).
- The `api` therefore reaches Cloudflare: tcp/443 to Cloudflare's published IP ranges only, for the team's certs, and no other egress (owner, 2026-10-26; A§14.3, built in P1f).

## Consequences

- Waterheight's tunnel, invariants and tests stay untouched.
- Cloudflare sees all traffic, which is acceptable for a personal site.
- A misconfigured Access policy still can't expose data, because the API refuses requests without a valid JWT. The static SPA holds no F1 data.

## Alternatives rejected

- **An extra hostname on Waterheight's tunnel:** breaks ADR-0021.
- **LAN or WireGuard only:** the owner wants access from anywhere without a VPN client.
