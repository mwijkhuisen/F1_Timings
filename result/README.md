# #110 evidence: the Result tab at 390 px

- **Build:** the production build of `claude/result-tab`, served with the production Caddy headers (the strict CSP) by a local static server. It ran against a local API on the dev backfill database (OpenF1 data only), with Cloudflare Access bypassed on loopback.
- **Browser:** Windows Edge headless, dark scheme. The page sits in a 390 px iframe inside a wider window, because Edge clamps headless windows to about 500 px.
- **Reports:** each `.txt` is the page's own report. `errs` lists CSP violations and script errors, and is empty in both. `overflow` is false: the page has no horizontal scroll, and the table scrolls inside its own box.

| Shot | Session |
|---|---|
| `race-390.png` | Mexico City 2026 race (11404). The winner's time is 2:20:28.772 (two red flags), then gaps, "+n laps" for the retirements, and the caption. |
| `quali-390.png` | Austin 2026 qualifying (11392). Q1 with its gaps; Q2 and Q3 scroll in from the right. |
