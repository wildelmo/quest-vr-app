import * as THREE from 'three';

/**
 * Audio engine scaffold. The context is created lazily on the first user gesture (unlock()).
 * Sub-systems (ambience, music, sfx) attach themselves through ctx.audio once it is running.
 * See src/audio/ambience.js, music.js, sfx.js.
 */
export function createAudio(ctx) {
  const listener = new THREE.AudioListener();
  ctx.camera.add(listener);
  const api = {
    listener, context: null, master: null, reverb: null, dry: null, wet: null, running: false,
    buffers: {}, manifest: ctx.assets?.audio?.manifest || [], _noise: {},
    subsystems: [],
    async unlock() {
      if (api.running) { try { await api.context.resume(); } catch { /* ignore */ } return; }
      try {
        const context = listener.context;
        api.context = context;
        api.master = context.createGain(); api.master.gain.value = 0.0;
        api.comp = context.createDynamicsCompressor();
        api.comp.threshold.value = -14; api.comp.knee.value = 18; api.comp.ratio.value = 3; api.comp.attack.value = 0.01; api.comp.release.value = 0.25;
        api.master.connect(api.comp);
        api.comp.connect(listener.getInput());
        api.analyser = context.createAnalyser(); api.analyser.fftSize = 2048; api.analyser.smoothingTimeConstant = 0;
        api.comp.connect(api.analyser);
        api._ana = new Float32Array(api.analyser.fftSize);
        // send/return reverb
        api.reverb = context.createConvolver();
        api.reverb.buffer = makeImpulse(context, 4.2, 2.6);
        api.wet = context.createGain(); api.wet.gain.value = 0.32;
        api.dry = context.createGain(); api.dry.gain.value = 1.0;
        api.dry.connect(api.master);
        api.wet.connect(api.reverb); api.reverb.connect(api.master);
        api.bus = context.createGain(); api.bus.connect(api.dry); api.bus.connect(api.wet);
        await context.resume();
        api.running = context.state === 'running';
        if (!api.running) {
          const retry = () => { context.resume().then(() => { api.running = context.state === 'running'; if (api.running) { document.removeEventListener('pointerdown', retry); api.start(); } }); };
          document.addEventListener('pointerdown', retry);
        }
        await decodeAll(api, ctx);
        if (api.running) api.start();
      } catch (err) { console.warn('[audio] unlock failed', err); }
    },
    start() {
      if (api.started) return; api.started = true;
      const t = api.context.currentTime;
      api.master.gain.setValueAtTime(0, t); api.master.gain.linearRampToValueAtTime(api.masterLevel, t + 2.5);
      for (const s of api.subsystems) { try { s.start?.(api, ctx); } catch (e) { console.error('[audio] subsystem start failed', e); } }
      ctx.events.emit('audiostart');
    },
    update(dt) {
      if (!api.started) return;
      for (const s of api.subsystems) { try { s.update?.(api, ctx, dt); } catch (e) { if (!s._err) { s._err = true; console.error('[audio] subsystem update failed', e); } } }
    },
    add(sub) { api.subsystems.push(sub); if (api.started) { try { sub.start?.(api, ctx); } catch (e) { console.error(e); } } return sub; },
    // helpers used by subsystems
    buffer(name) { return api.buffers[name] || null; },
    now() { return api.context ? api.context.currentTime : 0; },
    masterLevel: 0.9,
    /** Loudness of what reaches the listener (post-compressor): { rms, peak, rmsDb, peakDb } over the last ~46 ms. */
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
     * when the sample is untuned. `reliable` is false when the analyser's harmonic score is weak, in which case
     * callers should treat the sample as texture and not pitch-shift it.
     */
    pitch(name) {
      const m = api.info(name);
      if (!m || m.pitchHz == null || m.midi == null) return null;
      const score = m.analysis?.pitch?.harmonicScore;
      return { midi: m.midi + (m.cents || 0) / 100, hz: m.pitchHz, reliable: score == null || score >= 0.9 };
    },
    /** Cached deterministic mono noise buffer ('white' | 'pink'), `seconds` long. Shared by every subsystem. */
    noise(kind = 'white', seconds = 2) {
      const key = kind + ':' + seconds;
      if (api._noise[key]) return api._noise[key];
      const c = api.context;
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
     * A PositionalAudio routed like play(): input GainNode → panner → api.bus, added to ctx.scene so the panner
     * follows pa.position every frame. Equalpower panning unless hrtf is requested (keep HRTF for a few sources).
     * Returns the PositionalAudio with .input (connect your graph here) and .dispose().
     */
    spatial({ pos = null, refDistance = 1.5, rolloff = 1.2, hrtf = false, maxDistance = 60, out = null } = {}) {
      const c = api.context;
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
    play(name, { pos = null, gain = 1, rate = 1, detune = 0, loop = false, refDistance = 1.5, rolloff = 1.2, wet = null, out = null } = {}) {
      const buf = api.buffers[name];
      if (!buf || !api.running) return null;
      const c = api.context;
      const dest = out || api.bus;
      const src = c.createBufferSource(); src.buffer = buf; src.loop = loop; src.playbackRate.value = rate;
      if (detune) src.detune.value = detune;
      const g = c.createGain(); g.gain.value = gain;
      src.connect(g);
      if (pos) {
        const pa = new THREE.PositionalAudio(listener);
        pa.setNodeSource(g);
        pa.setRefDistance(refDistance); pa.setRolloffFactor(rolloff); pa.setDistanceModel('inverse');
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
  return api;
}

async function decodeAll(api, ctx) {
  const bytes = ctx.assets?.audio?.bytes || {};
  const entries = Object.entries(bytes);
  await Promise.all(entries.map(async ([file, ab]) => {
    try { api.buffers[file.replace(/\.ogg$/, '')] = await api.context.decodeAudioData(ab.slice(0)); }
    catch (err) { console.warn('[audio] decode failed', file, err); }
  }));
}

// Procedural stereo impulse response: decorrelated noise with exponential decay and a darkening tail.
function makeImpulse(context, seconds, decay) {
  const rate = context.sampleRate;
  const len = Math.floor(rate * seconds);
  const ir = context.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decay);
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * (0.35 - 0.3 * t); // progressively darker
      d[i] = lp * env * (i < 400 ? i / 400 : 1);
    }
  }
  return ir;
}
