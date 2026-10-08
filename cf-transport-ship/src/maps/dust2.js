// de_dust2 地图构建：把 dust2-layout.js 的纯数据渲染成合批网格 + 碰撞体
import * as THREE from 'three';
import { createBuilder } from '../mapkit.js';
import { LAYOUT, buildBoxes } from './dust2-layout.js';

// 布局材质 -> 碰撞材质（命中特效只区分 wood / 其他）
const CMAT = { adobe: 'concrete', adobeDark: 'concrete', door: 'wood', crate: 'wood', wood: 'wood', stone: 'concrete', barrel: 'metal', truck: 'metal', container: 'metal', metal: 'metal' };
// 布局材质 -> 外观材质（未列出的一律走土砖墙）
const SIDE = { door: 'door', wood: 'wood', crate: 'crate', stone: 'stone', metal: 'metal', container: 'container', truck: 'metal', adobeDark: 'adobeDark' };
// 可以站上去的台面用石板顶，其余用压顶石
const FLAT_TOP = new Set(['dais', 'catwalk', 'scaffold', 'pit', 'low']);

export function buildDust2(scene, T, world) {
  const kb = createBuilder(scene, T, world, 7731);
  const { matDefs, lampSpots, anim, std, defMat, box, solid, geom, rod, flush, cylG, cylG8, sphG } = kb;
  const D = T.desert;

  defMat('sand', std({ map: D.sand.map, normalMap: D.sand.normalMap, roughnessMap: D.sand.roughnessMap, roughness: 1, metalness: 0, normalScale: new THREE.Vector2(0.7, 0.7), envMapIntensity: 0.35 }), 5, { shadow: false });
  defMat('farGround', std({ color: 0xc2a473, roughness: 1, metalness: 0, fog: true }), 40, { shadow: false });
  defMat('adobe', std({ map: D.adobe.map, normalMap: D.adobe.normalMap, roughness: 0.95, metalness: 0, normalScale: new THREE.Vector2(1.1, 1.1) }), 3);
  defMat('adobeDark', std({ map: D.adobe.map, color: 0xb8ab92, normalMap: D.adobe.normalMap, roughness: 0.95, metalness: 0 }), 3);
  defMat('cap', std({ map: D.stone.map, normalMap: D.stone.normalMap, roughness: 0.9, metalness: 0 }), 2);
  defMat('stone', std({ map: D.stone.map, normalMap: D.stone.normalMap, roughness: 0.92, metalness: 0, normalScale: new THREE.Vector2(0.9, 0.9) }), 1.6);
  defMat('crate', std({ map: D.crate.map, normalMap: D.crate.normalMap, roughness: 0.85, metalness: 0.02 }), 1);
  defMat('wood', std({ map: D.crate.map, color: 0xa8855c, normalMap: D.crate.normalMap, roughness: 0.9, metalness: 0 }), 1);
  defMat('door', std({ map: D.door.map, normalMap: D.door.normalMap, roughness: 0.8, metalness: 0.05 }), 'unit');
  defMat('metal', std({ map: D.metal.map, normalMap: D.metal.normalMap, roughness: 0.7, metalness: 0.35 }), 1.2);
  defMat('container', std({ map: D.metal.map, color: 0x3f7f9e, normalMap: D.metal.normalMap, roughness: 0.68, metalness: 0.4 }), 1.4);
  defMat('truckTop', std({ map: D.metal.map, color: 0xb08a5a, normalMap: D.metal.normalMap, roughness: 0.75, metalness: 0.3 }), 1.2);
  defMat('black', std({ color: 0x23201c, roughness: 0.9, metalness: 0.05 }), 1);
  defMat('lamp', std({ color: 0xfff2d0, emissive: 0xffe2a8, emissiveIntensity: 3.5, roughness: 0.3 }), 1, { shadow: false });

  // ---------- 地面 ----------
  box(0, -0.25, 0, LAYOUT.ground.w, 0.5, LAYOUT.ground.d, 0, { py: 'sand' });
  solid(0, -0.25, 0, LAYOUT.ground.w, 0.5, LAYOUT.ground.d, 0, { mat: 'concrete', surface: 'sand', tag: 'ground' });
  // 远处的沙地，避免从高处看到空洞
  box(0, -0.4, 0, 1400, 0.4, 1400, 0, { py: 'farGround' });

  // ---------- 主体盒子 ----------
  for (const bx of buildBoxes()) {
    const cy = bx.y + bx.h / 2;
    const side = SIDE[bx.mat] || (bx.kind === 'perim' ? 'adobeDark' : 'adobe');
    const topKey = FLAT_TOP.has(bx.kind) ? 'stone' : bx.kind === 'roof' ? 'adobeDark' : 'cap';
    if (bx.kind === 'barrel') barrels(bx);
    else if (bx.mat === 'truck') truck(bx);
    else if (bx.kind === 'container') container(bx);
    else if (bx.kind === 'fence') fence(bx);
    else {
      box(bx.x, cy, bx.z, bx.w, bx.h, bx.d, bx.yaw, {
        px: side, nx: side, pz: side, nz: side, py: bx.top !== false ? topKey : null,
      });
    }
    if (bx.solid !== false) {
      solid(bx.x, cy, bx.z, bx.w, bx.h, bx.d, bx.yaw, {
        mat: CMAT[bx.mat] || 'concrete', bullet: bx.bullet, sight: bx.sight, surface: 'sand', tag: bx.kind,
      });
    }
  }

  // 油桶簇：一个碰撞盒，视觉上是若干个圆桶
  function barrels(bx) {
    const nx = Math.max(1, Math.round(bx.w / 0.62)), nz = Math.max(1, Math.round(bx.d / 0.62));
    let i = 0;
    for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
      if (i >= 4) break;
      const lx = (a - (nx - 1) / 2) * 0.6, lz = (b - (nz - 1) / 2) * 0.6;
      const c = Math.cos(bx.yaw), s = Math.sin(bx.yaw);
      const x = bx.x + c * lx + s * lz, z = bx.z - s * lx + c * lz;
      const h = bx.h * (0.88 + (i % 3) * 0.06);
      geom('metal', cylG, x, bx.y + h / 2, z, 0, i * 0.7, 0, 0.27, h, 0.27);
      geom('black', cylG, x, bx.y + h - 0.015, z, 0, i * 0.7, 0, 0.26, 0.03, 0.26);
      for (const ry of [0.22, 0.62]) geom('black', cylG, x, bx.y + h * ry, z, 0, 0, 0, 0.28, 0.035, 0.28);
      i++;
    }
  }
  // 卡车：车厢 + 驾驶楼 + 轮子
  function truck(bx) {
    const c = Math.cos(bx.yaw), s = Math.sin(bx.yaw);
    const put = (lx, lz) => [bx.x + c * lx + s * lz, bx.z - s * lx + c * lz];
    const L = Math.max(bx.w, bx.d), alongX = bx.w >= bx.d;
    const bodyH = bx.h * 0.78;
    const [bx1, bz1] = put(-L * 0.12, 0);
    box(bx1, bx.y + bodyH / 2, bz1, alongX ? L * 0.76 : bx.d, bodyH, alongX ? bx.w : L * 0.76, bx.yaw, 'metal');
    const [cx1, cz1] = put(L * 0.36, 0);
    box(cx1, bx.y + bx.h * 0.3, cz1, alongX ? L * 0.22 : bx.d * 0.9, bx.h * 0.6, alongX ? bx.w * 0.9 : L * 0.22, bx.yaw, {
      px: 'truckTop', nx: 'truckTop', pz: 'truckTop', nz: 'truckTop', py: 'truckTop',
    });
    for (const sx of [-0.32, 0.36]) for (const sz of [-0.5, 0.5]) {
      const [wx, wz] = put(sx * L, sz * (alongX ? bx.w : L) * 0.5);
      // 轮轴水平且垂直于车身朝向
      geom('black', cylG, wx, bx.y + 0.34, wz, alongX ? Math.PI / 2 : 0, 0, alongX ? 0 : Math.PI / 2, 0.34, 0.24, 0.34);
    }
  }

  // 蓝色集装箱：波纹侧板 + 顶部角件（A Main 入口的招牌掩体）
  function container(bx) {
    box(bx.x, bx.y + bx.h / 2, bx.z, bx.w, bx.h, bx.d, bx.yaw, 'container');
    box(bx.x, bx.y + bx.h + 0.04, bx.z, bx.w * 0.96, 0.08, bx.d * 0.96, bx.yaw, 'black');
    const c = Math.cos(bx.yaw), s = Math.sin(bx.yaw);
    const alongX = bx.w >= bx.d, L = Math.max(bx.w, bx.d);
    const n = Math.max(3, Math.round(L / 0.85));
    for (let i = 0; i <= n; i++) {
      const t = -L / 2 + (L * i) / n;
      for (const v of [-1, 1]) {
        const lx = alongX ? t : (v * bx.w) / 2, lz = alongX ? (v * bx.d) / 2 : t;
        box(bx.x + c * lx + s * lz, bx.y + bx.h * 0.52, bx.z - s * lx + c * lz,
          alongX ? 0.1 : 0.44, bx.h * 0.88, alongX ? 0.44 : 0.1, bx.yaw, 'container');
      }
    }
  }
  // 铁丝网围栏：立柱加横杆，视觉上可穿、碰撞与子弹穿透照旧
  function fence(bx) {
    const c = Math.cos(bx.yaw), s = Math.sin(bx.yaw);
    const alongX = bx.w >= bx.d, L = Math.max(bx.w, bx.d);
    const n = Math.max(2, Math.round(L / 1.4));
    for (let i = 0; i <= n; i++) {
      const t = -L / 2 + (L * i) / n;
      const lx = alongX ? t : 0, lz = alongX ? 0 : t;
      geom('black', cylG8, bx.x + c * lx + s * lz, bx.y + bx.h / 2, bx.z - s * lx + c * lz, 0, 0, 0, 0.05, bx.h, 0.05);
    }
    for (const f of [0.35, 0.72, 0.98]) {
      box(bx.x, bx.y + bx.h * f, bx.z, alongX ? L : 0.07, 0.06, alongX ? 0.07 : L, bx.yaw, 'metal');
    }
  }

  // ---------- 门楼拱门 ----------
  for (const a of LAYOUT.arches) {
    const piers = a.axis === 'z' ? [[a.x, a.z - 3], [a.x, a.z + 3]] : [[a.x - 3, a.z], [a.x + 3, a.z]];
    for (const [px, pz] of piers) {
      box(px, 2.2, pz, 1.0, 4.4, 1.0, 0, 'stone');
      solid(px, 2.2, pz, 1.0, 4.4, 1.0, 0, { mat: 'concrete', surface: 'sand', tag: 'arch' });
      geom('cap', cylG8, px, 4.5, pz, 0, 0, 0, 0.62, 0.22, 0.62);
    }
    const lw = a.axis === 'z' ? 1.2 : 7.2, ld = a.axis === 'z' ? 7.2 : 1.2;
    box(a.x, 4.95, a.z, lw, 0.7, ld, 0, 'stone');
    solid(a.x, 4.95, a.z, lw, 0.7, ld, 0, { mat: 'concrete', surface: 'sand', tag: 'arch' });
  }

  // ---------- 灯柱 ----------
  for (const lp of LAYOUT.lamps) {
    rod('black', lp.x, 0, lp.z, lp.x, 4.6, lp.z, 0.07);
    geom('black', cylG8, lp.x, 0.06, lp.z, 0, 0, 0, 0.24, 0.12, 0.24);
    box(lp.x, 4.72, lp.z, 0.5, 0.16, 0.5, 0, 'black');
    geom('lamp', sphG, lp.x, 4.5, lp.z, 0, 0, 0, 0.17, 0.17, 0.17);
    lampSpots.push(new THREE.Vector3(lp.x, 4.5, lp.z));
  }

  world.build();
  const meshes = flush();
  const yaw = LAYOUT.spawnYaw;
  return {
    spawns: {
      BL: LAYOUT.spawns.BL.map((p) => ({ ...p, yaw: yaw.BL })),
      GR: LAYOUT.spawns.GR.map((p) => ({ ...p, yaw: yaw.GR })),
    },
    lampSpots, meshes, materials: matDefs,
    update(dt, t) { for (const f of anim) f(dt, t); },
  };
}

const ROOFS = LAYOUT.walls.filter((w) => w.kind === 'roof').map((r) => ({ x: r.x, z: r.z, w: r.w, d: r.d }));
const N = Math.PI;   // 朝北（+Z）
const S = 0;         // 朝南（-Z）
// bot 路线图：不对称地图不能再用「己方坐标取反」，两套目标点直接给世界坐标
const BOT = {
  BL: {
    lanes: [[23, -30], [-3, -14], [-39, -20]],              // 早期占线：长道 / 中路 / 地道
    flank: [[-39, -20], [-39, 10], [-32, 40]],               // 绕地道打 B 点
    holds: [[27, -14, N], [-8, 10, N], [-39, 6, N], [40, 38, S], [6, 26, S]],
    sites: [[40, 38], [43, 42], [30, 22], [-36, 41], [-34, 43]],
  },
  GR: {
    lanes: [[-24, 26], [-2, 20], [40, 40]],                  // 回防：B 门 / 中路门后 / A 点
    flank: [[-34, 43], [-39, 10], [-39, -14]],               // 从 B 反压地道口
    holds: [[-5, 17, N], [43, 39, S], [-34, 43, S], [28, 24, S]],
    sites: [[40, 40], [43, 39], [28, 24], [-42, 40], [-34, 43], [-5, 17]],
  },
};

export const dust2Map = {
  id: 'dust2',
  name: '沙漠灰城',
  en: 'DE_DUST2',
  brief: '三条进攻线：长道、中路、地道，A 点在东北，B 点在西北',
  story: '北非某座被战争遗忘的土城，格局完全照搬经典 de_dust2：潜伏者在南场出生，保卫者在东北出生，A 包点在东北、B 包点在西北。<br>从南场出来有三条路：<b>长道</b>沿东侧一路向北，经长道双门打进 A Main 直取 A 点；<b>中路</b>穿过土城正中的走廊，撞开那两扇半开的破门，再经 Xbox 拐角和高台（Catwalk）摸向 A 小；<b>地道</b>从西侧拱门钻进去，头顶压着棚子，一路向北出口直通 B 点，中途还在中路双门西侧开了一个俗称「窗口」的拱洞。整张图不对称：保卫者两个包点都近，潜伏者必须先决定走哪条线。',
  tip: '小提示：三处木门都能穿子弹，先扫门板再冲；A 点的箱堆可以两级跳上去架枪，B 点那辆废弃卡车和平台木箱同理。中路高台是双向通道，谁先站住谁两头都能支援。',
  textures: ['desert'],
  tod: [{ v: 'day', label: '白天' }, { v: 'dusk', label: '黄昏' }],
  sea: false,
  nav: LAYOUT.nav,
  bot: BOT,
  shadowBox: LAYOUT.shadowBox,
  radar: { halfW: 56, halfH: 56, overlays: ROOFS },
  orbit: { cx: 0, cz: 0, rx: 76, rz: 76, y: 54, look: [0, 2, 0] },
  build: buildDust2,
};
