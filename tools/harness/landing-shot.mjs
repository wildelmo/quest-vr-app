// Screenshots of the landing page (desktop + phone widths): node tools/harness/landing-shot.mjs
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { server, port } = await startServer(root, 0);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--mute-audio'] });
for (const [name, w, h] of [['landing_desktop', 1400, 800], ['landing_phone', 400, 820]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.__nocturne && window.__nocturne.ready, null, { timeout: 90000 });
  await page.evaluate(() => window.__nocturne.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(root, 'tools/harness/out', `${name}.png`) });
  await page.close();
}
await browser.close(); server.close();
console.log('ok');
