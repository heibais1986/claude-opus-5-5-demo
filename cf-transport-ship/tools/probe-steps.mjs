// 台阶体检：真实碰撞体 + 玩家移动物理，沿「连续上台阶的导航格」逐段走一遍，
// 找出「导航连通但人走不上去」的楼梯（必须跳、必须后退的那种）。
//
// 每段楼梯不只试一次：起点沿走行方向按相位扫过去。台阶抖动是亚帧级的——
// 角色一帧走 0.095m，只有恰好停在「刚蹭到台阶立面」那一小段相位里，
// 「上台阶判定用半径 r、脚下支撑面却用 0.92r」才会露出来：人刚被抬上台阶，
// 下一秒又被判踏空掉回来，于原地无限上下。只测一个相位必然漏掉。
//
// 用法：node tools/probe-steps.mjs [每段限时秒] [最多测多少段] [相位步长]
import { World, NavGrid } from '../src/physics.js';
import { decodeGeo, makeSampler, addColliders, carveDoorways, navField } from '../src/maps/geo.js';
import { LAYOUT, DOORS } from '../src/maps/dust2-layout.js';

const LIMIT = Number(process.argv[2] ?? 6);
const MAXRUN = Number(process.argv[3] ?? 400);
const PHASE = Number(process.argv[4] ?? 0.05);   // 起点相位步长，0 表示只测格中心

const G = await decodeGeo();
const S = makeSampler(G);
const world = new World();
addColliders(world, G, LAYOUT.bounds, S);
carveDoorways(world, S, DOORS);
const n = LAYOUT.nav;
const nav = new NavGrid(world, n.x0, n.z0, n.x1, n.z1, n.cell, n.r, navField(G));

// ---------- 玩家物理替身：与 actor.js 同一套 ----------
const GRAV = 19, RUN = 5.7, RADIUS = 0.36, HEIGHT = 1.8, STEP = 0.42;
function makeWalker(x, z, y) {
  return {
    pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 },
    radius: RADIUS, height: HEIGHT, stepHeight: STEP,
    onGround: true, ground: null, stepped: 0,
  };
}
function step(w, wx, wz, dt) {
  const v = w.vel, wishSpeed = RUN;
  if (w.onGround) {
    const sp = Math.hypot(v.x, v.z);
    if (sp > 0) { const ns = Math.max(0, sp - Math.max(sp, 1.5) * 9 * dt) / sp; v.x *= ns; v.z *= ns; }
    const cur = v.x * wx + v.z * wz, add = wishSpeed - cur;
    if (add > 0) { const acc = Math.min(11 * dt * wishSpeed, add); v.x += acc * wx; v.z += acc * wz; }
  } else {
    const ws = Math.min(wishSpeed, 1.2), cur = v.x * wx + v.z * wz, add = ws - cur;
    if (add > 0) { const acc = Math.min(12 * dt * ws, add); v.x += acc * wx; v.z += acc * wz; }
  }
  v.y -= GRAV * dt;
  world.move(w, dt);
  return w;
}
// 从 A 沿给定方向按住 W 走到 B，返回进度与卡住时长
function walk(ax, az, ay, bx, bz, trace) {
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz) || 1;
  const wx = dx / d, wz = dz / d;
  const w = makeWalker(ax, az, ay + 0.02);
  const dt = 1 / 60;
  let best = 0, stuckFor = 0, maxStuck = 0;
  for (let t = 0; t < LIMIT; t += dt) {
    step(w, wx, wz, dt);
    const prog = ((w.pos.x - ax) * wx + (w.pos.z - az) * wz) / d;
    if (prog > best + 1e-4) { best = prog; stuckFor = 0; } else stuckFor += dt;
    maxStuck = Math.max(maxStuck, stuckFor);
    if (trace) trace.push([+w.pos.x.toFixed(2), +w.pos.y.toFixed(2), +w.pos.z.toFixed(2)]);
    if (best > 0.9) break;
  }
  return { best, end: [w.pos.x, w.pos.y, w.pos.z], maxStuck };
}

// ---------- 找连续上台阶的格子串（真实楼梯） ----------
const W = nav.w, H = nav.h;
const runs = [];
for (const [di, dj] of [[1, 0], [0, 1]]) {
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (nav.block[k]) continue;
    // 起点：上一格不是「小台阶」（避免从楼梯中段开始）
    const pi = i - di, pj = j - dj;
    const pk = pi < 0 || pj < 0 ? -1 : pj * W + pi;
    if (pk >= 0 && !nav.block[pk]) {
      const dp = nav.ground[k] - nav.ground[pk];
      if (dp > 0.1 && dp <= 0.45 && nav.linkOk(pk, di, dj)) continue;
    }
    const cells = [k];
    let ci = i, cj = j;
    for (;;) {
      const ck = cj * W + ci;
      if (!nav.linkOk(ck, di, dj)) break;
      const ni = ci + di, nj = cj + dj;
      if (ni >= W || nj >= H) break;
      const nk = nj * W + ni;
      if (nav.block[nk]) break;
      const dh = nav.ground[nk] - nav.ground[ck];
      if (dh <= 0.1 || dh > 0.45) break;
      cells.push(nk); ci = ni; cj = nj;
    }
    if (cells.length >= 4) runs.push({ cells, di, dj });
  }
}
// 去重（同一段会被不同起点重复找到）
const seen = new Set();
const uniq = [];
for (const r of runs) {
  const key = r.cells.join(',');
  if (seen.has(key)) continue;
  seen.add(key); uniq.push(r);
}
console.log(`连续上台阶的格子串（≥4 格，每格 0.1~0.45m）：${uniq.length} 段`);

const phases = [];
if (PHASE > 0) for (let p = 0; p <= n.cell * 0.75 + 1e-9; p += PHASE) phases.push(p);
else phases.push(0);

let badRuns = 0, badTrials = 0, trials = 0;
const fails = [];
for (const r of uniq.slice(0, MAXRUN)) {
  const a = r.cells[0], b = r.cells[r.cells.length - 1];
  const [ax, az] = nav.center(a), [bx, bz] = nav.center(b);
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz) || 1;
  const ux = dx / d, uz = dz / d;
  const climb = nav.ground[b] - nav.ground[a];
  let bad = 0, firstFail = null;
  for (const p of phases) {
    const sx = ax - ux * p, sz = az - uz * p;
    // 起点脚底站「这一格导航真正指的地面」上：NavGrid.ground 已是物理实测面。
    // 用 support(..., Infinity) 取最高面会把人放到头顶棚顶上，测出来的卡住是假象。
    const sup = world.support(sx, sz, RADIUS, nav.ground[a] + 0.5);
    const ay = sup ? sup.y : nav.ground[a];
    trials++;
    const res = walk(sx, sz, ay, bx, bz, null);
    if (res.best < 0.9) {
      bad++; badTrials++;
      if (!firstFail) firstFail = { p, sx, sz, ay, res };
    }
  }
  if (bad) {
    badRuns++;
    fails.push({ climb, len: r.cells.length, from: [ax, nav.ground[a], az], to: [bx, bz], bad, firstFail });
  }
}
console.log(`实测 ${Math.min(uniq.length, MAXRUN)} 段 × ${phases.length} 个起点相位 = ${trials} 次：走不上去的段 ${badRuns}，走不上去的次 ${badTrials}`);
for (const f of fails.slice(0, 30)) {
  const ff = f.firstFail;
  console.log(`  爬升 ${f.climb.toFixed(2)}m / ${f.len} 格  从(${f.from[0].toFixed(1)},${f.from[1].toFixed(2)},${f.from[2].toFixed(1)})`
    + ` -> (${f.to[0].toFixed(1)},${f.to[1].toFixed(2)})  ${f.bad}/${phases.length} 个相位走不上去`
    + `  最差停在(${ff.res.end[0].toFixed(2)},${ff.res.end[1].toFixed(2)},${ff.res.end[2].toFixed(2)}) 进度 ${ff.res.best.toFixed(2)} 顶住 ${ff.res.maxStuck.toFixed(1)}s`);
}
// 挑第一段失败的样例重放 y 轨迹：台阶抖动会表现为 y 在两个值之间来回跳
if (fails.length) {
  const f = fails[0].firstFail;
  const trace = [];
  walk(f.sx, f.sz, f.ay, fails[0].to[0], fails[0].to[1], trace);
  const line = [];
  for (let i = 0; i < trace.length && i < 60 * 8; i += 9) line.push(trace[i][1].toFixed(2));
  console.log(`\n最差相位 y 轨迹（每 0.15s）：\n  ${line.join(' ')}`);
}
