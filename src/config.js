// Tunables for NOCTURNE. Everything is in metres, seconds, radians unless noted.

export const CONFIG = {
  water: {
    level: 0.95,          // world y of the surface. The player rig is offset so the head sits headAboveWater above it.
    tileSize: 16,         // wave simulation tile (world metres); uv = fract(xz / tileSize)
    simSize: 512,         // simulation texture resolution (per side)
    alpha: 0.88,
    deepColor: 0x04101a,
    planktonColor: 0x5cf0ff,
    planktonColor2: 0x9fffe0,
    swellAmplitude: 0.012, // analytic bob used by floating things (and matched in the water shader)
    extent: 900,          // size of the water plane
  },
  player: {
    // The rig is offset so the water sits inside the headset's hand-tracking cone:
    headAboveWaterStanding: 0.60,
    headAboveWaterSeated: 0.45,
    seatedEyeHeight: 1.35,   // measured eye height below this → seated
    wadeGain: 2.0,           // rig Δv per (m/s of hand stroke) per second
    wadeMinSpeed: 0.35,      // palm must move faster than this (horizontal) to start a stroke
    strokeExitSpeed: 0.2,
    strokeAlignOn: 0.5,      // dot(palm normal, motion) to start a stroke ("push the water")
    strokeAlignOff: 0.2,
    strokeMinPath: 0.15,     // metres of stroke before it moves you
    strokeMinTime: 0.2,
    strokeMinDepth: 0.03,
    wadeConeDeg: 80,         // hand must be within this half-angle in front of the head (horizontal)
    seatedYawRate: 0.52,     // rad/s (≈30°/s) from lateral strokes when seated
    drag: 2.0,               // per second
    maxSpeed: 0.8,
    radiusLimit: 48,         // keep the player inside this radius (shore starts ~60 m)
    desktopSpeed: 1.6,
    eyeHeightDesktop: 1.73,
  },
  hands: {
    pinchOn: 0.020,
    pinchOff: 0.035,
    grabRadius: 0.13,
    stillDisp: 0.03,      // max displacement of the filtered palm over 0.5 s to count as still
    stillTime: 1.0,       // seconds of stillness before fireflies commit to landing
    curlOpen: 0.35,       // every finger curl below this → open hand
    graspOn: 0.55,        // mean curl above this → whole-hand grasp (acts like a pinch)
    graspOff: 0.40,
    lostFade: 0.35,       // seconds to fade hands out after tracking loss
    graceGrab: 1.0,       // seconds a held object survives tracking loss before it is released into the water
  },
  sky: {
    radius: 900,
    latitudeDeg: -30,     // La Silla-ish; the panorama was shot from Chile
    lstHours: 13.4,       // local sidereal time at t=0 (puts the galactic centre ~35° up, rising)
    siderealSpeed: 15,    // × real time
    coreAzimuthDeg: -28,  // where the galactic centre appears at t=0, degrees left(-)/right(+) of -Z
    exposure: 1.15,
    starScale: 1.0,
    // waxing crescent low in the west (right of the core); at 15× sidereal it sets a few minutes in
    moon: { azimuthDeg: 78, altitudeDeg: 21, illuminated: 0.30, distance: 850, tint: 0xffe9c4 },
  },
  fog: { color: 0x060a12, density: 0.0115 },
  colors: {
    lantern: 0xffb257, lanternHot: 0xff7a1a,
    aurora: [0x42ff9c, 0x35d5c8, 0xc46bff],
    firefly: 0xd8ff7a,
    lotus: [0xff9ad5, 0xffc0a0, 0xb8a4ff, 0x9fffe0, 0xffe27a, 0xa0d8ff],
    hand: 0xdff4ff,
  },
  energy: { decay: 0.02, lantern: 0.5, lotus: 0.15, firefly: 0.05 },
  music: { rootMidi: 62 /* D */, mode: 'dorian' },
};

// Quality tier from the user agent. Quest 2 (XR2 Gen 1) is the floor.
export function detectQuality() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const isQuest = /OculusBrowser|Quest/i.test(ua);
  let tier = 'desktop';
  if (isQuest) tier = /Quest 3|Quest Pro/i.test(ua) ? 'quest3' : 'quest2';
  const q = {
    tier, isQuest,
    panorama: tier === 'quest2' ? '2k' : '4k',
    simSize: tier === 'quest2' ? 384 : 512,
    particleScale: tier === 'quest2' ? 0.7 : 1.0,
    anisotropy: tier === 'desktop' ? 8 : 4,
  };
  return q;
}
