// GLSL for the firefly point sprites: the main layer and the mirrored reflection share the fragment
// shader. Positions are world space (the Points objects sit at the origin). Perspective point size:
//   px = worldSize * uPixelScale / depth,  uPixelScale = 0.5 * viewportHeight * projection[1][1]
// (ctx.view.pixelScale, right for asymmetric XR frusta too). Fog is the scene's FogExp2 applied as a
// brightness attenuation (additive sprites over a dark fog colour: fading toward black is the same
// thing as mixing toward the fog colour).
import { GLSL_FOG } from './common.js';

export const FIREFLY_VERT = /* glsl */`
attribute float aBright;
attribute float aSeed;
uniform float uPixelScale;
uniform float uSize;        // sprite world size in metres (per-firefly ±20%)
uniform float uFogDensity;
uniform float uMaxPx;
varying float vBright;
varying float vSeed;
${GLSL_FOG}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
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
varying float vSeed;
${GLSL_FOG}
void main() {
  vec3 I = vec3(position.x, 2.0 * uLevel - position.y, position.z);
  vec3 cam = cameraPosition;
  float camH = cam.y - uLevel;   // eye height above the surface
  float imgH = I.y - uLevel;     // image depth below it (negative when the firefly is above the water)
  float denom = camH - imgH;     // eye→image vertical drop; the ray crosses the plane at f = camH / denom
  vSeed = aSeed;
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
  float minPx = 2.5;
  float fade = smoothstep(0.0, 1.0, px / minPx);
  gl_PointSize = clamp(px, minPx, uMaxPx);
  float fog = fogExp2(length(mvI.xyz), uFogDensity);
  // the surface breaks the glint up a little: a slow per-firefly shimmer, no stretching
  float shimmer = 0.8 + 0.2 * sin(uTime * 2.9 + aSeed * 41.0) * sin(uTime * 1.7 + aSeed * 17.0);
  vBright = aBright * fade * (1.0 - fog) * shimmer;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}
`;

export const FIREFLY_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uDim;         // 1 for the main layer, ~0.3 for the reflection
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
