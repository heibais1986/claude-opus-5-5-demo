// de_dust2 台阶回归探针：在导航场里找出「连续上台阶」的地段，用真实的 World.move 走一遍。
//
// 这个探针是那个 bug 的回归闸门。World.move 里水平碰撞按半径 r 判重叠，
// 上台阶成功后紧接着的支撑查询却写成 r * 0.92：角色贴住踏面往上迈时，
// 只有 0.36 - 0.36*0.92 = 2.9cm 的重叠会被算作「站在阶面上」，
// 一旦迈上去的落点偏外侧，支撑查询就查不到这块踏面 -> [上台阶] 成功、[踏空] 立刻触发，
// 角色掉回原位。表现就是「台阶前反复抖动、走不过去，必须后退再按空格」。
//
// 抖动是亚帧级的：同一个起点采一次，经常正好落在能过的那一侧，看着像 0 失败。
// 所以每条地段都要沿走向扫一遍接近相位，把落点铺满整格。
//
// 用法：node tools/probe-steps.mjs [最少连续阶数] [相位采样数] [相位步长(米)] [台阶上限(米)]
//   默认 node tools/probe-steps.mjs 4 10 0.05 0.7
import { World, NavGrid, STEP_H } from '../src/physics.js';
import { decodeGeo, navField, makeSampler, addColliders, carveDoorways } from '../src/maps/geo.js';
import { LAYOUT, DOORS } from '../src/maps/dust2-layout.js';

const MIN_LEN = +(process.argv[2] || 4);
const PHASES = +(process.argv[3] || 10);
const PHASE_H = +(process.argv[4] || 0.05);

const GRAV = 19, RUN = 5.7;
const RADIUS = 0.36, HEIGHT = 1.8;
const DT = 1 / 60, FRAMES = 180;          // 3 秒足够走完 4~5 米台阶
const STEP_MIN = 0.10;
// 只收「跑楼梯时不该需要跳」的台阶。上限是个物理约定（多高的坎玩家还期望直接走上去），
// 刻意不跟着 STEP_H 缩：这个 bug 恰恰出在「坎比 stepHeight 略高」那一档，
// 上限要是跟着 STEP_H 走，探针就永远看不见它——原来的 0.40 就漏掉了 0.47 / 0.52 那两级，
// 结果长道门洞后的楼梯半边走线是死的，探针却报 0 失败。
// 约定：STEP_H 不能小于这个上限，否则探针必然红（这就是它要守的东西）。
const STAIR_MAX = +(process.argv[5] || 0.7);
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

// ---------- 地图：与运行时同一条装配路径 ----------
const G = await decodeGeo();
if (process.env.NO_WALLS) G.wall = null;   // 对照用：关掉补墙看基线
const S = makeSampler(G);
const world = new World();
addColliders(world, G, LAYOUT.bounds, S);
carveDoorways(world, S, DOORS);

const N = LAYOUT.nav;
const field = navField(G);
// 门洞修复（导航）：运行时在 dust2.js 里对同一份 field 做同样的事，
// 否则烘焙导航在门洞处是断的，探针会把门口当成墙。
{
  const NM = N, y = field.y, link = field.link;
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
const nav = new NavGrid(world, N.x0, N.z0, N.x1, N.z1, N.cell, N.r, field);

// ---------- 找出连续上台阶的地段 ----------
const cellOf = (i, j) => (i < 0 || j < 0 || i >= nav.w || j >= nav.h ? -1 : j * nav.w + i);
const cx = (k) => N.x0 + ((k % nav.w) + 0.5) * nav.cell;
const cz = (k) => N.z0 + (((k / nav.w) | 0) + 0.5) * nav.cell;

const runs = [];
for (let j = 0; j < nav.h; j++) for (let i = 0; i < nav.w; i++) {
  const k0 = j * nav.w + i;
  if (nav.block[k0]) continue;
  for (let d = 0; d < 4; d++) {
    const [di, dj] = DIRS[d];
    // 只从坡底起步：上一格也是同向台阶就说明这不是起点，避免同一条坡被正反各记一次
    const pk = cellOf(i - di, j - dj);
    if (pk >= 0 && !nav.block[pk]) {
      const dh = nav.ground[k0] - nav.ground[pk];
      if (dh >= STEP_MIN && dh <= STAIR_MAX) continue;
    }
    let cells = [k0], k = k0;
    for (;;) {
      const ci = (k % nav.w) + di, cj = ((k / nav.w) | 0) + dj;
      const nk = cellOf(ci, cj);
      if (nk < 0 || nav.block[nk]) break;
      if (!(nav.link[k] & (1 << d))) break;      // 导航自己都不认为这步能走，不算台阶
      const dh = nav.ground[nk] - nav.ground[k];
      if (dh < STEP_MIN || dh > STAIR_MAX) break;
      cells.push(nk); k = nk;
    }
    if (cells.length - 1 >= MIN_LEN) runs.push({ d, cells });
  }
}
// 去掉被更长地段整段包住的子段
const kept = runs.filter((r) => !runs.some((o) =>
  o !== r && o.d === r.d && o.cells.length > r.cells.length && o.cells.includes(r.cells[0])));

if (process.env.DUMP_RUNS) {
  for (const r of kept) {
    const k0 = r.cells[0], kT = r.cells[r.cells.length - 1];
    console.log(`d${r.d} 从(${cx(k0).toFixed(1)},${cz(k0).toFixed(1)}) ${r.cells.length - 1}阶 ` +
      `${nav.ground[k0].toFixed(2)}->${nav.ground[kT].toFixed(2)}`);
  }
  process.exit(0);
}

// ---------- 用真实的 World.move 走一遍 ----------
// 判据不是「终点在哪」而是「有没有爬完整段并且站住」：
//   passed   —— 走过了坡顶格中心（说明整段都迈上去了）
//   yAtTop   —— 越过坡顶那一刻的高度必须贴着坡顶
//   slips    —— 到达过坡顶高度之后又掉回坡顶以下 0.3m 的次数
// 抖动型 bug 正是 slips > 0：爬上去 -> 立刻掉回来 -> 再爬，来回死循环。
function walkOnce(run, off) {
  const [dx, dz] = DIRS[run.d];
  const k0 = run.cells[0], kT = run.cells[run.cells.length - 1];
  const y0 = nav.ground[k0], yT = nav.ground[kT];
  const sx = cx(k0) + dx * off, sz = cz(k0) + dz * off;
  const distTop = (cx(kT) - sx) * dx + (cz(kT) - sz) * dz;
  const ent = {
    pos: { x: sx, y: y0, z: sz }, vel: { x: 0, y: 0, z: 0 },
    radius: RADIUS, height: HEIGHT, stepHeight: STEP_H,
    onGround: true, ground: null, stepped: 0,
  };
  let maxY = y0, maxAlong = 0, trace = [], passed = false, yAtTop = null, slips = 0, up = false;
  for (let f = 0; f < FRAMES; f++) {
    const v = ent.vel;
    if (ent.onGround) {
      const sp = Math.hypot(v.x, v.z);
      if (sp > 0) {
        const drop = Math.max(sp, 1.5) * 9 * DT;
        const ns = Math.max(0, sp - drop) / sp;
        v.x *= ns; v.z *= ns;
      }
      const cur = v.x * dx + v.z * dz, add = RUN - cur;
      if (add > 0) { const acc = Math.min(11 * DT * RUN, add); v.x += acc * dx; v.z += acc * dz; }
    } else {
      const cur = v.x * dx + v.z * dz, add = Math.min(RUN, 1.2) - cur;
      if (add > 0) { const acc = Math.min(12 * DT * Math.min(RUN, 1.2), add); v.x += acc * dx; v.z += acc * dz; }
    }
    v.y -= GRAV * DT;
    world.move(ent, DT);
    const p = ent.pos;
    const along = (p.x - sx) * dx + (p.z - sz) * dz;
    if (along > maxAlong) maxAlong = along;
    if (p.y > maxY) maxY = p.y;
    if (f % 6 === 0) trace.push(p.y.toFixed(2));
    // 进到坡顶格就算「上去了」：坡顶正中可能顶着墙，位置到不了格心，
    // 所以留一格半径的余量，收的是高度而不是精确坐标。
    if (!passed && along >= distTop - 0.35) { passed = true; yAtTop = p.y; }
    if (p.y >= yT - 0.3) up = true;
    else if (up) { up = false; slips++; }
    if (passed && along >= distTop + 0.05) { trace.push(p.y.toFixed(2)); break; }
  }
  return {
    ok: passed && yAtTop >= yT - 0.35 && slips === 0,
    passed, slips, yAtTop, maxY, maxAlong, y: ent.pos.y, yT, distTop, trace,
  };
}

let segFail = 0, trialFail = 0, trials = 0;
const bad = [];
for (const run of kept) {
  let segBad = 0;
  for (let p = 0; p < PHASES; p++) {
    const off = -PHASE_H * ((PHASES - 1) / 2) + p * PHASE_H;
    const r = walkOnce(run, off);
    trials++;
    if (!r.ok) { trialFail++; segBad++; if (bad.length < 6) bad.push({ run, off, r }); }
  }
  if (segBad) segFail++;
}

console.log(`台阶地段：${kept.length} 条（连续 >= ${MIN_LEN} 阶，每阶 ${STEP_MIN}~${STAIR_MAX} m），`
  + `每条扫 ${PHASES} 个接近相位，共 ${trials} 次试走`);
for (const b of bad) {
  const k0 = b.run.cells[0], kT = b.run.cells[b.run.cells.length - 1];
  const how = !b.r.passed ? `卡在半路（只走了 ${b.r.maxAlong.toFixed(2)}m / 需 ${b.r.distTop.toFixed(2)}m）`
    : b.r.slips ? `爬上去又掉回来 ${b.r.slips} 次` : `越过坡顶时只有 ${b.r.yAtTop.toFixed(2)}m`;
  console.log(`  失败 off=${b.off.toFixed(2)} 起于 (${cx(k0).toFixed(1)}, ${cz(k0).toFixed(1)}) 朝 `
    + `${['+x(东)', '+z(北)', '-x(西)', '-z(南)'][b.run.d]} `
    + `${b.run.cells.length - 1} 阶 ${nav.ground[k0].toFixed(2)} -> ${nav.ground[kT].toFixed(2)}`
    + `　${how}　y: ${b.r.trace.join(' ')}`);
}
if (segFail) console.log(`\n失败：${segFail}/${kept.length} 条地段走不上去，${trialFail}/${trials} 次试走失败`);
else console.log(`\n通过：${kept.length}/${kept.length} 条地段全部走通，${trials} 次试走 0 失败`);
process.exit(segFail ? 1 : 0);
