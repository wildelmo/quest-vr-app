import * as THREE from 'three';

/**
 * Ambience — the place. Wind bed, water lapping, synthesized crickets, occasional distant
 * sounds, the aurora shimmer, and the session-level things (xr blur/focus fades).
 * Everything is scheduled on the audio clock with a short look-ahead; nothing is allocated per
 * frame except one small gain curve per cricket burst.
 *
 * Node budget (persistent): wind 3, water loop 3, swell 3, crickets 1 + 5 × (band-pass + panner),
 * aurora 6, far-reverb send 1 ≈ 27 nodes. All spatial sources are equalpower.
 */
const LOOKAHEAD = 0.15;
const CRICKET_COUNT = 5;
const CRICKET_MAKEUP = 3.0; // a Q≈15 band of white noise carries little energy; this brings a 0.05–0.08 "level" back to that loudness
const CTRL_RATE = 0.05;     // seconds between continuous-control updates (setTargetAtTime), ~20 Hz
const SESSION_ARC = 1200;   // seconds over which the crickets slowly thin out

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Piecewise-linear random walk between [min, max], each segment lasting tMin..tMax seconds. */
class Walker {
  constructor(rng, min, max, tMin, tMax, now) {
    this.rng = rng; this.min = min; this.max = max; this.tMin = tMin; this.tMax = tMax;
    this.v0 = this.v1 = min + (max - min) * rng(); this.t0 = this.t1 = now;
  }
  at(now) {
    if (now >= this.t1) {
      this.v0 = this.v1; this.t0 = this.t1;
      this.v1 = this.min + (this.max - this.min) * this.rng();
      this.t1 = this.t0 + this.tMin + (this.tMax - this.tMin) * this.rng();
      if (this.t1 <= now) { this.t0 = now; this.t1 = now + this.tMin; }
    }
    const u = clamp((now - this.t0) / Math.max(1e-3, this.t1 - this.t0), 0, 1);
    return this.v0 + (this.v1 - this.v0) * u;
  }
}

const _v = new THREE.Vector3(), _h = new THREE.Vector3();

export const ambience = {
  name: 'ambience',
  _s: null,

  start(api, ctx) {
    if (this._s) this.stop();
    const c = api.context;
    if (!c || !api.bus) return;
    const now = c.currentTime;
    const rng = ctx.harness ? makeRng(0xA5B1E7CE) : Math.random;
    const bed = api.buses?.bed || api.bus;
    const world = api.buses?.world || api.bus;
    const S = { api, ctx, rng, bed, world, offs: [], t0: now, ctrlAcc: 0, startleAcc: 0, energySm: 0 };
    this._s = S;
    S.arc = () => clamp((c.currentTime - S.t0) / SESSION_ARC, 0, 1);

    // ---- wind bed: loop → low-pass → gain (6 s fade-in, then a slow random walk ±30 %)
    const windBuf = api.buffer('wind_loop');
    if (windBuf) {
      const src = c.createBufferSource(); src.buffer = windBuf; src.loop = true;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800; lp.Q.value = 0.4;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, now); g.gain.linearRampToValueAtTime(0.28, now + 6);
      src.connect(lp); lp.connect(g); g.connect(bed);
      src.start(now, rng() * Math.max(0, windBuf.duration - 1));
      S.wind = { src, lp, g, walk: new Walker(rng, 0.7, 1.3, 20, 40, now + 6), base: 0.28, fadeEnd: now + 6 };
    }

    // ---- water lapping: short loop, low-passed, rising with the player's glide speed
    const waterBuf = api.buffer('water_loop_1');
    if (waterBuf) {
      const src = c.createBufferSource(); src.buffer = waterBuf; src.loop = true;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.5;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, now); g.gain.linearRampToValueAtTime(0.06, now + 4);
      src.connect(lp); lp.connect(g); g.connect(bed);
      src.start(now, rng() * waterBuf.duration * 0.9);
      S.water = { src, lp, g, fadeEnd: now + 4 };
    }
    // synthesized swell: band-passed noise breathing slowly (fills in under the loop)
    {
      const src = c.createBufferSource(); src.buffer = api.noise('white', 4); src.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.7;
      const g = c.createGain(); g.gain.value = 0.0001;
      src.connect(bp); bp.connect(g); g.connect(bed);
      src.start(now);
      S.swell = { src, bp, g, walk: new Walker(rng, 0.008, 0.035, 5, 11, now) };
    }

    // ---- crickets: one shared noise source fanned out to N narrow band-passes, each gated by pulse-train curves
    {
      const noiseSrc = c.createBufferSource(); noiseSrc.buffer = api.noise('white', 4); noiseSrc.loop = true; noiseSrc.start(now);
      const list = [];
      for (let i = 0; i < CRICKET_COUNT; i++) {
        const bp = c.createBiquadFilter(); bp.type = 'bandpass';
        bp.frequency.value = 4000 + 600 * rng(); bp.Q.value = 12 + 8 * rng();
        const pa = api.spatial({ refDistance: 4, rolloff: 1.0, hrtf: false, maxDistance: 40, out: bed });
        pa.input.gain.value = 0;
        noiseSrc.connect(bp); bp.connect(pa.input);
        const ang = (i / CRICKET_COUNT) * Math.PI * 2 + (rng() - 0.5) * 0.9;
        const dist = 3 + 6 * rng();
        list.push({
          bp, pa, offset: new THREE.Vector3(Math.cos(ang) * dist, 0.25 + 0.3 * rng(), Math.sin(ang) * dist),
          rate: 22 + 12 * rng(), level: 0.05 + 0.03 * rng(), next: now + 2 + 4 * rng(), quietUntil: 0, resumeRamp: 3,
        });
      }
      S.crickets = { noiseSrc, list };
    }

    // ---- occasional distant sounds; a big-reverb send for the very far ones
    S.farWet = c.createGain(); S.farWet.gain.value = 0.8; S.farWet.connect(api.wet);
    S.nextDistant = now + 20 + 30 * rng();

    // ---- aurora shimmer: two detuned high oscillators with slow vibrato → band-pass → reverb send only
    {
      const o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = 2637; // E7
      const o2 = c.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 2637; o2.detune.value = 9;
      const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.17;
      const lfoG = c.createGain(); lfoG.gain.value = 11; // cents
      lfo.connect(lfoG); lfoG.connect(o1.detune); lfoG.connect(o2.detune);
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2800; bp.Q.value = 1.2;
      const g = c.createGain(); g.gain.value = 0.0001;
      o1.connect(bp); o2.connect(bp); bp.connect(g); g.connect(api.wet);
      o1.start(now); o2.start(now); lfo.start(now);
      S.aurora = { o1, o2, lfo, lfoG, bp, g };
    }

    // ---- events
    const startle = (min, max) => { const t = api.now(); for (const cr of S.crickets.list) cr.quietUntil = Math.max(cr.quietUntil, t + min + (max - min) * rng()); };
    S.startle = startle;
    S.offs.push(ctx.events.on('lanternsplash', () => startle(6, 12)));
    S.offs.push(ctx.events.on('lotuschord', () => startle(4, 6)));
    // headset taken off / session blurred: fade the master out fast, bring it back gently on focus
    S.offs.push(ctx.events.on('xrblur', () => {
      if (!api.master) return;
      const t = api.now();
      api.master.gain.cancelScheduledValues(t); api.master.gain.setValueAtTime(Math.max(0.0001, api.master.gain.value), t);
      api.master.gain.linearRampToValueAtTime(0.0001, t + 0.1);
    }));
    S.offs.push(ctx.events.on('xrfocus', () => {
      if (!api.master) return;
      const resume = () => {
        const t = api.now();
        api.master.gain.cancelScheduledValues(t); api.master.gain.setValueAtTime(Math.max(0.0001, api.master.gain.value), t);
        api.master.gain.linearRampToValueAtTime(api.masterLevel ?? 0.9, t + 1.0);
      };
      try { const p = c.resume(); if (p && p.then) p.then(resume, resume); else resume(); } catch { resume(); }
    }));
  },

  update(api, ctx, dt) {
    const S = this._s;
    if (!S || !api.context) return;
    const c = api.context;
    const now = c.currentTime;
    const head = ctx.playerCtl?.state?.headWorld || (ctx.camera ? ctx.camera.getWorldPosition(_h) : null);
    S.energySm += ((ctx.energy || 0) - S.energySm) * Math.min(1, dt * 0.8);

    // crickets follow the player at fixed offsets (their panners ramp smoothly in updateMatrixWorld)
    if (head) for (const cr of S.crickets.list) cr.pa.position.copy(head).add(cr.offset);

    // ---- continuous controls, ~20 Hz
    S.ctrlAcc += dt;
    if (S.ctrlAcc >= CTRL_RATE) {
      S.ctrlAcc = 0;
      if (S.wind) {
        if (now > S.wind.fadeEnd) S.wind.g.gain.setTargetAtTime(clamp(S.wind.base * S.wind.walk.at(now), 0.05, 0.4), now, 0.6);
        S.wind.lp.frequency.setTargetAtTime(1800 + 1600 * S.energySm, now, 0.8);
      }
      if (S.water && now > S.water.fadeEnd) {
        const sp = ctx.playerCtl?.state?.speed || 0;
        S.water.g.gain.setTargetAtTime(clamp(0.06 + 0.14 * smoothstep(0.1, 1.0, sp), 0, 0.2), now, 0.3);
      }
      S.swell.g.gain.setTargetAtTime(S.swell.walk.at(now), now, 0.5);
      S.aurora.g.gain.setTargetAtTime(clamp(S.energySm * 0.05, 0, 0.05), now, 1.0);
    }

    // ---- startle: a fast submerged hand silences the crickets for a while (10 Hz check)
    S.startleAcc += dt;
    if (S.startleAcc >= 0.1) {
      S.startleAcc = 0;
      const hands = ctx.hands?.list;
      if (hands) for (const h of hands) if (h.visible && h.submerged && (h.palm?.speed || 0) > 1.0) { S.startle(6, 12); break; }
    }

    // ---- cricket bursts (look-ahead scheduler, one gain curve per burst); they thin out over the session
    const arc = S.arc();
    for (const cr of S.crickets.list) {
      let guard = 0;
      while (cr.next < now + LOOKAHEAD && guard++ < 4) {
        if (cr.next < cr.quietUntil) { cr.next = cr.quietUntil + 0.5 + 1.5 * S.rng(); cr.resumeRamp = 0; continue; }
        const start = Math.max(cr.next, now + 0.01);
        const dur = 0.4 + 0.4 * S.rng();
        const amp = clamp(cr.level * CRICKET_MAKEUP * (0.35 + 0.65 * Math.min(1, cr.resumeRamp / 3)) * (1 - 0.3 * arc), 0, 0.3);
        try { cr.pa.input.gain.setValueCurveAtTime(chirpCurve(dur, cr.rate * (0.95 + 0.1 * S.rng()), amp), start, dur); }
        catch (e) { /* overlapping automation after a hitch: skip this burst */ }
        cr.resumeRamp++;
        cr.next = start + dur + (0.3 + 1.2 * S.rng()) * (1 + arc);
      }
    }

    // ---- distant sounds every 40–90 s
    if (now >= S.nextDistant) {
      S.nextDistant = now + 40 + 50 * S.rng();
      if (head) distantSound(S, head);
    }
  },

  stop() {
    const S = this._s;
    if (!S) return;
    this._s = null;
    for (const off of S.offs) { try { off(); } catch { /* */ } }
    const kill = (n) => { if (!n) return; try { n.stop?.(); } catch { /* */ } try { n.disconnect?.(); } catch { /* */ } };
    if (S.wind) { kill(S.wind.src); kill(S.wind.lp); kill(S.wind.g); }
    if (S.water) { kill(S.water.src); kill(S.water.lp); kill(S.water.g); }
    if (S.swell) { kill(S.swell.src); kill(S.swell.bp); kill(S.swell.g); }
    if (S.crickets) { kill(S.crickets.noiseSrc); for (const cr of S.crickets.list) { kill(cr.bp); try { cr.pa.dispose(); } catch { /* */ } } }
    if (S.aurora) { const a = S.aurora; kill(a.o1); kill(a.o2); kill(a.lfo); kill(a.lfoG); kill(a.bp); kill(a.g); }
    kill(S.farWet);
  },
};

/** Gain curve for one cricket burst: chirps of ~12 ms at `rate` Hz, fading in/out at the burst edges. */
function chirpCurve(dur, rate, amp) {
  const n = Math.max(8, Math.round(dur * 1000));
  const curve = new Float32Array(n);
  const chirp = 0.012;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * dur;
    const tin = (t * rate) % 1 / rate;
    const env = tin < chirp ? Math.sin(Math.PI * tin / chirp) ** 2 : 0;
    const edge = Math.min(1, t / 0.06, (dur - t) / 0.08);
    curve[i] = amp * env * clamp(edge, 0, 1);
  }
  curve[n - 1] = 0;
  return curve;
}

function distantSound(S, head) {
  const { api, ctx, rng } = S;
  const ang = rng() * Math.PI * 2, dist = 6 + 9 * rng();
  _v.set(head.x + Math.cos(ang) * dist, ctx.water?.level ?? 0.95, head.z + Math.sin(ang) * dist);
  if (rng() < 0.72) {
    const name = rng() < 0.5 ? 'plop_airy_1' : (rng() < 0.5 ? 'splash_soft_2' : 'splash_soft_3');
    api.play(name, { pos: _v, gain: 0.12 + 0.06 * rng(), rate: 0.9 + 0.2 * rng(), refDistance: 4, rolloff: 1.0, out: S.world });
  } else {
    // a faint gong, far away in 2D with a big reverb send; tuned to the chord root or fifth when its pitch is known
    let rate = 0.5;
    const p = api.pitch('gong_1');
    const chord = ctx.music?.currentChord;
    if (p && p.reliable && chord) {
      let best = 0, bestAbs = 99;
      for (const pc of [chord.root, chord.fifth]) { const d = ((pc - p.midi) % 12 + 18) % 12 - 6; if (Math.abs(d) < bestAbs) { bestAbs = Math.abs(d); best = d; } }
      rate = 0.5 * Math.pow(2, best / 12);
    }
    const res = api.play('gong_1', { gain: 0.04, rate, out: S.world });
    if (res) { try { res.gain.connect(S.farWet); } catch { /* */ } }
  }
}
