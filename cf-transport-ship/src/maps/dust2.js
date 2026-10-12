// de_dust2：直接渲染真实 CS2 地图几何
// 数据来自 dust2-web/public/assets/map（collision.json 的三角面 + 每面一个穿透材质字节），
// 由 tools/dust2-geo.mjs 量化、焊接、gzip 后内联在 ./dust2-geo.js。这里解压后按
// 「材质 x 主朝向」分成十个合批网格；碰撞体和导航高度场出自同一次体素采样，
// 所以视觉、物理、寻路看到的是同一份真实数据。
import * as THREE from 'three';
import { createBuilder } from '../mapkit.js';
import { decodeGeo, navField, makeSampler, addColliders, buildSpawns, carveDoorways } from './geo.js';
import { GEO_META, NAV_META, MESH_SPAWNS, MESH_LABELS } from './dust2-geo.js';
import { LAYOUT, DOORS } from './dust2-layout.js';

// 门洞内的面是否该删：竖直面、中心在门洞矩形内、低于门楣。
// 只删门板，地面（水平面）和门楣保留。
function inDoorway(x, y, z, vertical) {
  if (!vertical) return false;
  for (const D of DOORS) {
    if (x > D.x0 && x < D.x1 && z > D.z0 && z < D.z1 && y < D.top) return true;
  }
  return false;
}

// 桶序：混凝土（平/仰/东西墙/南北墙）、木（平/东西/南北）、金属（平/东西/南北）
// 同一桶内的面朝向一致，才能用同一套平面投影 UV（UV 直接取世界坐标 / tile）
const BUCKETS = [
  { key: 'sand', tex: 'sand', tile: 5, proj: 'H', color: 0xffffff, rough: 1, metal: 0, nsc: 0.7, cast: false },
  { key: 'ceil', tex: 'adobe', tile: 3, proj: 'H', color: 0x8b7f6b, rough: 1, metal: 0, nsc: 1, cast: false },
  { key: 'wallE', tex: 'adobe', tile: 3, proj: 'X', color: 0xf4e8ce, rough: 0.95, metal: 0, nsc: 1.1, cast: true },
  { key: 'wallN', tex: 'adobe', tile: 3, proj: 'Z', color: 0xffffff, rough: 0.95, metal: 0, nsc: 1.1, cast: true },
  { key: 'woodU', tex: 'crate', tile: 1, proj: 'H', color: 0xffffff, rough: 0.85, metal: 0.02, nsc: 1, cast: true },
  { key: 'woodE', tex: 'crate', tile: 1, proj: 'X', color: 0xb6946a, rough: 0.9, metal: 0, nsc: 1, cast: true },
  { key: 'woodN', tex: 'crate', tile: 1, proj: 'Z', color: 0xc9a87c, rough: 0.9, metal: 0, nsc: 1, cast: true },
  { key: 'metalU', tex: 'metal', tile: 1.2, proj: 'H', color: 0xffffff, rough: 0.68, metal: 0.38, nsc: 1, cast: true },
  { key: 'metalE', tex: 'metal', tile: 1.2, proj: 'X', color: 0xc2bba7, rough: 0.66, metal: 0.42, nsc: 1, cast: true },
  { key: 'metalN', tex: 'metal', tile: 1.2, proj: 'Z', color: 0xd0c9b4, rough: 0.66, metal: 0.42, nsc: 1, cast: true },
];

function bucketOf(mt, nx, ny, nz) {
  const w = Math.abs(nx) > Math.abs(nz) ? 1 : 2;   // 1 朝东/西，2 朝南/北
  if (mt === 1) return Math.abs(ny) > 0.5 ? 4 : 4 + w;
  if (mt === 2) return Math.abs(ny) > 0.5 ? 7 : 7 + w;
  return Math.abs(ny) > 0.5 ? (ny > 0 ? 0 : 1) : 1 + w;
}

async function buildDust2(scene, T, world) {
  const G = await decodeGeo();
  const kb = createBuilder(scene, T, world, 7731);
  const { matDefs, lampSpots, anim, std, defMat, rod, geom, flush, cylG8, sphG } = kb;
  const D = T.desert;

  const mats = BUCKETS.map((b) => {
    const src = b.tex === 'sand' ? D.sand : b.tex === 'adobe' ? D.adobe : b.tex === 'crate' ? D.crate : D.metal;
    return std({
      map: src.map, normalMap: src.normalMap, roughnessMap: src.roughnessMap,
      color: b.color, roughness: b.rough, metalness: b.metal,
      normalScale: new THREE.Vector2(b.nsc, b.nsc),
      envMapIntensity: b.metal ? 0.7 : 0.32,
      // 硬边砖块：平面投影 UV 下棱角处的插值法线会糊成圆角，直接按面法线着色
      flatShading: true,
    });
  });
  for (let i = 0; i < BUCKETS.length; i++) defMat(BUCKETS[i].key, mats[i], 'unit', { shadow: BUCKETS[i].cast });
  defMat('black', std({ color: 0x24211c, roughness: 0.9, metalness: 0.05 }), 1);
  defMat('lamp', std({ color: 0xfff2d0, emissive: 0xffe2a8, emissiveIntensity: 3.5, roughness: 0.3 }), 1, { shadow: false });

  // ---------- 导航高度场：碰撞体、出生点、灯柱都靠它落到真实地面 ----------
  const S = makeSampler(G);

  // ---------- 真实三角面：反量化 + 平滑法线 + 分桶 ----------
  const M = GEO_META;
  const nV = M.nVerts, NT = M.nTris;
  const [ox, oy, oz] = M.origin, [qx, qy, qz] = M.scale;
  const pos = new Float32Array(nV * 3), nrm = new Float32Array(nV * 3);
  for (let i = 0; i < nV; i++) {
    pos[i * 3] = ox + G.verts[i * 3] * qx;
    pos[i * 3 + 1] = oy + G.verts[i * 3 + 1] * qy;
    pos[i * 3 + 2] = oz + G.verts[i * 3 + 2] * qz;
  }
  const bkt = new Uint8Array(NT), cnt = new Int32Array(BUCKETS.length);
  for (let t = 0; t < NT; t++) {
    const i0 = G.idx[t * 3], i1 = G.idx[t * 3 + 1], i2 = G.idx[t * 3 + 2];
    const a = i0 * 3, b = i1 * 3, c = i2 * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    // 门洞修复：删掉封死门洞的门板三角面（bkt=255，后续合批跳过）
    {
      const cx = (pos[a] + pos[b] + pos[c]) / 3;
      const cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
      const cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
      if (inDoorway(cx, cy, cz, Math.abs(ny) <= 0.5)) { bkt[t] = 255; continue; }
    }
    for (const v of [a, b, c]) { nrm[v] += nx; nrm[v + 1] += ny; nrm[v + 2] += nz; }
    const k = bucketOf(G.mat[t], nx, ny, nz);
    bkt[t] = k; cnt[k]++;
  }
  for (let i = 0; i < nV; i++) {
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1;
    nrm[i * 3] /= l; nrm[i * 3 + 1] /= l; nrm[i * 3 + 2] /= l;
  }
  // 位置与法线在十个几何体之间共享，只有 UV 和索引按桶分开
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const nrmAttr = new THREE.BufferAttribute(nrm, 3);
  const meshes = [];
  for (let k = 0; k < BUCKETS.length; k++) {
    const n = cnt[k];
    if (!n) continue;
    const B = BUCKETS[k], tile = B.tile;
    const uv = new Float32Array(nV * 2);
    const index = new Uint32Array(n * 3);
    let p = 0;
    for (let t = 0; t < NT; t++) {
      if (bkt[t] !== k) continue;
      const i0 = G.idx[t * 3], i1 = G.idx[t * 3 + 1], i2 = G.idx[t * 3 + 2];
      index[p++] = i0; index[p++] = i1; index[p++] = i2;
      for (const i of [i0, i1, i2]) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        uv[i * 2] = (B.proj === 'Z' ? x : B.proj === 'X' ? z : x) / tile;
        uv[i * 2 + 1] = (B.proj === 'H' ? z : y) / tile;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', posAttr);
    g.setAttribute('normal', nrmAttr);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mats[k]);
    mesh.castShadow = B.cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.name = B.key;
    scene.add(mesh);
    meshes.push(mesh);
  }

  // ---------- 碰撞体 + 世界夹：与离线校验共用同一套装配 ----------
  addColliders(world, G, LAYOUT.bounds, S);

  // ---------- 门洞修复：把烘焙数据里封死的门洞挖成开放门洞 ----------
  carveDoorways(world, S, DOORS);

  // ---------- 灯柱：报点上空，地面能站人时才立 ----------
  for (const l of MESH_LABELS) {
    const p = S.freeNear(l.x, l.z);
    if (!p) continue;
    rod('black', p.x, p.y, p.z, p.x, p.y + 4.6, p.z, 0.07);
    geom('black', cylG8, p.x, p.y + 0.06, p.z, 0, 0, 0, 0.24, 0.12, 0.24);
    geom('lamp', sphG, p.x, p.y + 4.5, p.z, 0, 0, 0, 0.17, 0.17, 0.17);
    lampSpots.push(new THREE.Vector3(p.x, p.y + 4.5, p.z));
  }

  meshes.push(...flush());

  // 出生点取自 Valve 官方点位，高度用导航场实测地面
  const yaw = LAYOUT.spawnYaw;
  // 门洞修复（导航）：烘焙的导航场在门洞处是断的，运行时按门洞地面高补上，
  // 并与相邻可走格双向打通。高度差复核交给 NavGrid（上行 1m / 下落 3m）。
  const field = navField(G);
  {
    const NM = NAV_META, y = field.y, link = field.link;
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (const D of DOORS) {
      const cells = [];
      for (let j = 0; j < NM.h; j++) for (let i = 0; i < NM.w; i++) {
        const cx = NM.x0 + (i + 0.5) * NM.cell, cz = NM.z0 + (j + 0.5) * NM.cell;
        if (cx < D.x0 || cx > D.x1 || cz < D.z0 || cz > D.z1) continue;
        const k = j * NM.w + i;
        y[k] = Math.round(D.ground * 100);
        cells.push(k);
      }
      for (const k of cells) {
        const i = k % NM.w, j = (k / NM.w) | 0;
        for (let d = 0; d < 4; d++) {
          const ni = i + DIRS[d][0], nj = j + DIRS[d][1];
          if (ni < 0 || nj < 0 || ni >= NM.w || nj >= NM.h) continue;
          const nk = nj * NM.w + ni;
          if (y[nk] === NM.blocked) continue;
          link[k] |= (1 << d);
          link[nk] |= (1 << ((d + 2) % 4));
        }
      }
    }
  }
  return {
    spawns: {
      BL: buildSpawns(MESH_SPAWNS.T, 10, yaw.BL, S),
      GR: buildSpawns(MESH_SPAWNS.CT, 10, yaw.GR, S),
    },
    lampSpots, meshes, materials: matDefs,
    nav: { ...LAYOUT.nav, field },
    update(dt, t) { for (const f of anim) f(dt, t); },
  };
}

export const dust2Map = {
  id: 'dust2',
  name: '沙漠灰城',
  en: 'DE_DUST2',
  brief: '三条进攻线：长道、中路、地道，A 点在东北，B 点在西北',
  story: LAYOUT.story,
  tip: LAYOUT.tip,
  textures: ['desert'],
  tod: [{ v: 'day', label: '白天' }, { v: 'dusk', label: '黄昏' }],
  sea: false,
  // 真实地形最低的地面是长道门 -4.41，再往下就是掉出地图
  voidY: -5.5,
  nav: LAYOUT.nav,
  bot: LAYOUT.bot,
  shadowBox: LAYOUT.shadowBox,
  radar: { halfW: 56, halfH: 56, overlays: [] },
  orbit: { cx: 0, cz: 0, rx: 78, rz: 82, y: 58, look: [0, 2, 0] },
  build: buildDust2,
};
