// de_dust2 走一遍全图的抽检：随机取可走格，八个方向按住 W 走几秒，看会不会：
//   stuck  没走动（既没掉下去也没挪窝）
//   buried 结束时人埋在实体里（卡进墙/箱子里，玩家体感就是「掉到里面」）
//   void   掉出世界（低于 voidY）
//   offnav 走完停在导航认为不可走的地方（导航与物理口径不一致）
// 台阶类的 bug 请用 probe-steps.mjs 看：那种抖动是亚帧级的，
// 随机起点抽检经常正好落在能过的一侧，这里看不出来。
//
// 用法：node tools/probe-walk.mjs [采样格数] [每方向按住几秒] [随机种子]
//   默认 node tools/probe-walk.mjs 400 1.6 1
import { World, NavGrid, STEP_H } from '../src/physics.js';
import { decodeGeo, navField, makeSampler, addColliders, carveDoorways } from '../src/maps/geo.js';
import { LAYOUT, DOORS } from '../src/maps/dust2-layout.js';

const SAMPLES = +(process.argv[2] || 400);
const SECONDS = +(process.argv[3] || 1.6);
const SEED = +(process.argv[4] || 1);

const GRAV = 19, RUN = 5.7, VOID_Y = -5.5;
const RADIUS = 0.36, HEIGHT = 1.8;
const DT = 1 / 60;

// 固定种子的 LCG：同一份数据每次跑出来的抽检点一样，方便对比前后
let seed = SEED >>> 0;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const G = await decodeGeo();
const S = makeSampler(G);
const world = new World();
addColliders(world, G, LAYOUT.bounds, S);
carveDoorways(world, S, DOORS);
const N = LAYOUT.nav;
const nav = new NavGrid(world, N.x0, N.z0, N.x1, N.z1, N.cell, N.r, navField(G));

const cx = (k) => N.x0 + ((k % nav.w) + 0.5) * N.cell;
const cz = (k) => N.z0 + (((k / nav.w) | 0) + 0.5) * N.cell;
const cellOf = (x, z) => {
  const i = Math.floor((x - N.x0) / N.cell), j = Math.floor((z - N.z0) / N.cell);
  if (i < 0 || j < 0 || i >= nav.w || j >= nav.h) return -1;
  return j * nav.w + i;
};

const walkable = [];
for (let k = 0; k < nav.w * nav.h; k++) if (!nav.block[k]) walkable.push(k);

function walk(k, yaw) {
  const dirx = -Math.sin(yaw), dirz = -Math.cos(yaw);   // 与 Actor.forward 一致
  const sx = cx(k), sz = cz(k);
  const ent = {
    pos: { x: sx, y: nav.ground[k], z: sz }, vel: { x: 0, y: 0, z: 0 },
    radius: RADIUS, height: HEIGHT, stepHeight: STEP_H,
    onGround: true, ground: null, stepped: 0,
  };
  const steps = Math.round(SECONDS / DT);
  for (let f = 0; f < steps; f++) {
    const v = ent.vel;
    if (ent.onGround) {
      const sp = Math.hypot(v.x, v.z);
      if (sp > 0) {
        const drop = Math.max(sp, 1.5) * 9 * DT;
        const ns = Math.max(0, sp - drop) / sp;
        v.x *= ns; v.z *= ns;
      }
      const cur = v.x * dirx + v.z * dirz, add = RUN - cur;
      if (add > 0) { const acc = Math.min(11 * DT * RUN, add); v.x += acc * dirx; v.z += acc * dirz; }
    } else {
      const cur = v.x * dirx + v.z * dirz, add = Math.min(RUN, 1.2) - cur;
      if (add > 0) { const acc = Math.min(12 * DT * Math.min(RUN, 1.2), add); v.x += acc * dirx; v.z += acc * dirz; }
    }
    v.y -= GRAV * DT;
    world.move(ent, DT);
  }
  const p = ent.pos;
  const moved = Math.hypot(p.x - sx, p.z - sz);
  const nk = cellOf(p.x, p.z);
  // 「埋进实体」必须是身子真的在墙里：只认占住中心立柱、且高出脚面 0.3m 以上的实体。
  // 用 blocked() 那种整段胶囊判定，脚边一级 0.16m 的坎都会误报。
  const buried = (() => {
    const o = {};
    for (const c of world.query(p.x - 0.3, p.z - 0.3, p.x + 0.3, p.z + 0.3)) {
      if (!c.solid) continue;
      if (c.top <= p.y + 0.3 || c.bottom >= p.y + HEIGHT - 0.1) continue;
      if (World.circleOBB(c, p.x, p.z, 0.1, o)) return true;
    }
    return false;
  })();
  const out = { moved, y: p.y, x: p.x, z: p.z, kind: 'ok' };
  if (p.y < VOID_Y) out.kind = 'void';
  else if (buried) out.kind = 'buried';
  else if (moved < 0.5) {
    // 没走动要分两种：鼻子前面就是墙（正常，玩家自己会拐弯），
    // 和导航明明说这一步能走、物理却把人钉住（导航与物理口径不一致，是真问题）。
    const ax = sx + dirx * 0.9, az = sz + dirz * 0.9;
    const ak = cellOf(ax, az);
    out.kind = ak >= 0 && !nav.block[ak] && nav.ground[ak] - nav.ground[k] <= STEP_H ? 'stuck' : 'walled';
  } else if (nk < 0 && Math.abs(p.x) < 200 && Math.abs(p.z) < 200) out.kind = 'offnav';
  return out;
}

const tally = { ok: 0, stuck: 0, walled: 0, buried: 0, void: 0, offnav: 0 };
const report = { stuck: [], walled: [], buried: [], void: [], offnav: [] };
let trials = 0;
for (let s = 0; s < SAMPLES; s++) {
  const k = walkable[(rnd() * walkable.length) | 0];
  for (let d = 0; d < 8; d++) {
    const r = walk(k, (d * Math.PI) / 4);
    trials++;
    tally[r.kind]++;
    if (r.kind !== 'ok' && report[r.kind].length < 8) {
      report[r.kind].push(`(${cx(k).toFixed(1)}, ${cz(k).toFixed(1)}) 朝 ${Math.round((d * 45))}° `
        + `→ (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) y=${r.y.toFixed(2)} 位移 ${r.moved.toFixed(2)}m`);
    }
  }
}

console.log(`抽检 ${SAMPLES} 个可走格 × 8 个方向 = ${trials} 次，每次按住 W ${SECONDS}s（种子 ${SEED}）`);
console.log(`可走格 ${walkable.length} / ${nav.w * nav.h}`);
console.log(`正常 ${tally.ok}，导航说能走但被钉住 ${tally.stuck}，鼻子顶着墙 ${tally.walled}，`
  + `埋进实体 ${tally.buried}，掉出世界 ${tally.void}，走出导航 ${tally.offnav}`);
const LABEL = { stuck: '导航说能走但被钉住', buried: '埋进实体', void: '掉出世界', offnav: '走出导航' };
for (const kind of ['void', 'buried', 'stuck', 'offnav']) {
  if (!report[kind].length) continue;
  console.log(`\n${LABEL[kind]}（最多列 8 条）：`);
  for (const line of report[kind]) console.log('  ' + line);
}
