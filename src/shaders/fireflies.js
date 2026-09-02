// GLSL for the firefly point sprites: the main layer and the mirrored reflection share the fragment
// shader. Positions are world space (the Points objects sit at the origin). Perspective point size:
//   px = worldSize * uPixelScale / depth,  uPixelScale = 0.5 * viewportHeight * projection[1][1]
// (ctx.view.pixelScale, right for asymmetric XR frusta too). Fog is the scene's FogExp2 applied as a
// brightness attenuation (additive sprites over a dark fog colour: fading toward black is the same
// thing as mixing toward the fog colour).
//
// The sprite is the *glow* of a firefly, not the insect: a small bright core (the lantern) inside a
// wide, soft halo (the glare a point of light throws in a dark-adapted eye). uSize is the halo's
// world diameter; the core is ~a fifth of it.
import { GLSL_FOG } from './common.js';

/**
 * Shared by both vertex shaders. `px` is the unclamped perspective size of the halo, `dist` the
 * distance used for fog. Writes gl_PointSize and returns the brightness factor that goes with it:
 *  - the size is held at a small minimum angle (~0.35 deg, min 2.5 px) instead of shrinking into
 *    sub-pixel shimmer; only beyond that (tens of metres) does the brightness fade with the size
 *  - a sprite a few pixels wide loses most of the profile to averaging (its core is a fraction of a
 *    texel), so the point's brightness is held up in compensation: a far firefly stays a twinkling
 *    point instead of a grey smear that vanishes
 *  - a light seen through haze dims more slowly than a lit surface: 70% of the fog factor
 */
const GLSL_FIREFLY_SIZE = /* glsl */`
float fireflySize(float px, float dist) {
  float minPx = max(2.5, uPixelScale * 0.006);
  float fade = smoothstep(0.0, 1.0, px / minPx);
  float tiny = 1.0 - smoothstep(3.0, 16.0, px);
  gl_PointSize = clamp(px, minPx, uMaxPx);
  float fog = fogExp2(dist, uFogDensity);
  return fade * (1.0 + 1.8 * tiny) * (1.0 - 0.7 * fog);
}
`;

export const FIREFLY_VERT = /* glsl */`
attribute float aBright;
attribute float aSeed;
uniform float uPixelScale;
uniform float uSize;        // halo world diameter in metres (per-firefly ±20%)
uniform float uFogDensity;
uniform float uMaxPx;
varying float vBright;      // pixel brightness: the flash level with the size / fog corrections
varying float vFlash;       // the flash level itself, 0..1: drives the colour
varying float vSeed;
${GLSL_FOG}
${GLSL_FIREFLY_SIZE}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 0.05);
  float px = uSize * (0.8 + 0.4 * aSeed) * uPixelScale / depth;
  vBright = aBright * fireflySize(px, length(mv.xyz));
  vFlash = aBright;
  vSeed = aSeed;
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Reflection: the virtual image I of the firefly below the water plane is sized and fogged by its own
 * distance (that is what a reflection looks like), but the sprite is slid along the eye→I ray to just
 * in front of the point where that ray meets the surface. Drawn after the water (renderOrder 3, depth
 * tested against it) it reads as a glint ON the surface instead of being swallowed by the water's
 * alpha, and anything between the eye and that surface point still occludes it (see
 * LANTERN_MIRROR_VERT for the same trick). Eye under the surface, or a firefly somehow under it:
 * no reflection — the point is collapsed and pushed out of the clip volume.
 */
export const FIREFLY_MIRROR_VERT = /* glsl */`
attribute float aBright;
attribute float aSeed;
uniform float uPixelScale;
uniform float uSize;
uniform float uLevel;       // water level (world y)
uniform float uFogDensity;
uniform float uMaxPx;
uniform float uTime;
varying float vBright;
varying float vFlash;
varying float vSeed;
${GLSL_FOG}
${GLSL_FIREFLY_SIZE}
void main() {
  vec3 I = vec3(position.x, 2.0 * uLevel - position.y, position.z);
  vec3 cam = cameraPosition;
  float camH = cam.y - uLevel;   // eye height above the surface
  float imgH = I.y - uLevel;     // image depth below it (negative when the firefly is above the water)
  float denom = camH - imgH;     // eye→image vertical drop; the ray crosses the plane at f = camH / denom
  vSeed = aSeed;
  vFlash = aBright;
  if (camH < 0.02 || imgH > -0.005 || denom < 0.03) {
    vBright = 0.0;
    gl_PointSize = 1.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float f = camH / denom;                        // in (0, 1): the surface point on the eye→I ray
  vec3 P = cam + (I - cam) * (f * 0.98);         // 2% short of the surface: in front of the water's depth
  vec4 mvI = viewMatrix * vec4(I, 1.0);
  float depth = max(-mvI.z, 0.05);               // the image's depth sizes the sprite
  float px = uSize * (0.8 + 0.4 * aSeed) * uPixelScale / depth;
  // the surface breaks the glint up a little: a slow per-firefly shimmer, no stretching
  float shimmer = 0.8 + 0.2 * sin(uTime * 2.9 + aSeed * 41.0) * sin(uTime * 1.7 + aSeed * 17.0);
  vBright = aBright * fireflySize(px, length(mvI.xyz)) * shimmer;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}
`;

/**
 * Radial profile, r = 0 at the centre, 1 at the sprite edge:
 *   halo  (1-r)^2 / (1 + 5 r^2)   a Lorentzian glare tail (the way a point of light spreads in the
 *                                 eye), pulled to exactly zero at the edge so the quad never shows
 *   core  alpha^2 of the glow map  the lantern itself: ~a fifth of the sprite; the map's mips keep it
 *                                 soft instead of aliasing when the sprite is only a few pixels wide
 * Weighted half and half the centre sums to at most 1.0 × colour, and uGain (< 1) keeps the peak
 * channel under the tone mapper's compression knee, so even a landed firefly at full brightness stays
 * a saturated yellow-green at the core instead of clipping to white.
 * Colour: the base green-yellow (per-firefly ±8% hue drift). As the flash peaks both core and halo
 * warm toward amber (a Photinus flash is yellowest at its brightest); the halo stays a little greener
 * than the core.
 */
export const FIREFLY_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uDim;         // 1 for the main layer, ~0.3 for the reflection
uniform float uGain;
varying float vBright;
varying float vFlash;
varying float vSeed;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r = min(1.0, length(q) * 2.0);
  float e = 1.0 - r;
  float halo = e * e / (1.0 + 5.0 * r * r);
  float tex = texture2D(uMap, gl_PointCoord).a;
  float core = tex * tex;
  float warm = smoothstep(0.25, 1.0, vFlash);
  float h = (fract(vSeed * 7.31 + 0.17) - 0.5) * 0.16;   // ±8% hue drift: warmer (+) or greener (-)
  vec3 base = uColor * vec3(1.0 + h, 1.0 - abs(h) * 0.3, 1.0 - h * 1.6);
  vec3 cHalo = base * mix(vec3(0.9, 1.0, 0.95), vec3(1.06, 1.0, 0.72), warm);
  vec3 cCore = base * mix(vec3(1.0), vec3(1.16, 0.96, 0.5), warm);
  vec3 c = cHalo * (0.5 * halo) + cCore * (0.5 * core);
  gl_FragColor = vec4(c * (vBright * uDim * uGain), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
