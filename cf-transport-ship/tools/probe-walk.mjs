// 地图可走性巡检：在真实碰撞体上到处「按住 W」走一遍，统计
//   卡住（导航说通、物理走不动）、身体埋进实体、掉出世界。
// 用法：node tools/probe-walk.mjs [采样点数] [每方向秒数]
import { World, NavGrid } from '../src/physics.js';
import { decodeGeo, makeSampler, addColliders, carveDoorways, navField } from '../src/maps/geo.js';
import { LAYOUT, DOORS } from '../src/maps/dust2-layout.js';

const SAMPLES = Number(process.argv[2] ?? 400);
const SECS = Number(process.argv[3] ?? 1.6);

const G = await decodeGeo();
const S = makeSampler(G);
const world = new World();
addColliders(world, G, LAYOUT.bounds, S);
carveDoorways(world, S, DOORS);
const n = LAYOUT.nav;
const nav = new NavGrid(world, n.x0, n.z0, n.x1, n.z1, n.cell, n.r, navField(G));
const VOIDY = -5.5;

const GRAV = 19, RUN = 5.7, R = 0.36, H = 1.8, STEP = 0.42;
let seed = 20261018;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed < 0 ? ~seed + 1 : seed) % 1e8) / 1e8; };

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const navSaysWalkable = (i, j, d) => {
  const [di, dj] = DIRS[d];
  if (!di || !dj) return nav.linkOk(j * nav.w + i, di, dj);
  return nav.linkOk(j * nav.w + i, di, 0) && nav.linkOk(j * nav.w + i, 0, dj)
    && nav.linkOk((j + dj) * nav.w + i, 0, dj) && nav.linkOk(j * nav.w + (i + di), di, 0);
};

function walkFrom(x, z, y, wx, wz) {
  const w = {
    pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 },
    radius: R, height: H, stepHeight: STEP, onGround: true, ground: null, stepped: 0,
  };
  const dt = 1 / 60;
  const L = Math.hypot(wx, wz);
  const ux = wx / L, uz = wz / L;
  let maxProgress = 0, stuckFor = 0, maxStuck = 0, inside = 0;
  let end = null;
  for (let t = 0; t < SECS; t += dt) {
    const v = w.vel;
    if (w.onGround) {
      const sp = Math.hypot(v.x, v.z);
      if (sp > 0) { const ns = Math.max(0, sp - Math.max(sp, 1.5) * 9 * dt) / sp; v.x *= ns; v.z *= ns; }
      const cur = v.x * ux + v.z * uz, add = RUN - cur;
      if (add > 0) { const acc = Math.min(11 * dt * RUN, add); v.x += acc * ux; v.z += acc * uz; }
    } else {
      const ws = Math.min(RUN, 1.2), cur = v.x * ux + v.z * uz, add = ws - cur;
      if (add > 0) { const acc = Math.min(12 * dt * ws, add); v.x += acc * ux; v.z += acc * uz; }
    }
    v.y -= GRAV * dt;
    world.move(w, dt);
    const prog = w.pos.x * ux + w.pos.z * uz;
    if (prog > maxProgress + 1e-4) { maxProgress = prog; stuckFor = 0; } else stuckFor += dt;
    maxStuck = Math.max(maxStuck, stuckFor);
    // 身体真的插进实体里：以胶囊体积问一次
    if (world.blocked(w.pos.x, w.pos.y + 0.05, w.pos.z, R * 0.8, H - 0.15)) inside++;
    end = [w.pos.x, w.pos.y, w.pos.z];
    if (w.pos.y < VOIDY) return { void: true, end };
  }
  return {
    progress: maxProgress - (x * ux + z * uz), maxStuck, inside, end,
    onGround: w.onGround,
  };
}

const cells = [];
for (let k = 0; k < nav.w * nav.h; k++) if (!nav.block[k]) cells.push(k);
let stuck = 0, insideN = 0, voidN = 0, offEdge = 0, tested = 0;
const bad = [];
for (let s = 0; s < SAMPLES; s++) {
  const k = cells[(rnd() * cells.length) | 0];
  const i = k % nav.w, j = (k / nav.w) | 0;
  const [x, z] = nav.center(k);
  // 起点脚底要站在「这一格导航真正指的地面」上：NavGrid.ground 已经是物理实测面，
  // 用 support(..., Infinity) 取最高面会把人放到头顶的棚顶上（中路走廊、门洞都有），
  // 在那上面测出来的卡住全是假象。
  const sup = world.support(x, z, R, nav.ground[k] + 0.5);
  if (!sup) continue;
  const y = sup.y + 0.02;
  for (let d = 0; d < DIRS.length; d++) {
    const [di, dj] = DIRS[d];
    tested++;
    const r = walkFrom(x, z, y, di, dj);
    if (r.void) {
      // 只有「导航说这边能走」才算缺陷：否则只是探针按住 W 走出了地图边界，
      // 那是断崖边缘的正常坠落，不该算进体检结论里
      if (navSaysWalkable(i, j, d)) { voidN++; bad.push({ kind: '掉出世界', at: [x, y, z], dir: DIRS[d], end: r.end }); }
      else offEdge++;
      continue;
    }
    if (r.inside > 30) { insideN++; bad.push({ kind: `陷进实体 ${(r.inside / 60).toFixed(1)}s`, at: [x, y, z], dir: DIRS[d], end: r.end }); }
    else if (navSaysWalkable(i, j, d) && r.progress < 0.4 && r.maxStuck > 0.8) {
      stuck++;
      bad.push({ kind: `导航说通但走不动（推进 ${r.progress.toFixed(2)}m，顶 ${r.maxStuck.toFixed(1)}s）`, at: [x, y, z], dir: DIRS[d], end: r.end });
    }
  }
}
console.log(`巡检 ${SAMPLES} 个可走格 × 8 方向 = ${tested} 次：卡住 ${stuck}，陷进实体 ${insideN}，掉出世界 ${voidN}（另有 ${offEdge} 次是走出导航边界后的正常坠落，不计）`);
const byKind = {};
for (const b of bad) { const key = b.kind.split(/[（ ]/)[0]; byKind[key] = (byKind[key] || 0) + 1; }
console.log('分类', JSON.stringify(byKind));
for (const b of bad.slice(0, 30)) {
  console.log(`  ${b.kind}  起点(${b.at.map((v) => (+v).toFixed(1)).join(',')})  方向(${b.dir.join(',')})  停在(${b.end.map((v) => (+v).toFixed(1)).join(',')})`);
}
