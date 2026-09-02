import * as THREE from 'three';

// Asset manifest. Paths are relative to index.html so the site works under a sub-path (GitHub Pages).
const TEXTURES = {
  panorama4k: { url: 'assets/sky/milkyway_4k.jpg', srgb: true, mips: true, tier: '4k' },
  panorama2k: { url: 'assets/sky/milkyway_2k.jpg', srgb: true, mips: true, tier: '2k' },
  moon: { url: 'assets/textures/moon_1024.jpg', srgb: true, mips: true },
  waterNormals: { url: 'assets/textures/waternormals.jpg', srgb: false, mips: true, repeat: true },
  noise: { url: 'assets/textures/noise.png', srgb: false, mips: true, repeat: true },
  caustic: { url: 'assets/textures/caustic.jpg', srgb: false, mips: true, repeat: true },
  paper: { url: 'assets/textures/paper.png', srgb: false, mips: true, repeat: true },
  glowSoft: { url: 'assets/textures/glow_soft.png', srgb: false, mips: true },
  glowFirefly: { url: 'assets/textures/glow_firefly.png', srgb: false, mips: true },
  spark: { url: 'assets/textures/spark1.png', srgb: true, mips: true },
  disc: { url: 'assets/textures/disc.png', srgb: false, mips: true },
  circle: { url: 'assets/textures/circle.png', srgb: false, mips: true },
  smoke: { url: 'assets/textures/smoke1.png', srgb: false, mips: true },
  ring: { url: 'assets/textures/ripple_ring.png', srgb: false, mips: true },
  blossom: { url: 'assets/textures/blossom.png', srgb: true, mips: true },
};

const DATA = {
  starsBin: 'assets/sky/stars.bin',
  starsMeta: 'assets/sky/stars.json',
  skyMeta: 'assets/sky/sky.json',
  audioManifest: 'assets/audio/manifest.json',
};

/**
 * Loads everything the world needs up front (textures + star catalog + audio bytes).
 * Audio is fetched as ArrayBuffers here and decoded later by the audio engine once an
 * AudioContext exists (it needs a user gesture on Quest).
 */
export async function loadAssets(ctx, onProgress = () => {}) {
  const assets = { tex: {}, stars: null, sky: null, audio: { bytes: {}, manifest: [] } };
  const quality = ctx.quality;

  const texEntries = Object.entries(TEXTURES).filter(([, d]) => !d.tier || d.tier === quality.panorama);
  const total = texEntries.length + Object.keys(DATA).length + 1; // +1 for audio group
  let done = 0;
  const tick = (label) => { done++; onProgress(done / total, label); };

  const loader = new THREE.TextureLoader();
  const loadTex = (key, d) => new Promise((resolve) => {
    loader.load(d.url, (t) => {
      t.colorSpace = d.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.generateMipmaps = !!d.mips;
      t.minFilter = d.mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      if (d.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
      t.anisotropy = Math.min(quality.anisotropy, ctx.renderer.capabilities.getMaxAnisotropy());
      assets.tex[key] = t;
      tick(key); resolve(t);
    }, undefined, (err) => {
      console.warn(`[assets] texture failed: ${d.url}`, err);
      assets.tex[key] = fallbackTexture(d.srgb);
      tick(key); resolve(assets.tex[key]);
    });
  });

  const fetchJSON = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
  const fetchBin = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.arrayBuffer(); };

  const jobs = [];
  for (const [key, d] of texEntries) jobs.push(loadTex(key, d));

  jobs.push((async () => {
    try {
      const [bin, meta, sky] = await Promise.all([fetchBin(DATA.starsBin), fetchJSON(DATA.starsMeta), fetchJSON(DATA.skyMeta)]);
      assets.stars = { data: new Float32Array(bin), meta };
      assets.sky = sky;
    } catch (err) {
      console.warn('[assets] star catalog unavailable, using a synthetic sky', err);
      assets.stars = syntheticStars(3000);
      assets.sky = null;
    }
    tick('stars'); tick('starsMeta'); tick('sky');
  })());

  jobs.push((async () => {
    try {
      const manifest = await fetchJSON(DATA.audioManifest);
      assets.audio.manifest = manifest;
      await Promise.all(manifest.map(async (item) => {
        try { assets.audio.bytes[item.file] = await fetchBin('assets/audio/' + item.file); }
        catch (err) { console.warn('[assets] audio failed:', item.file, err); }
      }));
    } catch (err) {
      console.warn('[assets] audio manifest unavailable; synthesized audio only', err);
    }
    tick('audio'); tick('audioManifest');
  })());

  await Promise.all(jobs);
  assets.tex.panorama = assets.tex.panorama4k || assets.tex.panorama2k;
  return assets;
}

function fallbackTexture(srgb) {
  const data = new Uint8Array([128, 128, 255, 255]);
  const t = new THREE.DataTexture(data, 1, 1);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function syntheticStars(n) {
  const data = new Float32Array(n * 4);
  let s = 1234567;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < n; i++) {
    data[i * 4] = rnd() * Math.PI * 2;
    data[i * 4 + 1] = Math.asin(rnd() * 2 - 1);
    data[i * 4 + 2] = 1.5 + rnd() * 5;
    data[i * 4 + 3] = rnd() * 1.6 - 0.2;
  }
  return { data, meta: { count: n, stride: 4, named: [] } };
}
