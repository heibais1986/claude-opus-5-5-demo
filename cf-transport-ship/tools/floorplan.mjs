// 离线校验地图布局：俯视图（PNG + ASCII）与寻路网格可达性
// 用法：node tools/floorplan.mjs [dust2] [--scale=8] [--out=path.png]
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { World, NavGrid } from '../src/physics.js';

const arg = (name, dft) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dft;
const SCALE = Number(arg('scale', 8));

// ---------- 布局加载 ----------
const id = process.argv[2] || 'dust2';
const mod = await import(`../src/maps/${id}-layout.js`);
const L = mod.LAYOUT;
const boxes = mod.buildBoxes();
const openBoxes = boxes.filter((bx) => bx.kind !== 'roof');   // 顶棚不参与俯视遮挡判定

const toCollider = (bx) => ({
  x: bx.x, y: bx.y + bx.h / 2, z: bx.z,
  sx: bx.w, sy: bx.h, sz: bx.d, yaw: bx.yaw || 0,
  mat: bx.mat || 'concrete', solid: bx.solid !== false,
  bullet: bx.bullet || 'block', sight: bx.sight !== false, surface: 'sand',
});

const world = new World();
for (const bx of boxes) world.add(toCollider(bx));
world.build();

const n = L.nav;
const nav = new NavGrid(world, n.x0, n.z0, n.x1, n.z1, n.cell, n.r);

// ---------- 几何查询 ----------
function inBox(bx, x, z) {
  const a = bx.yaw || 0, c = Math.cos(a), s = Math.sin(a);
  const dx = x - bx.x, dz = z - bx.z;
  return Math.abs(c * dx - s * dz) <= bx.w / 2 && Math.abs(s * dx + c * dz) <= bx.d / 2;
}
// 覆盖该点的最盒子（俯视取色 / 判定障碍来源）
function boxAt(x, z) {
  let best = null;
  for (const bx of openBoxes) if (inBox(bx, x, z)) if (!best || bx.y + bx.h > best.y + best.h) best = bx;
  return best;
}
// 1m 字符网格会漏掉 0.6m 薄墙，子采样补救
function boxNear(x, z) {
  let best = null;
  for (const o of [[0, 0], [-0.27, 0], [0.27, 0], [0, -0.27], [0, 0.27]]) {
    const b = boxAt(x + o[0], z + o[1]);
    if (b && (!best || b.y + b.h > best.y + best.h)) best = b;
  }
  return best;
}
function pathLen(p) {
  if (!p || p.length < 2) return p ? 0 : -1;
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return s;
}

// ---------- 洪泛可达性 ----------
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
      out[nk] = 1; stack.push(nk);
    }
  }
  return out;
}
const sets = {};
for (const team of ['BL', 'GR']) {
  const u = new Uint8Array(nav.w * nav.h);
  for (const s of L.spawns[team]) flood(nav.idx(s.x, s.z), u);
  sets[team] = u;
}
const reachAll = new Uint8Array(nav.w * nav.h);
for (let k = 0; k < reachAll.length; k++) reachAll[k] = sets.BL[k] | sets.GR[k];

// ---------- 检查 ----------
const fail = [];
const anchors = L.checks && L.checks.anchors;
if (!anchors) { console.error(`${id} 布局缺少 checks.anchors，无法校验关键点位`); process.exit(2); }
console.log(`${id}: ${boxes.length} boxes, nav ${nav.w}x${nav.h} @${nav.cell}m`);
for (const [name, a] of Object.entries(anchors)) {
  const k = nav.idx(a.x, a.z);
  if (k < 0) { fail.push(`${name}: 网格越界`); continue; }
  const b = boxAt(a.x, a.z);
  if (nav.block[k]) { fail.push(`${name} (${a.x},${a.z}): 不可走，来源=${b ? b.kind + '/' + b.mat + ' top=' + (b.y + b.h).toFixed(2) : '余量不足'}`); continue; }
  const team = sets.BL[k] ? 'BL' : sets.GR[k] ? 'GR' : null;
  if (!team) { fail.push(`${name}: 两队都到不了`); continue; }
  const dB = pathLen(nav.findPath(L.spawns.BL[0].x, L.spawns.BL[0].z, a.x, a.z));
  const dG = pathLen(nav.findPath(L.spawns.GR[0].x, L.spawns.GR[0].z, a.x, a.z));
  console.log(`  ${name.padEnd(10)} 潜伏 ${dB < 0 ? '不可达' : dB.toFixed(1) + 'm'} / 保卫 ${dG < 0 ? '不可达' : dG.toFixed(1) + 'm'}`);
}
for (const [t, u] of Object.entries(sets)) {
  const other = t === 'BL' ? 'GR' : 'BL';
  for (const s of L.spawns[t]) {
    const k = nav.idx(s.x, s.z);
    if (k < 0 || nav.block[k]) { fail.push(`spawn ${t} (${s.x},${s.z}) 不可走`); continue; }
    if (!u[k]) fail.push(`spawn ${t} (${s.x},${s.z}) 不在本队洪泛区`);
    if (!sets[other][k]) fail.push(`spawn ${t} (${s.x},${s.z}) 对方进不来（正常应互通）`);
    const b = boxAt(s.x, s.z);
    if (b) fail.push(`spawn ${t} (${s.x},${s.z}) 与 ${b.kind} 重叠`);
  }
}
let free = 0, reach = 0;
for (let k = 0; k < nav.block.length; k++) if (!nav.block[k]) { free++; if (reachAll[k]) reach++; }
console.log(`  可走格 ${reach}/${free}（${(100 * reach / free).toFixed(1)}% 可达）`);
if (free !== reach) {
  const seen = new Uint8Array(nav.w * nav.h);
  for (let k = 0; k < nav.block.length; k++) {
    if (nav.block[k] || reachAll[k] || seen[k]) continue;
    const g = flood(k, new Uint8Array(nav.w * nav.h));
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, cnt = 0;
    for (let q = 0; q < g.length; q++) {
      if (!g[q]) continue;
      seen[q] = 1; cnt++;
      const [cx, cz] = nav.center(q);
      minx = Math.min(minx, cx); maxx = Math.max(maxx, cx);
      minz = Math.min(minz, cz); maxz = Math.max(maxz, cz);
    }
    if (cnt >= 4) fail.push(`孤立区 ${cnt} 格 x[${minx.toFixed(1)},${maxx.toFixed(1)}] z[${minz.toFixed(1)},${maxz.toFixed(1)}]`);
  }
}
// 掩体之间不应互相穿插（墙、门板、顶棚除外；叠放的箱子顶面恰好相接，不算重叠）
const PROP = new Set(['cover', 'site', 'dais', 'catwalk', 'container', 'car', 'scaffold', 'barrel', 'xbox', 'block', 'pit', 'low']);
const props = openBoxes.filter((bx) => PROP.has(bx.kind));
const warn = [];
for (let i = 0; i < props.length; i++) for (let j = i + 1; j < props.length; j++) {
  const a = props[i], b = props[j];
  const yo = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (yo <= 0.02) continue;
  const xo = (a.w + b.w) / 2 - Math.abs(a.x - b.x), zo = (a.d + b.d) / 2 - Math.abs(a.z - b.z);
  if (xo > 0.8 && zo > 0.8) {
    warn.push(`掩体重叠 ${a.kind}(${a.x},${a.z}) × ${b.kind}(${b.x},${b.z}) 交叠 ${xo.toFixed(1)}x${zo.toFixed(1)}m 高 ${(yo * 100).toFixed(0)}cm`);
  }
}

// 视线检查：按布局自带的 checks.sight 清单逐条判定
function sightBlocked(ax, az, bx2, bz2) {
  return !nav.lineFree(ax, az, bx2, bz2);
}
for (const s of (L.checks.sight || [])) {
  console.log(`  视线 ${s.label}：${sightBlocked(s.a[0], s.a[1], s.b[0], s.b[1]) ? '遮挡' : '通透'}`);
}
if (warn.length) { console.log('\n掩体互相穿插（应修正坐标或高度）:'); for (const w of warn) console.log('  - ' + w); }

// ---------- ASCII 俯视图（1 字符 = 1m）----------
const chars = [];
for (let z = L.bounds.z[1]; z >= L.bounds.z[0]; z -= 1) {
  let line = '';
  for (let x = L.bounds.x[0]; x <= L.bounds.x[1]; x += 1) {
    const b = boxNear(x + 0.5, z - 0.5);
    const k = nav.idx(x + 0.5, z - 0.5);
    if (b) {
      const top = b.y + b.h;
      line += b.kind === 'perim' ? '█' : top >= 4 ? '#' : b.kind === 'dais' ? '_' : b.h >= 1.4 ? 'O' : top <= 0.4 ? '_' : 'o';
    } else if (k < 0) line += ' ';
    else if (nav.block[k]) line += ':';
    else if (!sets.BL[k] && !sets.GR[k]) line += 'X';
    else if (!sets.BL[k]) line += 'g';
    else if (!sets.GR[k]) line += 'b';
    else line += '.';
  }
  chars.push(line);
}
console.log('\n图例 #墙 o掩体 _平台 :贴墙余量 .双方可达 g仅保卫 b仅潜伏 X都到不了\n');
console.log(chars.join('\n') + '\n');

// ---------- PNG ----------
const W = Math.round((L.bounds.x[1] - L.bounds.x[0]) * SCALE), H = Math.round((L.bounds.z[1] - L.bounds.z[0]) * SCALE);
const px = Buffer.alloc(W * H * 3);
const COL = {
  sand: [214, 190, 150], adobe: [188, 160, 120], perim: [150, 126, 96], door: [110, 78, 46],
  crate: [172, 128, 70], wood: [150, 108, 62], stone: [156, 154, 148], barrel: [120, 96, 76],
  truck: [128, 110, 96],
};
const toPx = (x, z) => [Math.round((x - L.bounds.x[0]) * SCALE), Math.round((L.bounds.z[1] - z) * SCALE)];
// 先铺沙
for (let i = 0; i < px.length; i += 3) { px[i] = COL.sand[0]; px[i + 1] = COL.sand[1]; px[i + 2] = COL.sand[2]; }
function blend(x, y, c, mix) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - mix) + c[0] * mix;
  px[i + 1] = px[i + 1] * (1 - mix) + c[1] * mix;
  px[i + 2] = px[i + 2] * (1 - mix) + c[2] * mix;
}
for (const bx of boxes) {
  const a = bx.yaw || 0;
  const ex = Math.abs(Math.cos(a)) * bx.w / 2 + Math.abs(Math.sin(a)) * bx.d / 2;
  const ez = Math.abs(Math.sin(a)) * bx.w / 2 + Math.abs(Math.cos(a)) * bx.d / 2;
  const [x0, y0] = toPx(bx.x - ex, bx.z + ez), [x1, y1] = toPx(bx.x + ex, bx.z - ez);
  const base = (COL[bx.mat] || COL.adobe).map((v) => v * Math.max(0.5, 1 - (bx.y + bx.h) / 18));
  for (let py = y0; py <= y1; py++) for (let pxx = x0; pxx <= x1; pxx++) {
    const wx = L.bounds.x[0] + (pxx + 0.5) / SCALE, wz = L.bounds.z[1] - (py + 0.5) / SCALE;
    if (inBox(bx, wx, wz)) {
      const i = (py * W + pxx) * 3;
      px[i] = base[0]; px[i + 1] = base[1]; px[i + 2] = base[2];
    }
  }
  // 描边，方便看清墙与开口
  for (let py = y0; py <= y1; py++) for (let pxx = x0; pxx <= x1; pxx++) {
    const wx = L.bounds.x[0] + (pxx + 0.5) / SCALE, wz = L.bounds.z[1] - (py + 0.5) / SCALE;
    if (!inBox(bx, wx, wz)) continue;
    const near = inBox(bx, wx + 0.9 / SCALE, wz) && inBox(bx, wx - 0.9 / SCALE, wz) && inBox(bx, wx, wz + 0.9 / SCALE) && inBox(bx, wx, wz - 0.9 / SCALE);
    if (!near) { const i = (py * W + pxx) * 3; for (let c = 0; c < 3; c++) px[i + c] *= 0.55; }
  }
}
// nav 遮罩：可走但仅一队能到 = 半透明；双方可达 = 淡绿
for (let j = 0; j < nav.h; j++) for (let i = 0; i < nav.w; i++) {
  const k = j * nav.w + i, [cx, cz] = nav.center(k);
  if (nav.block[k] || boxAt(cx, cz)) continue;
  const [x0, y0] = toPx(cx - nav.cell / 2, cz + nav.cell / 2);
  const s = Math.round(nav.cell * SCALE);
  const both = sets.BL[k] && sets.GR[k];
  const col = both ? [120, 200, 120] : sets.BL[k] ? [230, 90, 70] : sets.GR[k] ? [70, 150, 230] : [60, 200, 220];
  for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) blend(x, y, col, both ? 0.12 : 0.5);
}
function dot(x, z, c, r = 5) {
  const [cx0, cy0] = toPx(x, z);
  for (let dy = -r - 1; dy <= r + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) {
    const d = Math.hypot(dx, dy);
    if (d <= r) set(cx0 + dx, cy0 + dy, c, 1);
    else if (d <= r + 1.2) set(cx0 + dx, cy0 + dy, [30, 30, 30], 1);
  }
}
function set(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
}
for (const s of L.spawns.BL) dot(s.x, s.z, [225, 60, 50], 4);
for (const s of L.spawns.GR) dot(s.x, s.z, [60, 175, 90], 4);
for (const [name, a] of Object.entries(anchors)) if (!name.startsWith('spawn.')) dot(a.x, a.z, [250, 220, 40], 3);
for (const s of L.sites || []) dot(s.x, s.z, [255, 120, 20], 8);

const out = arg('out', `dist/floorplan-${id}.png`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(px, W, H));
console.log(`wrote ${out} (${W}x${H})`);

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
