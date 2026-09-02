import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { WATER_JOINTS } from '../core/hands.js';

/**
 * GPGPU wave simulation on a world-space tiling texture (tile = CONFIG.water.tileSize metres).
 * uv = fract(worldXZ / tile). One fragment pass per frame, ping-pong between two half-float targets.
 * Channels: R = height, G = previous height, B = afterglow (slow-decay energy), A = instantaneous energy.
 * Anything can push a disturbance with ctx.water.disturb(x, z, radiusMetres, strength).
 */
const MAX_DISTURB = 16;
const _wv = new THREE.Vector3();

export const wavesim = {
  name: 'wavesim',
  init(ctx) {
    const { renderer } = ctx;
    const size = ctx.quality.simSize || CONFIG.water.simSize;
    const tile = CONFIG.water.tileSize;
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    const rtA = new THREE.WebGLRenderTarget(size, size, opts);
    const rtB = new THREE.WebGLRenderTarget(size, size, opts);
    let cur = rtA, next = rtB;

    const disturb = new Float32Array(MAX_DISTURB * 4);
    const uniforms = {
      uPrev: { value: null },
      uTexel: { value: 1 / size },
      uDamping: { value: 0.98 }, // rings from a finger travel ~0.7 m before they fade; the glow stays with the hand (energy threshold)
      uSpeed: { value: 0.2 },
      uGlowDecay: { value: 0.975 },
      uDisturb: { value: disturb },
      uCount: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uPrev; uniform float uTexel, uDamping, uSpeed, uGlowDecay; uniform vec4 uDisturb[${MAX_DISTURB}]; uniform int uCount;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(uPrev, vUv);
          float h = c.r, hp = c.g, glow = c.b;
          float l = texture2D(uPrev, vUv + vec2(-uTexel, 0.0)).r;
          float r = texture2D(uPrev, vUv + vec2( uTexel, 0.0)).r;
          float d = texture2D(uPrev, vUv + vec2(0.0, -uTexel)).r;
          float u = texture2D(uPrev, vUv + vec2(0.0,  uTexel)).r;
          float lap = (l + r + u + d) * 0.25 - h;
          float vel = (h - hp) * uDamping;
          float hn = h + vel + lap * uSpeed;
          float inj = 0.0; // how hard something is pushing the water here this step
          for (int i = 0; i < ${MAX_DISTURB}; i++) {
            if (i >= uCount) break;
            vec2 dv = vUv - uDisturb[i].xy; dv -= floor(dv + 0.5);
            float rr = uDisturb[i].z;
            float q = dot(dv, dv) / (rr * rr);
            float g = exp(-q);
            // zero-mean kernel (Laplacian of a Gaussian): a push lifts a crest and sinks a trough around it, so
            // the water is displaced, never added — no mound builds up under a hand that keeps moving
            hn += uDisturb[i].w * g * (1.0 - q);
            inj += abs(uDisturb[i].w) * g;
          }
          hn = clamp(hn, -0.6, 0.6);
          hn *= 0.999; // tiny leak so the tile settles to flat
          // Plankton flash under shear, so the light is where the water is being pushed: brightest in the
          // hand's own footprint, faint on the steep crests right next to it, and none on the rings that
          // travel on across the lake — those stay pure geometry.
          float shear = abs(hn - h) * 6.0 + abs(hn) * 0.5;
          float energy = smoothstep(0.006, 0.07, inj) + 0.3 * smoothstep(0.5, 1.4, shear);
          energy = max(min(energy, 1.0), c.a * 0.8); // a few frames of persistence so substeps and 72 Hz read alike
          glow = max(glow * uGlowDecay, energy);
          gl_FragColor = vec4(hn, h, glow, energy);
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const simScene = new THREE.Scene(); simScene.add(quad);
    const simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // clear both targets (restore whatever target was bound — inside an XR frame that is the XR layer)
    const clearMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    quad.material = clearMat;
    const prevRT = renderer.getRenderTarget();
    for (const rt of [rtA, rtB]) { renderer.setRenderTarget(rt); renderer.render(simScene, simCam); }
    renderer.setRenderTarget(prevRT);
    quad.material = mat;

    const queue = [];
    ctx.water.simTexture = cur.texture;
    ctx.water.simSize = size;
    ctx.water.calm = 0;
    ctx.water.disturb = (x, z, radius, strength) => { if (queue.length < 64) queue.push({ x, z, radius, strength }); };

    const state = { rtA, rtB, mat, simScene, simCam, queue, tile, cur, next, size };
    this._s = state;
    this._headPrev = new THREE.Vector3();
    // debugging aid: render the sim texture into an RGBA8 target and return pixels + stats
    ctx.water.simSnapshot = () => this.snapshot(ctx);
  },

  snapshot(ctx) {
    const s = this._s, { renderer } = ctx;
    const size = 256;
    if (!s.snapRT) {
      s.snapRT = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false });
      s.snapMat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `uniform sampler2D uTex; varying vec2 vUv; void main(){ vec4 c = texture2D(uTex, vUv); gl_FragColor = vec4(clamp(c.r * 2.0 + 0.5, 0.0, 1.0), c.b, c.a, 1.0); }`,
        depthTest: false, depthWrite: false,
      });
      s.snapQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), s.snapMat);
      s.snapScene = new THREE.Scene(); s.snapScene.add(s.snapQuad);
      s.snapPixels = new Uint8Array(size * size * 4);
    }
    s.snapMat.uniforms.uTex.value = s.cur.texture;
    const xrWas = renderer.xr.enabled; renderer.xr.enabled = false;
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(s.snapRT); renderer.render(s.snapScene, s.simCam);
    renderer.readRenderTargetPixels(s.snapRT, 0, 0, size, size, s.snapPixels);
    renderer.setRenderTarget(prevRT); renderer.xr.enabled = xrWas;
    const px = s.snapPixels;
    let maxH = 0, sumGlow = 0, glowAbove = 0, energyAbove = 0;
    for (let i = 0; i < size * size; i++) {
      const h = Math.abs(px[i * 4] / 255 - 0.5) * 0.5; if (h > maxH) maxH = h;
      const g = px[i * 4 + 1] / 255, e = px[i * 4 + 2] / 255;
      sumGlow += g; if (g > 0.3) glowAbove++; if (e > 0.3) energyAbove++;
    }
    const n = size * size;
    return { size, maxH, meanGlow: sumGlow / n, glowFrac: glowAbove / n, energyFrac: energyAbove / n, pixels: Array.from(px) };
  },

  update(ctx, dt) {
    const s = this._s;
    const { renderer } = ctx;
    const tile = s.tile;
    const disturb = s.mat.uniforms.uDisturb.value;
    let n = 0;
    // one sim step per frame: scale injection mildly with the frame time so slow frames don't starve
    // the ripples, but never let a long frame (or a slow test run) dump a burst into the tile
    const stepScale = THREE.MathUtils.clamp(dt * 72, 0.6, 1.2);
    const push = (x, z, radius, strength) => {
      if (n >= MAX_DISTURB) return;
      disturb[n * 4] = ((x / tile) % 1 + 1) % 1;
      disturb[n * 4 + 1] = ((z / tile) % 1 + 1) % 1;
      disturb[n * 4 + 2] = THREE.MathUtils.clamp(radius, 0.02, 0.6) / tile;
      disturb[n * 4 + 3] = strength;
      n++;
    };
    ctx.water.lastDisturb = disturb; // debugging aid (read via the harness)
    // hands
    for (const h of ctx.hands.list) {
      if (!h.visible || !h.submerged) continue;
      for (const name of WATER_JOINTS) {
        const j = h.joints[name];
        if (!j.valid) continue;
        const depth = ctx.water.level - j.position.y;
        if (depth <= 0) continue;
        // world-space speed: a hand held still while the player glides still moves through the water
        _wv.copy(j.velocity).applyQuaternion(ctx.player.quaternion).add(ctx.playerCtl.velocity);
        const sp = Math.min(_wv.length(), 2.0);
        if (sp < 0.04) continue;
        const near = 1 - THREE.MathUtils.smoothstep(depth, 0.02, 0.35); // strongest right at the surface
        const strength = sp * 0.075 * (0.35 + 0.65 * near) * stepScale;
        push(j.position.x, j.position.z, j.radius * 2.2 + 0.03, Math.min(strength, 0.16));
      }
    }
    // the body moving through the water
    const head = ctx.playerCtl.state.headWorld;
    const hv = ctx.playerCtl.state.headVelocity;
    const bodySpeed = Math.hypot(hv.x, hv.z);
    if (bodySpeed > 0.08 && ctx.time.frame > 5) push(head.x, head.z, 0.28, Math.min(bodySpeed * 0.02, 0.05) * stepScale);
    // external requests
    for (const q of s.queue) push(q.x, q.z, q.radius, q.strength);
    s.queue.length = 0;

    const calm = ctx.water.calm || 0;
    s.mat.uniforms.uDamping.value = 0.98 - calm * 0.02;
    s.mat.uniforms.uPrev.value = s.cur.texture;

    // The sim is tuned for one step per 72 Hz frame. Long frames (desktop at 30 fps, the test harness)
    // take extra substeps so ripples travel and decay at the same rate; injection happens once.
    const substeps = THREE.MathUtils.clamp(Math.round(dt * 72), 1, 3);
    // Inside an XR frame three has already bound the XR layer's framebuffer as the "current" target, so we
    // must restore exactly that (getRenderTarget), never null — null would leave the headset drawing into the
    // hidden canvas. xr.enabled is switched off so render() keeps our ortho camera instead of the XR one.
    const prevRT = renderer.getRenderTarget();
    const xrWas = renderer.xr.enabled;
    renderer.xr.enabled = false;
    for (let i = 0; i < substeps; i++) {
      s.mat.uniforms.uCount.value = i === 0 ? n : 0;
      s.mat.uniforms.uPrev.value = s.cur.texture;
      renderer.setRenderTarget(s.next);
      renderer.render(s.simScene, s.simCam);
      const t = s.cur; s.cur = s.next; s.next = t;
    }
    renderer.setRenderTarget(prevRT);
    renderer.xr.enabled = xrWas;
    ctx.water.simTexture = s.cur.texture;
  },
};
