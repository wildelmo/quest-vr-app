import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_DITHER } from '../shaders/common.js';

/**
 * Aurora: a few rayed curtains far away (r ≈ 800 m, 120–420 m high), additive, driven by fbm noise.
 * Rest intensity is low; ctx.energy (lanterns, lotus, fireflies) makes the curtains brighten and
 * sweep further across the sky — "the sky answers". Also feeds ctx.sky.auroraTint so the sky dome and
 * the water pick up a matching green cast.
 */
export const aurora = {
  name: 'aurora',
  init(ctx) {
    const [c0, c1, c2] = CONFIG.colors.aurora.map((c) => new THREE.Color(c));
    const group = new THREE.Group();
    group.name = 'aurora';
    ctx.scene.add(group);

    const curtains = [
      // az0/az1: azimuth span in degrees (0 = -Z ahead, + = right); r: distance; h0/h1: bottom/top heights
      { az0: -175, az1: -55, r: 820, h0: 130, h1: 420, wob: 0.9, seed: 0.13 },
      { az0: -150, az1: -80, r: 760, h0: 110, h1: 330, wob: 1.3, seed: 0.47 },
      { az0: -120, az1: -20, r: 880, h0: 160, h1: 460, wob: 0.7, seed: 0.81 },
      { az0: 120, az1: 190, r: 840, h0: 120, h1: 340, wob: 1.1, seed: 0.29 },
    ];
    const uniforms = {
      uTime: { value: 0 }, uIntensity: { value: 0.2 }, uSweep: { value: 0 },
      uC0: { value: c0 }, uC1: { value: c1 }, uC2: { value: c2 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        attribute float aU; attribute float aSeed;
        varying float vU; varying float vV; varying float vSeed; varying vec3 vWorld;
        void main() {
          vU = aU; vV = uv.y; vSeed = aSeed;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime, uIntensity, uSweep; uniform vec3 uC0, uC1, uC2;
        varying float vU; varying float vV; varying float vSeed; varying vec3 vWorld;
        ${GLSL_HASH}
        ${GLSL_NOISE}
        ${GLSL_DITHER}
        void main() {
          float t = uTime;
          float v = vV;
          // slow large-scale brightness bands moving along the curtain
          float band = fbm(vec2(vU * 5.0 + t * 0.035 + vSeed * 10.0, t * 0.02 + vSeed));
          band = smoothstep(0.25, 0.85, band);
          // fine vertical rays
          float rays = vnoise(vec2(vU * 90.0 + t * 0.12 + vSeed * 30.0, v * 1.5 - t * 0.25));
          rays = 0.45 + 0.55 * rays;
          float rays2 = vnoise(vec2(vU * 34.0 - t * 0.07, v * 0.6 + t * 0.05 + vSeed));
          // vertical profile: crisp lower edge, long fade upward
          float lower = smoothstep(0.0, 0.08, v);
          float upper = 1.0 - smoothstep(0.25, 1.0, v);
          float edgeGlow = exp(-v * 7.0);
          // sweep: the curtain lights up progressively from one end as energy rises
          float sweep = smoothstep(vU - 0.25, vU + 0.05, uSweep);
          float a = band * rays * (0.6 + 0.4 * rays2) * lower * upper * sweep;
          a *= 1.0 - smoothstep(0.0, 0.06, abs(vU - 0.5) - 0.44); // soft ends
          vec3 col = uC0 * (edgeGlow * 1.4 + 0.35) + uC1 * smoothstep(0.1, 0.5, v) * 0.6 + uC2 * smoothstep(0.35, 0.95, v) * 0.75;
          col *= a * uIntensity;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragColor.rgb = dither8(gl_FragColor.rgb, gl_FragCoord.xy);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false,
    });

    const SEG = 72;
    for (const c of curtains) {
      const pos = [], uvs = [], aU = [], aSeed = [], idx = [];
      const az0 = THREE.MathUtils.degToRad(c.az0), az1 = THREE.MathUtils.degToRad(c.az1);
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG;
        const az = THREE.MathUtils.lerp(az0, az1, u);
        // wobble the path in radius and add a gentle S-curve so the curtain folds
        const r = c.r * (1 + 0.06 * Math.sin(u * 9.0 + c.seed * 20) * c.wob + 0.03 * Math.sin(u * 23.0 + c.seed * 7));
        const x = Math.sin(az) * r, z = -Math.cos(az) * r;
        const hBottom = c.h0 * (1 + 0.15 * Math.sin(u * 6 + c.seed * 9));
        const hTop = c.h1 * (1 + 0.25 * Math.sin(u * 4 + c.seed * 3));
        pos.push(x, hBottom, z); uvs.push(u, 0); aU.push(u); aSeed.push(c.seed);
        pos.push(x, hTop, z); uvs.push(u, 1); aU.push(u); aSeed.push(c.seed);
        if (i < SEG) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 1));
      g.setAttribute('aSeed', new THREE.Float32BufferAttribute(aSeed, 1));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = -15; mesh.frustumCulled = false; mesh.name = 'auroraCurtain';
      group.add(mesh);
    }

    this._ = { group, uniforms, intensity: 0.2, sweep: 0.3, c0, c1 };
    ctx.aurora = { intensity: 0.2 };
  },

  update(ctx, dt) {
    const s = this._;
    const target = 0.16 + ctx.energy * 0.95;
    s.intensity += (target - s.intensity) * Math.min(1, dt * 0.35);
    const sweepTarget = 0.35 + ctx.energy * 0.9;
    s.sweep += (sweepTarget - s.sweep) * Math.min(1, dt * 0.25);
    s.uniforms.uTime.value = ctx.time.t;
    s.uniforms.uIntensity.value = s.intensity * 1.15;
    s.uniforms.uSweep.value = s.sweep;
    ctx.aurora.intensity = s.intensity;
    if (ctx.sky) {
      const k = 0.06 + 0.55 * Math.max(0, s.intensity - 0.16);
      ctx.sky.auroraTint.copy(s.c0).lerp(s.c1, 0.4).multiplyScalar(k);
    }
    const p = ctx.playerCtl.state.headWorld;
    s.group.position.set(p.x, 0, p.z);
  },
};
