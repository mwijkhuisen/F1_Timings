# ADR-0005: F1 TV credentials and token handling

- **Status:** Accepted (owner, 2026-10-25)
- **Date:** 2026-10-25
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-10-25)
- **Revisit:** after the P2a spike, or when F1 changes its login.

## Context

- The live feed (fully, since the 2025 Dutch GP) and the archive (since Oct 2026) need an F1 TV Access/Pro/Premium token. The owner has Pro, without 2FA.
- FastF1 3.9.0 (MIT) logs in with OAuth2 Authorization Code + PKCE against `id.formula1.com` (PingOne DaVinci, `response_mode=pi.flow`), using JSON calls only. The access token's `subscriptionToken` claim is sent as `Authorization: Bearer`. It lasts ~4 days and comes with no refresh token.

## Decision

- Email and password are file secrets (`f1tv_username`, `f1tv_password`), readable only by the `live` and `archive` containers' GID.
- A TS port of the FastF1 login flow (keeping the MIT notice) runs automatically when the cached token expires within the next session window + 1 h.
- The token is cached at `/srv/f1/state/f1tv-token` (mode 0600). The token and password never appear in logs or errors; only the expiry does.
- Fallback: the owner pastes the `login-session` cookie value from formula1.com into the token file, as undercut-f1 documents.
- Data fetched with the token stays behind Access and is never committed (A§12.1 #3).

## Consequences

- Recording runs unattended as long as the login flow is stable.
- If F1 adds bot protection or 2FA, recording needs a manual paste every ~4 days. The status panel warns 24 h before expiry.
