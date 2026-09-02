// GLSL for the lotus module (src/world/lotus.js). GLSL ES 3.00 (three prefixes #version 300 es and
// rewrites attribute/varying/texture2D). Fog is applied manually (exp2, same as the water).
import { GLSL_FOG } from './common.js';

/**
 * Flower vertex shader. One InstancedMesh; the geometry holds 14 petals (6 inner + 8 outer) plus a bud
 * and a floating base, all in a flower-local frame. Petal vertices are stored in a *petal* frame:
 *   position.x = offset across the petal (metres), position.y = t along the petal (0 base .. 1 tip),
 *   uv = (x normalised -1..1, t),  aPetal = (azimuth of the petal, part, petal length)
 *   part: 0 inner ring, 1 outer ring, 2 bud, 3 base (bud/base keep their real position + normal)
 * The petal is lofted along a circular-arc spine whose base tilt and curvature are driven by aBloom:
 * closed = nearly vertical, curling inward over the bud; open = outer ring ~75° from vertical with
 * drooping tips, inner ring ~45°. Edges are cupped toward the axis (strongly when closed, so the
 * petals wrap the bud). A slow breathing motion rides on the base tilt.
 */
export const LOTUS_FLOWER_VERT = /* glsl */`
attribute vec3 aPetal;
attribute float aBloom;
attribute vec3 aColor;
attribute float aPhase;
uniform float uTime;
varying vec3 vColor; varying vec3 vNormalW; varying vec3 vWorldPos; varying vec2 vUv; varying float vBloom; varying float vPart;
void main() {
  float phi = aPetal.x, part = aPetal.y, L = aPetal.z;
  float b = aBloom;
  vec3 local, nLocal;
  if (part > 1.5) {
    local = position;
    nLocal = normal;
  } else {
    float outer = part;
    float t = position.y;
    float x = position.x;
    float breathe = sin(uTime * 0.8 + aPhase) * 0.03 * (0.25 + 0.75 * b)
                  + sin(uTime * 1.9 + aPhase * 1.7 + phi) * 0.008 * b;
    // base tilt from vertical and the extra bend accumulated from base to tip (radians)
    float theta0 = mix(mix(0.12, 0.16, outer), mix(0.80, 1.31, outer), b) + breathe;
    float kappa = mix(-0.35, mix(0.50, 0.45, outer), b);
    kappa = (kappa >= 0.0) ? max(kappa, 0.02) : min(kappa, -0.02);
    float th = theta0 + kappa * t;
    float invK = L / kappa;
    float rad = invK * (cos(theta0) - cos(th));
    float up  = invK * (sin(th) - sin(theta0));
    vec3 radialDir = vec3(cos(phi), 0.0, sin(phi));
    vec3 tangDir = vec3(-sin(phi), 0.0, cos(phi));
    vec3 inward = vec3(-radialDir.x * cos(th), sin(th), -radialDir.z * cos(th));
    float baseR = mix(0.013, 0.019, outer);
    float baseY = mix(0.016, 0.007, outer);
    float rCur = max(baseR + rad, 0.006);
    // cup the edges toward the axis: a wrap when closed, a shallow dish when open
    float cupK = 0.8 * mix(1.0, 0.35, b) / (2.0 * rCur);
    float cup = cupK * x * x;
    local = radialDir * (baseR + rad) + vec3(0.0, baseY + up, 0.0) + tangDir * x + inward * cup;
    nLocal = normalize(inward - tangDir * (2.0 * cupK * x));
  }
  vec4 wp = instanceMatrix * vec4(local, 1.0);
  vec3 nW = mat3(instanceMatrix) * nLocal;
  wp = modelMatrix * wp;
  vWorldPos = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * nW);
  vColor = aColor;
  vUv = uv;
  vBloom = b;
  vPart = part;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/**
 * Flower fragment shader: base colour darkened toward the petal base, a self-glow that grows with
 * bloom (strongest at the petal centre), half-lambert from the moon so closed buds read at night,
 * a little rim/back-light for the translucent look, exp2 fog. Opaque, double sided.
 */
export const LOTUS_FLOWER_FRAG = /* glsl */`
precision highp float;
uniform vec3 uMoonDir; uniform vec3 uMoonColor; uniform vec3 uFogColor;
uniform float uFogDensity; uniform float uSurge;
varying vec3 vColor; varying vec3 vNormalW; varying vec3 vWorldPos; varying vec2 vUv; varying float vBloom; varying float vPart;
${GLSL_FOG}
void main() {
  vec3 N = normalize(vNormalW);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float b = vBloom;
  float hl = dot(N, uMoonDir) * 0.5 + 0.5; hl *= hl;
  float hemi = N.y * 0.5 + 0.5;
  vec3 col;
  if (vPart > 2.5) {
    // floating base: dark green like the pads, faintly lit by the open flower above it
    col = vec3(0.025, 0.07, 0.045) * (0.25 + 0.75 * hl) + vColor * 0.03 * b;
  } else if (vPart > 1.5) {
    // bud / seed pod: warm centre, lights up as the flower opens
    vec3 pod = mix(vColor, vec3(1.0, 0.86, 0.45), 0.6);
    col = pod * (0.05 + 0.30 * hl) + pod * (0.06 + 0.75 * b) * (1.0 + 1.2 * uSurge);
  } else {
    float t = vUv.y, xn = vUv.x;
    vec3 base = vColor * mix(0.18, 0.75, t);
    vec3 lit = base * (0.10 + 0.06 * hemi) + base * hl * uMoonColor * 1.4;
    float centre = (1.0 - xn * xn) * (1.0 - clamp(abs(t - 0.5) * 1.6, 0.0, 1.0));
    vec3 glow = vColor * (0.15 + 1.1 * b) * (0.25 + 0.75 * centre);
    float ndv = abs(dot(N, V));
    float rim = pow(1.0 - ndv, 3.0);
    float back = max(dot(-N, uMoonDir), 0.0);
    vec3 trans = vColor * (0.12 * rim + 0.10 * back) * (0.4 + 0.6 * b);
    col = lit + glow * 0.6 * (1.0 + 1.2 * uSurge) + trans;
  }
  float fog = fogExp2(length(cameraPosition - vWorldPos), uFogDensity);
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Glow halos: instanced billboard quads (6 instances) offset in VIEW space so they face each eye — not point
 * sprites, which GLES drops whole when their centre leaves one eye's frustum. aCenter is the bud position.
 * With uMirror = 1 the quad shows the virtual image below the water plane, slid along the view ray to just
 * in front of where that ray meets the surface, so drawn after the water (depth-tested) it reads as a
 * reflection on the surface instead of being swallowed by the water's alpha. Size is in metres, clamped to
 * 0.35 x distance so a bud at the face does not flood the view.
 */
export const LOTUS_GLOW_VERT = /* glsl */`
attribute vec3 aCenter; attribute vec3 aColor; attribute float aSize; attribute float aGain;
uniform float uMirror; uniform float uLevel; uniform float uGainMul;
varying vec3 vColor; varying float vGain; varying vec2 vUv;
void main() {
  vec3 p = aCenter;
  p.y = mix(p.y, 2.0 * uLevel - p.y, uMirror);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float d = max(-mv.z, 0.05);
  float ws = min(aSize, 0.35 * d);
  float k;
  if (uMirror > 0.5) {
    float camH = cameraPosition.y - uLevel;
    float imgH = p.y - uLevel;
    float f = clamp(camH / max(camH - imgH, 1e-3), 0.0, 1.0);
    k = max(f * d - ws * 0.6, 0.12) / d;
  } else {
    k = max(d - 0.03, 0.05) / d; // a touch toward the eye so the petals do not clip the halo
  }
  mv.xyz *= k;
  mv.xy += position.xy * ws * k;
  gl_Position = projectionMatrix * mv;
  vColor = aColor;
  vGain = aGain * uGainMul;
  vUv = uv;
}`;

export const LOTUS_GLOW_FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec3 vColor; varying float vGain; varying vec2 vUv;
void main() {
  float a = texture2D(uMap, vUv).a;
  gl_FragColor = vec4(vColor * a * vGain, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
