import * as THREE from 'three';
import { CONFIG } from '../config.js';

/**
 * SFX — the responses. An 8-voice FM bell pool (glass 3.5 / ceramic 1.41 ratios, oldest-note
 * stealing, index softened when many bells ring at once), layered CC0 bowl/ting samples tuned to
 * the same note, paper rustle / whoosh / splash for the lanterns, a synthesized crackle on the
 * three nearest lanterns, the per-hand water swish (HRTF), the player's own wading rush, hand
 * enter/exit plips and ticks, the calm-reward drone, and the aurora voice after a star is born.
 *
 * Node budget (persistent): bells 8 × 6 = 48, crackle 3 × 3 = 9, swish 2 × 2 = 4, glide 2,
 * calm drone 5, noise sources 2 ≈ 70. HRTF only on the two hand swishes.
 */
const LOOKAHEAD = 0.15;
const BELL_POOL = 8;
const CRACKLE_SLOTS = 3;
const ROOT = CONFIG.music?.rootMidi ?? 62;
const PENTA = [0, 3, 5, 7, 10];
const BELL_KINDS = { glass: { ratio: 3.5, index: 2.2 }, ceramic: { ratio: 1.41, index: 1.6 } };
const BOWLS = ['bowl_1', 'bowl_2', 'bowl_3', 'bowl_4', 'bowl_5', 'bowl_6', 'bowl_7'];
const TINGS = ['ting_1', 'ting_2', 'ting_3', 'ting_4'];
const SPLASHES = ['splash_soft_1', 'splash_soft_2', 'splash_soft_3', 'splash_soft_4'];

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mod12 = (n) => ((n % 12) + 12) % 12;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
function holdAt(p, t) {
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else { p.cancelScheduledValues(t); p.setValueAtTime(Math.max(0.0001, p.value), t); }
}
const _v = new THREE.Vector3(), _h = new THREE.Vector3();
const hasXYZ = (p) => !!p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number';

/** Public helper for other subsystems (music raindrops). Returns the pool voice or null before start(). */
export function fmBell(api, ctx, opts) { return sfx._s ? triggerBell(sfx._s, opts) : null; }

export const sfx = {
  name: 'sfx',
  _s: null,

  start(api, ctx) {
    if (this._s) this.stop();
    const c = api.context;
    if (!c || !api.bus) return;
    const now = c.currentTime;
    const rng = ctx.harness ? makeRng(0x5F3C0DE1) : Math.random;
    const S = {
      api, ctx, c, rng, offs: [], t0: now, ctrlAcc: 0, slowAcc: 0, crackleAcc: 0,
      out: { world: api.buses?.world || api.bus, chimes: api.buses?.chimes || api.bus, music: api.buses?.music || api.bus },
      bells: [], bellTimes: [], playerNotes: [], fireflyCount: 0, auroraAt: 0, auroraNotes: [],
    };
    this._s = S;
    S.arc = () => clamp((c.currentTime - S.t0) / 1200, 0, 1);
    S.head = () => ctx.playerCtl?.state?.headWorld || (ctx.camera ? ctx.camera.getWorldPosition(_h) : _h.set(0, 1.6, 0));

    // shared looping noise sources
    S.noiseWhite = c.createBufferSource(); S.noiseWhite.buffer = api.noise('white', 4); S.noiseWhite.loop = true; S.noiseWhite.start(now);
    S.noisePink = c.createBufferSource(); S.noisePink.buffer = api.noise('pink', 4); S.noisePink.loop = true; S.noisePink.start(now);

    // ---- FM bell pool: mod → modGain → car.frequency; car → env → panner (chimes) and env → send → reverb
    for (let i = 0; i < BELL_POOL; i++) {
      const car = c.createOscillator(); car.type = 'sine'; car.frequency.value = 440;
      const mod = c.createOscillator(); mod.type = 'sine'; mod.frequency.value = 1540;
      const mg = c.createGain(); mg.gain.value = 0;
      const env = c.createGain(); env.gain.value = 0.0001;
      const send = c.createGain(); send.gain.value = 0;
      const pa = api.spatial({ refDistance: 2, rolloff: 1.1, out: S.out.chimes });
      mod.connect(mg); mg.connect(car.frequency); car.connect(env); env.connect(pa.input); env.connect(send); send.connect(api.wet);
      car.start(now); mod.start(now);
      S.bells.push({ car, mod, mg, env, send, pa, busy: false, startedAt: -1, endAt: 0, tag: '' });
    }

    // ---- lantern crackle slots: pink noise → band-pass 2.5 kHz → gate (micro-bursts) → panner (level on pa.input)
    S.crackle = [];
    for (let i = 0; i < CRACKLE_SLOTS; i++) {
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2500; bp.Q.value = 1;
      const gate = c.createGain(); gate.gain.value = 0;
      const pa = api.spatial({ refDistance: 0.6, rolloff: 1.3, out: S.out.world });
      pa.input.gain.value = 0;
      S.noisePink.connect(bp); bp.connect(gate); gate.connect(pa.input);
      S.crackle.push({ bp, gate, pa, lantern: null, level: 0, next: now });
    }

    // ---- hand water swish (HRTF): white noise → band-pass (600–1200 Hz with speed) → panner at the palm
    S.swish = [];
    for (let i = 0; i < 2; i++) {
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.8;
      const pa = api.spatial({ refDistance: 1.0, rolloff: 1.0, hrtf: true, out: S.out.world });
      pa.input.gain.value = 0;
      S.noiseWhite.connect(bp); bp.connect(pa.input);
      S.swish.push({ bp, pa });
    }

    // ---- glide rush (2D): white noise → low-pass 500 → gain
    {
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500; lp.Q.value = 0.5;
      const g = c.createGain(); g.gain.value = 0;
      S.noiseWhite.connect(lp); lp.connect(g); g.connect(S.out.world);
      S.glide = { lp, g };
    }

    // ---- calm reward: soft low dyad (root − 12 and the fifth below it) that breathes in when the water is calm
    {
      const o1 = c.createOscillator(); o1.type = 'triangle'; o1.frequency.value = mtof(ROOT - 12);
      const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = mtof(ROOT - 17);
      const g2 = c.createGain(); g2.gain.value = 0.6;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 0.5;
      const g = c.createGain(); g.gain.value = 0.0001;
      o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(S.out.music);
      o1.start(now); o2.start(now);
      S.calm = { o1, o2, g2, lp, g };
    }

    // ---- events
    const on = (name, fn) => S.offs.push(ctx.events.on(name, (e) => { try { fn(e || {}); } catch (err) { console.error('[sfx]', name, err); } }));
    on('lotusbloom', (e) => onLotus(S, e));
    on('fireflyland', (e) => onFirefly(S, e));
    on('lanterngrab', (e) => { if (hasXYZ(e.pos)) noiseBurst(S, { pos: e.pos, dur: 0.09, gain: 0.12, type: 'bandpass', freq: 1500, q: 1.0 }); });
    on('lanternrelease', (e) => onLanternRelease(S, e));
    on('lanternsplash', (e) => { if (hasXYZ(e.pos)) playAt(S, SPLASHES[Math.floor(S.rng() * 4)], e.pos, { gain: 0.4, refDistance: 1.5, out: S.out.world }); });
    on('lanternstar', (e) => onLanternStar(S, e));
    on('handenter', (e) => onHandEnter(S, e));
    on('handexit', (e) => onHandExit(S, e));
    on('drip', (e) => onDrip(S, e));
    on('pinchmiss', (e) => { const p = hasXYZ(e.point) ? e.point : e.hand?.pinch?.point; if (hasXYZ(p)) noiseBurst(S, { pos: p, dur: 0.02, gain: 0.05, type: 'bandpass', freq: 2000, q: 3 }); });
  },

  update(api, ctx, dt) {
    const S = this._s;
    if (!S) return;
    const now = S.c.currentTime;
    const head = S.head();
    const hands = ctx.hands?.list || [];

    // ---- followers: hand swish (30 Hz control, positions every frame)
    for (let i = 0; i < S.swish.length; i++) {
      const h = hands[i]; const sw = S.swish[i];
      if (h && h.visible && hasXYZ(h.palm?.position)) sw.pa.position.copy(h.palm.position);
    }
    S.ctrlAcc += dt;
    if (S.ctrlAcc >= 0.033) {
      S.ctrlAcc = 0;
      for (let i = 0; i < S.swish.length; i++) {
        const h = hands[i]; const sw = S.swish[i];
        let g = 0;
        if (h && h.visible && h.submerged) {
          const sp = h.palm?.speed || 0;
          const depthF = clamp((h.submergedDepth || 0) / 0.3, 0, 1);
          g = smoothstep(0.15, 1.2, sp) * 0.35 * (0.5 + 0.5 * depthF) * nearAtten(h.palm.position, head);
          sw.bp.frequency.setTargetAtTime(600 + 600 * smoothstep(0, 1.5, sp), now, 0.08);
        }
        sw.pa.input.gain.setTargetAtTime(clamp(g, 0, 0.35), now, 0.05);
      }
      // glide rush from the player's own wading
      const speed = ctx.playerCtl?.state?.speed || 0;
      S.glide.g.gain.setTargetAtTime(smoothstep(0.2, 1.0, speed) * 0.18, now, 0.15);
    }

    // ---- slow controls (4 Hz): calm drone
    S.slowAcc += dt;
    if (S.slowAcc >= 0.25) {
      S.slowAcc = 0;
      const calm = Math.max(ctx.water?.calm || 0, ctx.calm || 0);
      S.calm.g.gain.setTargetAtTime(calm > 0.5 ? 0.06 : 0.0001, now, 1.5);
    }

    // ---- lantern crackle: nearest ≤ 3 lanterns re-evaluated every 0.5 s, positions every frame
    S.crackleAcc += dt;
    if (S.crackleAcc >= 0.5) { S.crackleAcc = 0; assignCrackle(S, head); }
    for (const sl of S.crackle) {
      if (!sl.lantern) continue;
      const p = lanternPos(sl.lantern);
      if (p) sl.pa.position.set(p.x, p.y, p.z);
      let guard = 0;
      while (sl.level > 0 && sl.next < now + LOOKAHEAD && guard++ < 12) {
        const t = Math.max(sl.next, now + 0.005);
        const len = 0.01 + 0.03 * S.rng();
        const amp = 0.4 + 0.6 * S.rng();
        sl.gate.gain.setValueAtTime(0, t);
        sl.gate.gain.linearRampToValueAtTime(amp, t + 0.003);
        sl.gate.gain.linearRampToValueAtTime(0, t + len);
        sl.next = t + len + clamp(-Math.log(1 - S.rng() * 0.999) * 0.125, 0.02, 0.5);
      }
      if (sl.level <= 0 && sl.next < now) sl.next = now; // keep the scheduler current while silent
    }

    // ---- the aurora voice, one bar after a star is born
    if (S.auroraAt && now + LOOKAHEAD >= S.auroraAt) { const t = S.auroraAt; S.auroraAt = 0; auroraVoice(S, Math.max(t, now + 0.01)); }

    // free finished bells
    for (const b of S.bells) if (b.busy && now > b.endAt) b.busy = false;
  },

  stop() {
    const S = this._s;
    if (!S) return;
    this._s = null;
    for (const off of S.offs) { try { off(); } catch { /* */ } }
    const kill = (n) => { if (!n) return; try { n.stop?.(); } catch { /* */ } try { n.disconnect?.(); } catch { /* */ } };
    for (const b of S.bells) { kill(b.car); kill(b.mod); kill(b.mg); kill(b.env); kill(b.send); try { b.pa.dispose(); } catch { /* */ } }
    for (const sl of S.crackle) { kill(sl.bp); kill(sl.gate); try { sl.pa.dispose(); } catch { /* */ } }
    for (const sw of S.swish) { kill(sw.bp); try { sw.pa.dispose(); } catch { /* */ } }
    kill(S.glide.lp); kill(S.glide.g);
    kill(S.calm.o1); kill(S.calm.o2); kill(S.calm.g2); kill(S.calm.lp); kill(S.calm.g);
    kill(S.noiseWhite); kill(S.noisePink);
  },

  /** bell({ midi, pos, gain, dur, kind, index, when, wet, detune, refDistance, attack }) → pool voice or null. */
  bell(opts) { return this._s ? triggerBell(this._s, opts) : null; },
};

// ---------------------------------------------------------------------------------------------
// −6 dB when a world-positioned source sits right at the listener's head
function nearAtten(pos, head) {
  if (!hasXYZ(pos) || !head) return 1;
  const d = Math.hypot(pos.x - head.x, pos.y - head.y, pos.z - head.z);
  return 0.5 + 0.5 * smoothstep(0.1, 0.25, d);
}

// ---------------------------------------------------------------------------------------------
// FM bell pool
function triggerBell(S, { midi = 74, pos = null, gain = 0.3, dur = 1.8, kind = 'glass', index = null, when = 0, wet = 0, detune = 0, refDistance = 2, tag = '', attack = 0.005 } = {}) {
  const c = S.c;
  const now = c.currentTime;
  let t = Math.max(when || 0, now + 0.005);
  let v = null, oldest = null;
  for (const b of S.bells) {
    if (b.busy && now > b.endAt) b.busy = false;
    if (!b.busy && !v) v = b;
    if (!oldest || b.startedAt < oldest.startedAt) oldest = b;
  }
  if (!v) { // steal the oldest note with a quick fade
    v = oldest;
    holdAt(v.env.gain, now); v.env.gain.setTargetAtTime(0.0001, now, 0.008);
    t = Math.max(t, now + 0.045);
  }
  S.bellTimes = S.bellTimes.filter((x) => x > t - 1);
  const dense = S.bellTimes.length;
  S.bellTimes.push(t);
  const k = BELL_KINDS[kind] || BELL_KINDS.glass;
  const idx = (index == null ? k.index : index) * (1 - 0.3 * S.arc()) / (1 + 0.25 * dense);
  const f = mtof(midi);
  let g = clamp(gain, 0, 0.7);
  const head = S.head();
  if (pos) g *= nearAtten(pos, head);
  dur = Math.max(0.3, dur);

  v.car.frequency.setValueAtTime(f, t); v.car.detune.setValueAtTime(detune, t);
  v.mod.frequency.setValueAtTime(f * k.ratio, t);
  holdAt(v.mg.gain, t);
  v.mg.gain.setValueAtTime(Math.max(0.001, f * idx), t);
  v.mg.gain.exponentialRampToValueAtTime(Math.max(0.001, f * idx * 0.04), t + dur * 0.55);
  holdAt(v.env.gain, t);
  v.env.gain.setValueAtTime(0.0001, t);
  v.env.gain.linearRampToValueAtTime(Math.max(0.0002, g), t + Math.max(0.005, attack));
  v.env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  v.send.gain.setValueAtTime(clamp(wet, 0, 1), t);
  if (pos) v.pa.position.set(pos.x, pos.y, pos.z); else v.pa.position.copy(head);
  v.pa.panner.refDistance = refDistance;
  v.busy = true; v.startedAt = t; v.endAt = t + dur; v.tag = tag;
  return v;
}

/** api.play() at a world position with the −6 dB near-listener rule applied to the gain. */
function playAt(S, name, pos, opts) { return S.api.play(name, { ...opts, pos, gain: (opts.gain ?? 1) * nearAtten(pos, S.head()) }); }

// ---------------------------------------------------------------------------------------------
// short filtered-noise transients (rustle, plip, ticks)
function noiseBurst(S, { pos, when = 0, dur = 0.08, gain = 0.1, type = 'bandpass', freq = 1500, q = 1, sweepTo = null, kind = 'white', refDistance = 1.5 }) {
  const { api, c } = S;
  const now = c.currentTime;
  const t = Math.max(when || 0, now + 0.005);
  const src = c.createBufferSource(); src.buffer = api.noise(kind, 4); src.loop = true;
  const f = c.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  const env = c.createGain();
  const g = clamp(gain, 0, 0.5) * nearAtten(pos, S.head());
  env.gain.setValueAtTime(0.0001, t); env.gain.linearRampToValueAtTime(Math.max(0.0002, g), t + 0.004); env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const pa = api.spatial({ pos, refDistance, rolloff: 1.2, out: S.out.world });
  src.connect(f); f.connect(env); env.connect(pa.input);
  src.start(t, S.rng() * 3.5); src.stop(t + dur + 0.02);
  src.onended = () => { for (const n of [src, f, env]) { try { n.disconnect(); } catch { /* */ } } pa.dispose(); };
}

// ---------------------------------------------------------------------------------------------
// tuned sample layer: the reliable sample whose measured pitch is closest to `midi`, within ±maxShift
function pickTuned(S, names, midi, maxShift = 7) {
  let best = null;
  for (const name of names) {
    const p = S.api.pitch(name);
    if (!p || !p.reliable || !S.api.buffer(name)) continue;
    const d = midi - p.midi;
    if (!best || Math.abs(d) < Math.abs(best.d)) best = { name, d };
  }
  if (!best || Math.abs(best.d) > maxShift) return null;
  return { name: best.name, rate: Math.pow(2, best.d / 12) };
}

function pitchFor(S, degree, register) {
  const m = S.ctx.music;
  if (m?.pitchFor) return m.pitchFor(degree, register);
  const d = Math.round(degree) || 0;
  return ROOT + (register - 4) * 12 + PENTA[((d % 5) + 5) % 5] + 12 * Math.floor(d / 5);
}
function notePlayed(S, midi) { S.playerNotes.push(midi); if (S.playerNotes.length > 4) S.playerNotes.shift(); }

// ---------------------------------------------------------------------------------------------
// event responses
function onLotus(S, e) {
  const pos = hasXYZ(e.pos) ? e.pos : S.head();
  const midi = pitchFor(S, e.note | 0, 5);
  triggerBell(S, { midi, pos, gain: 0.45, dur: 3.2, kind: (e.index | 0) & 1 ? 'ceramic' : 'glass', tag: 'lotus' });
  const layer = pickTuned(S, BOWLS.concat(TINGS), midi);
  if (layer) playAt(S, layer.name, pos, { gain: 0.25, rate: layer.rate, refDistance: 2, out: S.out.chimes });
  notePlayed(S, midi);
}

function onFirefly(S, e) {
  const pos = hasXYZ(e.pos) ? e.pos : (hasXYZ(e.hand?.palm?.position) ? e.hand.palm.position : S.head());
  const midi = pitchFor(S, Math.floor(S.rng() * 4), 6); // D6 … A6
  const detune = (S.rng() - 0.5) * 16;
  const useTing = (S.fireflyCount++ & 1) === 0;
  const layer = useTing ? pickTuned(S, TINGS, midi) : null;
  if (layer) playAt(S, layer.name, pos, { gain: 0.18, rate: layer.rate, detune, refDistance: 1.5, out: S.out.chimes });
  else triggerBell(S, { midi, pos, gain: 0.18, dur: 1.2, kind: 'glass', detune, tag: 'firefly' });
  notePlayed(S, midi);
}

function onLanternRelease(S, e) {
  const pos = hasXYZ(e.pos) ? e.pos : (hasXYZ(e.hand?.palm?.position) ? e.hand.palm.position : S.head());
  playAt(S, 'whoosh_gentle', pos, { gain: 0.25, rate: 1.05, refDistance: 1.5, out: S.out.world });
  const root = S.ctx.music?.currentChord?.root ?? mod12(ROOT);
  // a low ceramic bell on the chord root, struck softly (40 ms attack) so it blooms under the pads instead of hitting them
  triggerBell(S, { midi: 48 + mod12(root), pos, gain: 0.3, dur: 4, kind: 'ceramic', when: S.c.currentTime + 0.4, attack: 0.04, tag: 'lantern' });
}

function onLanternStar(S, e) {
  const head = S.head();
  const dir = hasXYZ(e.dir) ? _v.set(e.dir.x, e.dir.y, e.dir.z) : (hasXYZ(e.pos) ? _v.set(e.pos.x - head.x, e.pos.y - head.y, e.pos.z - head.z) : _v.set(0, 1, 0));
  if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
  dir.normalize().multiplyScalar(30).add(head);
  const now = S.c.currentTime;
  // a high sparkle: three quick ascending pentatonic bells, in the sky with a big reverb send
  const d0 = Math.floor(S.rng() * 5);
  for (let i = 0; i < 3; i++) triggerBell(S, { midi: pitchFor(S, d0 + i, 6), pos: dir, gain: 0.12, dur: 1.6, kind: 'glass', when: now + 0.02 + i * 0.11, wet: 0.7, refDistance: 25, tag: 'star' });
  // a single pure sine two octaves above the chord's fifth marks the star's birth
  const fifth = S.ctx.music?.currentChord?.fifth ?? mod12(ROOT + 7);
  triggerBell(S, { midi: 60 + mod12(fifth) + 24, pos: dir, gain: 0.15, dur: 2.5, index: 0, when: now + 0.05, wet: 0.8, refDistance: 25, tag: 'star' });
  // one bar later the aurora restates the player's last notes an octave up
  S.auroraAt = now + 3.2;
  S.auroraNotes = S.playerNotes.slice(-4);
}

function onHandEnter(S, e) {
  const h = e.hand;
  const pos = hasXYZ(h?.palm?.position) ? h.palm.position : null;
  if (!pos) return;
  const speed = typeof e.speed === 'number' ? e.speed : Math.abs(h.palm?.velocityLocal?.y || 0);
  const sp = clamp(speed / 1.5, 0, 1);
  noiseBurst(S, { pos, dur: 0.12, gain: 0.08 + 0.18 * sp, type: 'bandpass', freq: 1200, sweepTo: 300, q: 2 });
  if (speed > 0.5) playAt(S, SPLASHES[Math.floor(S.rng() * 4)], pos, { gain: 0.2, refDistance: 1.5, out: S.out.world });
}

// a droplet from a lifted hand meeting the surface: a very quiet, very short high plip, pitch scattered so a
// run of drips reads as water and not as a metronome (rate-limited to 8/s by the drips module)
function onDrip(S, e) {
  const pos = hasXYZ(e.pos) ? e.pos : null;
  if (!pos) return;
  const b = clamp(typeof e.bright === 'number' ? e.bright : 0.6, 0.2, 1.2);
  const f = 2600 + S.rng() * 1800;
  noiseBurst(S, { pos, dur: 0.028, gain: 0.012 + 0.018 * b, type: 'bandpass', freq: f, sweepTo: f * 0.55, q: 6, refDistance: 0.8 });
}

function onHandExit(S, e) {
  const pos = hasXYZ(e.hand?.palm?.position) ? e.hand.palm.position : null;
  if (!pos) return;
  const n = 2 + (S.rng() < 0.5 ? 1 : 0);
  let t = S.c.currentTime + 0.01;
  for (let i = 0; i < n; i++) { noiseBurst(S, { pos, when: t, dur: 0.015, gain: 0.06, type: 'highpass', freq: 3000, q: 0.7 }); t += 0.04 + 0.03 * S.rng(); }
}

// ---------------------------------------------------------------------------------------------
// lantern crackle assignment
function lanternPos(l) { const p = l && (l.position || l.pos); return hasXYZ(p) ? p : null; }
function lanternAudible(l) {
  if (!l || l.active === false || l.alive === false || l.lit === false) return false;
  const s = l.state;
  return !(s === 'star' || s === 'gone' || s === 'dead' || s === 'inactive' || s === 'sky');
}
function assignCrackle(S, head) {
  const list = S.ctx.lanterns?.list;
  const cands = [];
  if (Array.isArray(list)) {
    for (const l of list) {
      const p = lanternPos(l);
      if (!p || !lanternAudible(l)) continue;
      const d = Math.hypot(p.x - head.x, p.y - head.y, p.z - head.z);
      if (d < 30) cands.push({ l, d });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  const keep = cands.slice(0, CRACKLE_SLOTS);
  const now = S.c.currentTime;
  for (const sl of S.crackle) {
    if (!sl.lantern) continue;
    const k = keep.find((x) => x.l === sl.lantern);
    if (!k) {
      sl.level = 0;
      sl.pa.input.gain.setTargetAtTime(0.0001, now, 0.12);
      if (sl.pa.input.gain.value < 0.003) sl.lantern = null; // fully faded → free the slot
    }
  }
  for (const k of keep) {
    if (S.crackle.some((sl) => sl.lantern === k.l)) continue;
    const free = S.crackle.find((sl) => !sl.lantern);
    if (!free) break;
    free.lantern = k.l; free.next = now + 0.05;
    const p = lanternPos(k.l); if (p) free.pa.position.set(p.x, p.y, p.z);
  }
  for (const sl of S.crackle) {
    if (!sl.lantern) continue;
    const k = keep.find((x) => x.l === sl.lantern);
    if (!k) continue;
    const l = sl.lantern;
    const bright = clamp(l.bright ?? l.brightness ?? l.flame ?? l.glow ?? 0.5, 0, 1);
    sl.level = 0.05 * (1 + bright) * nearAtten(lanternPos(l), head);
    sl.pa.input.gain.setTargetAtTime(sl.level, now, 0.2);
  }
}

// ---------------------------------------------------------------------------------------------
// the aurora voice: 2–3 sine partials + a narrow noise band, high-passed, fully wet
function auroraVoice(S, t0) {
  const { api, c } = S;
  let notes = S.auroraNotes.map((m) => m + 12);
  if (notes.length < 2) {
    const ch = S.ctx.music?.currentChord;
    const root = ch ? ch.root : mod12(ROOT), fifth = ch ? ch.fifth : mod12(ROOT + 7);
    notes = [72 + mod12(root), 72 + mod12(fifth), 84 + mod12(root)];
  }
  const step = 0.7;
  const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 600; hp.Q.value = 0.6;
  const env = c.createGain(); env.gain.setValueAtTime(0.0001, t0);
  env.connect(hp); hp.connect(api.wet);
  const parts = [1, 2, 3].map((k, i) => {
    const o = c.createOscillator(); o.type = 'sine';
    const g = c.createGain(); g.gain.value = [1, 0.35, 0.15][i];
    o.connect(g); g.connect(env);
    return { o, g, k };
  });
  const nz = c.createBufferSource(); nz.buffer = api.noise('white', 4); nz.loop = true;
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 30;
  const ng = c.createGain(); ng.gain.value = 0.5;
  nz.connect(bp); bp.connect(ng); ng.connect(env);
  let t = t0;
  for (const m of notes) {
    const f = mtof(m);
    for (const p of parts) p.o.frequency.setValueAtTime(f * p.k, t);
    bp.frequency.setValueAtTime(f, t);
    env.gain.linearRampToValueAtTime(0.14, t + 0.25);
    env.gain.linearRampToValueAtTime(0.05, t + step);
    t += step;
  }
  const tEnd = t + 1.2;
  env.gain.exponentialRampToValueAtTime(0.0001, tEnd);
  for (const p of parts) { p.o.start(t0); p.o.stop(tEnd + 0.1); }
  nz.start(t0); nz.stop(tEnd + 0.1);
  parts[0].o.onended = () => { for (const n of [hp, env, nz, bp, ng, ...parts.map((p) => p.o), ...parts.map((p) => p.g)]) { try { n.disconnect(); } catch { /* */ } } };
}
