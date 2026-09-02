// Shared GLSL snippets (GLSL ES 3.00 — three.js always compiles with #version 300 es on WebGL2).

// Direction (unit, in the sky group's local "galactic" frame) -> equirect uv of the ESO panorama.
// Frame: +X = galactic centre (l=0,b=0), +Y = north galactic pole, -Z = l=90°.
// The panorama has longitude increasing to the LEFT as seen from inside (u = 0.5 - l/360) and
// v = 0 at the top row of the image (three flips images on upload, so texture v=1 is the top).
export const GLSL_GAL_UV = /* glsl */`
vec2 galUV(vec3 d) {
  float l = atan(-d.z, d.x);
  float b = asin(clamp(d.y, -1.0, 1.0));
  return vec2(fract(0.5 - l * 0.15915494309), 0.5 + b * 0.31830988618);
}
// equirect sample with the seam fixed (derivative discontinuity at u wrap would pick the smallest mip)
vec3 sampleSky(sampler2D tex, vec2 uv, float bias) {
  float w = fwidth(uv.x);
  if (w > 0.5) return textureLod(tex, uv, bias).rgb;
  return texture2D(tex, uv, bias).rgb;
}
`;

export const GLSL_HASH = /* glsl */`
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
`;

// Add after colorspace conversion to kill banding in dark gradients.
export const GLSL_DITHER = /* glsl */`
vec3 dither8(vec3 c, vec2 fragCoord) { float n = hash12(fragCoord) - 0.5; return c + n * (1.0 / 255.0); }
`;

export const GLSL_FOG = /* glsl */`
float fogExp2(float dist, float density) { float f = dist * density; return 1.0 - exp(-f * f); }
`;

// 2D value noise + fbm used by the aurora, mist and lantern flicker.
export const GLSL_NOISE = /* glsl */`
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
  return v;
}
`;

// Analytic swell matching ctx.water.swell() in main.js
export const GLSL_SWELL = /* glsl */`
float swell(vec2 p, float t, float A) {
  return A * (sin(p.x * 0.9 + t * 0.7) + 0.7 * sin(p.y * 1.3 - t * 0.55 + p.x * 0.4) + 0.5 * sin((p.x + p.y) * 2.1 + t * 1.1));
}
`;
