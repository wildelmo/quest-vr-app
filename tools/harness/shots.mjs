// Desktop-mode screenshots in given directions: node tools/harness/shots.mjs name:yaw:pitch [...]
// e.g. node tools/harness/shots.mjs moon:-78:12 back:180:8 up:-20:55
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = process.argv.slice(2).filter((a) => a.includes(':')).map((a) => { const [n, y, p] = a.split(':'); return [n, +y, +p]; });
const { server, port } = await startServer(root, 0);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await page.goto(`http://127.0.0.1:${port}/index.html?harness=1`);
await page.waitForFunction(() => window.__nocturne && window.__nocturne.ready, null, { timeout: 90000 });
await page.evaluate(() => window.__nocturne.ready);
for (const [name, yaw, pitch] of shots) {
  await page.evaluate(([y, p]) => window.__nocturne.look(y, p), [yaw, pitch]);
  for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  await page.screenshot({ path: path.join(root, 'tools/harness/out', `${name}.png`) });
}
console.log(JSON.stringify(await page.evaluate(() => { const s = window.__nocturne.stats(); return { moonAlt: s.moonAltitudeDeg, errors: s.errors }; })));
await browser.close(); server.close();
