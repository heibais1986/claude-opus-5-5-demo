// de_dust2「门洞后旋转楼梯」回归探针。
//
// 那个 bug：长道门洞后是一段绕圈上升的楼梯，碰撞数据把踏面量化成了一串高低不一的台阶
// （实测 0.47、0.52），比角色 stepHeight 高出十几厘米。World.move 的上台阶判据
// （rise <= ent.stepHeight）不成立，就走到「推开 + 吃掉水平速度」那一支：人既不往上迈，
// 也一步挪不动，原地钉死，只能后退再按空格。玩家体感就是「门洞后的旋转楼梯走不通」。
//
// 为什么单开一个探针：probe-steps 只认「同一方向连续上台阶」的直坡，这段楼梯是绕圈的，
// 直线段凑不满它要求的连续阶数，所以它看不见这里——实测把 stepHeight 调回 0.42 时
// probe-steps 会红（别处的直坡），但这道门洞后的楼梯得靠这个探针盯着。
//
// 判据：从门洞里沿一排平行走线各按 8 秒 W，每条都必须爬完整段（爬到 y > -0.5，
// 也就是从门洞地面 -4.64 爬上来约 4.2m 以上）；只要有走线被钉住就退出码 1。
//
// 实测（20 条走线能爬上去几条）：
//   stepHeight 0.42 -> 6/20    0.50 -> 13/20    0.55 -> 20/20    0.60 -> 20/20
// 所以 STEP_H 定在 0.55：刚好够用，再大就白送玩家迈上本该跳的箱子。
//
// 用法：node tools/probe-doorstairs.mjs [走线间距(米)]
import { World, STEP_H } from '../src/physics.js';
import { decodeGeo, makeSampler, addColliders, carveDoorways } from '../src/maps/geo.js';
import { LAYOUT, DOORS } from '../src/maps/dust2-layout.js';

const GRAV = 19, RUN = 5.7, RADIUS = 0.36, HEIGHT = 1.8, DT = 1 / 60;
const FRAMES = 8 * 60;              // 8 秒：这段楼梯总升高约 4.2m，足够宽裕
const PASS_Y = -0.5;                // 爬过这个高度才算真的走上去了

const GAP = +(process.argv[2] || 0.25);

const G = await decodeGeo();
const S = makeSampler(G);
const world = new World();
addColliders(world, G, LAYOUT.bounds, S);
carveDoorways(world, S, DOORS);

const D = DOORS.find((d) => d.id === 'long');
console.log(`长道门洞 x ${D.x0}~${D.x1}  z ${D.z0}~${D.z1}  地面 ${D.ground.toFixed(2)}   stepHeight=${STEP_H}`);
console.log(`从门洞里往北各按 ${FRAMES / 60} 秒 W，走线间距 ${GAP}m\n`);
console.log('  起点x     终点x     终点y     终点z     爬升    最高y    判定');

function walkNorth(x) {
  const ent = {
    pos: { x, y: D.ground + 0.05, z: (D.z0 + D.z1) / 2 }, vel: { x: 0, y: 0, z: 0 },
    radius: RADIUS, height: HEIGHT, stepHeight: STEP_H, onGround: true, ground: null, stepped: 0,
  };
  let maxY = ent.pos.y, maxZ = ent.pos.z;
  for (let f = 0; f < FRAMES; f++) {
    const v = ent.vel;
    if (ent.onGround) {
      const sp = Math.hypot(v.x, v.z);
      if (sp > 0) { const drop = Math.max(sp, 1.5) * 9 * DT; const ns = Math.max(0, sp - drop) / sp; v.x *= ns; v.z *= ns; }
      const add = RUN - v.z;
      if (add > 0) { const acc = Math.min(11 * DT * RUN, add); v.z += acc; }
    } else {
      const add = Math.min(RUN, 1.2) - v.z;
      if (add > 0) { const acc = Math.min(12 * DT * Math.min(RUN, 1.2), add); v.z += acc; }
    }
    v.y -= GRAV * DT;
    world.move(ent, DT);
    if (ent.pos.y > maxY) { maxY = ent.pos.y; maxZ = ent.pos.z; }
  }
  return { x, fx: ent.pos.x, fy: ent.pos.y, fz: ent.pos.z, maxY, maxZ, ok: maxY > PASS_Y };
}

const rows = [];
for (let x = D.x0 + 0.4; x <= D.x1 - 0.4 + 1e-9; x += GAP) rows.push(walkNorth(x));
for (const r of rows) {
  console.log(`  ${r.x.toFixed(2).padStart(6)}  ${r.fx.toFixed(2).padStart(7)}  ${r.fy.toFixed(2).padStart(7)}`
    + `  ${r.fz.toFixed(1).padStart(7)}  ${(r.fy - D.ground).toFixed(2).padStart(6)}`
    + `  ${r.maxY.toFixed(2).padStart(7)}    ${r.ok ? '走上去了' : `钉死在 y=${r.maxY.toFixed(2)} @z=${r.maxZ.toFixed(1)}`}`);
}
const pass = rows.filter((r) => r.ok).length;
console.log(`\n门洞后楼梯：${pass}/${rows.length} 条走线走得上去`);
if (pass < rows.length) {
  const worst = rows.filter((r) => !r.ok).map((r) => r.maxY);
  console.log(`走不上去的走线最高只到 y=${Math.max(...worst).toFixed(2)}`
    + `（门洞地面 ${D.ground.toFixed(2)}，需爬过 ${PASS_Y.toFixed(2)}）`);
  console.log('==> 失败：门洞后的楼梯仍有走线被钉死');
  process.exit(1);
}
console.log('==> 通过：每条走线都能从门洞里一直走上去');
