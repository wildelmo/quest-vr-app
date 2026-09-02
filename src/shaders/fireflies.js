// GLSL for the firefly point sprites (main layer + mirrored reflection share these sources).
// Positions are world space (the Points objects sit at the origin). Perspective point size:
//   px = worldSize * uPixelScale / depth,  uPixelScale = framebufferHeight / (2 tan(fov/2))
// Fog is the scene's FogExp2 applied as a brightness attenuation (additive sprites over a dark
// fog colour: fading toward black is the same thing as mixing toward the fog colour).
import { GLSL_FOG } from './common.js';

export const FIREFLY_VERT = /* glsl */`
attribute float aBright;
attribute float aSeed;
uniform float uPixelScale;
uniform float uSize;        // sprite world size in metres (per-firefly ±20%)
uniform float uMirror;      // 1 = reflect y about the water level
uniform float uLevel;       // water level (world y)
uniform float uFogDensity;
uniform float uMaxPx;
varying float vBright;
varying float vSeed;
${GLSL_FOG}
void main() {
  vec3 p = position;
  p.y = mix(p.y, 2.0 * uLevel - p.y, uMirror);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 0.05);
  float px = uSize * (0.8 + 0.4 * aSeed) * uPixelScale / depth;
  // sub-pixel sprites shimmer: hold a small minimum size and fade the brightness instead
  float minPx = 2.5;
  float fade = smoothstep(0.0, 1.0, px / minPx);
  gl_PointSize = clamp(px, minPx, uMaxPx);
  float fog = fogExp2(length(mv.xyz), uFogDensity);
  vBright = aBright * fade * (1.0 - fog);
  vSeed = aSeed;
  gl_Position = projectionMatrix * mv;
}
`;

export const FIREFLY_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uDim;         // 1 for the main layer, 0.4 for the reflection
uniform float uGain;
varying float vBright;
varying float vSeed;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a;
  a *= 0.45 + 0.55 * a;                                  // slightly tighter core, soft halo
  float h = (fract(vSeed * 7.31 + 0.17) - 0.5) * 0.16;   // ±8% hue drift: warmer (+) or greener (-)
  vec3 c = uColor * vec3(1.0 + h, 1.0 - abs(h) * 0.3, 1.0 - h * 1.6);
  gl_FragColor = vec4(c * (a * vBright * uDim * uGain), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
