import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { GLSL_GAL_UV, GLSL_HASH, GLSL_DITHER, GLSL_FOG } from '../shaders/common.js';

/**
 * The lake surface. One big quad, custom shader:
 *  - normals: 3 scrolling samples of a real water normal map + the gradient of the wave sim
 *  - reflection: the sky panorama looked up along the reflected view vector (same mapping as the sky dome)
 *  - moonglade: a sharp+wide specular lobe toward the moon, broken up by the ripples
 *  - bioluminescence: cyan emission from the sim's energy/afterglow channels, speckled by a noise map
 *  - Schlick fresnel between the deep colour and the reflection, exp2 fog, 8-bit dithering
 * Render order 2: underwater things draw before it (1), things above the water after it (3+).
 */
const MAX_LIGHTS = 4;
const _sortTmp = [];

export const water = {
  name: 'water',
  init(ctx) {
    const W = CONFIG.water;
    const tex = ctx.assets.tex;
    const uniforms = {
      uNormals: { value: tex.waterNormals },
      uSim: { value: ctx.water.simTexture },
      uNoise: { value: tex.noise },
      uSky: { value: tex.panorama },
      uSkyInv: { value: new THREE.Matrix3() },
      uSkyExposure: { value: CONFIG.sky.exposure },
      uTime: { value: 0 },
      uTile: { value: W.tileSize },
      uSimTexel: { value: 1 / (ctx.water.simSize || W.simSize) },
      uAlpha: { value: W.alpha },
      uDeep: { value: new THREE.Color(W.deepColor) },
      uPlankton: { value: new THREE.Color(W.planktonColor) },
      uPlankton2: { value: new THREE.Color(W.planktonColor2) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonColor: { value: new THREE.Color(CONFIG.sky.moon.tint) },
      uMoonStrength: { value: 1.0 },
      uFogColor: { value: new THREE.Color(CONFIG.fog.color) },
      uFogDensity: { value: CONFIG.fog.density },
      uPlayer: { value: new THREE.Vector3() },
      uCalm: { value: 0 },
      uAurora: { value: new THREE.Color(0x000000) },
      uDebug: { value: 0 },
      uHeightScale: { value: W.simHeightScale },
      uPatchHalf: { value: W.nearPatch / 2 },
      uLights: { value: new Float32Array(MAX_LIGHTS * 4) }, // nearest lanterns: xyz, brightness
      uLightColor: { value: new THREE.Color(CONFIG.colors.lantern) },
      uHush: { value: new Float32Array(8) }, // hush circles: world x, z, radius, strength (copied from ctx.water.hushWorld)
    };
    // Two meshes share these uniforms: a flat far plane, and a near patch around the player whose vertices are
    // displaced by the wave simulation so ripples from your fingers are real geometry, not just lighting.
    const vertexShader = /* glsl */`
        uniform sampler2D uSim; uniform float uTile, uHeightScale, uPatchHalf; uniform vec3 uPlayer;
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          #ifdef NEAR_PATCH
            float h = texture2D(uSim, fract(wp.xz / uTile)).r;
            float edge = max(abs(wp.x - uPlayer.x), abs(wp.z - uPlayer.z));
            float rim = 1.0 - smoothstep(uPatchHalf - 1.0, uPatchHalf - 0.05, edge);
            wp.y += h * uHeightScale * rim;
          #endif
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`;
    const fragmentShader = /* glsl */`
        precision highp float;
        uniform sampler2D uNormals, uSim, uNoise, uSky;
        uniform mat3 uSkyInv; uniform float uSkyExposure, uTime, uTile, uSimTexel, uAlpha, uMoonStrength, uFogDensity, uCalm, uDebug, uHeightScale, uPatchHalf;
        uniform vec3 uDeep, uPlankton, uPlankton2, uMoonDir, uMoonColor, uFogColor, uPlayer, uAurora, uLightColor;
        uniform vec4 uLights[${MAX_LIGHTS}];
        uniform vec4 uHush[2];
        varying vec3 vWorld;
        ${GLSL_GAL_UV}
        ${GLSL_HASH}
        ${GLSL_DITHER}
        ${GLSL_FOG}
        vec3 mapNormal(vec2 uv) { return texture2D(uNormals, uv).xyz * 2.0 - 1.0; }
        void main() {
          vec2 p = vWorld.xz;
          #ifdef FAR_PLANE
            // the near patch covers this square; leave it to the displaced mesh
            if (max(abs(p.x - uPlayer.x), abs(p.y - uPlayer.z)) < uPatchHalf - 0.03) discard;
          #endif
          vec3 V = cameraPosition - vWorld;
          float dist = length(V); V /= dist;
          float t = uTime;
          // --- normals from the real water normal map (3 scales, scrolling) — fade out with distance
          float detail = 1.0 / (1.0 + dist * 0.045);
          vec3 n0 = mapNormal(p / 1.9 + vec2(t * 0.020, t * 0.012));
          vec3 n1 = mapNormal(p / 6.5 + vec2(-t * 0.010, t * 0.016));
          vec3 n2 = mapNormal(p / 0.62 + vec2(t * 0.031, -t * 0.024));
          vec2 nxy = (n0.xy * 1.0 + n1.xy * 0.9 + n2.xy * 0.35) * detail * (0.55 - 0.25 * uCalm);
          // --- wave simulation gradient
          float dPlayer = length(p - uPlayer.xz);
          // --- hush: a resting hand's disc of still water. hf = 1 inside, soft edge over the outer 40 % of the
          // radius; hedge is the thin ring of plankton light on the spreading front (gone once fully grown)
          float hf = 0.0, hedge = 0.0;
          for (int i = 0; i < 2; i++) {
            vec2 hd = p - uHush[i].xy;
            float hrad = max(uHush[i].z, 1e-3);
            float hl = length(hd);
            hf = max(hf, uHush[i].w * (1.0 - smoothstep(0.6 * hrad, hrad, hl)));
            hedge += 0.10 * uHush[i].w * (1.0 - smoothstep(0.0, 0.035, abs(hl - hrad))) * max(0.0, 1.0 - hrad / 1.2);
          }
          float simFade = 1.0 - smoothstep(6.0, 8.5, dPlayer);
          vec2 suv = fract(p / uTile);
          vec4 sim = texture2D(uSim, suv);
          // forward differences from the centre tap (2 taps instead of 4; the sim is bilinear so the half-texel bias is invisible)
          float hr = texture2D(uSim, suv + vec2( uSimTexel, 0.0)).r;
          float hu = texture2D(uSim, suv + vec2(0.0,  uSimTexel)).r;
          vec2 grad = vec2(hr - sim.r, hu - sim.r) * (1.0 / (uSimTexel * uTile)); // dh/dx in (units/m)
          // slope of the displaced surface (uHeightScale metres per unit), exaggerated ×2.5 so rings read at night
          nxy += -grad * uHeightScale * 2.5 * simFade;
          nxy *= 1.0 - 0.92 * hf; // glass-still inside the hush: a mirror
          vec3 N = normalize(vec3(nxy.x, 1.0, nxy.y));
          // --- reflection of the real sky
          vec3 R = reflect(-V, N);
          R.y = max(R.y, 0.02);
          R = normalize(R);
          vec3 skyDir = uSkyInv * R;
          vec3 skyCol = sampleSky(uSky, galUV(skyDir), 1.2) * uSkyExposure;
          skyCol = mix(uFogColor * 1.4, skyCol, smoothstep(0.0, 0.16, R.y)); // atmosphere near the horizon
          skyCol += uAurora * 0.35 * smoothstep(0.05, 0.4, R.y);
          // --- moon: sharp glints + wide glow along the ripples
          float mdot = max(dot(R, uMoonDir), 0.0);
          float glint = pow(mdot, 1400.0) * 9.0 + pow(mdot, 90.0) * 0.55 + pow(mdot, 12.0) * 0.06;
          vec3 moon = uMoonColor * glint * uMoonStrength;
          // --- fresnel mix
          float ndv = max(dot(N, V), 0.0);
          float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          F = max(F, 0.32 * hf); // a deliberate lift so the stars and the aurora come up through the disc at this steep angle
          vec3 col = mix(uDeep, skyCol, F) + moon;
          // --- the nearest lanterns: their light breaks up on the ripples, so rings from your fingers read
          // as orange glints even where the sky reflection is too dim to show them
          vec3 glints = vec3(0.0);
          for (int i = 0; i < ${MAX_LIGHTS}; i++) {
            vec4 Lp = uLights[i];
            if (Lp.w <= 0.0) continue;
            vec3 Ld = Lp.xyz - vWorld; float d2 = dot(Ld, Ld); Ld *= inversesqrt(d2);
            vec3 Hh = normalize(Ld + V);
            float nh = max(dot(N, Hh), 0.0);
            float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(V, Hh), 0.0), 5.0);
            float sp = pow(nh, 260.0) * 1.0 + pow(nh, 28.0) * 0.05;
            glints += sp * Fh * 8.0 * Lp.w / (0.15 + d2 * 2.0);
          }
          col += uLightColor * glints;
          // --- bioluminescence
          float dens = texture2D(uNoise, p * 0.35).r;
          float dens2 = texture2D(uNoise, p * 1.7 + vec2(t * 0.01)).g;
          float speck = dens * 0.6 + dens2 * 0.4;
          float bio = (sim.b * 0.5 + sim.a * 0.8) * (0.2 + 0.8 * speck) * simFade;
          bio = pow(bio, 1.6); // mid values stay dim: light concentrates where the water actually moves
          float crest = clamp(length(grad) * uHeightScale * 6.0, 0.0, 1.0);
          bio *= 0.7 + 0.6 * crest; // the plankton light gathers on the ripple slopes, so rings show inside the glow
          bio += uCalm * 0.05 * (0.5 + 0.5 * sin(t * 0.8 + dPlayer * 2.0)) * (1.0 - smoothstep(1.5, 4.5, dPlayer)) * speck;
          bio *= 1.0 - 0.9 * hf; // the plankton go quiet inside the hush
          col += mix(uPlankton, uPlankton2, dens2) * bio * 0.7;
          col += uPlankton2 * hedge;
          // --- fog
          float fog = fogExp2(dist, uFogDensity);
          col = mix(col, uFogColor, fog);
          float alpha = mix(uAlpha, 1.0, max(F, fog));
          if (uDebug > 0.5) { col = vec3(sim.a, sim.b, simFade * 0.3); alpha = 1.0; }
          if (uDebug > 1.5) { col = vec3(bio, 0.0, 0.0); alpha = 1.0; }
          if (uDebug > 2.5) { col = vec3(clamp(sim.r * 4.0 + 0.5, 0.0, 1.0)); alpha = 1.0; }
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragColor.rgb = dither8(gl_FragColor.rgb, gl_FragCoord.xy);
        }`;
    const common = { uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: true, depthTest: true, side: THREE.FrontSide, fog: false };
    const farMat = new THREE.ShaderMaterial({ ...common, defines: { FAR_PLANE: '' } });
    const nearMat = new THREE.ShaderMaterial({ ...common, defines: { NEAR_PATCH: '' } });
    const geo = new THREE.PlaneGeometry(W.extent, W.extent, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, farMat);
    mesh.position.y = ctx.water.level;
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    mesh.name = 'water';
    ctx.scene.add(mesh);
    const seg = ctx.quality.tier === 'quest2' ? 128 : 160;
    const nearGeo = new THREE.PlaneGeometry(W.nearPatch, W.nearPatch, seg, seg);
    nearGeo.rotateX(-Math.PI / 2);
    const near = new THREE.Mesh(nearGeo, nearMat);
    near.position.y = ctx.water.level;
    near.renderOrder = 2;
    near.frustumCulled = false;
    near.name = 'waterNear';
    ctx.scene.add(near);
    this.mesh = mesh; this.near = near; this.uniforms = uniforms;
    ctx.water.mesh = mesh;
    ctx.water.nearMesh = near;
    ctx.water.uniforms = uniforms;
  },
  update(ctx) {
    const u = this.uniforms;
    u.uTime.value = ctx.time.t;
    u.uSim.value = ctx.water.simTexture;
    u.uCalm.value = Math.max(ctx.water.calm || 0, 0.6 * (ctx.water.hush?.strength || 0)); // a full hush counts as 0.6 calm
    if (ctx.water.hushWorld) u.uHush.value.set(ctx.water.hushWorld);
    const p = ctx.playerCtl.state.headWorld;
    u.uPlayer.value.copy(p);
    // keep the quad centred on the player (the shader works in world space, so this is invisible)
    this.mesh.position.x = Math.round(p.x / 8) * 8;
    this.mesh.position.z = Math.round(p.z / 8) * 8;
    this.mesh.position.y = ctx.water.level;
    // the displaced patch follows the head exactly (its vertices sample the sim at their world xz)
    this.near.position.set(p.x, ctx.water.level, p.z);
    // the four brightest nearby lanterns light the ripples
    const lights = u.uLights.value;
    lights.fill(0);
    const list = ctx.lanterns?.list;
    if (list && list.length) {
      _sortTmp.length = 0;
      for (const L of list) {
        if (L.bright <= 0.05 || L.state === 'rising') continue;
        const dx = L.position.x - p.x, dz = L.position.z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 64) continue;
        _sortTmp.push({ L, key: d2 / (0.2 + L.bright) });
      }
      _sortTmp.sort((a, b) => a.key - b.key);
      for (let i = 0; i < Math.min(MAX_LIGHTS, _sortTmp.length); i++) {
        const L = _sortTmp[i].L;
        lights[i * 4] = L.position.x; lights[i * 4 + 1] = L.position.y; lights[i * 4 + 2] = L.position.z;
        lights[i * 4 + 3] = L.bright * (L.flame || 1);
      }
    }
    if (ctx.sky) {
      u.uSkyInv.value.copy(ctx.sky.worldToPhoto);
      u.uMoonDir.value.copy(ctx.sky.moonDirWorld);
      u.uMoonStrength.value = ctx.sky.moonAbove;
      u.uAurora.value.copy(ctx.sky.auroraTint || u.uAurora.value);
    }
  },
};
