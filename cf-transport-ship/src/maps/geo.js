// 解析 tools/dust2-geo.mjs 生成的真实地图数据块：浏览器和 Node 离线校验共用同一条解码路径，
// 碰撞体与导航场也在这里装配，避免校验脚本和运行时各搭一套地图。
import { inflateB64 } from './blob.js';
import { GEO_META, GEO_BLOB, SOL_META, SOL_BLOB, ROOF_BLOB, NAV_META, NAV_BLOB, LINK_BLOB } from './dust2-geo.js';

const MAT_NAME = ['concrete', 'wood', 'metal'];
const SURFACE = ['sand', 'wood', 'metal'];

export async function decodeGeo() {
  const [geo, sol, roof, nav, link] = await Promise.all([
    inflateB64(GEO_BLOB), inflateB64(SOL_BLOB), inflateB64(ROOF_BLOB), inflateB64(NAV_BLOB), inflateB64(LINK_BLOB),
  ]);
  const o = GEO_META.off;
  return {
    geoMeta: GEO_META, solMeta: SOL_META, navMeta: NAV_META,
    verts: new Int16Array(geo.buffer, o.verts, GEO_META.nVerts * 3),
    idx: new Uint32Array(geo.buffer, o.idx, GEO_META.nTris * 3),
    mat: new Uint8Array(geo.buffer, o.mat, GEO_META.nTris),
    // 碰撞盒 / 顶棚：[x, z, w, d, y0, y1, mat]，单位 cm
    sol: new Int16Array(sol.buffer, 0, SOL_META.count * 7),
    roof: new Int16Array(roof.buffer, 0, SOL_META.roofCount * 7),
    // 高度场是 int16 厘米（哨兵 32767），必须按两个字节一个格来解释
    navY: new Int16Array(nav.buffer, nav.byteOffset, nav.length / 2),
    link,
  };
}

// 导航高度场 + 四向可走掩码，交给 NavGrid
export function navField(G) {
  const NM = G.navMeta;
  return { y: G.navY, link: G.link, blocked: NM.blocked, w: NM.w, h: NM.h, step: NM.step };
}

// 地面高度采样：体素列实测的真实海拔，未覆盖处视为 0
export function makeSampler(G) {
  const NM = G.navMeta;
  const cellOf = (x, z) => {
    const i = Math.floor((x - NM.x0) / NM.cell), j = Math.floor((z - NM.z0) / NM.cell);
    if (i < 0 || j < 0 || i >= NM.w || j >= NM.h) return -1;
    return j * NM.w + i;
  };
  const groundAt = (x, z) => {
    const k = cellOf(x, z);
    return k < 0 || G.navY[k] === NM.blocked ? 0 : G.navY[k] / 100;
  };
  // 吸附到最近的可走格（含坐标），落点在墙里时校验与出生点都靠它兜底
  const freeNear = (x, z) => {
    const k0 = cellOf(x, z);
    if (k0 >= 0 && G.navY[k0] !== NM.blocked) return cellPos(k0);
    const i0 = Math.floor((x - NM.x0) / NM.cell), j0 = Math.floor((z - NM.z0) / NM.cell);
    for (let r = 1; r < 8; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i >= NM.w || j >= NM.h) continue;
      const k = j * NM.w + i;
      if (G.navY[k] !== NM.blocked) return cellPos(k);
    }
    return null;
  };
  const cellPos = (k) => ({
    x: +(NM.x0 + ((k % NM.w) + 0.5) * NM.cell).toFixed(2),
    z: +(NM.z0 + (((k / NM.w) | 0) + 0.5) * NM.cell).toFixed(2),
    y: +(G.navY[k] / 100).toFixed(2),
  });
  return { cellOf, groundAt, freeNear, cellPos };
}

// 真实体素合并出的碰撞盒 + 顶棚 + 世界夹；纯数据，无渲染依赖
export function addColliders(world, G, bounds, S = makeSampler(G)) {
  for (let i = 0; i < G.sol.length; i += 7) {
    const x = G.sol[i] / 100, z = G.sol[i + 1] / 100;
    const w = G.sol[i + 2] / 100, d = G.sol[i + 3] / 100;
    const y0 = G.sol[i + 4] / 100, y1 = G.sol[i + 5] / 100;
    const mt = G.sol[i + 6];
    world.add({
      x, y: (y0 + y1) / 2, z, sx: w, sy: y1 - y0, sz: d, yaw: 0,
      mat: MAT_NAME[mt] || 'concrete', surface: SURFACE[mt] || 'sand',
      bullet: mt === 0 ? 'block' : 'pen', tag: y1 - S.groundAt(x, z) < 0.4 ? 'floor' : 'solid',
    });
  }
  for (let i = 0; i < G.roof.length; i += 7) {
    const x = G.roof[i] / 100, z = G.roof[i + 1] / 100;
    const w = G.roof[i + 2] / 100, d = G.roof[i + 3] / 100;
    const y0 = G.roof[i + 4] / 100, y1 = G.roof[i + 5] / 100;
    world.add({
      x, y: (y0 + y1) / 2, z, sx: w, sy: y1 - y0, sz: d, yaw: 0,
      mat: 'concrete', surface: 'sand', bullet: 'block', tag: 'roof', sight: false,
    });
  }
  // 真实数据不含世界夹，用四面只有碰撞的夹墙把对战区封住（雷达按 hx>30 自动过滤掉）
  for (const [x, z, w, d] of [
    [0, bounds.z[1] - 1, bounds.x[1] - bounds.x[0] + 4, 2], [0, bounds.z[0] + 1, bounds.x[1] - bounds.x[0] + 4, 2],
    [bounds.x[1] - 1, 0, 2, bounds.z[1] - bounds.z[0] + 4], [bounds.x[0] + 1, 0, 2, bounds.z[1] - bounds.z[0] + 4],
  ]) {
    world.add({ x, y: 6, z, sx: w, sy: 26, sz: d, yaw: 0, mat: 'concrete', surface: 'sand', bullet: 'block', sight: false, tag: 'clip' });
  }
  world.build();
}

// 出生点：官方点位吸附到可走格，人数不足时按固定偏移补位
export function buildSpawns(list, n, yaw, S) {
  const place = (x, z) => {
    const p = S.freeNear(x, z) || { x, z, y: 0 };
    return { x: p.x, z: p.z, y: p.y, yaw };
  };
  const out = list.map((p) => place(p.x, p.z));
  for (let i = 0; out.length < n; i++) {
    const s = list[i % list.length];
    out.push(place(s.x + (i % 2 ? 2 : -2), s.z + (i % 4 < 2 ? 2 : -2)));
  }
  return out;
}
