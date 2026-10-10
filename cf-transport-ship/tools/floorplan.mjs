// 离线校验真实地图数据：导航场可达性、Valve 官方导航图一致性、关键视线，并输出俯视图
// 用法：node tools/floorplan.mjs [dust2] [--scale=8] [--out=dist/floorplan-dust2.png]
// 走的是运行时同一条解码路径（src/maps/geo.js），所以脚本通过就等于游戏里的地图通过。
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { World, NavGrid } from '../src/physics.js';
import { decodeGeo, navField, makeSampler, addColliders, buildSpawns } from '../src/maps/geo.js';
import { MESH_SPAWNS, NAV_NODES, NAV_EDGES } from '../src/maps/dust2-geo.js';

const arg = (name, dft) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dft;
const SCALE = Number(arg('scale', 8));

const id = process.argv[2] || 'dust2';
if (id !== 'dust2') { console.error(`${id} 还没有真实数据块，floorplan 目前只校验 dust2`); process.exit(2); }
const { LAYOUT } = await import(`../src/maps/${id}-layout.js`);

// ---------- 装配：与 game.js 完全一致 ----------
const G = await decodeGeo();
const S = makeSampler(G);
const world = new World();
addColliders(world, G, LAYOUT.bounds, S);
const n = LAYOUT.nav;
const nav = new NavGrid(world, n.x0, n.z0, n.x1, n.z1, n.cell, n.r, navField(G));
const yaw = LAYOUT.spawnYaw;
const spawns = { BL: buildSpawns(MESH_SPAWNS.T, 10, yaw.BL, S), GR: buildSpawns(MESH_SPAWNS.CT, 10, yaw.GR, S) };

const fail = [];
const nFloor = world.colliders.filter((c) => c.tag === 'floor').length;
const nSolid = world.colliders.filter((c) => c.tag === 'solid').length;
const nRoof = world.colliders.filter((c) => c.tag === 'roof').length;
console.log(`${id}: 碰撞体 ${world.colliders.length}（地面 ${nFloor} / 实体 ${nSolid} / 顶棚 ${nRoof}），nav ${nav.w}x${nav.h} @${nav.cell}m`);

// ---------- 掩体占用图（只给俯视图着色用）----------
const wall = new Uint8Array(nav.w * nav.h);
for (const c of world.colliders) {
  if (c.tag !== 'solid') continue;
  const rise = c.top - S.groundAt(c.x, c.z);
  if (rise < 0.36) continue;
  const lvl = rise > 2 ? 2 : 1;
  const i0 = Math.floor((c.minX - nav.x0) / nav.cell), i1 = Math.floor((c.maxX - nav.x0) / nav.cell);
  const j0 = Math.floor((c.minZ - nav.z0) / nav.cell), j1 = Math.floor((c.maxZ - nav.z0) / nav.cell);
  for (let j = Math.max(0, j0); j <= Math.min(nav.h - 1, j1); j++) {
    for (let i = Math.max(0, i0); i <= Math.min(nav.w - 1, i1); i++) {
      const k = j * nav.w + i;
      if (nav.block[k]) continue;
      if (wall[k] < lvl) wall[k] = lvl;
    }
  }
}

function pathLen(p) {
  if (!p || p.length < 2) return p ? 0 : -1;
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return s;
}

// ---------- 洪泛可达性：必须沿 link 掩码扩展，否则会把断崖当成台阶 ----------
function flood(startK, out) {
  if (startK < 0 || nav.block[startK]) return out;
  const W = nav.w, stack = [startK];
  out[startK] = 1;
  while (stack.length) {
    const k = stack.pop();
    const ki = k % W, kj = (k / W) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ki + di, nj = kj + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= nav.h) continue;
      const nk = nj * W + ni;
      if (nav.block[nk] || out[nk]) continue;
      if (di && dj && (nav.block[kj * W + ni] || nav.block[nj * W + ki])) continue;
      if (!nav.linkOk(k, di, dj)) continue;
      out[nk] = 1; stack.push(nk);
    }
  }
  return out;
}
const sets = {};
for (const team of ['BL', 'GR']) {
  const u = new Uint8Array(nav.w * nav.h);
  for (const sp of spawns[team]) flood(nav.idx(sp.x, sp.z), u);
  sets[team] = u;
}
const reachAll = new Uint8Array(nav.w * nav.h);
for (let k = 0; k < reachAll.length; k++) reachAll[k] = sets.BL[k] | sets.GR[k];

// ---------- 关键点位 ----------
const anchors = LAYOUT.checks.anchors;
if (!anchors) { console.error(`${id} 布局缺少 checks.anchors，无法校验关键点位`); process.exit(2); }
for (const [name, a] of Object.entries(anchors)) {
  const k = nav.idx(a.x, a.z);
  if (k < 0) { fail.push(`${name}: 网格越界`); continue; }
  if (nav.block[k]) {
    const f = nav.nearestFree(k);
    if (f < 0) { fail.push(`${name} (${a.x},${a.z}): 不可走且附近无可走格`); continue; }
    const [fx, fz] = nav.center(f);
    const d = Math.hypot(fx - a.x, fz - a.z);
    if (d > 1.2) { fail.push(`${name} (${a.x},${a.z}): 不可走，最近可走格 ${d.toFixed(1)}m 外`); continue; }
    console.log(`  ${name.padEnd(18)} 贴墙，吸附 ${d.toFixed(1)}m → (${fx.toFixed(1)},${fz.toFixed(1)})`);
    a.x = fx; a.z = fz;
  }
  // 吸附之后点位已经挪了，可达性要按新的格子判，否则「贴墙但旁边就是通路」的点会被报成死点
  const kk = nav.idx(a.x, a.z);
  const team = sets.BL[kk] ? 'BL' : sets.GR[kk] ? 'GR' : null;
  if (!team) { fail.push(`${name} (${a.x},${a.z}): 两队都到不了`); continue; }
  if (name.startsWith('spawn.')) continue;
  const dB = pathLen(nav.findPath(spawns.BL[0].x, spawns.BL[0].z, a.x, a.z, spawns.BL[0].y));
  const dG = pathLen(nav.findPath(spawns.GR[0].x, spawns.GR[0].z, a.x, a.z, spawns.GR[0].y));
  if (dB < 0 && dG < 0) { fail.push(`${name}: 寻路不通`); continue; }
  console.log(`  ${name.padEnd(18)} 潜伏 ${dB < 0 ? '不可达' : dB.toFixed(1) + 'm'} / 保卫 ${dG < 0 ? '不可达' : dG.toFixed(1) + 'm'} 地面 ${nav.groundAt(a.x, a.z).toFixed(2)}m`);
}

// ---------- 出生点 ----------
for (const team of ['BL', 'GR']) {
  const other = team === 'BL' ? 'GR' : 'BL';
  for (const s of spawns[team]) {
    const k = nav.idx(s.x, s.z);
    if (k < 0 || nav.block[k]) { fail.push(`spawn ${team} (${s.x},${s.z}) 不可走`); continue; }
    if (!sets[team][k]) fail.push(`spawn ${team} (${s.x},${s.z}) 不在本队洪泛区`);
    if (!sets[other][k]) fail.push(`spawn ${team} (${s.x},${s.z}) 对方进不来（正常应互通）`);
  }
}
// 导航场海拔 vs Valve 官方出生点海拔
for (const [team, list] of Object.entries({ BL: MESH_SPAWNS.T, GR: MESH_SPAWNS.CT })) {
  let sum = 0, max = 0, cnt = 0;
  for (const p of list) {
    const k = nav.idx(p.x, p.z);
    if (k < 0 || nav.block[k]) continue;
    const d = Math.abs(nav.ground[k] - p.y);
    sum += d; cnt++; if (d > max) max = d;
  }
  console.log(`  ${team} 出生点海拔偏差：均值 ${(sum / cnt).toFixed(2)}m，最大 ${max.toFixed(2)}m`);
  if (max > 1.2) fail.push(`${team} 出生点海拔偏差 ${max.toFixed(2)}m > 1.2m`);
}

// ---------- 可达覆盖率：单向区块（能跳下来爬不回去）与真孤立区块要分开看 ----------
let free = 0, reach = 0;
for (let k = 0; k < nav.block.length; k++) if (!nav.block[k]) { free++; if (reachAll[k]) reach++; }
console.log(`  可走格 ${reach}/${free}（${(100 * reach / free).toFixed(1)}% 双向可达）`);
// 无向连通分量：链接是有方向的（上阶受限、下落不限），所以「到不了」不等于「孤立」
const compId = new Int32Array(nav.w * nav.h).fill(-1);
const compSize = [];
const undirected = (k, di, dj) => {
  const ni = (k % nav.w) + di, nj = (((k / nav.w) | 0) + dj);
  if (ni < 0 || nj < 0 || ni >= nav.w || nj >= nav.h) return -1;
  const nk = nj * nav.w + ni;
  if (nav.block[nk]) return -1;
  const bit = di > 0 ? 1 : di < 0 ? 4 : dj > 0 ? 2 : 8;
  const back = di > 0 ? 4 : di < 0 ? 1 : dj > 0 ? 8 : 2;
  if ((nav.link[k] & bit) || (nav.link[nk] & back)) return nk;
  return -1;
};
if (free !== reach) {
  for (let s = 0; s < nav.block.length; s++) {
    if (nav.block[s] || compId[s] >= 0) continue;
    const id = compSize.length, stack = [s];
    compId[s] = id; let cnt = 0, touched = false;
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    while (stack.length) {
      const k = stack.pop(); cnt++;
      if (reachAll[k]) touched = true;
      const [cx, cz] = nav.center(k);
      minx = Math.min(minx, cx); maxx = Math.max(maxx, cx);
      minz = Math.min(minz, cz); maxz = Math.max(maxz, cz);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = undirected(k, di, dj);
        if (nk >= 0 && compId[nk] < 0) { compId[nk] = id; stack.push(nk); }
      }
    }
    compSize.push({ cnt, touched, box: [minx, maxx, minz, maxz] });
  }
  // 孤立区：被真实碰撞体封死的小块（门板、栏杆后面）是正常的，只统计面积；
  // 成片的孤立区才说明导航场或碰撞体算错了
  let orphan = 0;
  const big = [];
  for (const c of compSize) {
    if (c.touched) continue;
    orphan += c.cnt;
    if (c.cnt >= 60) big.push(c);
  }
  console.log(`  孤立区 ${orphan} 格（${(100 * orphan / free).toFixed(1)}% 可走面积，被实体封死的小块）`);
  for (const c of big) fail.push(`大孤立区 ${c.cnt} 格 x[${c.box[0].toFixed(1)},${c.box[1].toFixed(1)}] z[${c.box[2].toFixed(1)},${c.box[3].toFixed(1)}]`);
  // 与出生点同处一个无向分量、却有去无回的区域
  const seedComp = compId[nav.idx(spawns.BL[0].x, spawns.BL[0].z)];
  let oneWay = 0, oneWayBox = null;
  for (let k = 0; k < nav.block.length; k++) {
    if (nav.block[k] || reachAll[k] || compId[k] !== seedComp) continue;
    oneWay++;
    const [cx, cz] = nav.center(k);
    oneWayBox = oneWayBox
      ? [Math.min(oneWayBox[0], cx), Math.max(oneWayBox[1], cx), Math.min(oneWayBox[2], cz), Math.max(oneWayBox[3], cz)]
      : [cx, cx, cz, cz];
  }
  if (oneWay) console.log(`  单向区 ${oneWay} 格（能跳下去、爬不回来）x[${oneWayBox[0].toFixed(1)},${oneWayBox[1].toFixed(1)}] z[${oneWayBox[2].toFixed(1)},${oneWayBox[3].toFixed(1)}]`);
  if (oneWay > free * 0.02) fail.push(`单向区 ${oneWay} 格超过可走面积 2%`);
}

// ---------- 与 Valve 官方导航图对照 ----------
// 高度场是自己按 0.42m 台阶上限重算的，与官方连通性允许有小比例差异；超过阈值说明体素或场高算错了
{
  // 用真实三角网格沿竖直方向采样：官方导航图是贴着几何做的，门洞下沿、雨棚底面、台阶立面上都可能有 nav 点。
  // 那种点在任何体素化碰撞里都站不住人，算不得生成错误；只有「真实几何明明能站人却找不到可走格」才要拦。
  const M = G.geoMeta, [ox, oy, oz] = M.origin, [qx, qy, qz] = M.scale;
  const tri = new Float32Array(M.nTris * 9);
  for (let t = 0; t < M.nTris; t++) for (let v = 0; v < 3; v++) {
    const p = G.idx[t * 3 + v] * 3;
    tri[t * 9 + v * 3] = ox + G.verts[p] * qx;
    tri[t * 9 + v * 3 + 1] = oy + G.verts[p + 1] * qy;
    tri[t * 9 + v * 3 + 2] = oz + G.verts[p + 2] * qz;
  }
  const standable = (x, z, gy) => {
    let ground = NaN, ceil = Infinity;
    const cs = [];
    for (let t = 0; t < M.nTris; t++) {
      const o = t * 9;
      const ax = tri[o], az = tri[o + 2], bx = tri[o + 3], bz = tri[o + 5], vx = tri[o + 6], vz = tri[o + 8];
      const d1 = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      const d2 = (vx - bx) * (z - bz) - (vz - bz) * (x - bx);
      const d3 = (ax - vx) * (z - vz) - (az - vz) * (x - vx);
      if (!((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0))) continue;
      const sum = d1 + d2 + d3;
      if (Math.abs(sum) < 1e-9) continue;
      const y = (d2 * tri[o + 1] + d3 * tri[o + 4] + d1 * tri[o + 7]) / sum;
      if (y < gy - 0.25 || y > gy + 8) continue;
      cs.push(y);
    }
    cs.sort((a, b) => a - b);
    for (const y of cs) {
      if (Number.isNaN(ground)) {
        if (y <= gy + 0.5) ground = y; else return false;   // 第一张面就高出导航海拔 → 这点在实体里
        continue;
      }
      if (y > ground + 0.05) { ceil = y; break; }
    }
    return !Number.isNaN(ground) && ceil - ground >= 1.5;
  };
  const badNodes = [];
  let near = 0, inSolid = 0;
  for (let i = 0; i < NAV_NODES.length; i++) {
    const [x, z] = NAV_NODES[i];
    const k = nav.idx(x, z);
    if (k >= 0 && !nav.block[k]) continue;
    const f = nav.nearestFree(k);
    if (f < 0) { badNodes.push([i, x, z, '附近无可走格']); continue; }
    const [fx, fz] = nav.center(f);
    const d = Math.hypot(fx - x, fz - z);
    if (d <= 1.5) { near++; continue; }
    const gy = k < 0 || G.navY[k] === G.navMeta.blocked ? nav.groundAt(x, z) : nav.ground[k];
    if (!standable(x, z, gy)) { inSolid++; continue; }
    badNodes.push([i, x, z, `最近可走格 ${d.toFixed(1)}m 外`]);
  }
  let badEdges = 0, unreachableEdges = 0;
  for (const [i, j] of NAV_EDGES) {
    const a = NAV_NODES[i], b = NAV_NODES[j];
    if (!a || !b) { badEdges++; continue; }
    if (nav.lineFree(a[0], a[1], b[0], b[1])) continue;
    const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const len = pathLen(nav.findPath(a[0], a[1], b[0], b[1]));
    if (len < 0) { unreachableEdges++; badEdges++; continue; }
    if (len > straight * 2.5 + 1.5) badEdges++;
  }
  const pct = (v, t) => `${(100 * v / t).toFixed(1)}%`;
  console.log(`  真实导航 ${NAV_NODES.length} 节点：坏点 ${badNodes.length}（${pct(badNodes.length, NAV_NODES.length)}），官方点本身在实体里 ${inSolid}，贴墙可绕 ${near}`);
  console.log(`  真实导航 ${NAV_EDGES.length} 条边：不通 ${unreachableEdges}（${pct(unreachableEdges, NAV_EDGES.length)}），绕行过大 ${badEdges - unreachableEdges}`);
  for (const [i, x, z, why] of badNodes.slice(0, 10)) console.log(`    - 节点 ${i} (${x.toFixed(1)},${z.toFixed(1)}) ${why}`);
  if (badNodes.length / NAV_NODES.length > 0.03) fail.push(`真实导航坏点比例 ${pct(badNodes.length, NAV_NODES.length)} > 3%`);
  if (unreachableEdges / NAV_EDGES.length > 0.03) fail.push(`真实导航不通边比例 ${pct(unreachableEdges, NAV_EDGES.length)} > 3%`);
}

// ---------- 视线：按官方清单用与 bot 相同的 'sight' 射线判定 ----------
function sightBlocked(ax, az, bx, bz) {
  const ay = nav.groundAt(ax, az) + 1.6, by = nav.groundAt(bx, bz) + 1.5;
  const d = Math.hypot(bx - ax, by - ay, bz - az);
  if (d < 0.01) return false;
  const hit = world.raycast(ax, ay, az, (bx - ax) / d, (by - ay) / d, (bz - az) / d, d - 0.2, 'sight');
  return !!hit;
}
for (const s of (LAYOUT.checks.sight || [])) {
  console.log(`  视线 ${s.label}：${sightBlocked(s.a[0], s.a[1], s.b[0], s.b[1]) ? '遮挡' : '通透'}`);
}

// ---------- ASCII 俯视图（1 字符 = 1m）----------
console.log('\n图例 #墙 o掩体 _台面 :不可走 .双方可达 g仅保卫 b仅潜伏 X都到不了\n');
for (let z = LAYOUT.bounds.z[1]; z >= LAYOUT.bounds.z[0]; z -= 1) {
  let line = '';
  for (let x = LAYOUT.bounds.x[0]; x <= LAYOUT.bounds.x[1]; x += 1) {
    const cx = x + 0.5, cz = z - 0.5;
    const k = nav.idx(cx, cz);
    if (k < 0) { line += ' '; continue; }
    if (nav.block[k]) { line += ':'; continue; }
    if (wall[k] === 2) { line += '#'; continue; }
    if (wall[k] === 1) { line += 'o'; continue; }
    if (!sets.BL[k] && !sets.GR[k]) line += 'X';
    else if (!sets.BL[k]) line += 'g';
    else if (!sets.GR[k]) line += 'b';
    else line += '.';
  }
  console.log(line);
}
console.log('');

// ---------- PNG ----------
const W = Math.round((LAYOUT.bounds.x[1] - LAYOUT.bounds.x[0]) * SCALE);
const H = Math.round((LAYOUT.bounds.z[1] - LAYOUT.bounds.z[0]) * SCALE);
const px = Buffer.alloc(W * H * 3);
const toPx = (x, z) => [Math.round((x - LAYOUT.bounds.x[0]) * SCALE), Math.round((LAYOUT.bounds.z[1] - z) * SCALE)];
let minG = 1e9, maxG = -1e9;
for (let k = 0; k < nav.block.length; k++) if (!nav.block[k]) { minG = Math.min(minG, nav.ground[k]); maxG = Math.max(maxG, nav.ground[k]); }
const span = Math.max(0.001, maxG - minG);
// 底色：真实地面海拔渐变，低处暗、高处亮（dust2 的场高差本身就是可读信息）
for (let py = 0; py < H; py++) {
  const wz = LAYOUT.bounds.z[1] - (py + 0.5) / SCALE;
  for (let pxx = 0; pxx < W; pxx++) {
    const wx = LAYOUT.bounds.x[0] + (pxx + 0.5) / SCALE;
    const k = nav.idx(wx, wz);
    const i = (py * W + pxx) * 3;
    let t = 0.35;
    if (k >= 0 && !nav.block[k]) t = 0.15 + 0.85 * ((nav.ground[k] - minG) / span);
    else if (k >= 0) t = 0.05;
    px[i] = 128 + 106 * t; px[i + 1] = 108 + 96 * t; px[i + 2] = 78 + 78 * t;
  }
}
function fillRect(c, x0, x1, z0, z1, mix) {
  const [a, b] = toPx(x0, z1), [c2, d2] = toPx(x1, z0);
  for (let y = Math.max(0, b); y <= Math.min(H - 1, d2); y++) for (let x = Math.max(0, a); x <= Math.min(W - 1, c2); x++) {
    const i = (y * W + x) * 3;
    for (let ch = 0; ch < 3; ch++) px[i + ch] = px[i + ch] * (1 - mix) + c[ch] * mix;
  }
}
// 顶棚压成灰，实体按高出地面的程度加深
for (const c of world.colliders) {
  if (c.tag === 'roof') { fillRect([120, 128, 134], c.minX, c.maxX, c.minZ, c.maxZ, 0.3); continue; }
  if (c.tag !== 'solid') continue;
  const rise = c.top - S.groundAt(c.x, c.z);
  if (rise < 0.36) continue;
  const t = Math.min(1, rise / 6);
  fillRect([188 - 120 * t, 160 - 104 * t, 122 - 84 * t], c.minX, c.maxX, c.minZ, c.maxZ, 0.92);
}
// 可达性遮罩：只有单队能到 = 醒目色，谁都到不了 = 青色
for (let j = 0; j < nav.h; j++) for (let i = 0; i < nav.w; i++) {
  const k = j * nav.w + i;
  if (nav.block[k]) continue;
  const both = sets.BL[k] && sets.GR[k];
  if (both) continue;
  const [cx, cz] = nav.center(k);
  const col = sets.BL[k] ? [230, 90, 70] : sets.GR[k] ? [70, 150, 230] : [60, 200, 220];
  fillRect(col, cx - nav.cell / 2, cx + nav.cell / 2, cz - nav.cell / 2, cz + nav.cell / 2, sets.BL[k] || sets.GR[k] ? 0.4 : 0.55);
}
function dot(x, z, c, r = 5) {
  const [cx0, cy0] = toPx(x, z);
  for (let dy = -r - 1; dy <= r + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) {
    const d = Math.hypot(dx, dy), xx = cx0 + dx, yy = cy0 + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const i = (yy * W + xx) * 3;
    const t = d <= r ? [c[0], c[1], c[2]] : d <= r + 1.2 ? [30, 30, 30] : null;
    if (!t) continue;
    for (let ch = 0; ch < 3; ch++) px[i + ch] = t[ch];
  }
}
for (const s of spawns.BL) dot(s.x, s.z, [225, 60, 50], 4);
for (const s of spawns.GR) dot(s.x, s.z, [60, 175, 90], 4);
for (const [name, a] of Object.entries(anchors)) if (!name.startsWith('spawn.')) dot(a.x, a.z, [250, 220, 40], 3);
for (const s of LAYOUT.sites || []) {
  const [sx, sy] = toPx(s.x, s.z);
  const r = Math.round(s.r * SCALE);
  for (let a = 0; a < 360; a += 2) {
    const x = Math.round(sx + Math.cos(a * Math.PI / 180) * r), y = Math.round(sy + Math.sin(a * Math.PI / 180) * r);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 3;
    for (let ch = 0; ch < 3; ch++) px[i + ch] = px[i + ch] * 0.4 + [255, 120, 20][ch] * 0.6;
  }
}

const out = arg('out', `dist/floorplan-${id}.png`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(px, W, H));
console.log(`wrote ${out} (${W}x${H})  海拔 ${minG.toFixed(2)}~${maxG.toFixed(2)}m`);

if (fail.length) { console.log('\n问题:'); for (const f of fail) console.log('  - ' + f); process.exitCode = 1; }
else console.log('\n全部检查通过');

// ---------- PNG 编码 ----------
var CRC_TABLE = null;
function encodePng(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[i] = c; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
