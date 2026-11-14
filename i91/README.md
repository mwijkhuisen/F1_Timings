# Evidence for #91 (PR #181): circuit layouts on the season page

All data is invented: a local stand-in API serves a made-up 2026 season (no real F1 data). Nothing here is in the repository.

Shots, path `/2026`, 390 and 1440 px wide, dark and light, full page height (`season-<scenario>-<width>-<theme>.png`):

- `season-weekend-*`: now is in the Sao Paulo weekend (after FP2, before FP3). This weekend = Sao Paulo, Up next = Practice 3 with the big layout under it.
- `season-grace-*`: now is after the Sao Paulo Race but less than 24 h later. This weekend is still Sao Paulo, there is no Up next (the next session is Las Vegas), the big layout stays.
- Each card shows its circuit outline as a thumbnail; the cancelled Bahrain meeting's outline is muted.
- `preview.png`: all 26 outlines with their start/finish mark (red bar). Only Madring (es-2026) and Silverstone (gb-1948) have one; the rest are "no mark (not sourced)".
- `shots.log`: one line per shot with the page's checks: no CSP violations (`errs []`), no horizontal overflow, one outline with a track path per card, the big layout present, "Up next" present or absent as expected, the credit line present. A line says PROBLEM when a check fails; none does.

The "A new version is out" line at the top is the stand-in's missing build revision, not the app.
The owner deletes this branch after review.

The stand-in answers /api/v1/status with 404 (its inherited status predates the current contract and would mark the page stale); the header shows nothing for an error. Built from 9c3481d.
