# Runbook: Cloudflare tunnel and Access

Owner actions A2 and A3 (A§12.2, ADR-0004). The F1 stack has its own tunnel and Access application; it shares nothing with Waterheight's (invariant 5). `<F1 hostname>` is a hostname on your Cloudflare zone, `<team>` your Zero Trust team name (`<team>.cloudflareaccess.com`).

## A2: tunnel, token file, public hostname [owner]

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared. Name it `f1`. This is a new tunnel, not Waterheight's.
2. On the install step, copy the token only (the long string after `--token` or `service install`). Do not run the shown install command.
3. [box] Put the token in the secret file, one line:

   ```bash
   sudo nano /etc/f1/secrets/cf_tunnel_token
   sudo ls -l /etc/f1/secrets/cf_tunnel_token
   ```

   Expected: `-r--r----- 1 root 62005 …`. The container reads it with `--token-file`; it is never an environment variable.
4. Public hostname: `<F1 hostname>`, service type HTTP, URL `caddy:80`. (`http://caddy:80`; cloudflared reaches caddy on the internal `f1-tunnel-edge` network by that name.)
5. Zone settings for `<F1 hostname>`: turn off every feature that injects a script or rewrites the HTML, because the strict CSP (`script-src 'self'`) blocks them and the page would break or log violations:
   - Speed → Optimization → Rocket Loader: off
   - Scrape Shield → Email Address Obfuscation: off
   - Web Analytics: automatic setup (auto-inject) off for this hostname
   - Zaraz: no tool or tracking enabled for this hostname
   - (a Configuration Rule scoped to `<F1 hostname>` does this without touching other hostnames on the zone)
6. [box] After the first deploy (`install.md`, step 6), the tunnel is up:

   ```bash
   sudo docker ps --filter name=f1-cloudflared --format '{{.Names}} {{.Status}}'
   sudo docker logs --tail 20 f1-cloudflared-1
   ```

   Expected: `f1-cloudflared-1 Up … (healthy)`, and log lines such as `Registered tunnel connection … location=…` (up to four). In the dashboard the tunnel shows Healthy.

## A3: Access application [owner]

1. Zero Trust → Access → Applications → Add an application → Self-hosted. Application domain `<F1 hostname>`. Session duration 24 hours.
2. Identity providers: One-time PIN only.
3. Policy: name `owner`, action Allow, include Emails: your email address. No other rule, no "everyone", no Bypass policy.
4. Save. Copy the Application Audience (AUD) tag from the application's overview (64 hex characters). The team name is the `<team>` part of `<team>.cloudflareaccess.com` (Zero Trust → Settings → Custom pages, or the URL of the Access login page).
5. [box] Put both in `/etc/f1/f1.env`, exactly these two lines, no quotes:

   ```
   CF_ACCESS_TEAM=<team>
   CF_ACCESS_AUD=<64 hex characters>
   ```

   ```bash
   sudo nano /etc/f1/f1.env
   sudo systemctl start f1-update.service
   sudo journalctl -u f1-update -n 10 --no-pager
   ```

   Expected: `deployed …` or `up to date …`, not `not configured`. The team must match `^[a-z0-9][a-z0-9-]{0,62}$` and the AUD `^[0-9a-f]{64}$`; otherwise `f1-update` logs `not configured` and the api (exit 78) does not start. If the api was already running with other values, recreate it: `sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env up -d --force-recreate api`.

## Access checklist [owner]

Run it from a browser outside the VM, after A2, A3 and the first deploy.

- [ ] Private window, `https://<F1 hostname>/`, not logged in: the Cloudflare Access login page appears, not the site.
- [ ] Enter your email: a one-time PIN arrives; entering it opens the site, and the lap data loads (the browser console shows no CSP violation).
- [ ] A different email address: the PIN request is accepted but no PIN arrives, or the login ends with "denied"; the site is never shown.
- [ ] `curl -sI https://<F1 hostname>/api/v1/seasons` without a cookie: a redirect (302) to `<team>.cloudflareaccess.com`, not JSON.
- [ ] After 24 hours the session ends and the login page returns.

## Refreshing the Cloudflare ranges [box]

`deploy/host/nftables-f1.conf` holds two sets, both fetched 2026-10-29 (A§14.3):

| Set | Used by | Source |
|---|---|---|
| `cf4` | `api`, tcp/443 to `<team>.cloudflareaccess.com` | https://www.cloudflare.com/ips-v4 |
| `cf_tunnel4` | `cloudflared`, tcp+udp/7844 | `198.41.192.0/24` and `198.41.200.0/24`, from Cloudflare's "Tunnel with firewall" documentation (developers.cloudflare.com, Cloudflare One, Cloudflare Tunnel) |

Symptoms of a stale set: `/api` answers 503 `unavailable` once the cached Access certs are over an hour old (`cf4`); `cloudflared` shows no connections (`cf_tunnel4`). To refresh:

```bash
curl -fsS https://www.cloudflare.com/ips-v4
```

Compare with the `cf4` elements in the repository file, edit them there (a PR; the sets stay IPv4, `flags interval`), merge, then on the VM:

```bash
cd ~/F1_Timings
git pull --ff-only
sudo deploy/bin/f1-install
```

Expected: `changed  /etc/f1/nftables-f1.conf`, `changed  f1-firewall.service restarted (table inet f1 reloaded)`, `f1-install: 2 change(s)` (or more). Check:

```bash
sudo nft list set inet f1 cf4
sudo nft list set inet f1 cf_tunnel4
```

A set edited by hand with `nft add element` is lost at the next reload; the file in the repository is the source.
