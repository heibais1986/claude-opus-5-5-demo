// 从 dust2-web 的真实 CS2 地图数据生成 de_dust2 的全部运行时数据。
//
// 输入：dust2-web/public/assets/map/collision.json      24 万个三角面（米制，已按 y-up 换好轴）
//       dust2-web/public/assets/map/penetration-materials.u8  每个三角面 1 字节材质（0 混凝土 1 木 2 金属）
//       dust2-web/shared/map-data.js                    Valve 官方出生点/包点/报点/导航多边形
// 输出：src/maps/dust2-geo.js —— gzip+base64 数据块
//       GEO  真实三角网格（int16 量化、顶点焊接），渲染用
//       SOL  轴对齐碰撞盒 + 顶棚（按列体素化，保留真实高度），物理用
//       NAV  导航高度场（每格地面 y）+ LINK 方向可通行位掩码，bot 寻路用
//
// 用法：node tools/dust2-geo.mjs [CELL] [--plot]
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { MAP } from '../../dust2-web/shared/map-data.js';
import { patchMapCollision } from '../../dust2-web/shared/map-collision-patch.js';

const argv = process.argv.slice(2);
const CELL = +(argv[0] && !argv[0].startsWith('-') ? argv[0] : 0.5);
const PLOT = argv.includes('--plot');

// ---------- 坐标系 ----------
// map-data：y 向上、+z 朝南。本项目：+z 朝北，地图居中于原点 —— 所以要镜像 z。
// 镜像会翻转三角面绕序，构建索引时交换第 2、3 个顶点补回来。
const CX = (MAP.bounds.minX + MAP.bounds.maxX) / 2;
const CZ = (MAP.bounds.minZ + MAP.bounds.maxZ) / 2;
const WX = (x) => x - CX;
const WZ = (z) => -z + CZ;

const X0 = -56, X1 = 56, Z0 = -60, Z1 = 60;
const gw = Math.round((X1 - X0) / CELL), gh = Math.round((Z1 - Z0) / CELL), N = gw * gh;
const HEAD = 1.9;          // 站人所需净高
const BASE = -9;           // 碰撞盒底：低于全场最低地面，杜绝踩空
const TOPCAP = 14;         // 碰撞盒顶上限

// ---------- 读入并打补丁 ----------
const t0 = Date.now();
const json = JSON.parse(readFileSync(new URL('../../dust2-web/public/assets/map/collision.json', import.meta.url), 'utf-8'));
const matBytes = readFileSync(new URL('../../dust2-web/public/assets/map/penetration-materials.u8', import.meta.url));
const srcMat = new Uint8Array(matBytes.buffer, matBytes.byteOffset, matBytes.byteLength);
const patched = patchMapCollision(json.positions, srcMat);
const SRC = patched.positions, SMAT = patched.materials;
const NT = SRC.length / 9;
console.log(`三角面 ${NT}（B 窗口补丁后），材质 ${SMAT ? SMAT.length : '无'}，载入 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 顶点搬到世界系
const PV = new Float32Array(SRC.length);
for (let i = 0; i < SRC.length; i += 3) { PV[i] = SRC[i] - CX; PV[i + 1] = SRC[i + 1]; PV[i + 2] = -SRC[i + 2] + CZ; }

// ---------- 逐列求垂直线交点（体素化） ----------
const t1 = Date.now();
const cross = new Map();
for (let t = 0; t < NT; t++) {
  const o = t * 9;
  const ax = PV[o], ay = PV[o + 1], az = PV[o + 2];
  const e1x = PV[o + 3] - ax, e1y = PV[o + 4] - ay, e1z = PV[o + 5] - az;
  const e2x = PV[o + 6] - ax, e2y = PV[o + 7] - ay, e2z = PV[o + 8] - az;
  const d00 = e1x * e1x + e1z * e1z, d01 = e1x * e2x + e1z * e2z, d11 = e2x * e2x + e2z * e2z;
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-9) continue;              // 竖直三角形不会被垂直线穿过
  const xa = Math.min(ax, PV[o + 3], PV[o + 6]), xb = Math.max(ax, PV[o + 3], PV[o + 6]);
  const za = Math.min(az, PV[o + 5], PV[o + 8]), zb = Math.max(az, PV[o + 5], PV[o + 8]);
  const i0 = Math.max(0, Math.floor((xa - X0) / CELL)), i1 = Math.min(gw - 1, Math.floor((xb - X0) / CELL));
  const j0 = Math.max(0, Math.floor((za - Z0) / CELL)), j1 = Math.min(gh - 1, Math.floor((zb - Z0) / CELL));
  if (i1 < i0 || j1 < j0) continue;
  for (let j = j0; j <= j1; j++) {
    const pz = Z0 + (j + 0.5) * CELL;
    for (let i = i0; i <= i1; i++) {
      const px = X0 + (i + 0.5) * CELL;
      const d20 = (px - ax) * e1x + (pz - az) * e1z, d21 = (px - ax) * e2x + (pz - az) * e2z;
      const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
      if (v < -1e-6 || w < -1e-6 || v + w > 1 + 1e-6) continue;
      const k = j * gw + i, y = ay + v * e1y + w * e2y;
      // 连同绕序朝向一起记：上表面（往上穿 = 离开实体）记 1，下表面记 -1。
      // 只按奇偶配对会把「薄板 + 单面地板」错配成几米厚的实心块，地面因此凭空升高一层，bot 就卡在悬空地板上。
      // 注意 PV 对 z 做了镜像，绕序随之翻转，所以这里取 -n.y 才是真实朝向。
      const ny = (PV[o + 3] - ax) * (PV[o + 8] - az) - (PV[o + 5] - az) * (PV[o + 6] - ax);
      const up = ny > 0 ? 1 : -1;
      const a = cross.get(k);
      if (a) { a.push(y, up); } else cross.set(k, [y, up]);
    }
  }
}
console.log(`求交命中列 ${cross.size}/${N}，${((Date.now() - t1) / 1000).toFixed(1)}s`);

// 每列材质计数：取三角面重心所在列
const matCnt = new Int32Array(N * 3);
for (let t = 0; t < NT; t++) {
  const o = t * 9;
  const gx = (PV[o] + PV[o + 3] + PV[o + 6]) / 3, gz = (PV[o + 2] + PV[o + 5] + PV[o + 8]) / 3;
  const i = Math.floor((gx - X0) / CELL), j = Math.floor((gz - Z0) / CELL);
  if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
  const m = SMAT ? SMAT[t] : 0;
  if (m <= 2) matCnt[(j * gw + i) * 3 + m]++;
}

// ---------- 每列：区间 -> 地面 / 实心顶 / 顶棚 ----------
const floorTop = new Float32Array(N).fill(NaN);  // 可走地面（绝对 y）
const solidTop = new Float32Array(N);            // 实心体顶（绝对 y）
const colTop = new Float32Array(N);              // 该列最高交点（绝对 y）
const solid = new Uint8Array(N);                 // 该列有实体几何（网格在这里有交点）
const walk = new Uint8Array(N);
const rLo = new Float32Array(N).fill(NaN), rHi = new Float32Array(N);
const colMat = new Uint8Array(N);                // 0 混凝土 1 木 2 金属
let noCross = 0, noUp = 0, loneTop = 0;
for (const [k, flat] of cross) {
  const m = flat.length >> 1;
  const ord = Array.from({ length: m }, (_, i) => i).sort((a, b) => flat[a * 2] - flat[b * 2]);
  // 2cm 内的重合交点并成一张面片（薄板、双层地板、箱壳都靠这个判定）
  const cs = [];
  for (const i of ord) {
    const y = flat[i * 2], up = flat[i * 2 + 1] > 0;
    const last = cs[cs.length - 1];
    if (last && y - last.hi < 0.02) { last.hi = y; last.anyUp = last.anyUp || up; last.anyDn = last.anyDn || !up; }
    else cs.push({ y, hi: y, anyUp: up, anyDn: !up });
  }
  let top = -Infinity;
  for (const i of ord) { const y = flat[i * 2]; if (y > top) top = y; }
  colTop[k] = Math.min(TOPCAP, top);
  solid[k] = 1;
  for (let mm = 0; mm < 3; mm++) if (matCnt[k * 3 + mm] > matCnt[k * 3 + colMat[k]]) colMat[k] = mm;
  // 地面 = 最低的「上表面」。奇偶配对在薄板 + 单面地板的列上会把相位搞错，
  // 于是雨棚下沿被当地面、地面凭空高三米多，导航和物理就对不上了。
  let gi = -1;
  for (let i = 0; i < cs.length; i++) if (cs[i].anyUp) { gi = i; break; }
  if (gi < 0) { if (!cs.length) { noCross++; solid[k] = 0; continue; } noUp++; solidTop[k] = colTop[k]; continue; }
  let G = cs[gi].hi;
  // 地面之上按物体聚簇：与上一个面空隙不到一个身位就算同一块；
  // 只朝上的孤立面（lone top）意味着它下面一直到上一个面都是实的——这正是墙体。
  const cl = [];
  let prev = G;
  for (let i = gi + 1; i < cs.length; i++) {
    const c = cs[i];
    let lo = c.y;
    if (c.anyUp && !c.anyDn) { lo = prev; loneTop++; }
    const last = cl[cl.length - 1];
    if (last && lo - last[1] < HEAD) last[1] = Math.max(last[1], c.hi);
    else cl.push([lo, c.hi]);
    prev = c.hi;
  }
  // 一级台阶（≤ 0.42m）就是地面本身
  while (cl.length && cl[0][0] - G < 0.05 && cl[0][1] - G <= 0.42) { G = cl[0][1]; cl.shift(); }
  // 从地面长起来的更高实体是墙/箱子：这一列站不住人
  if (cl.length && cl[0][0] - G < 0.05 && cl[0][1] - G > 0.42) { solidTop[k] = Math.min(TOPCAP, cl[0][1]); continue; }
  walk[k] = 1;
  floorTop[k] = G;
  let st = G;
  for (const c of cl) {
    if (c[0] - G >= HEAD) { if (Number.isNaN(rLo[k]) || c[0] < rLo[k]) { rLo[k] = c[0]; rHi[k] = c[1]; } }
    else st = Math.max(st, c[1]);
  }
  solidTop[k] = Math.min(TOPCAP, st);
}
for (let k = 0; k < N; k++) if (!cross.has(k)) noCross++;
console.log(`可走列 ${walk.reduce((a, b) => a + b, 0)}，只有下表面的列 ${noUp}，孤立顶面 ${loneTop}，无数据列 ${noCross}`);

// ---------- 以 Valve 导航数据为准：nav 覆盖的地方一定能走 ----------
const navCells = [];
for (const n of MAP.nav) {
  const wx = WX(n.x), wz = WZ(n.z);
  const i = Math.floor((wx - X0) / CELL), j = Math.floor((wz - Z0) / CELL);
  if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
  navCells.push([j * gw + i, n.y, wx, wz]);
}
const navIndex = new Map(MAP.nav.map((n, idx) => [n.id, idx]));
// 挖开半径要大于「引擎贴墙余量 + 半个体素列」，否则 nav 点会被自己身边的墙判死
const NODE_R = 0.8, EDGE_R = 0.62;
let carved = 0, skipped = 0;
const carve = (x, z, r, y) => {
  const i0 = Math.max(0, Math.floor((x - r - X0) / CELL)), i1 = Math.min(gw - 1, Math.floor((x + r - X0) / CELL));
  const j0 = Math.max(0, Math.floor((z - r - Z0) / CELL)), j1 = Math.min(gh - 1, Math.floor((z + r - Z0) / CELL));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const dx = X0 + (i + 0.5) * CELL - x, dz = Z0 + (j + 0.5) * CELL - z;
    if (dx * dx + dz * dz > r * r) continue;
    const k = j * gw + i;
    if (walk[k]) continue;                       // 本来就能走，别动它的掩体高度
    // 顶面远高于导航面的列是真墙/真建筑（导航点不会在墙里），留着；其余是网格缺口或误判，削成地面
    if (solidTop[k] > y + 2.2 && solid[k]) { skipped++; continue; }
    walk[k] = 1; solid[k] = 1; floorTop[k] = y; solidTop[k] = y; carved++;
  }
};
for (const [, y, wx, wz] of navCells) carve(wx, wz, NODE_R, y);
for (const n of MAP.nav) for (const nb of n.neighbors) {
  const m = MAP.nav[navIndex.get(nb)];
  if (!m) continue;
  const x0 = WX(n.x), z0 = WZ(n.z), x1 = WX(m.x), z1 = WZ(m.z);
  const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (EDGE_R * 0.7));
  for (let s = 0; s <= steps; s++) {
    const t = steps ? s / steps : 0;
    carve(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, EDGE_R, n.y + (m.y - n.y) * t);
  }
}
console.log(`按真实导航补成可走 ${carved} 列，跳过真墙 ${skipped}`);

// ---------- 真实导航没覆盖的空地填成实心 ----------
// 导航网格覆盖全部可玩地面，离任何 nav 点/边都远的「可走列」一定是建筑内部、屋顶、边界外。
const NEAR_R = 2.4;
const navNear = new Uint8Array(N);
const stamp = (x, z, r) => {
  const i0 = Math.max(0, Math.floor((x - r - X0) / CELL)), i1 = Math.min(gw - 1, Math.floor((x + r - X0) / CELL));
  const j0 = Math.max(0, Math.floor((z - r - Z0) / CELL)), j1 = Math.min(gh - 1, Math.floor((z + r - Z0) / CELL));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const dx = X0 + (i + 0.5) * CELL - x, dz = Z0 + (j + 0.5) * CELL - z;
    if (dx * dx + dz * dz <= r * r) navNear[j * gw + i] = 1;
  }
};
for (const [, , wx, wz] of navCells) stamp(wx, wz, NEAR_R);
for (const n of MAP.nav) for (const nb of n.neighbors) {
  const m = MAP.nav[navIndex.get(nb)];
  if (!m) continue;
  const x0 = WX(n.x), z0 = WZ(n.z), x1 = WX(m.x), z1 = WZ(m.z);
  const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (NEAR_R * 0.6));
  for (let s = 0; s <= steps; s++) {
    const t = steps ? s / steps : 0;
    stamp(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, NEAR_R);
  }
}
let filled = 0;
for (let k = 0; k < N; k++) {
  if (!walk[k] || navNear[k]) continue;
  if (solidTop[k] > floorTop[k] + 0.4) continue;      // 上面有掩体，保留地形
  walk[k] = 0; solidTop[k] = colTop[k] > floorTop[k] ? colTop[k] : floorTop[k] + 1.2; filled++;
}
console.log(`离真实导航 >${NEAR_R}m 的空地填成实心 ${filled} 列`);

// （台阶不做抹平：真实高差交给导航场的「上阶 ≤ step、下落 ≤ 3m」判定，见 physics.js NavGrid）


// ---------- 合并碰撞盒（按顶高分组，同高 ±0.2 可并） ----------
function mergeRects(flag, value, tol) {
  const used = new Uint8Array(N);
  const out = [];
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const k = j * gw + i;
    if (used[k] || !flag(k)) continue;
    const v0 = value(k);
    let i1 = i;
    while (i1 + 1 < gw) { const q = k + (i1 + 1 - i); if (used[q] || !flag(q) || Math.abs(value(q) - v0) > tol) break; i1++; }
    let j1 = j;
    outer: while (j1 + 1 < gh) {
      for (let x = i; x <= i1; x++) { const q = (j1 + 1) * gw + x; if (used[q] || !flag(q) || Math.abs(value(q) - v0) > tol) break outer; }
      j1++;
    }
    let hi = -Infinity, m0 = 0, m1 = 0, m2 = 0;
    for (let y = j; y <= j1; y++) for (let x = i; x <= i1; x++) {
      const q = y * gw + x;
      used[q] = 1;
      const v = value(q);
      if (v > hi) hi = v;
      m0 += matCnt[q * 3]; m1 += matCnt[q * 3 + 1]; m2 += matCnt[q * 3 + 2];
    }
    out.push({
      x: X0 + (i + i1 + 1) * CELL / 2, z: Z0 + (j + j1 + 1) * CELL / 2,
      w: (i1 - i + 1) * CELL, d: (j1 - j + 1) * CELL, hi,
      mat: m2 >= m0 && m2 >= m1 ? 2 : m1 >= m0 ? 1 : 0,
      n: (i1 - i + 1) * (j1 - j + 1),
    });
  }
  return out;
}
const boxes = mergeRects((k) => solid[k] && solidTop[k] > BASE + 0.5, (k) => solidTop[k], 0.2)
  .filter((b) => b.w * b.d > 0.04);
// 顶棚单独合并（量化到底高，厚度固定 0.4m）
const hasRoof = (k) => !Number.isNaN(rLo[k]);
const roofs = mergeRects(hasRoof, (k) => Math.round(rLo[k] / 0.4) * 0.4, 0.05).filter((b) => b.w * b.d >= 0.5);
console.log(`碰撞盒 ${boxes.length}，顶棚 ${roofs.length}`);

// ---------- 导航高度场 ----------
// 面积取体素可走列（且离真实导航够近），海拔优先取 Valve 导航节点/边的海拔，
// 连通性则以 Valve 导航图为准：边线经过的方向一定通，其余方向要求「上阶不高于一步」且
// 「两格之间没有实体列」。自己从 0.25m 体素采样推连通性会把贴墙的真实台阶判成断崖。
const NC = 0.6, NX0 = -52.5, NZ0 = -56.5, NX1 = 52.5, NZ1 = 56.3;
const nw = Math.round((NX1 - NX0) / NC), nh = Math.round((NZ1 - NZ0) / NC);
const cellOfN = (x, z) => {
  const i = Math.floor((x - NX0) / NC), j = Math.floor((z - NZ0) / NC);
  if (i < 0 || j < 0 || i >= nw || j >= nh) return -1;
  return j * nw + i;
};
const colAt = (x, z) => {
  const i = Math.floor((x - X0) / CELL), j = Math.floor((z - Z0) / CELL);
  if (i < 0 || j < 0 || i >= gw || j >= gh) return -1;
  return j * gw + i;
};
const bestRank = new Float32Array(nw * nh).fill(999), bestY = new Float32Array(nw * nh);
// 每格取「最近的导航采样」而不是取平均：台阶上下两侧的海拔一平均就会抹平 0.3m 的高差，
// 那正是区分楼梯和断崖所需要的信息。节点比边插值点更可信，所以给它更小的排名。
const R = 1.1;
const vote = (x, z, y, node) => {
  const i0 = Math.max(0, Math.floor((x - R - NX0) / NC)), i1 = Math.min(nw - 1, Math.floor((x + R - NX0) / NC));
  const j0 = Math.max(0, Math.floor((z - R - NZ0) / NC)), j1 = Math.min(nh - 1, Math.floor((z + R - NZ0) / NC));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const cx = NX0 + (i + 0.5) * NC, cz = NZ0 + (j + 0.5) * NC;
    const d = Math.hypot(cx - x, cz - z);
    if (d > R) continue;
    const k = j * nw + i, rank = d + (node ? 0 : 0.4);
    if (rank < bestRank[k]) { bestRank[k] = rank; bestY[k] = y; }
  }
};
const edgeBit = new Uint8Array(nw * nh);       // Valve 导航边直接认定的可通行方向
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const linkBit = (k, di, dj) => {
  if (k < 0) return;
  if (di > 0) edgeBit[k] |= 1; else if (di < 0) edgeBit[k] |= 4;
  if (dj > 0) edgeBit[k] |= 2; else if (dj < 0) edgeBit[k] |= 8;
};
const walkEdge = (n, m) => {
  const x0 = WX(n.x), z0 = WZ(n.z), x1 = WX(m.x), z1 = WZ(m.z);
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.25));
  let pk = cellOfN(x0, z0);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    if (s < steps) vote(x, z, n.y + (m.y - n.y) * t, false);
    const k = cellOfN(x, z);
    if (k >= 0 && pk >= 0 && k !== pk) {
      const di = (k % nw) - (pk % nw), dj = ((k / nw) | 0) - ((pk / nw) | 0);
      linkBit(pk, Math.sign(di), Math.sign(dj));
      linkBit(k, -Math.sign(di), -Math.sign(dj));
    }
    if (k >= 0) pk = k;
  }
};
for (const n of MAP.nav) vote(WX(n.x), WZ(n.z), n.y, true);
for (const n of MAP.nav) for (const nb of n.neighbors) {
  const m = MAP.nav[navIndex.get(nb)];
  if (m) walkEdge(n, m);
}
const STEP = 0.42, MAX_FALL = 3;
const field = new Int16Array(nw * nh).fill(32767);
const link = new Uint8Array(nw * nh);
let fromVoxel = 0, fromNav = 0, heightDiff = 0, heightMax = 0;
for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) {
  const k = j * nw + i, cx = NX0 + (i + 0.5) * NC, cz = NZ0 + (j + 0.5) * NC;
  // 海拔以体素地面为准：物理碰撞盒就是用它刷的，导航若采用 Valve 的海拔就会和物理不一致
  // （1.1m 投票半径内常混进上一层的节点，bot 会「按导航走出悬崖」掉下去再也爬不上来）。
  // Valve 海拔只在体素没封闭的地方兜底——那些列本来就由 carve() 按导航海拔补成地面。
  const q = colAt(cx, cz);
  let y = NaN;
  if (q >= 0 && walk[q] && !Number.isNaN(floorTop[q])) {
    y = floorTop[q];
    fromVoxel++;
    if (bestRank[k] < 999) {
      const d = Math.abs(bestY[k] - y);
      if (d > 0.42) heightDiff++;
      if (d > heightMax) heightMax = d;
    }
  } else if (bestRank[k] < 999) { y = bestY[k]; fromNav++; }
  else continue;
  field[k] = Math.round(y * 100);
}
// 两格中心之间是否立着实体列（不可走且明显高出地面）
const wallBetween = (ax, az, bx, bz, gy) => {
  for (const t of [0.34, 0.66]) {
    const q = colAt(ax + (bx - ax) * t, az + (bz - az) * t);
    if (q < 0) return true;
    if (walk[q]) continue;
    if (solidTop[q] > gy + 0.5) return true;
  }
  return false;
};
for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) {
  const k = j * nw + i;
  if (field[k] === 32767) continue;
  const cx = NX0 + (i + 0.5) * NC, cz = NZ0 + (j + 0.5) * NC, y0 = field[k] / 100;
  for (let d = 0; d < 4; d++) {
    const ni = i + DIRS[d][0], nj = j + DIRS[d][1];
    if (ni < 0 || nj < 0 || ni >= nw || nj >= nh) continue;
    const nk = nj * nw + ni;
    if (field[nk] === 32767) continue;
    if (edgeBit[k] & (1 << d)) { link[k] |= 1 << d; continue; }
    const dh = field[nk] - y0 * 100;
    if (dh > STEP * 100 || dh < -MAX_FALL * 100) continue;
    if (wallBetween(cx, cz, NX0 + (ni + 0.5) * NC, NZ0 + (nj + 0.5) * NC, Math.min(y0, field[nk] / 100))) continue;
    link[k] |= 1 << d;
  }
}
// 死坑剪枝：可走格若四个方向都出不去（只能跳进来），bot 走进去就永远卡死。
// 反复剪到不动点：剪掉一格可能让邻格也变成出不去的坑。真实 dust2 的房间总有出口，不会因此丢地面。
let pits = 0;
{
  const back = [4, 8, 1, 2];
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < field.length; k++) {
      if (field[k] === 32767 || !link[k]) continue;
      const ki = k % nw, kj = (k / nw) | 0;
      let out = false;
      for (let d = 0; d < 4 && !out; d++) {
        if (!(link[k] & (1 << d))) continue;
        const ni = ki + DIRS[d][0], nj = kj + DIRS[d][1];
        if (ni < 0 || nj < 0 || ni >= nw || nj >= nh) continue;
        const nk = nj * nw + ni;
        // 只能靠「跳下去」离开的格子等于自杀，除非对面也能爬回来
        if (field[nk] === 32767 || (link[nk] & back[d]) === 0) continue;
        out = true;
      }
      if (!out) { field[k] = 32767; link[k] = 0; pits++; changed = true; }
    }
  }
}
// 只保留与真实导航连通的那部分地面：体素补面里难免有墙背面、屋顶、室内角落，
// 它们自成一个小连通块，bot 走进去就出不来，宁可判成不可走。
{
  const seen = new Uint8Array(nw * nh), stack = [];
  for (let k = 0; k < field.length; k++) if (bestRank[k] < 999 && field[k] !== 32767) { seen[k] = 1; stack.push(k); }
  const back = [4, 8, 1, 2];
  while (stack.length) {
    const k = stack.pop(), ki = k % nw, kj = (k / nw) | 0;
    for (let d = 0; d < 4; d++) {
      const ni = ki + DIRS[d][0], nj = kj + DIRS[d][1];
      if (ni < 0 || nj < 0 || ni >= nw || nj >= nh) continue;
      const nk = nj * nw + ni;
      if (field[nk] === 32767 || seen[nk]) continue;
      if (!(link[k] & (1 << d)) && !(link[nk] & back[d])) continue;
      seen[nk] = 1; stack.push(nk);
    }
  }
  let cut = 0;
  for (let k = 0; k < field.length; k++) if (field[k] !== 32767 && !seen[k]) { field[k] = 32767; link[k] = 0; cut++; }
  console.log(`砍掉与导航不连通的补面格 ${cut}`);
}
let free = 0, isolated = 0;
for (let k = 0; k < field.length; k++) if (field[k] !== 32767) { free++; if (!link[k]) isolated++; }
console.log(`导航场 ${nw}x${nh}，可走格 ${free}（体素地面 ${fromVoxel} / 导航补面 ${fromNav}），剪掉死坑 ${pits}，四方向都不通的孤格 ${isolated}`);
console.log(`体素地面 vs Valve 海拔：差 >${STEP}m 的格 ${heightDiff}，最大高差 ${heightMax.toFixed(2)}m`);

const sample = (x, z) => {
  const k = cellOfN(x, z);
  if (k < 0) return NaN;
  const v = field[k];
  return v === 32767 ? NaN : v / 100;
};
let upBig = 0, dnBig = 0, edges = 0, maxUp = 0, missNode = 0;
const errs = [];
const hist = {};
for (const n of MAP.nav) {
  const y = sample(WX(n.x), WZ(n.z));
  if (Number.isNaN(y)) { missNode++; continue; }
  errs.push(Math.abs(y - n.y));
  for (const nb of n.neighbors) {
    const m = MAP.nav[navIndex.get(nb)];
    if (!m) continue;
    const a = sample(WX(n.x), WZ(n.z)), b = sample(WX(m.x), WZ(m.z));
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    edges++;
    const d = b - a;
    hist[Math.round(Math.abs(d) * 10) / 10] = (hist[Math.round(Math.abs(d) * 10) / 10] || 0) + 1;
    if (d > 0.42) upBig++;
    if (d < -1.2) dnBig++;
    if (d > maxUp) maxUp = d;
  }
}
errs.sort((a, b) => a - b);
const pct = (q) => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(errs.length * q))] : NaN).toFixed(2);
console.log(`导航边 ${edges} 条：上阶 >0.42m 的 ${upBig}（官方台阶/坡道，由边线放行），下落 >1.2m 的 ${dnBig}，最大上阶 ${maxUp.toFixed(2)}m`);
console.log(`导航节点落格缺失 ${missNode}，场高 vs Valve 海拔偏差：中位 ${pct(0.5)}m，90% ${pct(0.9)}m，最大 ${pct(1)}m`);
console.log('  高差分布', JSON.stringify(hist));

// ---------- 俯视占位图 ----------
if (PLOT) {
  for (let j = gh - 1; j >= 0; j -= 2) {
    let line = Math.round(Z0 + j * CELL).toString().padStart(5) + ' ';
    for (let i = 0; i < gw; i += 2) {
      const k = j * gw + i;
      line += !cross.has(k) ? ' ' : walk[k] ? (solidTop[k] - floorTop[k] > 0.5 ? '+' : '.') : (solidTop[k] > 2 ? '#' : ':');
    }
    console.log(line);
  }
  console.log('#墙 +掩体 .地面 :矮块');
}

// ---------- 真实三角网格：量化 + 焊接 ----------
const vg = new Map();
const verts = [];
const idx = new Uint32Array(NT * 3);
let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let t = 0; t < NT; t++) {
  const o = t * 9;
  // 镜像 z 之后翻转绕序：顺序取 (0,2,1)
  for (let vi = 0; vi < 3; vi++) {
    const s = o + [0, 2, 1][vi] * 3;
    const x = PV[s], y = PV[s + 1], z = PV[s + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    const key = `${Math.round(x * 500)},${Math.round(y * 500)},${Math.round(z * 500)}`;
    let id = vg.get(key);
    if (id === undefined) { id = verts.length / 3; vg.set(key, id); verts.push(x, y, z); }
    idx[t * 3 + vi] = id;
  }
}
const nv = verts.length / 3;
const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2, oz = (minZ + maxZ) / 2;
const sx = Math.max(0.0016, (maxX - minX) / 2 / 32767), sy = Math.max(0.0016, (maxY - minY) / 2 / 32767), sz = Math.max(0.0016, (maxZ - minZ) / 2 / 32767);
const iq = new Int16Array(nv * 3);
for (let i = 0; i < nv; i++) {
  iq[i * 3] = Math.round((verts[i * 3] - ox) / sx);
  iq[i * 3 + 1] = Math.round((verts[i * 3 + 1] - oy) / sy);
  iq[i * 3 + 2] = Math.round((verts[i * 3 + 2] - oz) / sz);
}
const mt = new Uint8Array(NT);
for (let t = 0; t < NT; t++) mt[t] = SMAT ? Math.min(2, SMAT[t]) : 0;
console.log(`网格顶点 ${nv}（焊接 @2mm），量化步长 x${(sx * 1000).toFixed(2)} y${(sy * 1000).toFixed(2)} z${(sz * 1000).toFixed(2)}mm`);

// ---------- 打包 ----------
const pad4 = (n) => (n + 3) & ~3;                 // typed array 视图要求 4 字节对齐
const gzB64 = (buf) => zlib.gzipSync(buf, { level: 9 }).toString('base64');
const geoVerts = Buffer.from(iq.buffer);
const geoIdx = Buffer.from(idx.buffer);
const geoMat = Buffer.from(mt.buffer);
const oV = 0, oI = pad4(geoVerts.length), oM = oI + geoIdx.length;
const geoBuf = Buffer.alloc(oM + geoMat.length);
geoVerts.copy(geoBuf, oV); geoIdx.copy(geoBuf, oI); geoMat.copy(geoBuf, oM);
const geoBlob = gzB64(geoBuf);

// 碰撞盒：[x, z, w, d, y0, y1, mat]，坐标 int16 cm
const sb = [];
for (const b of boxes) sb.push(Math.round(b.x * 100), Math.round(b.z * 100), Math.round(b.w * 100), Math.round(b.d * 100), Math.round(BASE * 100), Math.round(b.hi * 100), b.mat);
const solBlob = gzB64(Buffer.from(Int16Array.from(sb).buffer));
const rb = [];
for (const b of roofs) rb.push(Math.round(b.x * 100), Math.round(b.z * 100), Math.round(b.w * 100), Math.round(b.d * 100), Math.round((b.hi - 0.4) * 100), Math.round(b.hi * 100), 0);
const roofBlob = gzB64(Buffer.from(Int16Array.from(rb).buffer));
const navBlob = gzB64(Buffer.from(field.buffer));
const linkBlob = gzB64(Buffer.from(link.buffer));

const r2 = (v) => +v.toFixed(2);
let out = `// de_dust2 运行时数据 —— 由 tools/dust2-geo.mjs 从 dust2-web 的真实 CS2 地图数据生成，勿手改。\n`;
out += `// 输入：collision.json（${NT} 个三角面，米制）+ penetration-materials.u8（每面 1 字节材质）+ map-data.js 的 Valve 导航/出生点。\n`;
out += `// 世界系：+X 东，+Z 北，Y 向上，地图居中于原点；z 相对 Source 数据做了镜像，因此三角面绕序已翻转补回。\n`;
out += `// 数据块都是 gzip 后的 base64，用 src/maps/blob.js 解压。\n`;
out += `export const GEO_META = {\n`;
out += `  cell: ${CELL}, nVerts: ${nv}, nTris: ${NT},\n`;
out += `  // 解压后字节布局：int16 顶点 [0,${oI})，uint32 索引 [${oI},${oM})，uint8 每面材质 [${oM},${oM + geoMat.length})\n`;
out += `  off: { verts: ${oV}, idx: ${oI}, mat: ${oM} },\n`;
out += `  origin: [${(+ox).toFixed(4)}, ${(+oy).toFixed(4)}, ${(+oz).toFixed(4)}],\n`;
out += `  scale: [${sx.toExponential(4)}, ${sy.toExponential(4)}, ${sz.toExponential(4)}],\n`;
out += `  bounds: { x: [${r2(minX)}, ${r2(maxX)}], y: [${r2(minY)}, ${r2(maxY)}], z: [${r2(minZ)}, ${r2(maxZ)}] },\n`;
out += `};\n`;
out += `export const GEO_BLOB = '${geoBlob}';\n`;
out += `// 碰撞盒 [x,z,w,d,y0,y1,mat]（cm，int16）；mat 0 混凝土 1 木 2 金属\n`;
out += `export const SOL_META = { count: ${boxes.length}, base: ${r2(BASE)}, roofCount: ${roofs.length} };\n`;
out += `export const SOL_BLOB = '${solBlob}';\n`;
out += `export const ROOF_BLOB = '${roofBlob}';\n`;
out += `// 导航高度场：每个 nav 格的地面 y（cm，int16），32767 = 不可走\n`;
out += `export const NAV_META = { x0: ${NX0}, z0: ${NZ0}, cell: ${NC}, w: ${nw}, h: ${nh}, blocked: 32767, step: ${STEP} };\n`;
out += `export const NAV_BLOB = '${navBlob}';\n`;
out += `// 每格的方向可通行位掩码：bit0 +X，bit1 +Z，bit2 -X，bit3 -Z（沿体素列按一步高走一遍得出）\n`;
out += `export const LINK_BLOB = '${linkBlob}';\n`;
out += `// Valve 官方点位（已换到世界系），y 是导航节点自带的海拔\n`;
out += `export const MESH_SPAWNS = {\n  T: [\n`;
for (const s of MAP.spawns.T) out += `    { x: ${r2(WX(s.x))}, z: ${r2(WZ(s.z))}, y: ${r2(s.y)} },\n`;
out += `  ],\n  CT: [\n`;
for (const s of MAP.spawns.CT) out += `    { x: ${r2(WX(s.x))}, z: ${r2(WZ(s.z))}, y: ${r2(s.y)} },\n`;
out += `  ],\n};\n`;
out += `export const MESH_SITES = {\n`;
for (const key of Object.keys(MAP.sites)) out += `  ${key}: { x: ${r2(WX(MAP.sites[key].x))}, z: ${r2(WZ(MAP.sites[key].z))}, r: ${MAP.sites[key].radius} },\n`;
out += `};\n`;
out += `export const MESH_LABELS = [\n`;
for (const l of MAP.labels) out += `  { text: '${l.text}', x: ${r2(WX(l.x))}, z: ${r2(WZ(l.z))} },\n`;
out += `];\n`;
out += `// 真实导航点 [x, z]（世界系），bot 落点与离线校验用\n`;
out += `export const NAV_NODES = [\n`;
for (const n of MAP.nav) out += `  [${r2(WX(n.x))}, ${r2(WZ(n.z))}],\n`;
out += `];\n`;
// 导航边（下标对，i<j）：离线校验「两个真实导航点之间我们能不能走」
{
  const seenE = new Set(), edges = [];
  for (let i = 0; i < MAP.nav.length; i++) for (const nb of MAP.nav[i].neighbors) {
    const j = navIndex.get(nb);
    if (j === undefined || j <= i) continue;
    const key = i * 4096 + j;
    if (seenE.has(key)) continue;
    seenE.add(key); edges.push(`[${i},${j}]`);
  }
  out += `// 真实导航边的节点下标对 [i, j]，离线拓扑校验用（${edges.length} 条）\n`;
  out += `export const NAV_EDGES = [${edges.join(',')}];\n`;
  console.log(`导航边 ${edges.length} 条`);
}
writeFileSync(new URL('../src/maps/dust2-geo.js', import.meta.url), out);
console.log(`written src/maps/dust2-geo.js（${(out.length / 1024 / 1024).toFixed(2)} MB）`);
console.log(`  GEO ${(geoBlob.length / 1024 / 1024).toFixed(2)} MB  SOL ${(solBlob.length / 1024).toFixed(0)} KB  ROOF ${(roofBlob.length / 1024).toFixed(0)} KB  NAV ${(navBlob.length / 1024).toFixed(0)} KB`);
console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
