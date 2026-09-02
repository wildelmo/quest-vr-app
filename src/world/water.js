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
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uNormals, uSim, uNoise, uSky;
        uniform mat3 uSkyInv; uniform float uSkyExposure, uTime, uTile, uSimTexel, uAlpha, uMoonStrength, uFogDensity, uCalm;
        uniform vec3 uDeep, uPlankton, uPlankton2, uMoonDir, uMoonColor, uFogColor, uPlayer, uAurora;
        varying vec3 vWorld;
        ${GLSL_GAL_UV}
        ${GLSL_HASH}
        ${GLSL_DITHER}
        ${GLSL_FOG}
        vec3 mapNormal(vec2 uv) { return texture2D(uNormals, uv).xyz * 2.0 - 1.0; }
        void main() {
          vec3 V = cameraPosition - vWorld;
          float dist = length(V); V /= dist;
          vec2 p = vWorld.xz;
          float t = uTime;
          // --- normals from the real water normal map (3 scales, scrolling) — fade out with distance
          float detail = 1.0 / (1.0 + dist * 0.045);
          vec3 n0 = mapNormal(p / 1.9 + vec2(t * 0.020, t * 0.012));
          vec3 n1 = mapNormal(p / 6.5 + vec2(-t * 0.010, t * 0.016));
          vec3 n2 = mapNormal(p / 0.62 + vec2(t * 0.031, -t * 0.024));
          vec2 nxy = (n0.xy * 1.0 + n1.xy * 0.9 + n2.xy * 0.35) * detail * (0.55 - 0.25 * uCalm);
          // --- wave simulation gradient
          float dPlayer = length(p - uPlayer.xz);
          float simFade = 1.0 - smoothstep(6.0, 8.5, dPlayer);
          vec2 suv = fract(p / uTile);
          vec4 sim = texture2D(uSim, suv);
          float hl = texture2D(uSim, suv + vec2(-uSimTexel, 0.0)).r;
          float hr = texture2D(uSim, suv + vec2( uSimTexel, 0.0)).r;
          float hd = texture2D(uSim, suv + vec2(0.0, -uSimTexel)).r;
          float hu = texture2D(uSim, suv + vec2(0.0,  uSimTexel)).r;
          vec2 grad = vec2(hr - hl, hu - hd) * (0.5 / (uSimTexel * uTile)); // dh/dx in (units/m)
          nxy += -grad * 0.06 * simFade;
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
          vec3 col = mix(uDeep, skyCol, F) + moon;
          // --- bioluminescence
          float dens = texture2D(uNoise, p * 0.35).r;
          float dens2 = texture2D(uNoise, p * 1.7 + vec2(t * 0.01)).g;
          float speck = dens * 0.6 + dens2 * 0.4;
          float bio = (sim.b * 0.45 + sim.a * 0.9) * (0.25 + 0.75 * speck) * simFade;
          bio += uCalm * 0.05 * (0.5 + 0.5 * sin(t * 0.8 + dPlayer * 2.0)) * (1.0 - smoothstep(1.5, 4.5, dPlayer)) * speck;
          col += mix(uPlankton, uPlankton2, dens2) * bio * 1.1;
          // --- fog
          float fog = fogExp2(dist, uFogDensity);
          col = mix(col, uFogColor, fog);
          float alpha = mix(uAlpha, 1.0, max(F, fog));
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragColor.rgb = dither8(gl_FragColor.rgb, gl_FragCoord.xy);
        }`,
      transparent: true, depthWrite: true, depthTest: true, side: THREE.FrontSide, fog: false,
    });
    const geo = new THREE.PlaneGeometry(W.extent, W.extent, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = ctx.water.level;
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    mesh.name = 'water';
    ctx.scene.add(mesh);
    this.mesh = mesh; this.uniforms = uniforms;
    ctx.water.mesh = mesh;
    ctx.water.uniforms = uniforms;
  },
  update(ctx) {
    const u = this.uniforms;
    u.uTime.value = ctx.time.t;
    u.uSim.value = ctx.water.simTexture;
    u.uCalm.value = ctx.water.calm || 0;
    const p = ctx.playerCtl.state.headWorld;
    u.uPlayer.value.copy(p);
    // keep the quad centred on the player (the shader works in world space, so this is invisible)
    this.mesh.position.x = Math.round(p.x / 8) * 8;
    this.mesh.position.z = Math.round(p.z / 8) * 8;
    this.mesh.position.y = ctx.water.level;
    if (ctx.sky) {
      u.uSkyInv.value.copy(ctx.sky.worldToPhoto);
      u.uMoonDir.value.copy(ctx.sky.moonDirWorld);
      u.uMoonStrength.value = ctx.sky.moonAbove;
      u.uAurora.value.copy(ctx.sky.auroraTint || u.uAurora.value);
    }
  },
};
