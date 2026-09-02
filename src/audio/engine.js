import * as THREE from 'three';

/**
 * Audio engine.
 *
 * Lifecycle (matters on Quest): the AudioContext exists from boot (suspended), so sample decoding and the
 * reverb impulse are prepared while the landing page is up. unlock() must be called synchronously inside
 * the user's click — it wires the graph and calls resume() without awaiting anything, so the transient
 * activation is still valid for requestSession(). Subsystems start as soon as the context runs (they null-
 * check buffers and pick them up lazily), so the wind and crickets are there when the picture fades in.
 *
 * Graph:  buses.bed / world / music / chimes  →  master  →  compressor  →  soft limiter  →  output
 *         each bus also sends to a parallel convolution reverb (bed: none, world: light, music/chimes: full)
 *
 * Sub-systems (ambience, music, sfx) attach through add(); see src/audio/index.js.
 */
export function createAudio(ctx) {
  const listener = new THREE.AudioListener();
  ctx.camera.add(listener);
  const context = listener.context; // created suspended; decoding works before any gesture
  const api = {
    listener, context, master: null, reverb: null, running: false, started: false, unlocked: false, decoded: false,
    buffers: {}, manifest: ctx.assets?.audio?.manifest || [], _noise: {},
    subsystems: [], buses: null, bus: null,
    masterLevel: 0.9,
    landingLevel: 0.0,

    /** Async, called at boot: decode the sample buffers (wind first, then everything in parallel). */
    async load() {
      if (api._loading) return api._loading;
      api._loading = (async () => {
        const bytes = ctx.assets?.audio?.bytes || {};
        const names = Object.keys(bytes);
        const decode = async (file) => {
          try { api.buffers[file.replace(/\.ogg$/, '')] = await context.decodeAudioData(bytes[file].slice(0)); }
          catch (err) { console.warn('[audio] decode failed', file, err); }
        };
        const first = names.filter((n) => n.startsWith('wind') || n.startsWith('water_loop'));
        await Promise.all(first.map(decode));
        api.windReady = true;
        api.maybeStart();
        await Promise.all(names.filter((n) => !first.includes(n)).map(decode));
        api.decoded = true;
        api.maybeStart();
      })();
      return api._loading;
    },

    /** Synchronous: wire the graph and kick resume(). Safe to call more than once. */
    unlock() {
      if (api.unlocked) { try { context.resume(); } catch { /* */ } return; }
      api.unlocked = true;
      try {
        const c = context;
        // output chain
        api.master = c.createGain(); api.master.gain.value = 0.0;
        api.comp = c.createDynamicsCompressor();
        api.comp.threshold.value = -12; api.comp.knee.value = 6; api.comp.ratio.value = 3.5; api.comp.attack.value = 0.005; api.comp.release.value = 0.25;
        api.limiter = c.createWaveShaper(); api.limiter.curve = api._clip || (api._clip = makeSoftClip()); api.limiter.oversample = '2x';
        api.master.connect(api.comp); api.comp.connect(api.limiter); api.limiter.connect(listener.getInput());
        api.analyser = c.createAnalyser(); api.analyser.fftSize = 2048; api.analyser.smoothingTimeConstant = 0;
        api.limiter.connect(api.analyser);
        api._ana = new Float32Array(api.analyser.fftSize);
        // reverb as a parallel path (the IR was rendered at boot)
        api.reverb = c.createConvolver();
        api.reverb.buffer = api._ir || (api._ir = makeImpulse(c, 4.5, 2.8));
        api.reverbHP = c.createBiquadFilter(); api.reverbHP.type = 'highpass'; api.reverbHP.frequency.value = 120;
        api.reverbReturn = c.createGain(); api.reverbReturn.gain.value = 0.45;
        api.reverb.connect(api.reverbHP); api.reverbHP.connect(api.reverbReturn); api.reverbReturn.connect(api.master);
        // layer buses with their own reverb sends
        const mk = (level, send) => {
          const g = c.createGain(); g.gain.value = level; g.connect(api.master);
          const s = c.createGain(); s.gain.value = send; g.connect(s); s.connect(api.reverb);
          g.send = s; return g;
        };
        api.buses = { bed: mk(1.0, 0.0), world: mk(1.0, 0.18), music: mk(1.0, 0.7), chimes: mk(1.0, 0.8) };
        api.bus = api.buses.world; // default for anything that doesn't pick a layer
        api.dry = api.master; api.wet = api.reverb;
        const p = c.resume();
        if (p && p.then) p.then(() => { api.running = c.state === 'running'; api.maybeStart(); }).catch(() => {});
        api.running = c.state === 'running';
        c.onstatechange = () => {
          api.running = c.state === 'running';
          if (c.state === 'suspended' && ctx.mode !== 'landing') c.resume().catch(() => {});
          api.maybeStart();
        };
        // if the browser refused (no gesture), try again on the next pointer/touch
        const retry = () => { c.resume().then(() => { api.running = c.state === 'running'; if (api.running) { document.removeEventListener('pointerdown', retry); api.maybeStart(); } }).catch(() => {}); };
        if (!api.running) document.addEventListener('pointerdown', retry);
      } catch (err) { console.warn('[audio] unlock failed', err); }
    },
    maybeStart() { if (api.running && api.unlocked && !api.started && (api.windReady || api.decoded || ctx.harness)) api.start(); },
    start() {
      if (api.started) return; api.started = true;
      api.fadeMaster(api.masterLevel, 3);
      for (const s of api.subsystems) { try { s.start?.(api, ctx); } catch (e) { console.error('[audio] subsystem start failed', e); } }
      ctx.events.emit('audiostart');
    },
    fadeMaster(level, seconds) {
      if (!api.master) return;
      const t = context.currentTime;
      const g = api.master.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, g.value), t);
      g.linearRampToValueAtTime(Math.max(0.0001, level), t + Math.max(0.02, seconds));
    },
    update(dt) {
      if (!api.started) return;
      for (const s of api.subsystems) { try { s.update?.(api, ctx, dt); } catch (e) { if (!s._err) { s._err = true; console.error('[audio] subsystem update failed', e); } } }
    },
    add(sub) { api.subsystems.push(sub); if (api.started) { try { sub.start?.(api, ctx); } catch (e) { console.error(e); } } return sub; },

    // ---- helpers used by subsystems
    buffer(name) { return api.buffers[name] || null; },
    now() { return context.currentTime; },
    /** Loudness of what reaches the listener (post-limiter): { rms, peak, rmsDb, peakDb } over the last ~46 ms. */
    stats() {
      if (!api.analyser) return { rms: 0, peak: 0, rmsDb: -Infinity, peakDb: -Infinity };
      const d = api._ana; api.analyser.getFloatTimeDomainData(d);
      let sum = 0, peak = 0;
      for (let i = 0; i < d.length; i++) { const x = d[i]; sum += x * x; const a = x < 0 ? -x : x; if (a > peak) peak = a; }
      const rms = Math.sqrt(sum / d.length);
      const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
      return { rms, peak, rmsDb: db(rms), peakDb: db(peak) };
    },
    /** Manifest entry for a decoded buffer name (file name without .ogg), or null. */
    info(name) { return api.manifest.find((m) => m.file === name + '.ogg') || null; },
    /**
     * Measured pitch of a sample from the manifest: { midi (fractional, cents folded in), hz, reliable } or null
     * when the sample is untuned. `reliable` is false when the analyser's harmonic score is weak OR when the
     * strongest audible partial is far from the reported fundamental (inharmonic bells): then the sample is
     * texture and must not be pitch-shifted.
     */
    pitch(name) {
      const m = api.info(name);
      if (!m || m.pitchHz == null || m.midi == null) return null;
      const a = m.analysis?.pitch || {};
      const score = a.harmonicScore;
      let reliable = score == null || score >= 0.9;
      const strongest = a.strongestPartialHz ?? m.strongestPartialHz;
      if (reliable && strongest && m.pitchHz) { const r = strongest / m.pitchHz; reliable = r >= 0.48 && r <= 2.1; }
      return { midi: m.midi + (m.cents || 0) / 100, hz: m.pitchHz, reliable };
    },
    /** Cached deterministic mono noise buffer ('white' | 'pink'), `seconds` long. Shared by every subsystem. */
    noise(kind = 'white', seconds = 2) {
      const key = kind + ':' + seconds;
      if (api._noise[key]) return api._noise[key];
      const c = context;
      const n = Math.floor(c.sampleRate * seconds);
      const buf = c.createBuffer(1, n, c.sampleRate);
      const d = buf.getChannelData(0);
      let seed = (kind === 'pink' ? 0x9e3779b9 : 0x7f4a7c15) >>> 0;
      const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      if (kind === 'pink') {
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; // Paul Kellet's economy pink filter
        for (let i = 0; i < n; i++) {
          const w = rnd() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        }
      } else {
        for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
      }
      api._noise[key] = buf;
      return buf;
    },
    /**
     * A PositionalAudio routed like play(): input GainNode → panner → bus, added to ctx.scene so the panner
     * follows pa.position every frame. Equalpower panning unless hrtf is requested (keep HRTF for a few sources).
     * Returns the PositionalAudio with .input (connect your graph here) and .dispose().
     */
    spatial({ pos = null, refDistance = 1.5, rolloff = 1.2, hrtf = false, maxDistance = 60, out = null } = {}) {
      const c = context;
      const input = c.createGain();
      const pa = new THREE.PositionalAudio(listener);
      pa.setNodeSource(input);
      pa.setRefDistance(refDistance); pa.setRolloffFactor(rolloff); pa.setDistanceModel('inverse'); pa.setMaxDistance(maxDistance);
      pa.panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
      try { pa.panner.disconnect(); } catch { /* */ }
      pa.panner.connect(out || api.bus);
      if (pos) pa.position.set(pos.x, pos.y, pos.z);
      ctx.scene.add(pa);
      pa.updateMatrixWorld();
      pa.input = input;
      pa.dispose = () => { ctx.scene.remove(pa); for (const n of [input, pa.panner, pa.gain]) { try { n.disconnect(); } catch { /* */ } } };
      return pa;
    },
    /** Plays a decoded buffer at a world position (or 2D if pos is null). Returns the source. */
    play(name, { pos = null, gain = 1, rate = 1, detune = 0, loop = false, refDistance = 1.5, rolloff = 1.2, hrtf = false, out = null } = {}) {
      const buf = api.buffers[name];
      if (!buf || !api.running || !api.bus) return null;
      const c = context;
      const dest = out || api.bus;
      const src = c.createBufferSource(); src.buffer = buf; src.loop = loop; src.playbackRate.value = rate;
      if (detune) src.detune.value = detune;
      const g = c.createGain(); g.gain.value = gain;
      src.connect(g);
      if (pos) {
        const pa = new THREE.PositionalAudio(listener);
        pa.setNodeSource(g);
        pa.setRefDistance(refDistance); pa.setRolloffFactor(rolloff); pa.setDistanceModel('inverse');
        pa.panner.panningModel = hrtf ? 'HRTF' : 'equalpower'; // three defaults to HRTF, which is costly per event
        pa.panner.disconnect?.();
        pa.panner.connect(dest);
        pa.position.copy(pos);
        ctx.scene.add(pa);
        pa.updateMatrixWorld();
        src.onended = () => { ctx.scene.remove(pa); for (const n of [g, pa.panner, pa.gain]) { try { n.disconnect(); } catch { /* */ } } };
        src.start();
        return { src, gain: g, node: pa };
      }
      g.connect(dest);
      src.onended = () => { try { g.disconnect(); } catch { /* */ } };
      src.start();
      return { src, gain: g, node: null };
    },
  };

  // prepare the expensive buffers now, not inside the click
  try { api._ir = makeImpulse(context, 4.5, 2.8); api._clip = makeSoftClip(); } catch (err) { console.warn('[audio] prepare failed', err); }

  // the engine owns the master fader
  ctx.events.on('xrblur', () => api.fadeMaster(0, 0.1));
  ctx.events.on('xrfocus', () => { context.resume().catch(() => {}); api.fadeMaster(api.masterLevel, 1.0); });
  ctx.events.on('xrstart', () => { if (api.started) api.fadeMaster(api.masterLevel, 2.0); });
  ctx.events.on('desktopstart', () => { if (api.started) api.fadeMaster(api.masterLevel, 2.0); });
  // a doffed headset ends the session: don't keep playing through the speakers on the landing page
  ctx.events.on('xrend', () => { if (ctx.mode !== 'desktop') api.fadeMaster(api.landingLevel, 1.5); });
  return api;
}

// Soft clip with unity gain for small signals (tanh(x)): the ceiling is tanh(1) ≈ 0.76 (−2.3 dBFS) for
// full-scale input, so stacked events squash instead of clipping. No hidden makeup gain.
function makeSoftClip() {
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x); }
  return curve;
}

// Procedural stereo impulse response: decorrelated noise, exponential decay, a tail that darkens from
// ~7 kHz to ~1.2 kHz, 30 ms pre-delay. Reads as open sky rather than a room.
function makeImpulse(context, seconds, decay) {
  const rate = context.sampleRate;
  const len = Math.floor(rate * seconds);
  const pre = Math.floor(rate * 0.03);
  const ir = context.createBuffer(2, len, rate);
  let seed = 0x1234abcd;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      const env = Math.pow(1 - t, decay);
      const n = rnd() * 2 - 1;
      const fc = 7000 * Math.pow(1200 / 7000, t); // darkening cutoff
      const a = 1 - Math.exp(-2 * Math.PI * fc / rate);
      lp += (n - lp) * a;
      const ramp = i - pre < 200 ? (i - pre) / 200 : 1;
      d[i] = lp * env * ramp;
    }
  }
  return ir;
}
