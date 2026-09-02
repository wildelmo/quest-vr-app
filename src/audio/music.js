import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { fmBell } from './sfx.js';

/**
 * Music — a generative pad engine in D Dorian whose chords are all consonant with the D minor
 * pentatonic (D F G A C), so every note the player can trigger always fits:
 *   Dm(add9) Dm7 F(add9) Am7 Csus2 Gsus4 Dsus2 A7sus4, walked by a small Markov chain.
 * Voicings are chosen by minimum semitone motion from the previous one (never repeated), in
 * MIDI 38–74 (+ a soft upper voice when the world is excited). Each voice = saw + triangle (±6 ct)
 * → low-pass (350·2^(1.2·energy) Hz with mild key tracking, ≤ 1.4 kHz) → gain with 4–6 s attack /
 * 6–10 s release, into a pad bus with a two-delay chorus. A D2 drone sits under everything.
 * Raindrop bells fall when the world is calm; the real CC0 pad swells are pitch-matched to the
 * current chord's root or fifth on big events. Every 3–5 minutes the pads take a 25–40 s "breath".
 *
 * Node budget (persistent): 7 voices × 4 = 28, chorus 9, drone 4, pad bus 1, swell send 1 ≈ 43.
 * Exposes ctx.music (see makeMusicApi).
 */
const LOOKAHEAD = 0.15;
const ROOT = CONFIG.music?.rootMidi ?? 62;
const PENTA = [0, 3, 5, 7, 10]; // minor pentatonic relative to the root
const POOL = 10; // 5 new notes never have to steal from a voice that is still releasing
const LO = 38, HI = 74, UPPER_LO = 72, UPPER_HI = 84;
const VOICE_LEVEL = 0.05, UPPER_LEVEL = 0.03;
const SESSION_ARC = 1200; // seconds over which the session slowly settles

// pitch classes relative to the root; each chord's tones are consonant with the minor pentatonic
const CHORD_DEFS = [
  { name: 'Dm(add9)', root: 0, pcs: [0, 3, 7, 2] },
  { name: 'Dm7', root: 0, pcs: [0, 3, 7, 10] },
  { name: 'F(add9)', root: 3, pcs: [3, 7, 10, 5] },
  { name: 'Am7', root: 7, pcs: [7, 10, 2, 5] },
  { name: 'Csus2', root: 10, pcs: [10, 0, 5] },
  { name: 'Gsus4', root: 5, pcs: [5, 10, 0] },
  { name: 'Dsus2', root: 0, pcs: [0, 2, 7] },
  { name: 'A7sus4', root: 7, pcs: [7, 0, 2, 5] },
];
const WEIGHTS = [0.16, 0.2, 0.15, 0.15, 0.1, 0.1, 0.09, 0.05];

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const mod12 = (n) => ((n % 12) + 12) % 12;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
function holdAt(p, t) {
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else { p.cancelScheduledValues(t); p.setValueAtTime(Math.max(0.0001, p.value), t); }
}

const CHORDS = CHORD_DEFS.map((d) => ({
  name: d.name, rel: d.pcs.slice(), root: mod12(ROOT + d.root), fifth: mod12(ROOT + d.root + 7), pcs: d.pcs.map((p) => mod12(ROOT + p)),
}));
const PENTA_ABS = PENTA.map((p) => mod12(ROOT + p));
const _v = new THREE.Vector3();

export const music = {
  name: 'music',
  _s: null,

  start(api, ctx) {
    if (this._s) this.stop();
    const c = api.context;
    if (!c || !api.bus) return;
    const now = c.currentTime;
    const rng = ctx.harness ? makeRng(0x4D75516B) : Math.random;
    const out = api.buses?.music || api.bus;
    const S = {
      api, ctx, c, rng, out, offs: [], t0: now, energySm: 0, ctrlAcc: 0,
      chordIdx: -1, prevIdx: -1, chord: CHORDS[1], voicing: [], upper: -1, history: [],
      nextChordAt: now + 0.05, breathing: false, breathUntil: 0, breathAt: now + 180 + 120 * rng(),
      nextDrop: now + 8 + 6 * rng(), dropArmed: true, drops: [], dropKind: 0,
      lastSwell: -100, swellQueue: null, swellEnds: [], swellToggle: false,
    };
    this._s = S;
    S.arc = () => clamp((c.currentTime - S.t0) / SESSION_ARC, 0, 1);

    // ---- pad bus with a two-delay chorus (17 / 23 ms, 0.3 Hz ±2 ms), panned apart
    S.padBus = c.createGain(); S.padBus.gain.value = 1;
    S.padBus.connect(out);
    S.chorus = [];
    S.chorusMix = c.createGain(); S.chorusMix.gain.value = 0.45; S.chorusMix.connect(out);
    for (const [ms, rate, pan] of [[0.017, 0.3, -0.6], [0.023, 0.31, 0.6]]) {
      const d = c.createDelay(0.1); d.delayTime.value = ms;
      const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = rate;
      const depth = c.createGain(); depth.gain.value = 0.002;
      lfo.connect(depth); depth.connect(d.delayTime);
      S.padBus.connect(d);
      let last = d;
      if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; d.connect(p); last = p; }
      last.connect(S.chorusMix);
      lfo.start(now);
      S.chorus.push({ d, lfo, depth, last });
    }

    // ---- D2 drone: sine + a soft triangle an octave up (≈ −18 dBFS), always present
    {
      const o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = mtof(ROOT - 24);
      const o2 = c.createOscillator(); o2.type = 'triangle'; o2.frequency.value = mtof(ROOT - 12);
      const g1 = c.createGain(); g1.gain.value = 0.09; const g2 = c.createGain(); g2.gain.value = 0.04;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.5;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, now); g.gain.linearRampToValueAtTime(1, now + 8);
      o1.connect(g1); o2.connect(g2); g1.connect(lp); g2.connect(lp); lp.connect(g); g.connect(out);
      o1.start(now); o2.start(now);
      S.drone = { o1, o2, g1, g2, lp, g };
    }

    // ---- voice pool
    S.voices = [];
    for (let i = 0; i < POOL; i++) {
      const oscA = c.createOscillator(); oscA.type = 'sawtooth'; oscA.detune.value = 6;
      const oscB = c.createOscillator(); oscB.type = 'triangle'; oscB.detune.value = -6;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 350; lp.Q.value = 0.7;
      const g = c.createGain(); g.gain.value = 0.0001;
      oscA.connect(lp); oscB.connect(lp); lp.connect(g); g.connect(S.padBus);
      oscA.frequency.value = oscB.frequency.value = 110;
      oscA.start(now); oscB.start(now);
      S.voices.push({ oscA, oscB, lp, g, midi: -1, on: false, offAt: 0, level: 0, freq: 110, tilt: 0.9 + 0.25 * rng() });
    }

    // ---- swell reverb send (extra 0.4 on top of the bus send)
    S.swellWet = c.createGain(); S.swellWet.gain.value = 0.4; S.swellWet.connect(api.wet);

    ctx.music = makeMusicApi(this);

    S.offs.push(ctx.events.on('lanternrelease', () => { S.swellToggle = !S.swellToggle; requestSwell(S, S.swellToggle ? 'pad_northern_brilliant' : 'pad_northern_swell', 0.35); }));
    S.offs.push(ctx.events.on('lotuschord', () => requestSwell(S, 'pad_bioluminescence', 0.45)));
  },

  update(api, ctx, dt) {
    const S = this._s;
    if (!S) return;
    const now = S.c.currentTime;
    const energy = clamp(ctx.energy || 0, 0, 1);
    S.energySm += (energy - S.energySm) * Math.min(1, dt * 0.7);

    // ---- breaths: pads fade out for 25–40 s every 3–5 minutes, drone + ambience carry on
    if (!S.breathing && now >= S.breathAt) {
      S.breathing = true;
      S.breathUntil = now + 25 + 15 * S.rng();
      S.breathAt = S.breathUntil + 180 + 120 * S.rng();
      releaseAll(S, now + 0.05, 8 + 2 * S.rng());
      S.nextChordAt = S.breathUntil;
    }
    if (S.breathing && now >= S.breathUntil) { S.breathing = false; S.nextChordAt = now; }
    if (!S.breathing && now + LOOKAHEAD >= S.nextChordAt) changeChord(S, Math.max(S.nextChordAt, now + 0.02), energy);

    // ---- filters follow energy (5 Hz)
    S.ctrlAcc += dt;
    if (S.ctrlAcc >= 0.2) {
      S.ctrlAcc = 0;
      const base = 350 * Math.pow(2, 1.2 * S.energySm);
      for (const v of S.voices) {
        if (!v.on && v.offAt < now) continue;
        const track = clamp(Math.sqrt(v.freq / 110), 1, 2.5);
        v.lp.frequency.setTargetAtTime(Math.min(1400, base * track * v.tilt), now, 0.5);
      }
    }

    // ---- raindrop notes when the world is calm
    const anySub = !!ctx.hands?.list?.some((h) => h.visible && h.submerged);
    const calmWorld = energy < 0.15 && !anySub;
    if (!calmWorld) S.dropArmed = false;
    else if (!S.dropArmed) { S.dropArmed = true; S.nextDrop = now + 6 + 8 * S.rng(); }
    if (calmWorld && now + LOOKAHEAD >= S.nextDrop) {
      raindrop(S, Math.max(S.nextDrop, now + 0.01));
      S.nextDrop = Math.max(S.nextDrop, now) + 6 + 8 * S.rng();
    }

    // ---- queued swell
    if (S.swellQueue && now >= S.swellQueue.at) { const q = S.swellQueue; S.swellQueue = null; playSwell(S, q.name, q.gain); }
  },

  stop() {
    const S = this._s;
    if (!S) return;
    this._s = null;
    for (const off of S.offs) { try { off(); } catch { /* */ } }
    const kill = (n) => { if (!n) return; try { n.stop?.(); } catch { /* */ } try { n.disconnect?.(); } catch { /* */ } };
    for (const v of S.voices) { kill(v.oscA); kill(v.oscB); kill(v.lp); kill(v.g); }
    for (const ch of S.chorus) { kill(ch.lfo); kill(ch.depth); kill(ch.d); kill(ch.last); }
    const d = S.drone; kill(d.o1); kill(d.o2); kill(d.g1); kill(d.g2); kill(d.lp); kill(d.g);
    kill(S.padBus); kill(S.chorusMix); kill(S.swellWet);
  },
};

// ---------------------------------------------------------------------------------------------
// public API on ctx.music
function makeMusicApi(mod) {
  const cur = () => mod._s?.chord || CHORDS[1];
  const scaleNote = (degree, octave = 4) => {
    const d = Math.round(degree) || 0;
    return ROOT + (octave - 4) * 12 + PENTA[((d % 5) + 5) % 5] + 12 * Math.floor(d / 5);
  };
  const nearestConsonant = (midi) => {
    const ch = cur(); const pc = mod12(midi);
    if (ch.pcs.includes(pc)) return midi;
    if (ch.pcs.includes(mod12(pc - 1))) return midi - 1; // a semitone above a chord tone → the chord tone below
    return midi;
  };
  const api = {
    rootMidi: ROOT, penta: PENTA.slice(), chords: CHORDS,
    get currentChord() { const ch = cur(); const S = mod._s; return { name: ch.name, root: ch.root, fifth: ch.fifth, intervals: ch.rel.slice(), pcs: ch.pcs.slice(), midi: S ? S.voicing.slice() : [] }; },
    get breathing() { return !!mod._s?.breathing; },
    scaleNote,
    pitchFor: (degree, register = 5) => nearestConsonant(scaleNote(degree, register)),
    isConsonant: (midi) => { const ch = cur(); const pc = mod12(midi); return ch.pcs.includes(pc) || (PENTA_ABS.includes(pc) && !ch.pcs.includes(mod12(pc - 1))); },
    nearestConsonant,
    /** Move to the next chord now (used by tests and big moments). */
    advance: () => { const S = mod._s; if (S && !S.breathing) changeChord(S, S.c.currentTime + 0.02, clamp(S.ctx.energy || 0, 0, 1)); },
    /** Play one raindrop note now. */
    raindrop: () => { const S = mod._s; if (S) raindrop(S, S.c.currentTime + 0.02); },
    /** Start a breath (pads fade out for 25–40 s) now. */
    breathe: () => { const S = mod._s; if (S) S.breathAt = S.c.currentTime; },
    requestSwell: (name, gain = 0.35) => { const S = mod._s; if (S) requestSwell(S, name, gain); },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// chords + voicings
function pickChord(S) {
  const w = WEIGHTS.map((x, i) => (i === S.chordIdx ? 0 : i === S.prevIdx ? x * 0.3 : x));
  let total = 0; for (const x of w) total += x;
  let r = S.rng() * total;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return w.length - 1;
}

function candidates(pc, lo, hi) { const out = []; for (let m = lo; m <= hi; m++) if (mod12(m) === pc) out.push(m); return out; }

function movement(prev, next) {
  if (!prev.length || !next.length) return 0;
  const a = prev.length >= next.length ? prev : next, b = prev.length >= next.length ? next : prev;
  let best = Infinity;
  for (let off = 0; off + b.length <= a.length; off++) { let s = 0; for (let i = 0; i < b.length; i++) s += Math.abs(a[off + i] - b[i]); if (s < best) best = s; }
  return best;
}

function pickVoicing(S, chord, n) {
  let slots;
  if (n <= 2) slots = [chord.root, chord.fifth];
  else if (n === 3) slots = chord.pcs.slice(0, 3);
  else slots = chord.pcs.length >= 4 ? chord.pcs.slice(0, 4) : chord.pcs.concat([chord.root]);
  const cands = slots.map((pc) => candidates(pc, LO, HI));
  const idx = new Array(slots.length).fill(0);
  const scored = [];
  const prev = S.voicing;
  for (;;) {
    const v = idx.map((k, i) => cands[i][k]).sort((a, b) => a - b);
    let cost = 0, ok = true;
    for (let i = 1; i < v.length && ok; i++) {
      const d = v[i] - v[i - 1];
      if (d === 0) ok = false;
      else if (d < 3 && v[i - 1] < 55) ok = false;
      else { if (d < 5 && v[i - 1] < 48) cost += 4; if (d > 15) cost += 2; }
    }
    if (ok && v[v.length - 1] - v[0] > 30) ok = false;
    if (ok && S.history.some((h) => h.length === v.length && h.every((m, i) => m === v[i]))) ok = false;
    if (ok) {
      const bass = mod12(v[0]);
      if (bass !== chord.root && bass !== chord.fifth) cost += 6;
      if (v[0] > 52) cost += (v[0] - 52) * 0.5;
      cost += movement(prev, v);
      scored.push({ v, cost });
    }
    let i = idx.length - 1;
    while (i >= 0) { if (++idx[i] < cands[i].length) break; idx[i] = 0; i--; }
    if (i < 0) break;
  }
  if (!scored.length) return slots.map((pc) => candidates(pc, LO, HI)[0]).sort((a, b) => a - b);
  scored.sort((a, b) => a.cost - b.cost);
  const r = S.rng();
  const pick = scored[r < 0.65 || scored.length < 2 ? 0 : r < 0.9 || scored.length < 3 ? 1 : 2];
  return pick.v;
}

function pickUpper(S, chord) {
  const c = candidates(chord.root, UPPER_LO, UPPER_HI).concat(candidates(chord.fifth, UPPER_LO, UPPER_HI));
  const ref = S.upper > 0 ? S.upper : 78;
  let best = c[0];
  for (const m of c) if (Math.abs(m - ref) < Math.abs(best - ref) || (Math.abs(m - ref) === Math.abs(best - ref) && S.rng() < 0.5)) best = m;
  return best;
}

function changeChord(S, t, energy) {
  const e = clamp(energy, 0, 1);
  const idx = pickChord(S);
  const chord = CHORDS[idx];
  const n = e < 0.1 ? 2 + (S.rng() < 0.5 ? 1 : 0) : e < 0.5 ? 3 + (S.rng() < 0.5 ? 1 : 0) : 5;
  const voicing = pickVoicing(S, chord, Math.min(n, 4));
  const want = new Map();
  for (const m of voicing) want.set(m, VOICE_LEVEL);
  let upper = -1;
  if (n >= 5) { upper = pickUpper(S, chord); if (!want.has(upper)) want.set(upper, UPPER_LEVEL); }

  const attack = 4 + 2 * S.rng(), release = 6 + 4 * S.rng();
  for (const v of S.voices) {
    if (!v.on) continue;
    if (want.has(v.midi)) {
      const lvl = want.get(v.midi);
      if (Math.abs(lvl - v.level) > 1e-3) { holdAt(v.g.gain, t); v.g.gain.linearRampToValueAtTime(lvl, t + 3); v.level = lvl; }
      want.delete(v.midi);
    } else noteOff(v, t, release);
  }
  for (const [midi, lvl] of want) { const pk = pickFree(S, t); noteOn(S, pk.v, midi, lvl, pk.at, attack, pk.at === t); }

  S.prevIdx = S.chordIdx; S.chordIdx = idx; S.chord = chord;
  S.voicing = voicing; S.upper = upper;
  S.history.push(voicing.slice()); if (S.history.length > 2) S.history.shift();
  const dur = lerp(26, 10, e) * (1 + 0.4 * S.arc());
  S.nextChordAt = t + dur;
}

/**
 * Picks a voice for a new note: a fully released one if any; otherwise the one whose release ends soonest,
 * shortened to end within 0.3 s, and the new note starts exactly when that fade reaches silence (no pitch
 * jump at full level). Returns { v, at } — `at` is when the note may start.
 */
function pickFree(S, t) {
  let free = null, soonest = null;
  for (const v of S.voices) {
    if (v.on) continue;
    if (v.offAt <= t) { if (!free || v.offAt < free.offAt) free = v; }
    else if (!soonest || v.offAt < soonest.offAt) soonest = v;
  }
  if (free) return { v: free, at: t };
  if (soonest) {
    const at = Math.min(soonest.offAt, t + 0.3);
    if (soonest.offAt > at) { holdAt(soonest.g.gain, t); soonest.g.gain.linearRampToValueAtTime(0.0001, at); soonest.offAt = at; }
    return { v: soonest, at };
  }
  // every voice is sounding (cannot happen with POOL > 5): steal the quietest with a short fade
  let best = S.voices[0];
  for (const v of S.voices) if (v.level < best.level) best = v;
  noteOff(best, t, 0.3);
  return { v: best, at: t + 0.3 };
}

function noteOn(S, v, midi, level, t, attack, fresh = true) {
  const f = mtof(midi);
  v.oscA.frequency.setValueAtTime(f, t); v.oscB.frequency.setValueAtTime(f, t);
  if (fresh) holdAt(v.g.gain, t);
  else v.g.gain.setValueAtTime(0.0001, t); // the previous release ends exactly here; append, don't cancel it
  v.g.gain.linearRampToValueAtTime(level, t + attack);
  v.midi = midi; v.on = true; v.level = level; v.freq = f;
}
function noteOff(v, t, release) {
  holdAt(v.g.gain, t);
  v.g.gain.linearRampToValueAtTime(0.0001, t + release);
  v.on = false; v.offAt = t + release; v.level = 0;
}
function releaseAll(S, t, release) { for (const v of S.voices) if (v.on) noteOff(v, t, release); }

// ---------------------------------------------------------------------------------------------
// raindrops
function raindrop(S, t) {
  const { ctx, api } = S;
  S.drops = S.drops.filter((end) => end > t);
  if (S.drops.length >= 4) return;
  const head = ctx.playerCtl?.state?.headWorld || ctx.camera?.getWorldPosition(_v) || _v.set(0, 1.6, 0);
  const deg = Math.floor(S.rng() * 8); // D5 … G6
  const midi = ctx.music ? ctx.music.pitchFor(deg, 5) : ROOT + 12 + PENTA[deg % 5] + 12 * Math.floor(deg / 5);
  const ang = S.rng() * Math.PI * 2, dist = 3 + 5 * S.rng();
  _v.set(head.x + Math.cos(ang) * dist, (ctx.water?.level ?? 0.95) + 0.3, head.z + Math.sin(ang) * dist);
  const dur = 2.5 + 1.5 * S.rng();
  S.dropKind ^= 1;
  fmBell(api, ctx, { midi, pos: _v, gain: 0.12, dur, kind: S.dropKind ? 'ceramic' : 'glass', when: t, refDistance: 3, tag: 'raindrop' });
  S.drops.push(t + dur);
}

// ---------------------------------------------------------------------------------------------
// real pad swells, pitch-matched to the chord (root or fifth, whichever needs the smaller shift)
function requestSwell(S, name, gain) {
  const now = S.c.currentTime;
  if (now < S.lastSwell + 8) { S.swellQueue = { name, gain, at: S.lastSwell + 8 }; return; }
  playSwell(S, name, gain);
}
function playSwell(S, name, gain) {
  const { api } = S;
  const now = S.c.currentTime;
  const buf = api.buffer(name);
  if (!buf) return;
  S.swellEnds = S.swellEnds.filter((e) => e > now);
  if (S.swellEnds.length >= 2) return;
  let rate = 1;
  const p = api.pitch(name);
  if (p && p.reliable) {
    let best = 0, bestAbs = 99;
    for (const pc of [S.chord.root, S.chord.fifth]) {
      const d = ((pc - p.midi) % 12 + 18) % 12 - 6;
      if (Math.abs(d) < bestAbs) { bestAbs = Math.abs(d); best = d; }
    }
    if (bestAbs <= 5) rate = Math.pow(2, best / 12);
  }
  const res = api.play(name, { gain: clamp(gain, 0, 0.5), rate, out: S.out });
  if (!res) return;
  try { res.gain.connect(S.swellWet); } catch { /* */ }
  S.lastSwell = now;
  S.swellEnds.push(now + buf.duration / rate);
}
