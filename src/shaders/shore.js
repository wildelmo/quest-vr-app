// GLSL for the shore module (reeds) and the mist module. Both are custom ShaderMaterials on
// InstancedMeshes: three declares `instanceMatrix` for us under USE_INSTANCING; fog is exp2 and
// applied by hand from the scene fog uniforms.
import { GLSL_FOG } from './common.js';

// ---------------------------------------------------------------------------------------------
// Reeds: a thin tapered blade per instance. uv.y is the height fraction (0 root, 1 tip).
// Sway = two harmonics along the wind, weighted by hf² so the root stays put; hands within
// 0.45 m push the blade away (strongest at the tip). Lit by a half-lambert from the moon plus a
// hemisphere ambient, with a faint moon rim when the blade is between the eye and the moon.
export const REED_VERT = /* glsl */`
attribute float aPhase;
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uHands[2];
uniform float uHandOn[2];
varying vec3 vWorld;
varying vec3 vNormal;
varying float vH;
void main() {
  float hf = uv.y;
  float k = hf * hf;
  mat4 M = modelMatrix * instanceMatrix;
  vec4 wp = M * vec4(position, 1.0);
  vec3 base = M[3].xyz;
  float top = (M * vec4(0.0, 1.0, 0.0, 1.0)).y;
  // wind sway: main harmonic + a faster second one + a slow gust
  float s = sin(uTime * 1.3 + aPhase) * 0.04
          + sin(uTime * 2.7 + aPhase * 1.9 + 1.3) * 0.014
          + sin(uTime * 0.45 + aPhase * 0.31) * 0.02;
  vec2 off = uWind * (s * k);
  // hands push the blade away
  for (int i = 0; i < 2; i++) {
    vec2 d = base.xz - uHands[i].xz;
    float dist = length(d);
    float prox = (1.0 - smoothstep(0.08, 0.45, dist)) * uHandOn[i];
    prox *= 1.0 - smoothstep(top, top + 0.35, uHands[i].y);
    off += (d / max(dist, 0.02)) * (prox * 0.35 * k);
    wp.y -= prox * k * 0.10;
  }
  wp.xz += off;
  vWorld = wp.xyz;
  vNormal = normalize(mat3(M) * vec3(0.0, 0.0, 1.0));
  vH = hf;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const REED_FRAG = /* glsl */`
uniform vec3 uBase, uTip, uMoonDir, uMoonColor, uSkyAmb, uGroundAmb, uFogColor;
uniform float uMoonStrength, uFogDensity;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vH;
${GLSL_FOG}
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = cameraPosition - vWorld;
  float dist = length(V);
  V /= dist;
  float ndv = dot(N, V);
  if (ndv < 0.0) { N = -N; ndv = -ndv; }
  vec3 alb = mix(uBase, uTip, vH);
  float hl = dot(N, uMoonDir) * 0.5 + 0.5;
  hl *= hl;
  vec3 amb = mix(uGroundAmb, uSkyAmb, 0.3 + 0.7 * vH) * 0.7;
  vec3 col = alb * (amb + uMoonColor * (uMoonStrength * hl * 0.22));
  float rim = pow(1.0 - ndv, 3.0) * pow(max(dot(-V, uMoonDir), 0.0), 3.0);
  col += uMoonColor * (rim * 0.05 * uMoonStrength * (0.3 + 0.7 * vH));
  float fog = fogExp2(dist, uFogDensity);
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Mist: one billboard quad per instance. The instance matrix only carries the sprite's home
// position; drift with the wind, wrapping around the player, the slow bob and the billboard
// itself all happen here so nothing is uploaded per frame. aSize = (width, height),
// aAlpha = peak opacity, aSeed = per-sprite random in [0,1).
// The near fade is by HORIZONTAL distance from the eye and scales with the card's width (a 5 m card
// fades in over 5–9 m, a 14 m one over 9–14 m) so a card never fills the view at full alpha, and a
// card drifting over the player's head fades like one drifting through them. A card whose alpha
// would be invisible (< 0.004, i.e. inside the near fade or out in the far one) is pushed out of the
// clip volume instead of being rasterised as a huge transparent quad over both eyes.
// The quad is front-face only (see mist.js): with camRight = the eye's right vector and +y up, the
// plane's CCW winding faces the eye whenever the card is in front of it.
export const MIST_VERT = /* glsl */`
attribute float aSeed;
attribute vec2 aSize;
attribute float aAlpha;
uniform float uTime, uLevel, uRange;
uniform vec2 uWind;
uniform vec3 uPlayer;
varying vec2 vUv;
varying float vA;
varying float vSeed;
varying float vDist;
void main() {
  vec3 home = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  // drift with the wind, wrapped into a square of half-size uRange around the player
  vec2 rel = home.xz + uWind * uTime - uPlayer.xz;
  rel += vec2(sin(uTime * 0.11 + aSeed * 9.4), cos(uTime * 0.09 + aSeed * 5.1)) * 1.5;
  rel = mod(rel + uRange, 2.0 * uRange) - uRange;
  float bob = sin(uTime * 0.17 + aSeed * 6.2832) * 0.12;
  vec3 c = vec3(uPlayer.x + rel.x, uLevel + aSize.y * 0.32 + bob, uPlayer.z + rel.y);
  // cylindrical billboard (stays upright, faces the eye)
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  camRight.y = 0.0;
  camRight = normalize(camRight + vec3(1e-4, 0.0, 0.0));
  vec3 wp = c + camRight * (position.x * aSize.x) + vec3(0.0, position.y * aSize.y, 0.0);
  float d = distance(c, cameraPosition);
  float dh = distance(c.xz, cameraPosition.xz);
  float near = smoothstep(max(5.0, aSize.x * 0.65), max(9.0, aSize.x), dh);
  float far = 1.0 - smoothstep(uRange * 0.55, uRange * 0.95, length(rel));
  vA = aAlpha * near * far;
  vUv = uv;
  vSeed = aSeed;
  vDist = d;
  if (vA < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // invisible: cull the whole card
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

export const MIST_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor, uFogColor;
uniform float uFogDensity, uTime;
varying vec2 vUv;
varying float vA;
varying float vSeed;
varying float vDist;
${GLSL_FOG}
void main() {
  // the smoke shape turns slowly inside the (flattened) card
  float dir = fract(vSeed * 3.17) > 0.5 ? 1.0 : -1.0;
  float ang = uTime * dir * (0.025 + 0.035 * fract(vSeed * 7.31)) + vSeed * 6.2832;
  vec2 uv = vUv - 0.5;
  float ca = cos(ang), sa = sin(ang);
  uv = vec2(uv.x * ca - uv.y * sa, uv.x * sa + uv.y * ca) * 0.92 + 0.5;
  float a = texture2D(uMap, uv).a;
  // kill any hard card edge
  vec2 e = abs(vUv - 0.5) * 2.0;
  a *= 1.0 - smoothstep(0.75, 1.0, max(e.x, e.y));
  a *= vA;
  vec3 col = uColor;
  float fog = fogExp2(vDist, uFogDensity);
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
