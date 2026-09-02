#!/usr/bin/env node
/**
 * run.mjs — NOCTURNE headless test harness.
 *
 *   node tools/harness/run.mjs [--url /index.html] [--frames 240] [--out tools/harness/out]
 *                              [--no-xr] [--timeout 90000] [--timeline file.js]
 *                              [--shots 3,7,11,14] [--headless-shell]
 *
 * Starts the static server on a free port, launches headless Chromium (SwiftShader
 * WebGL), injects fake-xr.js, opens the page with ?harness=1, waits for
 * window.__nocturne.ready, takes desktop screenshots, enters the fake XR session,
 * drives the scripted hand timeline deterministically for N frames while taking
 * stereo screenshots, exits XR and writes out/summary.json.
 *
 * Exit code 1 on: any pageerror, any console.error, console text matching a shader /
 * WebGL / 404 / "Failed to load" pattern, a failed or 4xx/5xx request, or a timeout.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FAKE_XR_PATH = path.join(HERE, 'fake-xr.js');
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--disable-gpu-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
];

const FAIL_PATTERNS = [
  { name: 'THREE.WebGLProgram', re: /THREE\.WebGLProgram/ },
  { name: 'Shader Error', re: /Shader Error/i },
  { name: 'WebGL: INVALID', re: /WebGL: INVALID/ },
  { name: 'GL_INVALID', re: /GL_INVALID/ },
  { name: '404', re: /\b404\b/ },
  { name: 'Failed to load', re: /Failed to load/ },
];

// ------------------------------------------------------------------ args
function parseArgs(argv) {
  const opts = {
    url: '/index.html',
    frames: 240,
    out: path.join(HERE, 'out'),
    xr: true,
    timeout: 90000,
    timeline: null,
    shots: [3, 7, 11, 14],
    desktopTimes: [0, 15, 30],
    headlessShell: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') opts.url = next();
    else if (a.startsWith('--url=')) opts.url = a.slice(6);
    else if (a === '--frames') opts.frames = parseInt(next(), 10);
    else if (a.startsWith('--frames=')) opts.frames = parseInt(a.slice(9), 10);
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a.startsWith('--out=')) opts.out = path.resolve(a.slice(6));
    else if (a === '--no-xr') opts.xr = false;
    else if (a === '--timeout') opts.timeout = parseInt(next(), 10);
    else if (a.startsWith('--timeout=')) opts.timeout = parseInt(a.slice(10), 10);
    else if (a === '--timeline') opts.timeline = path.resolve(next());
    else if (a.startsWith('--timeline=')) opts.timeline = path.resolve(a.slice(11));
    else if (a === '--shots') opts.shots = next().split(',').map(Number).filter(Number.isFinite);
    else if (a.startsWith('--shots=')) opts.shots = a.slice(8).split(',').map(Number).filter(Number.isFinite);
    else if (a === '--headless-shell') opts.headlessShell = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { process.stderr.write(`Unknown argument: ${a}\n`); printHelp(); process.exit(2); }
  }
  if (!opts.url.startsWith('/')) opts.url = '/' + opts.url;
  if (!Number.isFinite(opts.frames) || opts.frames < 1) opts.frames = 240;
  if (!Number.isFinite(opts.timeout) || opts.timeout < 1000) opts.timeout = 90000;
  return opts;
}
function printHelp() {
  process.stderr.write(`Usage: node tools/harness/run.mjs [options]
  --url <path>        page to test, relative to the repo root (default /index.html)
  --frames <N>        XR frames to run (default 240); the timeline is spread over them
  --out <dir>         output directory (default tools/harness/out)
  --no-xr             skip the fake-XR phase
  --timeout <ms>      timeout for window.__nocturne.ready (default 90000)
  --timeline <file>   extra script injected before the page (calls window.__fakeXR.setTimeline)
  --shots <s,s,..>    timeline seconds at which XR screenshots are taken (default 3,7,11,14)
  --headless-shell    use the chromium headless shell instead of new headless
  --verbose           echo console messages as they arrive
`);
}

// ------------------------------------------------------------------ helpers
const log = (msg) => process.stderr.write(`[harness] ${msg}\n`);
const now = () => performance.now();
const ms = (t) => Math.round(t);

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

async function launchChromium(preferShell) {
  const attempts = preferShell
    ? [{ name: 'chromium headless shell', opts: {} }, { name: 'chromium (new headless)', opts: { channel: 'chromium' } }]
    : [{ name: 'chromium (new headless)', opts: { channel: 'chromium' } }, { name: 'chromium headless shell', opts: {} }];
  attempts.push(
    { name: 'executablePath chromium-1194', opts: { executablePath: path.join(BROWSERS_PATH, 'chromium-1194', 'chrome-linux', 'chrome') } },
    { name: 'executablePath chromium_headless_shell-1194', opts: { executablePath: path.join(BROWSERS_PATH, 'chromium_headless_shell-1194', 'chrome-linux', 'headless_shell') } },
  );
  const failures = [];
  for (const a of attempts) {
    try {
      const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS, ...a.opts });
      return { browser, launch: a.name };
    } catch (err) {
      failures.push(`${a.name}: ${String(err.message || err).split('\n')[0]}`);
    }
  }
  throw new Error(`Could not launch Chromium:\n  ${failures.join('\n  ')}`);
}

// ------------------------------------------------------------------ main
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = now();
  const timings = {};
  const errors = [];     // { kind, text }
  const warnings = [];   // { kind, text }
  const consoleLog = []; // { level, text, location }
  const stats = {};
  const screenshots = [];
  const seenFailureTexts = new Set();
  const addError = (kind, text) => {
    const key = `${kind}:${text}`;
    if (seenFailureTexts.has(key)) return;
    seenFailureTexts.add(key);
    errors.push({ kind, text });
  };

  await fs.mkdir(opts.out, { recursive: true });
  try { await fs.access(path.join(opts.out, '.gitignore')); } catch { await fs.writeFile(path.join(opts.out, '.gitignore'), '*\n!.gitignore\n'); }

  // timeline script (optional)
  let timelineSource = null;
  if (opts.timeline) timelineSource = await fs.readFile(opts.timeline, 'utf8');

  const server = await startServer(REPO_ROOT, 0);
  const pageUrl = `${server.url}${opts.url}${opts.url.includes('?') ? '&' : '?'}harness=1`;
  log(`server ${server.url}/  (root ${REPO_ROOT})`);

  let browser = null;
  let launchName = null;
  const summary = {
    ok: false,
    url: pageUrl,
    startedAt: new Date().toISOString(),
    playwright: null,
    options: { frames: opts.frames, xr: opts.xr, timeout: opts.timeout, shots: opts.shots, timeline: opts.timeline },
    timings,
    errors,
    warnings,
    stats,
    screenshots,
    fakeXR: null,
    console: consoleLog,
  };

  try {
    const tl = now();
    ({ browser, launch: launchName } = await launchChromium(opts.headlessShell));
    timings.launchMs = ms(now() - tl);
    summary.playwright = { version: await playwrightVersion(), launch: launchName, browserVersion: browser.version() };
    log(`chromium ${browser.version()} via ${launchName} (${timings.launchMs} ms)`);

    const context = await browser.newContext({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeout);
    await page.addInitScript({ path: FAKE_XR_PATH });
    if (timelineSource) await page.addInitScript({ content: timelineSource });

    page.on('console', (msg) => {
      const level = msg.type();
      const text = msg.text();
      const loc = msg.location();
      consoleLog.push({ level, text, location: loc && loc.url ? `${loc.url}:${loc.lineNumber}` : undefined });
      if (opts.verbose) log(`console.${level}: ${text}`);
      const reasons = [];
      if (level === 'error') reasons.push('console.error');
      for (const p of FAIL_PATTERNS) if (p.re.test(text)) reasons.push(`pattern:${p.name}`);
      if (reasons.length) addError(reasons.join('+'), text);
      else if (level === 'warning' || level === 'warn') warnings.push({ kind: 'console.warn', text });
    });
    page.on('pageerror', (err) => addError('pageerror', `${err.message}${err.stack ? '\n' + err.stack.split('\n').slice(1, 4).join('\n') : ''}`));
    page.on('requestfailed', (req) => {
      const f = req.failure();
      const reason = f ? f.errorText : 'unknown';
      if (reason === 'net::ERR_ABORTED') { warnings.push({ kind: 'requestaborted', text: `${req.method()} ${req.url()}` }); return; }
      addError('requestfailed', `${req.method()} ${req.url()} — ${reason}`);
    });
    page.on('response', (res) => { if (res.status() >= 400) addError('http', `HTTP ${res.status()} ${res.request().method()} ${res.url()}`); });
    page.on('crash', () => addError('crash', 'page crashed'));

    // ---- load + ready
    const tr = now();
    log(`opening ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'load', timeout: opts.timeout });
    try {
      await page.waitForFunction(() => !!(window.__nocturne && window.__nocturne.ready), null, { timeout: opts.timeout, polling: 100 });
      const remaining = Math.max(1000, opts.timeout - (now() - tr));
      await withTimeout(page.evaluate((limit) => Promise.race([
        window.__nocturne.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('ready promise did not resolve in time')), limit)),
      ]), remaining), remaining + 2000, 'window.__nocturne.ready');
    } catch (err) {
      addError('timeout', `window.__nocturne.ready: ${err.message}`);
      throw err;
    }
    timings.readyMs = ms(now() - tr);
    log(`ready after ${timings.readyMs} ms`);
    await raf(page, 2);
    stats.ready = await getStats(page);

    const shot = async (name) => {
      const file = path.join(opts.out, name);
      await page.screenshot({ path: file, type: 'png' });
      screenshots.push(file);
      log(`screenshot ${name}`);
      return file;
    };
    const call = async (label, fn, arg) => {
      try { return await withTimeout(page.evaluate(fn, arg), 20000, label); }
      catch (err) { addError('contract', `${label}: ${err.message.split('\n')[0]}`); return undefined; }
    };

    // ---- desktop phase
    const td = now();
    await call('look(0,0)', () => window.__nocturne.look(0, 0));
    await call(`setTime(${opts.desktopTimes[0]})`, (t) => window.__nocturne.setTime(t), opts.desktopTimes[0]);
    await raf(page, 3);
    await shot('desktop_0.png');
    stats.desktop_0 = await getStats(page);

    await call('look(90,10)', () => window.__nocturne.look(90, 10));
    await call(`setTime(${opts.desktopTimes[1]})`, (t) => window.__nocturne.setTime(t), opts.desktopTimes[1]);
    await raf(page, 3);
    await shot('desktop_1.png');
    stats.desktop_1 = await getStats(page);

    await call('look(-60,-25)', () => window.__nocturne.look(-60, -25));
    await call('setHand(submerged, pinch)', () => window.__nocturne.setHand({ x: 0.6, y: 0.6, pinch: true, submerged: true }));
    await call(`setTime(${opts.desktopTimes[2]})`, (t) => window.__nocturne.setTime(t), opts.desktopTimes[2]);
    await raf(page, 3);
    await shot('desktop_2.png');
    stats.desktop_2 = await getStats(page);
    timings.desktopMs = ms(now() - td);

    // ---- XR phase
    if (opts.xr) {
      const tx = now();
      await call('setHand(release)', () => window.__nocturne.setHand({ x: 0.5, y: 0.5, pinch: false, submerged: false }));
      log('entering XR');
      let entered = true;
      try {
        await withTimeout(page.evaluate(() => window.__nocturne.enterXR()), 30000, 'enterXR()');
        await page.waitForFunction(() => window.__nocturne.stats().xr === true, null, { timeout: 30000, polling: 100 });
      } catch (err) {
        addError('xr', `enterXR: ${err.message.split('\n')[0]}`);
        entered = false;
      }
      if (entered) {
        const duration = await page.evaluate(() => window.__fakeXR.timeline.duration);
        const step = duration / opts.frames;
        const startFrames = await page.evaluate((s) => {
          const c = window.__fakeXR.clock;
          c.mode = 'manual'; c.step = s; c.set(0);
          return window.__fakeXR.frames;
        }, step);
        const perFrameBudget = 1500;
        const xrTimeout = Math.max(60000, opts.frames * perFrameBudget);
        log(`XR presenting; running ${opts.frames} frames, timeline ${duration} s (step ${step.toFixed(4)} s/frame)`);
        const shots = opts.shots.filter((s) => s <= duration);
        for (const s of opts.shots) if (s > duration) warnings.push({ kind: 'harness', text: `--shots ${s} exceeds timeline duration ${duration}; skipped` });
        try {
          for (const T of shots) {
            await page.waitForFunction((t) => window.__fakeXR.clock.time >= t, T, { timeout: xrTimeout, polling: 50 });
            const name = `xr_t${Number.isInteger(T) ? T : String(T).replace('.', '_')}.png`;
            await shot(name);
            const key = name.replace('.png', '');
            stats[key] = await getStats(page);
            stats[key].fakeXR = await page.evaluate(() => window.__fakeXR.getState());
          }
          await page.waitForFunction((n) => window.__fakeXR.frames >= n, startFrames + opts.frames, { timeout: xrTimeout, polling: 50 });
        } catch (err) {
          addError('xr', `XR frame loop: ${err.message.split('\n')[0]}`);
        }
        const framesRun = await page.evaluate(() => window.__fakeXR.frames);
        log(`XR frames delivered: ${framesRun}`);
        try {
          await withTimeout(page.evaluate(() => window.__nocturne.exitXR()), 20000, 'exitXR()');
          await page.waitForFunction(() => window.__nocturne.stats().xr === false, null, { timeout: 20000, polling: 100 });
        } catch (err) {
          addError('xr', `exitXR: ${err.message.split('\n')[0]}`);
        }
        await raf(page, 2);
        stats.afterExit = await getStats(page);
        if (stats.afterExit && stats.afterExit.xr !== false) addError('xr', `stats().xr is ${JSON.stringify(stats.afterExit.xr)} after exitXR()`);
        summary.fakeXR = await page.evaluate(() => ({
          frames: window.__fakeXR.frames,
          sessions: window.__fakeXR.sessions,
          timeline: window.__fakeXR.timeline.name,
          duration: window.__fakeXR.timeline.duration,
          warnings: window.__fakeXR.warnings.slice(),
          events: window.__fakeXR.events.slice(),
        }));
        for (const w of summary.fakeXR.warnings) warnings.push({ kind: 'fake-xr', text: w });
        if (!summary.fakeXR.events.some((e) => e.type === 'selectstart') && summary.fakeXR.timeline === 'default') {
          warnings.push({ kind: 'fake-xr', text: 'no selectstart event was generated by the default timeline (hands not connected?)' });
        }
      }
      timings.xrMs = ms(now() - tx);
    }

    // app-reported errors
    const last = stats.afterExit || stats.desktop_2 || stats.ready;
    if (last && Array.isArray(last.errors) && last.errors.length) for (const e of last.errors) addError('app.errors', String(e));
  } catch (err) {
    if (!errors.some((e) => e.text.includes(err.message))) addError('harness', err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  timings.totalMs = ms(now() - t0);
  summary.ok = errors.length === 0;
  summary.finishedAt = new Date().toISOString();
  const summaryPath = path.join(opts.out, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  const printed = { ...summary, console: `${consoleLog.length} console message(s) — see ${summaryPath}` };
  process.stdout.write(JSON.stringify(printed, null, 2) + '\n');
  if (summary.ok) {
    log(`PASS — ${screenshots.length} screenshot(s) in ${opts.out}, ${warnings.length} warning(s), ${timings.totalMs} ms`);
  } else {
    log(`FAIL — ${errors.length} error(s):`);
    for (const e of errors) log(`  [${e.kind}] ${e.text.split('\n')[0]}`);
  }
  process.exitCode = summary.ok ? 0 : 1;
}

async function playwrightVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(new URL(import.meta.resolve('playwright/package.json')), 'utf8'));
    return pkg.version;
  } catch {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'node_modules', 'playwright', 'package.json'), 'utf8'));
      return pkg.version;
    } catch { return 'unknown'; }
  }
}

function raf(page, n = 1) {
  return page.evaluate((count) => new Promise((resolve) => {
    let i = 0;
    const step = () => { if (++i >= count) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n).catch(() => {});
}

function getStats(page) {
  return page.evaluate(() => {
    try {
      const s = window.__nocturne && typeof window.__nocturne.stats === 'function' ? window.__nocturne.stats() : null;
      return s ? JSON.parse(JSON.stringify(s)) : { error: 'window.__nocturne.stats() unavailable' };
    } catch (e) { return { error: String(e) }; }
  }).catch((e) => ({ error: String(e.message || e) }));
}

main().catch((err) => {
  process.stderr.write(`[harness] fatal: ${err.stack || err}\n`);
  process.exit(1);
});
