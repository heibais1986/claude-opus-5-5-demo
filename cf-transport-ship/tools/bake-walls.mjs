// 从渲染三角面里补出「烘焙碰撞漏掉的墙」。
//
// 背景（bug 根因）：
//   dust2-geo.js 里的碰撞块 SOL_BLOB 是**高度场**——每 0.5m 格一根从 y=-9 拉到
//   「这一格水平面的最高处」的柱子（8.7k 根柱子，全部 y0=-9，我核对过）。
//   高度场只能表达水平面：一块立在格子里的薄墙（厚度远小于格宽）没有朝上的面，
//   它所在格的水平面仍然是地面，于是那一格没有柱子，这堵墙在物理里**根本不存在**。
//   玩家体感就是「走到墙跟前直接穿进去」，B 点安包处旁边那堵矮墙就是这么穿的。
//
// 这个工具的职责：拿 bundle 里现成的真实三角面（GEO_BLOB，24 万面，和画出来的是同一份），
// 找出「玩家够得到、但现有碰撞盒盖不住」的竖直面，把它们栅格化成一根根竖向薄盒，
// 写成 src/maps/dust2-walls.js。运行时由 geo.js 的 addColliders 一并装进世界——
// 顺序上必须在 NavGrid 之前，NavGrid 里本来就有「格中心埋在墙身就封掉」的检查（initField
// 的 buried 分支），薄墙落进哪个可走格，那个格会自动封上，导航和物理不会再各说各话。
//
// 用法：
//   node tools/bake-walls.mjs            干跑，只打统计
//   node tools/bake-walls.mjs --write    真的写出 src/maps/dust2-walls.js
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { World, STEP_H } from '../src/physics.js';
import { decodeGeo, makeSampler, addColliders, carveDoorways } from '../src/maps/geo.js';
import { GEO_META, NAV_META } from '../src/maps/dust2-geo.js';
import { LAYOUT, DOORS } from '../src/maps/dust2-layout.js';

const WRITE = process.argv.includes('--write');
// 栅格宽度：薄盒的边长。0.3 比烘焙的 0.5 细一档，把「本该挡住的地方现在挡不住」
// 换成最多 15cm 的提前阻挡，而不是整堵墙穿过去。
const CW = +(process.env.CW || 0.3);
const MAT_NAME = ['concrete', 'wood', 'metal'];
const SURFACE = ['sand', 'wood', 'metal'];

const M = GEO_META;
const [ox, oy, oz] = M.origin, [qx, qy, qz] = M.scale;

const G = await decodeGeo();
// 必须只跟「烘焙出来的」碰撞比：dust2-walls.js 是本工具上一次的产物，
// 拿它一起比会把自己的输出当成已有碰撞，越跑补得越少。
G.wall = null;
const S = makeSampler(G);
const world = new World();
addColliders(world, G, LAYOUT.bounds, S);      // 旧碰撞：只用来判断「这块面已经有碰撞了」
carveDoorways(world, S, DOORS);

const inDoorway = (x, y, z) => DOORS.some((D) => x > D.x0 && x < D.x1 && z > D.z0 && z < D.z1 && y < D.top);

// 落在某个实体盒里？（盒是轴对齐的，yaw 一律 0；留 5cm 余量，体素和真实面不可能严丝合缝）
function coveredAt(x, y, z) {
  for (const c of world.query(x - 0.001, z - 0.001, x + 0.001, z + 0.001)) {
    if (!c.solid || c.tag === 'clip') continue;
    if (y < c.bottom - 0.05 || y > c.top + 0.05) continue;
    if (Math.abs(x - c.x) <= c.hx + 0.05 && Math.abs(z - c.z) <= c.hz + 0.05) return true;
  }
  return false;
}
// 碰撞是体素量化的，沿面法线前后各让 0.3m 都算「这堵墙有碰撞」；
// 再远就说明这块几何在碰撞里根本不存在（0.3m 的阻挡位置误差玩家分不出来）。
const OFF = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3];
const covered = (x, y, z, nx, nz) => OFF.some((d) => coveredAt(x + nx * d, y, z + nz * d));

// ---------- 导航可走格：用来筛掉地图外/天上的装饰面 ----------
const NM = NAV_META;
const navOK = (i, j) => i >= 0 && j >= 0 && i < NM.w && j < NM.h && G.navY[j * NM.w + i] !== NM.blocked;
// 这块墙是不是玩家真的够得到：附近有可走格，且墙面高度和「站那儿的身体」有交集
function reachable(mx, my0, my1, mz) {
  const R = 2;   // 2 格 = 1.2m
  const i0 = Math.floor((mx - NM.x0) / NM.cell) - R, i1 = Math.floor((mx - NM.x0) / NM.cell) + R;
  const j0 = Math.floor((mz - NM.z0) / NM.cell) - R, j1 = Math.floor((mz - NM.z0) / NM.cell) + R;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (!navOK(i, j)) continue;
    const gy = G.navY[j * NM.w + i] / 100;
    if (my0 < gy + 1.75 && my1 > gy + 0.15) return true;
  }
  return false;
}

// ---------- 2D 工具 ----------
// 线段在 xz 上被矩形裁出的参数区间（Liang–Barsky）
function clipSeg2(ax, az, bx, bz, x0, z0, x1, z1) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const p = [-dx, dx, -dz, dz];
  const q = [ax - x0, x1 - ax, az - z0, z1 - az];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}
function inTri2(px, pz, ax, az, bx, bz, cx, cz) {
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
  const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
// 三角形落在某个格里的 y 跨度。y 沿面是线性的，所以极值一定在边界上：
// 顶点在格内 + 三条边被格裁出来的端点，取全部 y 的 min/max。
const PV = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
function yRangeInCell(t, x0, z0, x1, z1) {
  let lo = Infinity, hi = -Infinity;
  for (const p of t) {
    if (p[0] >= x0 && p[0] <= x1 && p[2] >= z0 && p[2] <= z1) {
      if (p[1] < lo) lo = p[1];
      if (p[1] > hi) hi = p[1];
    }
  }
  for (let e = 0; e < 3; e++) {
    const u = t[e], v = t[(e + 1) % 3];
    const r = clipSeg2(u[0], u[2], v[0], v[2], x0, z0, x1, z1);
    if (!r) continue;
    for (const s of r) {
      const y = u[1] + (v[1] - u[1]) * s;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  if (lo === Infinity) {
    // 格整个落在三角面投影内部（宽面才有）：退回用整面的 y 跨度
    if (inTri2((x0 + x1) / 2, (z0 + z1) / 2, t[0][0], t[0][2], t[1][0], t[1][2], t[2][0], t[2][2])) {
      for (const p of t) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
    }
  }
  return lo === Infinity ? null : [lo, hi];
}

// ---------- 扫全部三角面 ----------
const px = (i) => ox + G.verts[i * 3] * qx;
const py = (i) => oy + G.verts[i * 3 + 1] * qy;
const pz = (i) => oz + G.verts[i * 3 + 2] * qz;

// 单个三角面的判定，--why / --tri 共用
function judge(ti) {
  const a = G.idx[ti * 3], b = G.idx[ti * 3 + 1], c = G.idx[ti * 3 + 2];
  const ax = px(a), ay = py(a), az = pz(a);
  const bx = px(b), by = py(b), bz = pz(b);
  const cx = px(c), cy = py(c), cz = pz(c);
  const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx0 = uy * vz - uz * vy, ny0 = uz * vx - ux * vz, nz0 = ux * vy - uy * vx;
  const len = Math.hypot(nx0, ny0, nz0) || 1;
  const area = 0.5 * len;
  const ylo = Math.min(ay, by, cy), yhi = Math.max(ay, by, cy);
  const why = [];
  if (Math.abs(ny0 / len) > 0.35) why.push(`太斜 |ny|=${(ny0 / len).toFixed(2)}`);
  if (area < 0.01) why.push('面太小');
  if (inDoorway(mx, (ay + by + cy) / 3, mz)) why.push('在门洞里');
  if (!reachable(mx, ylo, yhi, mz)) why.push('够不到（附近没可走格/不在身体高度）');
  let miss = 0, tot = 0;
  if (!why.length) {
    const nx = nx0 / len, nz = nz0 / len;
    const n = Math.max(2, Math.min(7, Math.ceil(Math.sqrt(area) / 0.4)));
    for (let i = 0; i <= n; i++) for (let j = 0; j + i <= n; j++) {
      const w0 = i / n, w1 = j / n, w2 = 1 - w0 - w1;
      tot++;
      if (!covered(ax * w0 + bx * w1 + cx * w2, ay * w0 + by * w1 + cy * w2,
        az * w0 + bz * w1 + cz * w2, nx, nz)) miss++;
    }
    if (miss === 0) why.push(`已有碰撞（${miss}/${tot} 点撞不到）`);
  }
  return {
    ti, area, why,
    mx, my: (ay + by + cy) / 3, mz, nx: nx0 / len, ny: ny0 / len, nz: nz0 / len,
    ylo, yhi, v: [[ax, ay, az], [bx, by, bz], [cx, cy, cz]],
  };
}
const show = (j) => console.log(`面 ${j.ti} 面积 ${j.area.toFixed(2)} `
  + `中心(${j.mx.toFixed(2)},${j.my.toFixed(2)},${j.mz.toFixed(2)}) `
  + `法线(${j.nx.toFixed(2)},${j.ny.toFixed(2)},${j.nz.toFixed(2)}) y ${j.ylo.toFixed(2)}~${j.yhi.toFixed(2)}`
  + ` -> ${j.why.length ? j.why.join('; ') : '★补上'}`);

// 排查用：--why x z [R] 打附近每个竖直面的判定；--tri i 打指定面
const whyAt = process.argv.indexOf('--why');
const triAt = process.argv.indexOf('--tri');
if (triAt >= 0) {
  const j = judge(+process.argv[triAt + 1]);
  show(j);
  console.log('  顶点: ' + j.v.map((p) => `(${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)})`).join('  '));
  process.exit(0);
}
if (whyAt >= 0) {
  const WX = +process.argv[whyAt + 1], WZ = +process.argv[whyAt + 2], WR = +(process.argv[whyAt + 3] || 1.5);
  for (let ti = 0; ti < M.nTris; ti++) {
    const j = judge(ti);
    if (Math.hypot(j.mx - WX, j.mz - WZ) <= WR) show(j);
  }
  process.exit(0);
}

const grid = new Map();     // `${i},${j}` -> {lo, hi, mat}
let nVert = 0, nReach = 0, nMiss = 0, missArea = 0, nCells = 0;
for (let ti = 0; ti < M.nTris; ti++) {
  const a = G.idx[ti * 3], b = G.idx[ti * 3 + 1], c = G.idx[ti * 3 + 2];
  const ax = px(a), ay = py(a), az = pz(a);
  const bx = px(b), by = py(b), bz = pz(b);
  const cx = px(c), cy = py(c), cz = pz(c);
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx0 = uy * vz - uz * vy, ny0 = uz * vx - ux * vz, nz0 = ux * vy - uy * vx;
  const len = Math.hypot(nx0, ny0, nz0) || 1;
  // 只要真正的「墙」：|ny| <= 0.35 即比 ~70° 还陡。斜顶/坡道有朝上的面，
  // 高度场本来就抓得住它们，不该重复补。
  if (Math.abs(ny0 / len) > 0.35) continue;
  const area = 0.5 * len;
  // 只滤掉真正的碎片。楼梯侧面那种 0.03m² 的细长条（顶边斜着的挡板）也是墙，
  // 一个台阶的高度也够挡住人的胸口，不能按面积一刀切掉。
  if (area < 0.01) continue;
  const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
  if (inDoorway(mx, (ay + by + cy) / 3, mz)) continue;   // 门洞面是运行时故意挖掉的
  nVert++;

  const ylo = Math.min(ay, by, cy), yhi = Math.max(ay, by, cy);
  if (!reachable(mx, ylo, yhi, mz)) continue;
  nReach++;

  const nx = nx0 / len, nz = nz0 / len;
  // 采样看这块面有没有碰撞；只补「大部分点都撞不到」的面
  const n = Math.max(2, Math.min(7, Math.ceil(Math.sqrt(area) / 0.4)));
  let miss = 0, tot = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j + i <= n; j++) {
    const w0 = i / n, w1 = j / n, w2 = 1 - w0 - w1;
    tot++;
    if (!covered(ax * w0 + bx * w1 + cx * w2, ay * w0 + by * w1 + cy * w2,
      az * w0 + bz * w1 + cz * w2, nx, nz)) miss++;
  }
  const t3 = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
  // 每个采样点都撞得到，才算「这堵墙已经有碰撞了」。只要还有采样点悬空，
  // 就说明这面墙的碰撞只盖了一半（矮处有、高处没有），照样得补。
  if (miss === 0) continue;
  nMiss++;
  missArea += area;

  const gx0 = Math.floor(Math.min(ax, bx, cx) / CW), gx1 = Math.floor(Math.max(ax, bx, cx) / CW);
  const gz0 = Math.floor(Math.min(az, bz, cz) / CW), gz1 = Math.floor(Math.max(az, bz, cz) / CW);
  for (let gi = gx0; gi <= gx1; gi++) for (let gj = gz0; gj <= gz1; gj++) {
    const r = yRangeInCell(t3, gi * CW, gj * CW, (gi + 1) * CW, (gj + 1) * CW);
    if (!r) continue;
    const key = gi + ',' + gj;
    const cur = grid.get(key);
    if (!cur) { grid.set(key, { lo: r[0], hi: r[1], mat: G.mat[ti] }); nCells++; }
    else {
      if (r[0] < cur.lo) cur.lo = r[0];
      if (r[1] > cur.hi) cur.hi = r[1];
    }
  }
}

// ---------- 合并：同一行里 y 跨度一致的相邻格合成一根长盒 ----------
// 轴对齐的墙因此退化成一根盒子，盒子数量不会随墙长线性膨胀。
const rows = new Map();
for (const [key, v] of grid) {
  const [gi, gj] = key.split(',').map(Number);
  let r = rows.get(gj);
  if (!r) { r = []; rows.set(gj, r); }
  r.push([gi, v.lo, v.hi, v.mat]);
}
const boxes = [];
for (const [gj, cells] of rows) {
  cells.sort((p, q) => p[0] - q[0]);
  let run = null;
  for (const [gi, lo, hi, mat] of cells) {
    if (run && gi === run.i1 + 1 && Math.abs(lo - run.lo) <= 0.05 && Math.abs(hi - run.hi) <= 0.05) {
      run.i1 = gi;
      run.lo = Math.min(run.lo, lo); run.hi = Math.max(run.hi, hi);
    } else {
      if (run) boxes.push(run);
      run = { i0: gi, i1: gi, j: gj, lo, hi, mat };
    }
  }
  if (run) boxes.push(run);
}

// 只留「真能挡住走路的人」的盒子：盒顶要高过「贴着它的那块可走地面」一个台阶（STEP_H）。
// 注意不能拿盒子自己的高度去比——楼梯侧面那种顶边斜着的挡板，栅格化之后每个格子
// 只有 20~30cm 高，却长在胸口位置，一样挡人。只有「贴着地面、矮过一个台阶」的东西
// 才该迈上去（stepHeight 就是干这个的），补了纯属白掏碰撞开销。
//
// 取的是「最近一格可走地面的高度」，不是附近最低的那一格：
// 台阶的踢面就是 15cm 宽的一根矮挡板，顶面正好和上一级踏面齐平。要是拿「附近最低」
// 去比，旁边有个坑或下坡就能把踢面留住 —— 玩家站的那一格中心正好卡在两根踢面之间
// 那条 15cm 的缝里，物理会把他从缝里挤出去，挤到脚下那块地板以下，然后无限下坠。
function groundNear(x, z) {
  const ci = Math.floor((x - NM.x0) / NM.cell), cj = Math.floor((z - NM.z0) / NM.cell);
  for (let R = 0; R <= 2; R++) {
    let best = Infinity, bd = Infinity;
    for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
      if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== R) continue;
      if (!navOK(i, j)) continue;
      const gx = NM.x0 + (i + 0.5) * NM.cell, gz = NM.z0 + (j + 0.5) * NM.cell;
      const d = (gx - x) * (gx - x) + (gz - z) * (gz - z);
      if (d < bd) { bd = d; best = G.navY[j * NM.w + i] / 100; }
    }
    if (best !== Infinity) return best;
  }
  return Infinity;
}
const kept = [];
let dropShort = 0;
for (const b of boxes) {
  const x = (b.i0 + b.i1 + 1) / 2 * CW, z = (b.j + 0.5) * CW;
  const gy = groundNear(x, z);
  // 只丢「长在地面上、矮过一个台阶」的东西（真正的踢面/矮台）。
  // 底边悬在地面之上的（横梁侧面、栏杆、阳台边）一律留着：那是胸口高度的一条带，
  // 脚下那块地面再低一点，人就该被它挡住，丢了就等于墙上开了条缝。
  if (gy !== Infinity && b.hi <= gy + STEP_H + 0.05 && b.lo <= gy + 0.1) { dropShort++; continue; }
  kept.push(b);
}
boxes.length = 0;
boxes.push(...kept);

let vol = 0, minH = Infinity;
for (const b of boxes) {
  const h = b.hi - b.lo;
  vol += CW * CW * h;
  if (h < minH) minH = h;
}
console.log(`栅格 ${CW}m  竖直面 ${nVert} 个 -> 够得到的 ${nReach} 个 -> 撞不到 ${nMiss} 个（${missArea.toFixed(0)} m²）`);
console.log(`栅格格 ${nCells} 个 -> 合并 ${boxes.length + dropShort} 根 -> 去掉「一个台阶就能迈过去」的 ${dropShort} 根 -> 留 ${boxes.length} 根`);
console.log(`  盒子总体积 ${vol.toFixed(0)} m³，最矮 ${minH.toFixed(2)} m`);
const hist = [[-99, 1.2], [1.2, 2.2], [2.2, 4], [4, 99]];
for (const [a, b] of hist) {
  const n = boxes.filter((x) => x.hi - x.lo > a && x.hi - x.lo <= b).length;
  console.log(`  高度 ${a}~${b}m: ${n} 根`);
}

if (!WRITE) {
  console.log('\n（干跑，加 --write 才会写出 src/maps/dust2-walls.js）');
} else {
  // 盒子格式与 SOL 一致：[x, z, w, d, y0, y1, mat]，cm 为单位的 int16
  const out = new Int16Array(boxes.length * 7);
  boxes.forEach((b, i) => {
    const x = (b.i0 + b.i1 + 1) / 2 * CW, z = (b.j + 0.5) * CW;
    out[i * 7] = Math.round(x * 100);
    out[i * 7 + 1] = Math.round(z * 100);
    out[i * 7 + 2] = Math.round((b.i1 - b.i0 + 1) * CW * 100);
    out[i * 7 + 3] = Math.round(CW * 100);
    out[i * 7 + 4] = Math.round(b.lo * 100);
    out[i * 7 + 5] = Math.round(b.hi * 100);
    out[i * 7 + 6] = b.mat;
  });
  const b64 = gzipSync(Buffer.from(out.buffer, 0, out.byteLength), { level: 9 }).toString('base64');
  const js = `// de_dust2 补墙碰撞 —— 由 tools/bake-walls.mjs 从 dust2-geo.js 的真实三角面推导，勿手改。
// 烘焙的碰撞块是高度场，表达不了立在格子里的薄墙（详见 tools/bake-walls.mjs 顶部注释），
// 这里补的就是那些「看得见、却撞不到」的墙。格式与 SOL_BLOB 相同：[x,z,w,d,y0,y1,mat]，cm。
export const WALL_META = { count: ${boxes.length}, cell: ${CW} };
export const WALL_BLOB = '${b64}';
`;
  writeFileSync(new URL('../src/maps/dust2-walls.js', import.meta.url), js);
  const kb = (js.length / 1024).toFixed(1);
  console.log(`\n已写出 src/maps/dust2-walls.js：${boxes.length} 根盒子，${kb} KB`);
}
