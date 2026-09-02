// GLSL for the drip sprites: droplets of plankton-lit water falling from a hand that has just come up
// out of the lake. Positions are world space (the Points object sits at the origin). Perspective point
// size as everywhere else: px = worldSize * uPixelScale / depth, uPixelScale = ctx.view.pixelScale.
// A dead pool slot carries aBright = 0 and is collapsed out of the clip volume, so the pool can be
// drawn as one range without touching the index buffer.
import { GLSL_FOG } from './common.js';

export const DRIPS_VERT = /* glsl */`
attribute float aBright;
attribute float aSeed;
uniform float uPixelScale;
uniform float uSize;        // sprite world diameter (metres); the bright core is ~a third of it
uniform float uFogDensity;
uniform float uMaxPx;
varying float vBright;
varying float vSeed;
${GLSL_FOG}
void main() {
  vSeed = aSeed;
  if (aBright <= 0.0) {
    vBright = 0.0;
    gl_PointSize = 1.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 0.05);
  float px = uSize * (0.85 + 0.3 * aSeed) * uPixelScale / depth;
  // held at a 2 px minimum instead of shrinking into sub-pixel shimmer; below that it fades out.
  // A sprite a few pixels wide loses most of its profile to averaging, so its brightness is held up.
  float minPx = 2.0;
  float fade = smoothstep(0.0, 1.0, px / minPx);
  float tiny = 1.0 - smoothstep(3.0, 12.0, px);
  gl_PointSize = clamp(px, minPx, uMaxPx);
  float fog = fogExp2(length(mv.xyz), uFogDensity);
  vBright = aBright * fade * (1.0 + 1.2 * tiny) * (1.0 - 0.7 * fog);
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Radial profile: a soft glare halo (Lorentzian tail, zero at the sprite edge) around a small bright
 * core (alpha^2 of the glow map). The halo keeps the plankton colour; the core is pulled a little
 * toward white so a droplet reads as a bead of water with light inside it, not a firefly.
 */
export const DRIPS_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uC0, uC1;
uniform float uGain;
varying float vBright;
varying float vSeed;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r = min(1.0, length(q) * 2.0);
  float e = 1.0 - r;
  float halo = e * e / (1.0 + 6.0 * r * r);
  float tex = texture2D(uMap, gl_PointCoord).a;
  float core = tex * tex;
  vec3 c = mix(uC0, uC1, vSeed);
  vec3 col = c * (0.45 * halo) + mix(c, vec3(1.0), 0.35) * (0.7 * core);
  gl_FragColor = vec4(col * (vBright * uGain), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
