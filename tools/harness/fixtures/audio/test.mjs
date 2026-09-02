#!/usr/bin/env node
/**
 * Runs the audio fixture under headless Chromium and prints its report.
 *   node tools/harness/fixtures/audio/test.mjs [--nobuffers] [--verbose]
 * Exit code 1 on any page error, console.error, fixture-reported error or timeout.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--mute-audio'];
const verbose = process.argv.includes('--verbose');
const query = process.argv.includes('--nobuffers') ? '?harness=1&nobuffers=1' : '?harness=1';

const server = await startServer(REPO_ROOT, 0);
let browser;
try { browser = await chromium.launch({ headless: true, args: ARGS, channel: 'chromium' }); }
catch { browser = await chromium.launch({ headless: true, args: ARGS }); }
const problems = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (verbose) console.log(`console.${m.type()}: ${m.text()}`); if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url()}`); });
  await page.goto(`${server.url}/tools/harness/fixtures/audio/index.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__audioTest && window.__audioTest.report, null, { timeout: 120000, polling: 200 });
  const report = await page.evaluate(() => window.__audioTest.report);
  for (const e of report.errors || []) problems.push('fixture: ' + e);
  console.log(JSON.stringify({ ...report, problems }, null, 1));
} catch (err) {
  problems.push('runner: ' + (err.stack || err));
  console.log(JSON.stringify({ ok: false, problems }, null, 1));
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
process.exit(problems.length ? 1 : 0);
