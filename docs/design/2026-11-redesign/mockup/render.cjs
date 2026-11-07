// Screenshot every frame of out/preview.html: node render.cjs <absolute path of preview.html> <out dir> <dark|light> [delta] [scale]
// Needs Playwright with Chromium (preinstalled in Claude Code cloud sessions; not a dependency of this repository).
const { chromium } = require('playwright');

const [file, out, theme, delta, scale] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1340, height: 900 }, deviceScaleFactor: Number(scale || 1) });
  await page.goto(`file://${file}?theme=${theme}${delta === 'delta' ? '&delta=1' : ''}`);
  await page.waitForTimeout(400);
  for (const el of await page.$$('section.frame')) {
    const id = await el.getAttribute('id');
    await el.screenshot({ path: `${out}/${id}-${theme}${delta === 'delta' ? '-delta' : ''}.png` });
  }
  await browser.close();
  console.log('done');
})();
