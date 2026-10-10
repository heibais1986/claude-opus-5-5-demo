// 无浏览器对局校验：在 Node 里驱动真实的 Bot/Actor 打一场 bot-only 对局。
// 世界、导航、出生点都走运行时同一条路径，只有渲染与音频用空壳替掉。
// 用法：node tools/sim.mjs [dust2|ship] [秒数]，SEED=1 可换一场对局
import * as THREE from 'three';
import { World, NavGrid } from '../src/physics.js';
import { Bot } from '../src/bots.js';
import { WEAPONS, jitterDir } from '../src/weapons.js';

const id = process.argv[2] || 'dust2';
const SECS = Number(process.argv[3] || 180);
const DT = 1 / 30;

// 固定种子：改动前后要能逐字对比同一场对局
{
  let s = Number(process.env.SEED || 20261009) | 0;
  Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s < 0 ? ~s + 1 : s) % 1e8) / 1e8; };
}

// 2D 画布替身：角色贴图 / 甲板 AO 只是像素工作，模拟里全走空实现
const noop = () => {};
function fakeCanvas() {
  const ctx = {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop, fillRect: noop, clearRect: noop, drawImage: noop,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop, setTransform: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, arc: noop, rect: noop,
    measureText: () => ({ width: 10 }), fillText: noop,
    createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null, clip: noop, quadraticCurveTo: noop, bezierCurveTo: noop, ellipse: noop,
    strokeRect: noop, roundRect: noop, setLineDash: noop, arcTo: noop,
  };
  const cv = { width: 0, height: 0, style: {}, getContext: () => ctx };
  ctx.canvas = cv;
  return cv;
}
globalThis.document = { createElement: fakeCanvas };

// ---------- 地图装配 ----------
let world, nav, spawns, botRoutes, voidY = -3;
if (id === 'dust2') {
  const { decodeGeo, navField, makeSampler, addColliders, buildSpawns } = await import('../src/maps/geo.js');
  const { LAYOUT } = await import('../src/maps/dust2-layout.js');
  const { MESH_SPAWNS } = await import('../src/maps/dust2-geo.js');
  const G = await decodeGeo();
  const S = makeSampler(G);
  world = new World();
  addColliders(world, G, LAYOUT.bounds, S);
  const n = LAYOUT.nav;
  nav = new NavGrid(world, n.x0, n.z0, n.x1, n.z1, n.cell, n.r, navField(G));
  spawns = { BL: buildSpawns(MESH_SPAWNS.T, 10, LAYOUT.spawnYaw.BL, S), GR: buildSpawns(MESH_SPAWNS.CT, 10, LAYOUT.spawnYaw.GR, S) };
  botRoutes = LAYOUT.bot;
  voidY = (await import('../src/maps/dust2.js')).dust2Map.voidY;
} else {
  // 运输船：只需要碰撞体与出生点，纹理用最小替身（材质拿到的 map 是 undefined 也无妨）
  const { buildMap } = await import('../src/map.js');
  const { shipMap } = await import('../src/maps/ship.js');
  const { buildTextures } = await import('../src/textures.js');
  world = new World();
  const T = buildTextures(1, shipMap.textures);
  const m = buildMap(new THREE.Scene(), T, world, {});
  spawns = m.spawns;
  const n = shipMap.nav;
  nav = new NavGrid(world, n.x0, n.z0, n.x1, n.z1, n.cell, n.r, undefined);
  botRoutes = null;
}

// ---------- 假 game：只保留 AI 与武器状态机需要的部分 ----------
let pathNulls = 0, pathTries = 0;
const nullWhy = {}, nullEG = {};
const realFind = nav.findPath.bind(nav);
nav.findPath = (ax, az, bx, bz, ay) => {
  pathTries++;
  const p = realFind(ax, az, bx, bz, ay);
  if (!p) {
    pathNulls++;
    const why = (k) => (k < 0 ? '出界' : !nav.block[k] ? 'ok' : nav.nearestFree(k, ay) < 0 ? '孤岛' : 'ok');
    const r = `起${why(nav.idx(ax, az))} 终${why(nav.idx(bx, bz))}`;
    nullWhy[r] = (nullWhy[r] || 0) + 1;
    if (!nullEG[r]) nullEG[r] = `(${ax.toFixed(1)},${az.toFixed(1)})->(${bx.toFixed(1)},${bz.toFixed(1)})`;
  }
  return p;
};

const game = {
  time: 0, frame: 0, world, nav, actors: [], def: { bot: botRoutes, voidY },
  renderer: { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() },
  onFootstep() {}, onSwitch() {}, onReloadDone() {}, onScope() {}, onDryFire() {}, onGrenadeStart() {},
  onJump() {}, onLand() {}, throwGrenade() {}, melee() {}, onReloadStart() {},
  fireWeapon(a, ws, spread) {
    const d = ws.def;
    const eye = a.eye(new THREE.Vector3());
    const dir = a.forward(new THREE.Vector3());
    jitterDir(dir, spread, Math.random);
    for (const b of this.actors) if (b !== a && b.team !== a.team && b.pos.distanceTo(a.pos) < 45) b.hear(a.pos, true);
    this.traceBullet(a, eye, dir, d);
  },
  traceBullet(shooter, o, dir, d) {
    const range = d.range;
    const hits = this.world.raycastAll(o.x, o.y, o.z, dir.x, dir.y, dir.z, range);
    let power = d.pen, mul = 1, wall = false, from = 0;
    this.frame++;
    for (let i = 0; i <= hits.length; i++) {
      const h = hits[i];
      const lim = h ? h.t : range;
      let best = null, bestT = lim, part = null;
      for (const a of this.actors) {
        if (!a.alive || a === shooter || a.team === shooter.team) continue;
        const r = a.soldier.hitTest(o, dir, bestT, this.frame);
        if (r && r.t > from - 0.01 && r.t < bestT) { best = a; bestT = r.t; part = r.part; }
      }
      if (best) { this.damage(best, shooter, d.dmg * mul * Math.pow(d.falloff, bestT / 10) * (part === 'head' ? d.headMul : part === 'arm' || part === 'leg' ? d.limbMul : 1), part, d.id, dir, wall); return; }
      if (!h) return;
      if (h.collider.bullet === 'pen') {
        const cost = (h.exit - h.t) * (h.collider.mat === 'wood' ? 1.0 : 1.9);
        if (power > cost) { power -= cost; mul *= 0.6; wall = true; from = h.exit; continue; }
      }
      return;
    }
  },
  damage(v, att, amt, part, wid, dir, wall) {
    if (!v.alive || v.protectT > 0) return;
    if (!att || att === v || att.team === v.team) return;
    const def = WEAPONS[wid];
    let hpD = amt;
    if (v.armor > 0 && part !== 'leg') { const ap = def?.armorPen ?? 0.75; hpD = amt * ap; v.armor = Math.max(0, v.armor - amt * (1 - ap) * 1.4); }
    v.hp -= hpD;
    v.lastAttacker = att; v.lastHurt = this.time;
    att.stats.hits++;
    if (v.onDamaged) v.onDamaged(att);
    if (v.hp <= 0) this.kill(v, att, part === 'head', dir);
  },
  kill(v, att, hs, dir) {
    v.alive = false; v.hp = 0; v.deadT = 0; v.respawnT = 4.0; v.stats.d++; v.scoped = 0;
    att.stats.k++; if (hs) att.stats.hs++;
    kills[att.team]++;
  },
};

// ---------- 出生 ----------
const N = 5;
const prim = (team, i) => (i === 1 ? 'awm' : i === 3 ? 'mp5' : team === 'BL' ? 'ak47' : 'm4a1');
const kills = { BL: 0, GR: 0 };
const bots = [];
let uid = 0;
for (const team of ['BL', 'GR']) {
  for (let i = 0; i < N; i++) {
    const b = new Bot(game, { id: uid++, name: `${team}${i}`, team, diff: 'normal' });
    b.primary = prim(team, i);
    game.actors.push(b);
    bots.push(b);
  }
}
function spawnActor(a) {
  const pts = spawns[a.team];
  let best = null, bestScore = -1e9;
  for (const p of pts) {
    let sc = Math.random() * 3;
    for (const o of game.actors) {
      if (!o.alive || o === a) continue;
      const d = Math.hypot(o.pos.x - p.x, o.pos.z - p.z);
      if (d < 1.2) sc -= 100;
      if (o.team !== a.team) sc += Math.min(d, 40) * 0.1;
    }
    if (sc > bestScore) { bestScore = sc; best = p; }
  }
  a.spawn(best);
  a.onSpawn();
}
for (const a of game.actors) spawnActor(a);

// ---------- 主循环（复刻 game.simulate 中与 AI 相关的部分） ----------
const W = 10;                     // 卡住检测窗口（秒）
const SITES = id === 'dust2' ? await dust2Sites() : [{ id: 'CT', x: 34, z: 0 }, { id: 'BL', x: -34, z: 0 }];
async function dust2Sites() {
  const { MESH_SITES } = await import('../src/maps/dust2-geo.js');
  return [['A', MESH_SITES.A], ['B', MESH_SITES.B]].map(([id, s]) => ({ id, x: s.x, z: s.z }));
}
const stat = bots.map((b) => ({
  bot: b, last: null, wedge: [], NaNs: 0, goals: 0, home: null, far: 0,
  sites: new Set(), firstContact: -1, contacts: 0, goalKey: '', goalAge: 0, stalls: 0,
}));
let tick = 0, repairs = 0;
const t0 = Date.now();
for (game.time = 0; game.time < SECS; game.time += DT, tick++) {
  for (const a of game.actors) {
    if (a.alive) { a.protectT = Math.max(0, a.protectT - DT); a.update(DT); }
    else { a.deadT += DT; a.respawnT -= DT; if (a.respawnT <= 0) spawnActor(a); }
    if (!Number.isFinite(a.pos.x) || !Number.isFinite(a.pos.y) || !Number.isFinite(a.pos.z)) {
      const s = stat[bots.indexOf(a)]; s.NaNs++; a.pos.set(0, 0, 0); a.vel.set(0, 0, 0);
    }
    if (a.alive && a.pos.y < voidY) repairs++;
  }
  for (const a of game.actors) {
    if (!a.alive) continue;
    const s = a.soldier;
    s.root.position.copy(a.pos); s.root.rotation.y = a.yaw;
    const fwd = (a.vel.x * -Math.sin(a.yaw) + a.vel.z * -Math.cos(a.yaw)) / Math.max(0.01, a.speed || 0);
    s.update(DT, { speed: a.speed || 0, fwd, crouch: a.crouch, pitch: a.pitch + a.punchP, onGround: a.onGround, reloading: a.weapon?.reloading });
  }
  if (tick % Math.round(W / DT) === 0) {
    for (const s of stat) {
      const b = s.bot;
      const prev = s.last;
      s.last = [b.pos.x, b.pos.z];
      if (!b.alive || !prev || b.role === 'hold') continue;
      if (Math.hypot(b.pos.x - prev[0], b.pos.z - prev[1]) < 4) {
        const wp = b.path && b.pi < b.path.length ? b.path[b.pi] : null;
        let diag = '';
        if (wp) {
          const dx = wp[0] - b.pos.x, dz = wp[1] - b.pos.z, dd = Math.hypot(dx, dz) || 1;
          const ux = dx / dd, uz = dz / dd;
          const ray = [0.4, 0.8, 1.4].map((t) =>
            (world.blocked(b.pos.x + ux * t, b.pos.y + 0.05, b.pos.z + uz * t, 0.336, 1.7) ? 'X' : '.'));
          const sup = world.support(b.pos.x, b.pos.z, 0.336, b.pos.y + 0.6);
          const c = sup?.collider;
          diag = ` wp(${wp[0].toFixed(1)},${wp[1].toFixed(1)} d${dd.toFixed(1)}) ray${ray.join('')}`
            + ` 站${sup ? `${c.tag}/${c.mat} y[${c.bottom.toFixed(1)},${c.top.toFixed(1)}] ${(c.hx * 2).toFixed(1)}x${(c.hz * 2).toFixed(1)}@(${c.x.toFixed(1)},${c.z.toFixed(1)})` : '空'}`
            + ` onG${b.onGround ? 1 : 0} vy${b.vel.y.toFixed(1)} spd${(b.speed || 0).toFixed(1)}`;
        }
        s.wedge.push(`${game.time | 0}s@(${b.pos.x.toFixed(1)},${b.pos.z.toFixed(1)} y${b.pos.y.toFixed(1)} goal(${(b.goal || [NaN, NaN]).map((v) => (+v).toFixed(1)).join(',')}) pi${b.pi}/${b.path ? b.path.length : '-'}${diag}`);
      }
    }
  }
  if (tick % 6 === 0) {
    for (const s of stat) {
      const b = s.bot;
      if (!b.alive) continue;
      if (b.home === null || s.home === null) s.home = [b.pos.x, b.pos.z];
      s.far = Math.max(s.far, Math.hypot(b.pos.x - s.home[0], b.pos.z - s.home[1]));
      for (const st of SITES) if (Math.hypot(b.pos.x - st.x, b.pos.z - st.z) < 9) s.sites.add(st.id);
      if (b.visible && s.firstContact < 0) s.firstContact = game.time;
      if (b.visible && !s.wasVisible) s.contacts++;
      s.wasVisible = b.visible;
      const key = b.goal ? b.goal.join(',') + b.role : 'none';
      if (key === s.goalKey) s.goalAge += 0.2;
      else {
        if (s.goalAge > 20 && b.role !== 'hold') s.stalls++;
        s.goalKey = key; s.goalAge = 0;
      }
      if (b.goal) {
        const d = Math.hypot(b.pos.x - b.goal[0], b.pos.z - b.goal[1]);
        if (d < 2.5) { s.goals++; b.goal = null; }
      }
    }
  }
}

// ---------- 报告 ----------
console.log(`\n[${id}] ${SECS}s 模拟（${tick} tick，${((Date.now() - t0) / 1000).toFixed(1)}s 墙钟）`);
console.log(`寻路：请求 ${pathTries}，失败 ${pathNulls}（${((pathNulls / Math.max(1, pathTries)) * 100).toFixed(1)}%）`);
for (const [k, v] of Object.entries(nullWhy)) console.log(`  失败原因 ${k} x${v} 例 ${nullEG[k]}`);
console.log(`导航：可走 ${nav.w * nav.h - nav.block.reduce((a, b) => a + b, 0)}，剔除无地面 ${nav.noFloor ?? 0}，埋进墙里 ${nav.buried ?? 0}，剪掉碎片 ${nav.dropped?.cut ?? 0}`);
console.log(`兜底：掉出世界 ${repairs} 次，NaN ${stat.reduce((a, s) => a + s.NaNs, 0)} 次`);
console.log(`击杀 BL ${kills.BL} / GR ${kills.GR}，爆头 ${game.actors.reduce((a, x) => a + x.stats.hs, 0)}`);
for (const a of game.actors) {
  const s = stat[bots.indexOf(a)];
  console.log(
    `${a.name} ${a.role.padEnd(5)} K${a.stats.k}/D${a.stats.d} 命中${a.stats.hits}/${a.stats.shots}` +
    ` 到位${s.goals} 深入${s.far.toFixed(0)}m 进点[${[...s.sites].join('')}]` +
    ` 首见${s.firstContact < 0 ? '--' : s.firstContact.toFixed(0) + 's'} 遭遇${s.contacts} 卡窗${s.wedge.length} 僵持${s.stalls}`);
}
for (const s of stat) for (const w of s.wedge.slice(0, 3)) console.log(`  !! ${s.bot.name} 卡住 ${w}`);
