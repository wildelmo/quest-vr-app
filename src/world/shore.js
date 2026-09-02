import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { REED_VERT, REED_FRAG } from '../shaders/shore.js';

/**
 * The horizon and the near shallows. Four draw calls, all opaque (renderOrder 0, before the water):
 *  - hills:  one ring heightfield r 55..170 m, layered gradient noise, lower in front (±35°) so
 *            the Milky Way core stays clear, ridges in the back sectors. Lambert, fogged.
 *  - pines:  one InstancedMesh of a merged trunk + two cones, rooted on the hills (height > 3 m).
 *  - islets: two mounds + rocks + bare trees merged into one vertex-coloured Lambert mesh.
 *  - reeds:  one InstancedMesh of tapered blades with a custom sway / hand-push shader.
 * Exposes ctx.shore = { heightAt(x, z), groundAt(x, z), islets, reedPatches, wind }.
 */

const WIND = new THREE.Vector2(-1, 1).normalize(); // the wind blows toward -x, +z

// ---------------------------------------------------------------------------------------------
// seeded helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// 2-D gradient (Perlin) noise with a seeded permutation, ≈ [-0.7, 0.7]
function makeNoise2D(seed) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(512);
  const src = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = src[i]; src[i] = src[j]; src[j] = t; }
  for (let i = 0; i < 512; i++) p[i] = src[i & 255];
  const GX = [1, -1, 1, -1, 1, -1, 0, 0], GY = [1, 1, -1, -1, 0, 0, 1, -1];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  return (x, y) => {
    const X = Math.floor(x), Y = Math.floor(y);
    const xf = x - X, yf = y - Y;
    const xi = X & 255, yi = Y & 255;
    const u = fade(xf), v = fade(yf);
    const aa = p[p[xi] + yi] & 7, ab = p[p[xi] + yi + 1] & 7, ba = p[p[xi + 1] + yi] & 7, bb = p[p[xi + 1] + yi + 1] & 7;
    const n0 = lerp(GX[aa] * xf + GY[aa] * yf, GX[ba] * (xf - 1) + GY[ba] * yf, u);
    const n1 = lerp(GX[ab] * xf + GY[ab] * (yf - 1), GX[bb] * (xf - 1) + GY[bb] * (yf - 1), u);
    return lerp(n0, n1, v);
  };
}

const smoothstep = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// terrain
function makeTerrain(seed) {
  const noise = makeNoise2D(seed);
  const fbm = (x, z) => noise(x / 46, z / 46) + 0.5 * noise(x / 21 + 37.1, z / 21 - 11.3) + 0.15 * noise(x / 11 - 5.7, z / 11 + 23.9);
  // returns { h, ridge } — ridge in [0,1] is how close to a ridge crest (x,z) is (for the pines)
  function terrain(x, z) {
    const r = Math.hypot(x, z);
    if (r < 55) return { h: 0, ridge: 0 };
    const az = Math.abs(Math.atan2(x, -z)); // 0 = straight ahead (-Z)
    const front = 1 - smoothstep(30 * DEG, 52 * DEG, az);
    const back = smoothstep(72 * DEG, 112 * DEG, az);
    const n01 = THREE.MathUtils.clamp(0.5 + fbm(x, z) * 0.62, 0, 1);
    // rolling hills: a gentle shore ramp up to 9–20 m, then (outside the front sector) up to 40 m further back
    let h = smoothstep(55, 82, r) * (9 + 11 * n01);
    h += smoothstep(68, 118, r) * n01 * 20 * (1 - front);
    // ridges in the back sectors, up to +30 m (45–70 m total)
    const rv = noise(x / 68 + 91.3, z / 68 - 41.7);
    let rn = 1 - Math.sqrt(rv * rv + 0.012) * 1.4; // |noise| with a rounded crest so the ridge line stays smooth
    rn = THREE.MathUtils.clamp(rn, 0, 1);
    const ridge = rn * rn * back * smoothstep(80, 125, r);
    h += ridge * 30 * (0.7 + 0.3 * n01);
    return { h, ridge };
  }
  return { terrain, noise, heightAt: (x, z) => terrain(x, z).h };
}

function isletHeightAt(islet, x, z) {
  const d = Math.hypot(x - islet.x, z - islet.z) / islet.geoRadius;
  if (d >= 1) return 0;
  return islet.base + islet.geoHeight * Math.pow(1 - d * d, 1.3);
}

// ---------------------------------------------------------------------------------------------
export const shore = {
  name: 'shore',
  init(ctx) {
    const rnd = mulberry32(0x5EEDA5);
    const T = makeTerrain(1337);
    const level = ctx.water.level;
    const pScale = ctx.quality?.particleScale ?? 1;
    const group = new THREE.Group();
    group.name = 'shore';
    ctx.scene.add(group);

    // ---- 1. hills: ring heightfield, inner rows packed tighter for a clean shoreline
    {
      const geo = new THREE.RingGeometry(55, 170, 320, 32); // 20,480 triangles
      geo.rotateX(-Math.PI / 2); // lay it flat first (a proper rotation: keeps the winding / normals pointing up)
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        const th = Math.atan2(z, x);
        const t = THREE.MathUtils.clamp((Math.hypot(x, z) - 55) / 115, 0, 1);
        const r = 55 + 115 * Math.pow(t, 1.5);
        const wx = r * Math.cos(th), wz = r * Math.sin(th);
        pos.setXYZ(i, wx, T.heightAt(wx, wz) - 0.4, wz); // a little below datum so the inner edge sits under the water
      }
      geo.deleteAttribute('normal');
      const merged = mergeVertices(geo, 1e-3);
      geo.dispose();
      merged.computeVertexNormals();
      merged.computeBoundingSphere();
      const mat = new THREE.MeshLambertMaterial({ color: 0x0b141d, emissive: 0x000000, flatShading: false, fog: true });
      const hills = new THREE.Mesh(merged, mat);
      hills.name = 'hills';
      hills.renderOrder = 0;
      group.add(hills);
      this._hills = hills;
    }

    // ---- 2. pines: one InstancedMesh, merged trunk + two cones (24 triangles each)
    {
      const trunk = new THREE.CylinderGeometry(0.025, 0.04, 0.3, 5, 1, true); trunk.translate(0, 0.02, 0);  // -0.13 .. 0.17
      const cone1 = new THREE.ConeGeometry(0.19, 0.62, 7, 1, true); cone1.translate(0, 0.37, 0);            // 0.06 .. 0.68
      const cone2 = new THREE.ConeGeometry(0.13, 0.56, 7, 1, true); cone2.translate(0, 0.72, 0);            // 0.44 .. 1.00
      const pineGeo = mergeGeometries([trunk, cone1, cone2], false);
      trunk.dispose(); cone1.dispose(); cone2.dispose();
      const N = Math.max(1, Math.round(550 * pScale));
      const mat = new THREE.MeshLambertMaterial({ color: 0x07110d, fog: true });
      const pines = new THREE.InstancedMesh(pineGeo, mat, N);
      pines.name = 'pines';
      pines.renderOrder = 0;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      let placed = 0, tries = 0;
      while (placed < N && tries < N * 60) {
        tries++;
        const r = THREE.MathUtils.lerp(58, 166, Math.pow(rnd(), 1.25));
        const th = rnd() * Math.PI * 2;
        const x = r * Math.cos(th), z = r * Math.sin(th);
        const t = T.terrain(x, z);
        if (t.h <= 3) continue;
        if (rnd() > 0.55 + 0.45 * t.ridge) continue; // denser on the ridge lines
        const h = THREE.MathUtils.lerp(5, 11, rnd());
        const w = h * THREE.MathUtils.lerp(0.75, 1.05, rnd());
        // sink by the local slope so the downhill side never floats
        const slope = Math.max(Math.abs(T.heightAt(x + 1, z) - T.heightAt(x - 1, z)), Math.abs(T.heightAt(x, z + 1) - T.heightAt(x, z - 1))) * 0.5;
        const sink = 0.3 + Math.min(1.5, slope * w * 0.25);
        p.set(x, t.h - sink, z);
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        s.set(w, h, w);
        m.compose(p, q, s);
        pines.setMatrixAt(placed++, m);
      }
      pines.count = placed;
      pines.instanceMatrix.needsUpdate = true;
      pines.computeBoundingSphere();
      group.add(pines);
      this._pines = pines;
    }

    // ---- 3. islets: two mounds, rocks and bare trees merged into one vertex-coloured mesh
    const islets = [
      { name: 'A', dist: 14, azDeg: 60, radius: 3, height: 1.1, rocks: 6, trees: 2 },
      { name: 'B', dist: 38, azDeg: -110, radius: 6, height: 2.5, rocks: 8, trees: 3 },
    ];
    {
      const parts = [];
      const colMound = new THREE.Color(0x0c1519), colRock = new THREE.Color(0x10161c), colTree = new THREE.Color(0x0a0d10);
      const paint = (g, c) => {
        const n = g.attributes.position.count;
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        if (g.attributes.uv) g.deleteAttribute('uv');
        return g.index ? g.toNonIndexed() : g;
      };
      const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3();
      const SUBMERGE = 0.45; // how far the mound's rim sits under the water
      for (const isl of islets) {
        const az = isl.azDeg * DEG;
        isl.x = isl.dist * Math.sin(az);
        isl.z = -isl.dist * Math.cos(az);
        isl.base = level - SUBMERGE;
        isl.geoHeight = isl.height + SUBMERGE;
        // profile (1 - d²)^1.3 = SUBMERGE/geoHeight at the waterline → geoRadius so the waterline radius = isl.radius
        const dWater = Math.sqrt(1 - Math.pow(SUBMERGE / isl.geoHeight, 1 / 1.3));
        isl.geoRadius = isl.radius / dWater;
        isl.top = level + isl.height;
        // mound
        const mound = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2);
        const mp = mound.attributes.position;
        for (let i = 0; i < mp.count; i++) {
          const x = mp.getX(i), z = mp.getZ(i);
          const d = Math.min(1, Math.hypot(x, z));
          const lump = 1 + 0.16 * T.noise(x * 2.1 + isl.dist, z * 2.1 - isl.dist) + 0.08 * T.noise(x * 5.3, z * 5.3 + 7.7);
          const y = Math.pow(1 - d * d, 1.3) * lump * (1 - 0.35 * d * d * (1 - d * d)); // flat top, sagging shoulders
          mp.setXYZ(i, x * isl.geoRadius + isl.x, Math.max(0, y) * isl.geoHeight + isl.base, z * isl.geoRadius + isl.z);
        }
        mound.deleteAttribute('normal');
        mound.deleteAttribute('uv'); // so the pole and seam duplicates merge and get smooth normals
        const moundM = mergeVertices(mound, 1e-3); mound.dispose();
        moundM.computeVertexNormals();
        parts.push(paint(moundM, colMound));
        // rocks
        for (let k = 0; k < isl.rocks; k++) {
          const rock = new THREE.IcosahedronGeometry(1, 0);
          const rp = rock.attributes.position;
          for (let i = 0; i < rp.count; i++) { const j = 0.78 + 0.35 * T.noise(rp.getX(i) * 3.1 + k * 9.7, rp.getZ(i) * 3.1 + rp.getY(i) * 2.2); rp.setXYZ(i, rp.getX(i) * j, rp.getY(i) * j * 0.7, rp.getZ(i) * j); }
          rock.computeVertexNormals();
          const d = 0.25 + 0.7 * Math.sqrt(rnd()), a = rnd() * Math.PI * 2;
          const rx = isl.x + Math.cos(a) * d * isl.radius, rz = isl.z + Math.sin(a) * d * isl.radius;
          const size = THREE.MathUtils.lerp(0.25, 0.6, rnd()) * (isl.radius / 3) ** 0.7;
          const gy = isletHeightAt(isl, rx, rz);
          tmpE.set(rnd() * 0.5, rnd() * Math.PI * 2, rnd() * 0.5);
          tmpM.compose(tmpV.set(rx, gy - size * 0.25, rz), tmpQ.setFromEuler(tmpE), tmpS.set(size * (0.8 + 0.5 * rnd()), size, size * (0.8 + 0.5 * rnd())));
          rock.applyMatrix4(tmpM);
          parts.push(paint(rock, colRock));
        }
        // bare trees: a tapered trunk + 6 branches
        for (let k = 0; k < isl.trees; k++) {
          const d = 0.15 + 0.5 * rnd(), a = rnd() * Math.PI * 2;
          const tx = isl.x + Math.cos(a) * d * isl.radius, tz = isl.z + Math.sin(a) * d * isl.radius;
          const ty = isletHeightAt(isl, tx, tz) - 0.15;
          const scale = THREE.MathUtils.lerp(0.8, 1.3, rnd()) * (isl.name === 'B' ? 1.25 : 1);
          const lean = (rnd() - 0.5) * 0.25;
          const trunkH = 3.4;
          const trunk = new THREE.CylinderGeometry(0.05, 0.15, trunkH, 5, 1, true);
          trunk.translate(0, trunkH / 2, 0);
          const treeParts = [trunk];
          for (let b = 0; b < 6; b++) {
            const len = THREE.MathUtils.lerp(0.8, 1.6, rnd());
            const br = new THREE.CylinderGeometry(0.012, 0.045, len, 4, 1, true);
            br.translate(0, len / 2, 0);
            const at = THREE.MathUtils.lerp(1.2, 3.1, (b + rnd() * 0.6) / 6);
            tmpE.set(THREE.MathUtils.lerp(0.65, 1.2, rnd()), 0, 0);
            tmpQ.setFromEuler(tmpE);
            tmpQ.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b * 1.05 + rnd() * 0.6));
            tmpM.compose(tmpV.set(0, at, 0), tmpQ, tmpS.set(1, 1, 1));
            br.applyMatrix4(tmpM);
            treeParts.push(br);
          }
          const tree = mergeGeometries(treeParts, false);
          for (const g of treeParts) g.dispose();
          tmpE.set(lean, rnd() * Math.PI * 2, lean * 0.6);
          tmpM.compose(tmpV.set(tx, ty, tz), tmpQ.setFromEuler(tmpE), tmpS.set(scale, scale, scale));
          tree.applyMatrix4(tmpM);
          parts.push(paint(tree, colTree));
        }
      }
      const isletGeo = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      isletGeo.computeBoundingSphere();
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, fog: true });
      const isletMesh = new THREE.Mesh(isletGeo, mat);
      isletMesh.name = 'islets';
      isletMesh.renderOrder = 0;
      group.add(isletMesh);
      this._islets = isletMesh;
    }

    // ---- 4. reeds: one InstancedMesh of tapered 4-quad blades
    const reedPatches = [];
    {
      // blade: 5 rows × 2 verts, width 2.5 cm → 0.4 cm, unit height (uv.y = height fraction)
      const rows = 5;
      const bpos = new Float32Array(rows * 2 * 3), buv = new Float32Array(rows * 2 * 2);
      const bidx = [];
      for (let i = 0; i < rows; i++) {
        const t = i / (rows - 1);
        const hw = THREE.MathUtils.lerp(0.0125, 0.002, t);
        bpos.set([-hw, t, 0, hw, t, 0], i * 6);
        buv.set([0, t, 1, t], i * 4);
        if (i < rows - 1) { const a = i * 2; bidx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
      }
      const blade = new THREE.BufferGeometry();
      blade.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
      blade.setAttribute('uv', new THREE.BufferAttribute(buv, 2));
      blade.setIndex(bidx);

      const N = Math.max(1, Math.round(450 * pScale));
      const A = islets[0];
      // patches: near (beside/behind the player), mid, and a ring around islet A; weights sum to 1
      const P = (dist, azDeg, ra, rb, w) => ({ x: dist * Math.sin(azDeg * DEG), z: -dist * Math.cos(azDeg * DEG), ra, rb, rot: rnd() * Math.PI, w });
      const spec = [
        P(6.5, 128, 2.6, 1.4, 0.15), P(7.2, -122, 2.2, 1.6, 0.14),                 // near
        P(16, -55, 3.2, 1.8, 0.14), P(22, 32, 3.8, 2.0, 0.15), P(20, 168, 3.0, 1.9, 0.14), // mid
        { x: A.x, z: A.z, ring: [A.radius + 0.35, A.radius + 1.7], w: 0.28 },       // around islet A
      ];
      const phase = new Float32Array(N);
      const reedMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uWind: { value: WIND.clone() },
          uHands: { value: [new THREE.Vector3(0, -100, 0), new THREE.Vector3(0, -100, 0)] },
          uHandOn: { value: new Float32Array(2) },
          uBase: { value: new THREE.Color(0x1a2414) },
          uTip: { value: new THREE.Color(0x2a3b1c) },
          uMoonDir: { value: new THREE.Vector3(0.5, 0.6, 0.3).normalize() },
          uMoonColor: { value: new THREE.Color(0xbfd0ff) },
          uMoonStrength: { value: 1 },
          uSkyAmb: { value: new THREE.Color(0x1a2740).multiplyScalar(0.55) },
          uGroundAmb: { value: new THREE.Color(0x020306).multiplyScalar(0.55) },
          uFogColor: { value: new THREE.Color(CONFIG.fog.color) },
          uFogDensity: { value: CONFIG.fog.density },
        },
        vertexShader: REED_VERT,
        fragmentShader: REED_FRAG,
        side: THREE.DoubleSide, fog: false, transparent: false, depthWrite: true, depthTest: true,
      });
      const reeds = new THREE.InstancedMesh(blade, reedMat, N);
      reeds.name = 'reeds';
      reeds.renderOrder = 0;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
      let i = 0;
      for (let k = 0; k < spec.length; k++) {
        const sp = spec[k];
        const count = k === spec.length - 1 ? N - i : Math.round(N * sp.w);
        const patch = { x: sp.x, z: sp.z, radius: sp.ring ? sp.ring[1] : Math.max(sp.ra, sp.rb), count };
        reedPatches.push(patch);
        for (let j = 0; j < count && i < N; j++, i++) {
          let x, z;
          if (sp.ring) {
            const a = rnd() * Math.PI * 2, r = THREE.MathUtils.lerp(sp.ring[0], sp.ring[1], Math.sqrt(rnd()));
            x = sp.x + Math.cos(a) * r; z = sp.z + Math.sin(a) * r;
          } else {
            const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
            const ex = Math.cos(a) * r * sp.ra, ez = Math.sin(a) * r * sp.rb;
            x = sp.x + ex * Math.cos(sp.rot) - ez * Math.sin(sp.rot);
            z = sp.z + ex * Math.sin(sp.rot) + ez * Math.cos(sp.rot);
          }
          const h = THREE.MathUtils.lerp(1.1, 1.9, rnd());
          const d = Math.hypot(x, z);
          const wScale = 1 + 0.12 * Math.max(0, d - 6); // fatten distant blades so they don't shimmer to nothing
          e.set((rnd() - 0.5) * 0.16, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.16, 'YXZ');
          m.compose(p.set(x, level - 0.05, z), q.setFromEuler(e), s.set(wScale, h, 1));
          reeds.setMatrixAt(i, m);
          phase[i] = rnd() * Math.PI * 2;
        }
      }
      reeds.count = i;
      reeds.instanceMatrix.needsUpdate = true;
      blade.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
      reeds.computeBoundingSphere();
      reeds.boundingSphere.radius += 1.0;
      group.add(reeds);
      this._reeds = reeds;
      this._reedMat = reedMat;
    }

    // ---- lights we read from (set up by the sky module)
    this._moonLight = ctx.scene.getObjectByName('moonLight') || null;
    let hemi = null;
    ctx.scene.traverse((o) => { if (!hemi && o.isHemisphereLight) hemi = o; });
    if (hemi) {
      this._reedMat.uniforms.uSkyAmb.value.copy(hemi.color).multiplyScalar(hemi.intensity);
      this._reedMat.uniforms.uGroundAmb.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity);
    }
    if (this._moonLight) this._reedMat.uniforms.uMoonColor.value.copy(this._moonLight.color);

    // ---- public surface
    const heightAt = T.heightAt;
    ctx.shore = {
      heightAt,
      groundAt: (x, z) => { let h = heightAt(x, z); for (const isl of islets) h = Math.max(h, isletHeightAt(isl, x, z)); return h; },
      islets: islets.map((isl) => ({ name: isl.name, x: isl.x, z: isl.z, radius: isl.radius, height: isl.height })),
      reedPatches,
      wind: WIND.clone(),
      group,
    };
    this._group = group;
  },

  update(ctx) {
    const u = this._reedMat.uniforms;
    u.uTime.value = ctx.time.t;
    if (ctx.scene.fog) { u.uFogColor.value.copy(ctx.scene.fog.color); u.uFogDensity.value = ctx.scene.fog.density ?? u.uFogDensity.value; }
    if (ctx.sky?.moonDirWorld) { u.uMoonDir.value.copy(ctx.sky.moonDirWorld); u.uMoonStrength.value = ctx.sky.moonAbove ?? 1; }
    else if (this._moonLight) { u.uMoonDir.value.copy(this._moonLight.position).normalize(); u.uMoonStrength.value = Math.min(1, this._moonLight.intensity / 0.55); }
    const list = ctx.hands?.list || [];
    for (let i = 0; i < 2; i++) {
      const h = list[i];
      const on = !!(h && h.visible && h.alpha > 0.05);
      u.uHandOn.value[i] = on ? h.alpha : 0;
      if (on) u.uHands.value[i].copy(h.palm.position); else u.uHands.value[i].set(0, -100, 0);
    }
  },
};
