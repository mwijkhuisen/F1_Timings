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

## Amendment 2026-10-30 (P2c)

- **Token path (owner decision O1):** the `live` container sees only the host directory `/srv/f1/state/live`, mounted at `/srv/f1/state`. So the token file is `/srv/f1/state/live/f1tv-token` on the host (the owner pastes there) and `/srv/f1/state/f1tv-token` in the container. The rest of `/srv/f1/state` holds `current.env`, which picks what root deploys, and stays root-only. The decision above names `/srv/f1/state/f1tv-token`; that is the container path.
- **Login timing (owner decision O4):** `live` logs in when a session starts within 48 h and the token does not cover that session's end + 1 h, replacing "when the cached token expires within the next session window + 1 h". It warns before expiry (under 24 h) only when a session is due within 48 h, and always warns on a failed login.
- **Limits (P2a security review):** one login per 10 min, and one per 6 h after 3 failures in a row, kept in the database so a restart does not reset them. A token the feed rejects is ignored until the file changes.
- `archive` is not built yet: until P3 only `live` is the consumer of `f1tv_username` and `f1tv_password` (GIDs 62007 and 62008).
