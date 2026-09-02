// GLSL for src/world/lanterns.js (GLSL ES 3.00 via three's ShaderMaterial preprocessing).
import { GLSL_HASH, GLSL_NOISE, GLSL_FOG } from './common.js';

/**
 * Lantern bodies: one InstancedMesh. Geometry origin is at the TOP of the lantern (the hanging
 * point), local y in [-uHeight, 0]. Instanced attributes: aSeed, aBright (0..1), aHeld (0/1).
 * Per-vertex attribute aPart: 0 = paper, 1 = the dark bamboo rings.
 * The candle flicker is evaluated per vertex (it is constant per instance anyway).
 */
export const LANTERN_BODY_VERT = /* glsl */`
attribute float aSeed; attribute float aBright; attribute float aHeld; attribute float aPart;
uniform float uTime; uniform float uHeight;
varying vec3 vNormalW; varying vec3 vWorldPos; varying vec2 vUv;
varying float vH; varying float vPart; varying float vBright; varying float vFlicker; varying float vHeld;
${GLSL_HASH}
${GLSL_NOISE}
void main() {
  vec4 wp = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
    n = mat3(instanceMatrix) * n;
  #endif
  wp = modelMatrix * wp;
  vWorldPos = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * n);
  vUv = uv;
  vH = clamp((position.y + uHeight) / uHeight, 0.0, 1.0); // 0 = bottom, 1 = top
  vPart = aPart; vBright = aBright; vHeld = aHeld;
  // candle flicker: value noise along time (~7 cells/s) plus a slow breath
  float fl = 0.85 + 0.15 * vnoise(vec2(uTime * 7.0 + aSeed * 113.0, aSeed * 41.0));
  fl *= 0.97 + 0.03 * sin(uTime * 1.7 + aSeed * 30.0);
  vFlicker = fl;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const LANTERN_BODY_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uPaper;
uniform vec3 uColor; uniform vec3 uColorHot; uniform vec3 uFogColor;
uniform float uFogDensity;
varying vec3 vNormalW; varying vec3 vWorldPos; varying vec2 vUv;
varying float vH; varying float vPart; varying float vBright; varying float vFlicker; varying float vHeld;
${GLSL_FOG}
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = cameraPosition - vWorldPos;
  float dist = length(V); V /= dist;
  float ndv = abs(dot(N, V));
  vec3 col;
  if (vPart > 0.5) {
    // dark lacquered bamboo rings, faintly warmed by the candle
    col = vec3(0.10, 0.055, 0.03) * (0.35 + 0.65 * ndv) + uColorHot * 0.05 * vFlicker * (0.3 + vBright);
  } else {
    float p = texture2D(uPaper, vec2(vUv.x * 2.0, vH * 3.0)).r;   // paper tiled 2 x 3
    float fibre = mix(0.68, 1.32, p);
    float candle = exp(-pow((vH - 0.30) / 0.24, 2.0));              // brightest low-centre
    float base = 0.18 + 0.82 * candle;
    float through = 0.5 + 0.5 * ndv;                                // paper glows most seen face-on
    float rim = smoothstep(0.0, 0.07, vH) * smoothstep(1.0, 0.93, vH);
    float I = mix(0.25, 1.7, vBright) * vFlicker;
    col = mix(uColor, uColorHot, candle * 0.7) * base * fibre * through * I;
    col += vec3(0.30, 0.22, 0.10) * candle * candle * I * 0.45;     // hot core near the flame
    col = mix(col * 0.18, col, rim);                                // dark rims at the edges
  }
  float fog = fogExp2(dist, uFogDensity);
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Glow sprites (THREE.Points). Positions are the lantern centres. The point is pulled toward the
 * eye along its view ray (uPull metres) so the opaque body does not depth-clip the sprite; its
 * world size is clamped to 0.35 x distance so a lantern at the face does not flood the view.
 * Far glows fade out (30..60 m) so arrivals emerge from the murk and ascents vanish into it.
 */
export const LANTERN_GLOW_VERT = /* glsl */`
attribute float aBright; attribute float aSeed;
uniform float uPixelScale; uniform float uSize; uniform float uWaterLevel; uniform float uTime; uniform float uPull;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(-mv.z, 0.05);
  float ws = min(uSize, 0.35 * d);
  // a point sprite has one depth: slide it toward the eye by more than its own radius so the water in
  // front of the lantern's base (seen from above) cannot clip the lower half of the halo
  mv.xyz *= max(d - (uPull + ws * 0.6), 0.12) / d;
  float fl = 0.92 + 0.08 * sin(uTime * 9.0 + aSeed * 50.0) * sin(uTime * 5.3 + aSeed * 20.0);
  vA = aBright * fl * (1.0 - smoothstep(30.0, 60.0, d));
  gl_PointSize = clamp(ws * uPixelScale / d, 1.0, 1024.0);
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Mirrored glow: the virtual image of the glow below the water plane, sized by its distance, but the
 * sprite is slid along the view ray to just in front of the point where that ray meets the surface.
 * Drawn after the water (renderOrder 3, depth-tested) it reads as a reflection on the surface instead
 * of being swallowed by the water's alpha, and anything between the eye and that surface point still
 * occludes it. When the eye is below the surface the mirror image is above it and the same math holds.
 */
export const LANTERN_MIRROR_VERT = /* glsl */`
attribute float aBright; attribute float aSeed;
uniform float uPixelScale; uniform float uSize; uniform float uWaterLevel; uniform float uTime; uniform float uPull;
varying float vA;
void main() {
  vec3 m = vec3(position.x, 2.0 * uWaterLevel - position.y, position.z);
  vec4 mv = modelViewMatrix * vec4(m, 1.0);
  float d = max(-mv.z, 0.05);
  float ws = min(uSize, 0.35 * d);
  float camH = cameraPosition.y - uWaterLevel;
  float imgH = m.y - uWaterLevel;
  float f = clamp(camH / max(camH - imgH, 1e-3), 0.0, 1.0); // fraction of the ray at the water plane
  // sit just in front of the surface point, by more than the halo's radius (see LANTERN_GLOW_VERT)
  mv.xyz *= max(f * d - (uPull + ws * 0.6), 0.12) / d;
  float fl = 0.92 + 0.08 * sin(uTime * 9.0 + aSeed * 50.0) * sin(uTime * 5.3 + aSeed * 20.0);
  vA = aBright * fl * (1.0 - smoothstep(30.0, 60.0, d));
  gl_PointSize = clamp(ws * uPixelScale / d, 1.0, 1024.0);
  gl_Position = projectionMatrix * mv;
}
`;

export const LANTERN_GLOW_FRAG = /* glsl */`
uniform sampler2D uMap; uniform vec3 uColor; uniform vec3 uColorHot; uniform float uGain;
varying float vA;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a;
  vec3 c = mix(uColor, uColorHot, 0.35 * a) * (a * a * 1.1 + a * 0.45) * vA * uGain;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** The flame itself: a 3 cm hot dot at the candle (5 cm below the centre), flickering. aFlame = extra gain. */
export const LANTERN_FLAME_VERT = /* glsl */`
attribute float aBright; attribute float aSeed; attribute float aFlame;
uniform float uPixelScale; uniform float uTime; uniform float uPull;
varying float vA; varying float vHot;
${GLSL_HASH}
${GLSL_NOISE}
void main() {
  vec3 p = position + vec3(0.0, -0.05, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = max(-mv.z, 0.05);
  mv.xyz *= max(d - uPull, 0.02) / d;
  float n = vnoise(vec2(uTime * 7.0 + aSeed * 113.0, aSeed * 41.0));
  float fl = 0.8 + 0.2 * n;
  vA = (0.25 + 0.75 * aBright) * fl * aFlame * (1.0 - smoothstep(30.0, 60.0, d));
  vHot = n;
  gl_PointSize = clamp(0.03 * (0.85 + 0.3 * n) * aFlame * uPixelScale / d, 1.0, 256.0);
  gl_Position = projectionMatrix * mv;
}
`;

export const LANTERN_FLAME_FRAG = /* glsl */`
uniform sampler2D uMap;
varying float vA; varying float vHot;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a;
  vec3 hot = vec3(1.0, 0.93, 0.78);
  vec3 orange = vec3(1.0, 0.48, 0.12);
  vec3 c = mix(orange, hot, a * a * (0.5 + 0.5 * vHot)) * a * vA * 2.6;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
