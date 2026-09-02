import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { GLSL_GAL_UV, GLSL_HASH, GLSL_DITHER } from '../shaders/common.js';

/**
 * The real night sky.
 *  - ESO/S. Brunier Milky Way panorama on an inside-out sphere, sampled by direction (galactic frame),
 *    with the measured ~3.8° rotation of the mosaic corrected so the catalog lines up with the photo
 *  - every naked-eye star from the Yale Bright Star Catalog as a point sprite at its J2000 position,
 *    coloured by B-V, sized by magnitude, twinkling
 *  - a crescent moon (real lunar texture) with phase shading and a halo; a dim directional light from it.
 *    It sets a few minutes in — the lake goes darker and the plankton read brighter.
 *  - the whole celestial sphere turns with the sidereal rate × CONFIG.sky.siderealSpeed for a
 *    southern-hemisphere observer (the photo was taken from Chile)
 *  - "lantern stars": stars the player adds to the sky by releasing lanterns; they persist across visits
 *  - the occasional meteor
 */

// J2000 equatorial -> galactic rotation (rows), from the IAU 1958 definition.
const M_EG = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [ 0.4941094279, -0.4448296300,  0.7469822445],
  [-0.8676661490, -0.1980763734,  0.4559837762],
];
const SIDEREAL_DAY = 86164.0905;
const MAX_LANTERN_STARS = 64;
const MAX_METEORS = 6;

function bvToRGB(bv) {
  // Ballesteros' formula for temperature, then a blackbody -> sRGB approximation.
  bv = THREE.MathUtils.clamp(bv, -0.4, 2.0);
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const t = T / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); b = 255; }
  const c = new THREE.Color(THREE.MathUtils.clamp(r, 0, 255) / 255, THREE.MathUtils.clamp(g, 0, 255) / 255, THREE.MathUtils.clamp(b, 0, 255) / 255);
  // desaturate a little: real stars are subtle
  const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  c.r = THREE.MathUtils.lerp(l, c.r, 0.75); c.g = THREE.MathUtils.lerp(l, c.g, 0.75); c.b = THREE.MathUtils.lerp(l, c.b, 0.75);
  return c;
}

// RA/Dec (radians) -> unit vector in the sky group's local frame (galactic: +X centre, +Y NGP, -Z l=90°)
function radecToLocal(ra, dec, out) {
  const ex = Math.cos(dec) * Math.cos(ra), ey = Math.cos(dec) * Math.sin(ra), ez = Math.sin(dec);
  const gx = M_EG[0][0] * ex + M_EG[0][1] * ey + M_EG[0][2] * ez;
  const gy = M_EG[1][0] * ex + M_EG[1][1] * ey + M_EG[1][2] * ez;
  const gz = M_EG[2][0] * ex + M_EG[2][1] * ey + M_EG[2][2] * ez;
  return out.set(gx, gz, -gy);
}

function loadStars() { try { return JSON.parse(localStorage.getItem('nocturne.stars') || '[]'); } catch { return []; } }
function saveStars(list) { try { localStorage.setItem('nocturne.stars', JSON.stringify(list.map((e) => [+e.local.x.toFixed(2), +e.local.y.toFixed(2), +e.local.z.toFixed(2)]))); } catch { /* */ } }

export const sky = {
  name: 'sky',
  init(ctx) {
    const S = CONFIG.sky;
    const tex = ctx.assets.tex;
    const group = new THREE.Group();
    group.name = 'sky';
    ctx.scene.add(group);

    // The ESO mosaic is rotated ~3.8° relative to true J2000 galactic coordinates (measured by the asset
    // pipeline on 92 bright stars). photoDir = M · galacticDir in the standard frame (x,y,z) = (cos b cos l,
    // cos b sin l, sin b); our local frame is (x, z, -y) of that, so the correction becomes P·M·P⁻¹.
    const photoCorrection = new THREE.Matrix3();
    {
      const M = ctx.assets.sky?.photoFrameCorrection?.matrix;
      const Pm = new THREE.Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0); // local = P · g
      if (M) {
        const Mm = new THREE.Matrix3().set(M[0][0], M[0][1], M[0][2], M[1][0], M[1][1], M[1][2], M[2][0], M[2][1], M[2][2]);
        photoCorrection.copy(Pm).multiply(Mm).multiply(Pm.clone().invert());
      }
    }

    // ---- panorama dome
    const domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex.panorama }, uExposure: { value: S.exposure },
        uFogColor: { value: new THREE.Color(CONFIG.fog.color) }, uHorizon: { value: new THREE.Color(0x0c1a26) },
        uAurora: { value: new THREE.Color(0x000000) }, uPhoto: { value: photoCorrection },
      },
      vertexShader: /* glsl */`
        varying vec3 vLocal; varying vec3 vWorld;
        void main() { vLocal = position; vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uMap; uniform float uExposure; uniform vec3 uFogColor, uHorizon, uAurora; uniform mat3 uPhoto;
        varying vec3 vLocal; varying vec3 vWorld;
        ${GLSL_GAL_UV}
        ${GLSL_HASH}
        ${GLSL_DITHER}
        void main() {
          vec3 d = normalize(uPhoto * normalize(vLocal));
          vec3 w = normalize(vWorld - cameraPosition);
          vec3 c = sampleSky(uMap, galUV(d), 0.0);
          c = max(c - 0.006, 0.0); // the JPEG's lifted black level
          c = pow(c, vec3(1.06)) * uExposure;
          // atmospheric extinction + airglow near the horizon, fog colour below it
          float h = w.y;
          float ext = mix(0.25, 1.0, smoothstep(-0.02, 0.28, h));
          c *= ext;
          c += uHorizon * exp(-max(h, 0.0) * 9.0) * 0.55 * smoothstep(-0.08, 0.02, h);
          c = mix(uFogColor, c, smoothstep(-0.06, 0.03, h));
          c += uAurora * 0.025 * smoothstep(0.0, 0.5, h);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragColor.rgb = dither8(gl_FragColor.rgb, gl_FragCoord.xy);
        }`,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(S.radius, 48, 32), domeMat);
    dome.renderOrder = -20; dome.frustumCulled = false; dome.name = 'skyDome';
    group.add(dome);

    // ---- catalog stars
    const stars = ctx.assets.stars;
    const N = stars.meta.count || stars.data.length / 4;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), mag = new Float32Array(N), seed = new Float32Array(N);
    const v = new THREE.Vector3();
    const R = S.radius * 0.985;
    for (let i = 0; i < N; i++) {
      const ra = stars.data[i * 4], dec = stars.data[i * 4 + 1], m = stars.data[i * 4 + 2], bv = stars.data[i * 4 + 3];
      radecToLocal(ra, dec, v).multiplyScalar(R);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      const c = bvToRGB(bv);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      mag[i] = m; seed[i] = (i * 0.618033) % 1;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    starGeo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    starGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const starMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex.glowFirefly }, uTime: { value: 0 }, uPixelScale: { value: 1 }, uStarScale: { value: S.starScale }, uFogColor: { value: new THREE.Color(CONFIG.fog.color) } },
      vertexShader: /* glsl */`
        attribute float aMag; attribute float aSeed; attribute vec3 color;
        uniform float uTime, uPixelScale, uStarScale;
        varying vec3 vColor; varying float vBright; varying float vHorizon;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec3 w = normalize(wp.xyz - cameraPosition);
          vHorizon = smoothstep(-0.03, 0.2, w.y);
          float m = aMag;
          float bright = clamp(pow(10.0, -0.4 * (m - 1.2)), 0.05, 1.0);
          bright = pow(bright, 0.65);
          float tw = 1.0 + (0.18 + 0.25 * smoothstep(1.5, 5.5, m)) * sin(uTime * (2.5 + aSeed * 5.0) + aSeed * 40.0) * sin(uTime * 1.7 + aSeed * 13.0);
          vBright = bright * tw;
          vColor = color;
          float size = clamp(7.2 - m * 1.15, 1.4, 8.0) * uPixelScale * uStarScale;
          gl_PointSize = size;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; varying vec3 vColor; varying float vBright; varying float vHorizon;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a;
          vec3 c = vColor * a * vBright * vHorizon * 1.35;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const starPoints = new THREE.Points(starGeo, starMat);
    starPoints.renderOrder = -19; starPoints.frustumCulled = false; starPoints.name = 'stars';
    group.add(starPoints);

    // ---- lantern stars (added by the player; persisted so returning visitors find their own)
    const lpos = new Float32Array(MAX_LANTERN_STARS * 3), lcol = new Float32Array(MAX_LANTERN_STARS * 3), lmag = new Float32Array(MAX_LANTERN_STARS).fill(20), lseed = new Float32Array(MAX_LANTERN_STARS);
    const lGeo = new THREE.BufferGeometry();
    lGeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3).setUsage(THREE.DynamicDrawUsage));
    lGeo.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
    lGeo.setAttribute('aMag', new THREE.BufferAttribute(lmag, 1).setUsage(THREE.DynamicDrawUsage));
    lGeo.setAttribute('aSeed', new THREE.BufferAttribute(lseed, 1));
    for (let i = 0; i < MAX_LANTERN_STARS; i++) { lcol[i * 3] = 1.0; lcol[i * 3 + 1] = 0.85; lcol[i * 3 + 2] = 0.6; lseed[i] = (i * 0.37) % 1; }
    const lanternStars = new THREE.Points(lGeo, starMat);
    lanternStars.renderOrder = -18; lanternStars.frustumCulled = false; lanternStars.name = 'lanternStars';
    group.add(lanternStars);
    const lanternList = [];
    if (!ctx.harness) {
      for (const e of loadStars().slice(-MAX_LANTERN_STARS)) {
        if (Array.isArray(e) && e.length === 3) lanternList.push({ local: new THREE.Vector3(e[0], e[1], e[2]).normalize().multiplyScalar(R), born: -100 });
      }
    }

    // ---- meteors: a small pool of additive line segments on the sphere
    const mPos = new Float32Array(MAX_METEORS * 2 * 3), mCol = new Float32Array(MAX_METEORS * 2 * 3);
    const mGeo = new THREE.BufferGeometry();
    mGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3).setUsage(THREE.DynamicDrawUsage));
    mGeo.setAttribute('color', new THREE.BufferAttribute(mCol, 3).setUsage(THREE.DynamicDrawUsage));
    const meteors = new THREE.LineSegments(mGeo, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, fog: false }));
    meteors.renderOrder = -17; meteors.frustumCulled = false; meteors.name = 'meteors';
    group.add(meteors);
    const meteorPool = Array.from({ length: MAX_METEORS }, () => ({ active: false, t0: 0, dur: 0.7, a: new THREE.Vector3(), b: new THREE.Vector3(), bright: 1 }));
    let nextMeteor = 90;
    let mseed = 4242;
    const mrnd = () => { mseed = (mseed * 1664525 + 1013904223) >>> 0; return mseed / 4294967296; };

    // ---- moon
    const M = S.moon;
    const moonR = M.distance * Math.tan(THREE.MathUtils.degToRad(0.26)) * 1.25; // a touch larger than life
    const moonMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex.moon }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uTint: { value: new THREE.Color(M.tint) }, uLow: { value: 0 } },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying vec3 vN;
        void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform vec3 uSun; uniform vec3 uTint; uniform float uLow; varying vec2 vUv; varying vec3 vN;
        void main(){
          vec3 tex = texture2D(uMap, vUv).rgb;
          float lit = smoothstep(-0.02, 0.08, dot(normalize(vN), uSun));
          float earthshine = 0.035;
          vec3 tint = mix(uTint, vec3(1.0, 0.69, 0.42), uLow); // reddens near the horizon
          vec3 c = tex * tint * (lit * 2.4 + earthshine);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      fog: false, depthWrite: false, depthTest: false,
    });
    const moon = new THREE.Mesh(new THREE.SphereGeometry(moonR, 32, 24), moonMat);
    moon.renderOrder = -17; moon.frustumCulled = false; moon.name = 'moon';
    group.add(moon);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.glowSoft, color: new THREE.Color(M.tint).multiplyScalar(0.55), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false, transparent: true }));
    halo.scale.setScalar(moonR * 9); halo.renderOrder = -16;
    group.add(halo);
    const halo2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.glowSoft, color: new THREE.Color(M.tint).multiplyScalar(0.10), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false, transparent: true }));
    halo2.scale.setScalar(moonR * 40); halo2.renderOrder = -16;
    group.add(halo2);

    // moonlight + a little sky light for the few lit things (reeds, hills, lotus pads)
    const moonLight = new THREE.DirectionalLight(0xbfd0ff, 0.55);
    moonLight.name = 'moonLight';
    ctx.scene.add(moonLight); ctx.scene.add(moonLight.target);
    const hemi = new THREE.HemisphereLight(0x1a2740, 0x020306, 0.55);
    ctx.scene.add(hemi);

    // ---- orientation math
    const lat = THREE.MathUtils.degToRad(S.latitudeDeg);
    const theta0 = S.lstHours / 24 * Math.PI * 2;
    const P = new THREE.Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0); // local = P·g, rows: (1,0,0), (0,0,1), (0,-1,0)
    const Pinv = P.clone().invert();
    const Meg = new THREE.Matrix3().set(M_EG[0][0], M_EG[0][1], M_EG[0][2], M_EG[1][0], M_EG[1][1], M_EG[1][2], M_EG[2][0], M_EG[2][1], M_EG[2][2]);
    const MegT = Meg.clone().transpose();
    const Mwe = new THREE.Matrix3();
    const Rfull = new THREE.Matrix3();
    const Rmat4 = new THREE.Matrix4();
    const yawOffset = { value: 0 };

    function worldFromEquatorial(theta, out) {
      // zenith, north point and east in the equatorial frame for latitude lat, sidereal time theta
      const zx = Math.cos(lat) * Math.cos(theta), zy = Math.cos(lat) * Math.sin(theta), zz = Math.sin(lat);
      // north = normalize(ncp - (ncp·zenith) zenith), ncp = (0,0,1)
      let nx = -zz * zx, ny = -zz * zy, nz = 1 - zz * zz;
      const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
      // east = north × up
      const ex = ny * zz - nz * zy, ey = nz * zx - nx * zz, ez = nx * zy - ny * zx;
      // rows: world.x = east·e, world.y = zenith·e, world.z = -north·e
      out.set(ex, ey, ez, zx, zy, zz, -nx, -ny, -nz);
      return out;
    }
    function computeRotation(t) {
      const theta = theta0 + (S.siderealSpeed * t / SIDEREAL_DAY) * Math.PI * 2;
      worldFromEquatorial(theta, Mwe);
      Rfull.copy(Mwe).multiply(MegT).multiply(Pinv); // R = Mwe · Meg^T · P^-1
      return Rfull;
    }
    // yaw offset so the galactic centre appears at coreAzimuth at t=0
    {
      const R0 = computeRotation(0);
      const core = new THREE.Vector3(1, 0, 0).applyMatrix3(R0);
      const az = Math.atan2(core.x, -core.z); // 0 = -Z (ahead), + = right
      yawOffset.value = THREE.MathUtils.degToRad(S.coreAzimuthDeg) - az;
    }
    const yawQ = new THREE.Quaternion();
    const rotQ = new THREE.Quaternion();
    const upAxis = new THREE.Vector3(0, 1, 0);
    function applyRotation(t) {
      const Rm = computeRotation(t);
      Rmat4.setFromMatrix3(Rm);
      rotQ.setFromRotationMatrix(Rmat4);
      yawQ.setFromAxisAngle(upAxis, yawOffset.value);
      group.quaternion.copy(yawQ).multiply(rotQ);
      group.updateMatrixWorld(true);
    }
    applyRotation(0);

    // place the moon: desired world direction at t=0 -> sky-local
    const moonDirWorld0 = new THREE.Vector3();
    let sunLocal;
    {
      const az = THREE.MathUtils.degToRad(M.azimuthDeg), alt = THREE.MathUtils.degToRad(M.altitudeDeg);
      moonDirWorld0.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
      const inv = group.quaternion.clone().invert();
      const local = moonDirWorld0.clone().applyQuaternion(inv);
      moon.position.copy(local).multiplyScalar(M.distance);
      halo.position.copy(moon.position); halo2.position.copy(moon.position);
      // sun direction for the phase: rotate the moon direction about the vertical by the phase angle so the
      // lit limb faces away from the core (a waxing crescent after dusk). illuminated fraction f = (1 + cos psi)/2
      const psi = Math.acos(2 * M.illuminated - 1);
      const sunWorld = moonDirWorld0.clone().applyAxisAngle(upAxis, psi).setY(-0.15).normalize();
      sunLocal = sunWorld.clone().applyQuaternion(inv);
    }

    const worldToSky = new THREE.Matrix3();
    const worldToPhoto = new THREE.Matrix3();
    const moonDirWorld = new THREE.Vector3();
    ctx.sky = { group, worldToSky, worldToPhoto, moonDirWorld, moonAbove: 1, moonAltitudeDeg: M.altitudeDeg, auroraTint: new THREE.Color(0, 0, 0), addLanternStar: null, moon, dome, starPoints, photoCorrection, meteorShower: 0 };

    const rebuildLanternStars = () => {
      for (let i = 0; i < MAX_LANTERN_STARS; i++) {
        const e = lanternList[i];
        if (e) { lpos[i * 3] = e.local.x; lpos[i * 3 + 1] = e.local.y; lpos[i * 3 + 2] = e.local.z; }
        else { lpos[i * 3] = 0; lpos[i * 3 + 1] = -R; lpos[i * 3 + 2] = 0; lmag[i] = 20; }
      }
      lGeo.attributes.position.needsUpdate = true;
      lGeo.setDrawRange(0, Math.max(1, lanternList.length));
    };
    ctx.sky.addLanternStar = (dirWorld) => {
      if (lanternList.length >= MAX_LANTERN_STARS) lanternList.shift();
      const inv = group.quaternion.clone().invert();
      const local = dirWorld.clone().normalize().applyQuaternion(inv).multiplyScalar(R);
      lanternList.push({ local, born: ctx.time.t });
      rebuildLanternStars();
      if (!ctx.harness) saveStars(lanternList);
      ctx.events.emit('starborn', { dir: dirWorld.clone().normalize(), count: lanternList.length });
    };
    rebuildLanternStars();
    ctx.events.on('lanternstar', (e) => { if (e?.dir) ctx.sky.addLanternStar(e.dir); });
    ctx.sky.lanternStarCount = () => lanternList.length;
    // after moonset the sky goes darker and, for a minute and a half, meteors come more often
    ctx.events.on('moonset', () => { this._.showerUntil = ctx.time.t + 90; });

    let moonWasUp = true;
    this._ = {
      group, domeMat, starMat, starPoints, moon, moonMat, halo, halo2, moonLight, hemi, applyRotation, lanternList, lmag, lGeo,
      worldToSky, worldToPhoto, photoCorrection, moonDirWorld, R, sunLocal, meteorPool, mPos, mCol, mGeo, mrnd,
      get nextMeteor() { return nextMeteor; }, set nextMeteor(v) { nextMeteor = v; }, get moonWasUp() { return moonWasUp; }, set moonWasUp(v) { moonWasUp = v; },
      tmp: new THREE.Vector3(), tmp2: new THREE.Vector3(), tmp3: new THREE.Vector3(),
    };
  },

  spawnMeteor(ctx) {
    const s = this._;
    const m = s.meteorPool.find((e) => !e.active);
    if (!m) return;
    // random start high in the sky (local frame — the group rotates, fine for a 0.7 s streak)
    const inv = s.group.quaternion.clone().invert();
    const alt = THREE.MathUtils.degToRad(25 + s.mrnd() * 55), az = s.mrnd() * Math.PI * 2;
    const a = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    const tangent = new THREE.Vector3(s.mrnd() - 0.5, -0.4 - s.mrnd() * 0.6, s.mrnd() - 0.5).normalize();
    tangent.sub(a.clone().multiplyScalar(tangent.dot(a))).normalize();
    const len = THREE.MathUtils.degToRad(18 + s.mrnd() * 22);
    const b = a.clone().multiplyScalar(Math.cos(len)).addScaledVector(tangent, Math.sin(len)).normalize();
    m.a.copy(a.applyQuaternion(inv)).multiplyScalar(s.R * 0.995);
    m.b.copy(b.applyQuaternion(inv)).multiplyScalar(s.R * 0.995);
    m.t0 = ctx.time.t; m.dur = 0.5 + s.mrnd() * 0.5; m.bright = 0.6 + s.mrnd() * 0.8; m.active = true;
    ctx.events.emit('meteor', { dir: a });
  },

  update(ctx, dt) {
    const s = this._;
    const t = ctx.time.t;
    s.applyRotation(t);
    s.domeMat.uniforms.uAurora.value.copy(ctx.sky.auroraTint);
    s.starMat.uniforms.uTime.value = t;
    const h = ctx.renderer.xr.isPresenting ? 1700 : ctx.renderer.domElement.height;
    s.starMat.uniforms.uPixelScale.value = Math.max(0.6, h / 1000);
    // sky-space matrices for the water
    s.worldToSky.setFromMatrix4(s.group.matrixWorld).invert();
    s.worldToPhoto.copy(s.photoCorrection).multiply(s.worldToSky);
    // moon
    s.moon.getWorldPosition(s.moonDirWorld).sub(s.group.position).normalize();
    const alt = Math.asin(THREE.MathUtils.clamp(s.moonDirWorld.y, -1, 1));
    ctx.sky.moonAltitudeDeg = THREE.MathUtils.radToDeg(alt);
    ctx.sky.moonAbove = THREE.MathUtils.smoothstep(s.moonDirWorld.y, -0.01, 0.05);
    const low = 1 - THREE.MathUtils.smoothstep(ctx.sky.moonAltitudeDeg, 0, 9);
    s.moonMat.uniforms.uLow.value = low;
    s.moonMat.uniforms.uSun.value.copy(s.sunLocal).applyQuaternion(s.group.quaternion);
    s.halo.material.opacity = ctx.sky.moonAbove; s.halo2.material.opacity = ctx.sky.moonAbove;
    s.moonLight.position.copy(s.moonDirWorld).multiplyScalar(100);
    s.moonLight.intensity = 0.55 * ctx.sky.moonAbove;
    if (s.moonWasUp && ctx.sky.moonAbove < 0.02) { s.moonWasUp = false; ctx.events.emit('moonset', {}); }
    // lantern stars brighten over a few seconds after they are born
    let dirty = false;
    for (let i = 0; i < s.lanternList.length; i++) {
      const age = t - s.lanternList[i].born;
      const m = THREE.MathUtils.lerp(6.5, 1.6, THREE.MathUtils.smoothstep(age, 0, 6)) - (age > 0 && age < 1.2 ? 2.5 * Math.sin(age / 1.2 * Math.PI) : 0);
      if (s.lmag[i] !== m) { s.lmag[i] = m; dirty = true; }
    }
    if (dirty) s.lGeo.attributes.aMag.needsUpdate = true;
    // meteors: one every ~2–3 minutes at rest, more when the sky is active, a shower after moonset
    ctx.sky.meteorShower = s.showerUntil ? THREE.MathUtils.clamp((s.showerUntil - t) / 30, 0, 1) : 0;
    s.nextMeteor -= dt * (1 + ctx.energy * 3 + ctx.sky.meteorShower * 10);
    if (s.nextMeteor <= 0) { this.spawnMeteor(ctx); s.nextMeteor = 90 + s.mrnd() * 90; }
    for (let i = 0; i < s.meteorPool.length; i++) {
      const m = s.meteorPool[i];
      const o = i * 6;
      if (m.active) {
        const u = (t - m.t0) / m.dur;
        if (u >= 1) m.active = false;
        else {
          const head = Math.min(1, u * 1.15), tail = Math.max(0, u * 1.15 - 0.35);
          s.tmp.lerpVectors(m.a, m.b, tail); s.tmp2.lerpVectors(m.a, m.b, head);
          s.mPos[o] = s.tmp.x; s.mPos[o + 1] = s.tmp.y; s.mPos[o + 2] = s.tmp.z;
          s.mPos[o + 3] = s.tmp2.x; s.mPos[o + 4] = s.tmp2.y; s.mPos[o + 5] = s.tmp2.z;
          const k = m.bright * Math.sin(Math.min(1, u) * Math.PI);
          s.mCol[o] = 0; s.mCol[o + 1] = 0; s.mCol[o + 2] = 0;
          s.mCol[o + 3] = k; s.mCol[o + 4] = k * 0.95; s.mCol[o + 5] = k * 0.85;
          continue;
        }
      }
      for (let j = 0; j < 6; j++) { s.mPos[o + j] = 0; s.mCol[o + j] = 0; }
      s.mPos[o + 1] = -s.R; s.mPos[o + 4] = -s.R;
    }
    s.mGeo.attributes.position.needsUpdate = true;
    s.mGeo.attributes.color.needsUpdate = true;
    // keep the dome centred on the player so it never clips
    const p = ctx.playerCtl.state.headWorld;
    s.group.position.set(p.x, 0, p.z);
  },
};
