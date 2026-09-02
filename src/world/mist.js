import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { MIST_VERT, MIST_FRAG } from '../shaders/shore.js';

/**
 * Lake mist: ~40 large, very faint, flattened smoke sprites lying on the water. One InstancedMesh
 * of unit quads with a custom shader: the instance matrix only stores each sprite's home position;
 * the wind drift (wrapped around the player), the billboarding, the slow turn and the near/far
 * fades all happen on the GPU, so the per-frame CPU cost is a handful of uniforms.
 * renderOrder 3 (after the water, which writes depth: the part of a sprite under the surface is
 * clipped away), depthWrite off, normal blending, alpha 0.06–0.12. Front faces only: the billboard
 * always faces the eye, so DoubleSide would only double the edge-on raster work; cards whose alpha
 * would be invisible (near the player, overhead, or out in the far fade) are culled in the vertex
 * shader rather than rasterised full size.
 */
export const mist = {
  name: 'mist',
  init(ctx) {
    const pScale = ctx.quality?.particleScale ?? 1;
    const N = Math.max(1, Math.round(40 * pScale));
    const RANGE = 45;
    let seed = 0x3157A7;
    const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

    // where the mist should be thicker: the reed patches and islets if the shore module is in, else a fixed guess
    const hot = [];
    if (ctx.shore) {
      for (const p of ctx.shore.reedPatches || []) hot.push({ x: p.x, z: p.z, r: (p.radius || 3) + 3 });
      for (const i of ctx.shore.islets || []) hot.push({ x: i.x, z: i.z, r: i.radius + 4 });
    }
    if (!hot.length) hot.push({ x: 12.1, z: -7, r: 7 }, { x: -35.7, z: 13, r: 10 }, { x: 5.1, z: 4, r: 5 }, { x: -6.1, z: 3.8, r: 5 }, { x: -13.1, z: 9.2, r: 6 }, { x: 11.7, z: -18.7, r: 6 });

    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    const sizes = new Float32Array(N * 2), alphas = new Float32Array(N), seeds = new Float32Array(N);
    const fog = ctx.scene.fog;
    const uniforms = {
      uMap: { value: ctx.assets.tex.smoke },
      uColor: { value: new THREE.Color(0x1a2635) },
      uFogColor: { value: fog ? fog.color.clone() : new THREE.Color(CONFIG.fog.color) },
      uFogDensity: { value: fog?.density ?? CONFIG.fog.density },
      uTime: { value: 0 },
      uLevel: { value: ctx.water.level },
      uRange: { value: RANGE },
      uWind: { value: (ctx.shore?.wind || new THREE.Vector2(-1, 1).normalize()).clone().multiplyScalar(0.15) },
      uPlayer: { value: new THREE.Vector3() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: MIST_VERT, fragmentShader: MIST_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending, side: THREE.FrontSide, fog: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    const m = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      let x, z;
      if (rnd() < 0.45) {
        const h = hot[Math.floor(rnd() * hot.length)];
        const a = rnd() * Math.PI * 2, r = h.r * Math.sqrt(rnd());
        x = h.x + Math.cos(a) * r; z = h.z + Math.sin(a) * r;
      } else {
        const a = rnd() * Math.PI * 2, r = RANGE * Math.sqrt(rnd());
        x = Math.cos(a) * r; z = Math.sin(a) * r;
      }
      m.makeTranslation(x, 0, z);
      mesh.setMatrixAt(i, m);
      const w = THREE.MathUtils.lerp(5, 14, rnd() * rnd() * 0.5 + rnd() * 0.5);
      sizes[i * 2] = w;
      sizes[i * 2 + 1] = THREE.MathUtils.lerp(2, 4, rnd());
      alphas[i] = THREE.MathUtils.lerp(0.06, 0.12, rnd());
      seeds[i] = rnd();
    }
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 2));
    geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 3;
    mesh.frustumCulled = false; // positions live in the shader
    mesh.name = 'mist';
    ctx.scene.add(mesh);
    this._mesh = mesh;
    this._u = uniforms;
    ctx.mist = { mesh, count: N };
  },

  update(ctx) {
    const u = this._u;
    u.uTime.value = ctx.time.t;
    u.uLevel.value = ctx.water.level;
    const head = ctx.playerCtl?.state?.headWorld;
    if (head) u.uPlayer.value.copy(head); else ctx.camera.getWorldPosition(u.uPlayer.value);
    if (ctx.scene.fog) { u.uFogColor.value.copy(ctx.scene.fog.color); u.uFogDensity.value = ctx.scene.fog.density ?? u.uFogDensity.value; }
  },
};
