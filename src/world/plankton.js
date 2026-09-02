import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { GLSL_HASH } from '../shaders/common.js';

/**
 * Bioluminescent plankton: thousands of tiny points just under the surface. They live on an
 * infinite tiling volume around the player (wrapped in the vertex shader), and light up where the
 * wave simulation carries energy — so anything that disturbs the water leaves a glowing trail.
 * Drawn before the water (renderOrder 1) so the surface tints them.
 */
export const plankton = {
  name: 'plankton',
  init(ctx) {
    const N = Math.round(4500 * ctx.quality.particleScale);
    const TILE = 14; // metres, wraps around the player
    const level = ctx.water.level;
    const pos = new Float32Array(N * 3), seed = new Float32Array(N);
    let s = 987654321;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < N; i++) {
      pos[i * 3] = rnd() * TILE;
      pos[i * 3 + 1] = -Math.pow(rnd(), 1.8) * 0.9 - 0.015; // most within the top 30 cm
      pos[i * 3 + 2] = rnd() * TILE;
      seed[i] = rnd();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const uniforms = {
      uMap: { value: ctx.assets.tex.glowFirefly },
      uSim: { value: ctx.water.simTexture },
      uTile: { value: CONFIG.water.tileSize },
      uWrap: { value: TILE },
      uLevel: { value: level },
      uPlayer: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uPixelScale: { value: 1000 },
      uCalm: { value: 0 },
      uC0: { value: new THREE.Color(CONFIG.water.planktonColor) },
      uC1: { value: new THREE.Color(CONFIG.water.planktonColor2) },
      uHand: { value: [new THREE.Vector3(0, -10, 0), new THREE.Vector3(0, -10, 0)] },
      uHandOn: { value: [0, 0] },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform sampler2D uSim; uniform float uTile, uWrap, uLevel, uTime, uPixelScale, uCalm;
        uniform vec3 uPlayer; uniform vec3 uHand[2]; uniform float uHandOn[2];
        varying float vB; varying float vMix;
        void main() {
          vec3 p = position;
          // wrap the tile around the player so the field is endless
          p.xz = uPlayer.xz + mod(p.xz - uPlayer.xz + uWrap * 0.5, uWrap) - uWrap * 0.5;
          p.y += uLevel;
          // slow drift
          p.x += 0.05 * sin(uTime * 0.31 + aSeed * 40.0);
          p.z += 0.05 * cos(uTime * 0.27 + aSeed * 33.0);
          p.y += 0.01 * sin(uTime * 0.7 + aSeed * 50.0);
          vec4 sim = texture2D(uSim, fract(p.xz / uTile));
          float energy = sim.b * 0.75 + sim.a * 1.3;
          // no constant floor: thousands of dim points seen from 0.6 m would sum into a carpet.
          // ~8% of the plankton twinkle on their own, briefly.
          float twinkle = pow(0.5 + 0.5 * sin(uTime * (1.5 + aSeed * 3.0) + aSeed * 90.0), 12.0);
          float base = 0.28 * twinkle * step(0.92, aSeed);
          float breathe = uCalm * 0.35 * (0.5 + 0.5 * sin(uTime * 0.8 + aSeed * 6.0 - length(p.xz - uPlayer.xz) * 1.5)) * (1.0 - smoothstep(1.5, 5.0, length(p.xz - uPlayer.xz)));
          float hand = 0.0;
          // a small soft halo around a submerged hand (kept tight: it is seen from 0.5 m away)
          for (int i = 0; i < 2; i++) { float d = distance(p, uHand[i]); float k = 1.0 - smoothstep(0.02, 0.17, d); hand += uHandOn[i] * k * k; }
          float depthFade = smoothstep(-0.9, -0.05, p.y - uLevel);
          // only a fraction of the plankton respond to a given amount of energy (speckle, not a carpet)
          float react = smoothstep(0.55 - energy * 0.5, 1.0, aSeed);
          float b = (base + energy * 1.6 * react + breathe + hand * 0.45 * react) * (0.6 + 0.4 * aSeed) * depthFade;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float dist = -mv.z;
          b *= 1.0 - smoothstep(6.0, 9.0, dist);
          b *= smoothstep(0.15, 0.4, dist); // nothing huge right at the eyes
          vB = min(b, 1.3); vMix = aSeed;
          float size = (0.008 + 0.014 * aSeed + 0.015 * min(energy, 1.0)) * uPixelScale / max(dist, 0.1);
          gl_PointSize = clamp(size, 0.0, 10.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform vec3 uC0, uC1; varying float vB; varying float vMix;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a;
          vec3 c = mix(uC0, uC1, vMix) * a * vB * 2.4;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = 1; points.frustumCulled = false; points.name = 'plankton';
    ctx.scene.add(points);
    this._ = { points, uniforms };
  },
  update(ctx) {
    const u = this._.uniforms;
    u.uSim.value = ctx.water.simTexture;
    u.uTime.value = ctx.time.t;
    u.uLevel.value = ctx.water.level;
    u.uCalm.value = ctx.water.calm || 0;
    u.uPlayer.value.copy(ctx.playerCtl.state.headWorld);
    const r = ctx.renderer;
    const h = r.xr.isPresenting ? 1700 : r.domElement.height;
    u.uPixelScale.value = h * 0.55;
    ctx.hands.list.forEach((hs, i) => {
      const on = hs.visible && hs.submerged ? 1 : 0;
      u.uHandOn.value[i] = on;
      if (on) u.uHand.value[i].copy(hs.palm.position);
    });
  },
};
