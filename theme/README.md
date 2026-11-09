# Dark theme toggle: evidence

Local harness only (`~/.cache/f1-dev/theme`, never committed to the app branch). The production build (`apps/web/dist`) is served with the production Caddy headers, including the strict CSP, and the P5c stand-in API (Monaco 2023 race, Weather tab). Windows Edge headless runs `shot.html`, which loads the app in an iframe, optionally clears the saved pick, clicks the moon after 7 s, and posts a report (`*.txt`).

- `light-*` start from a light system (`preferredColorScheme=1`), `dark-*` from a dark one.
- `*-1-system`: no saved pick, so the page follows the system.
- `*-2-moon`: the same page after a click on the moon. The screenshot is taken after the click.
- `*-reload.txt`: a click, then a reload of the iframe. The pick is kept (`reloaded`).

Each report has `theme` (`data-theme`), `pressed` (`aria-pressed`), the body background, the moon's box (x, y, w, h), the chart canvas count, horizontal overflow, the stored pick and the page's errors and CSP violations, before and after the click.
