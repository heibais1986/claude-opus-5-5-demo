// de_dust2 地图构建：把 dust2-layout.js 的纯数据渲染成合批网格 + 碰撞体
import * as THREE from 'three';
import { createBuilder } from '../mapkit.js';
import { LAYOUT, buildBoxes } from './dust2-layout.js';

// 布局材质 -> 碰撞材质（命中特效只区分 wood / 其他）
const CMAT = { adobe: 'concrete', door: 'wood', crate: 'wood', wood: 'wood', stone: 'concrete', barrel: 'metal', truck: 'metal' };

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
    const side = bx.mat === 'door' ? 'door' : bx.mat === 'wood' ? 'wood' : bx.mat === 'crate' ? 'crate'
      : bx.mat === 'stone' ? 'stone' : bx.mat === 'truck' ? 'metal' : bx.kind === 'perim' ? 'adobeDark' : 'adobe';
    const topKey = bx.kind === 'dais' ? 'stone' : 'cap';
    if (bx.kind === 'barrel') { barrels(bx); } else if (bx.kind === 'site' && bx.mat === 'truck') { truck(bx); } else {
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

export const dust2Map = {
  id: 'dust2',
  name: '沙漠灰城',
  en: 'DE_DUST2',
  brief: '经典三线：中路双门、北长道 A 点、南地道 B 点',
  story: '北非某座被战争遗忘的土城。潜伏者要从东侧庭院突入，在 A（北广场）或 B（南广场）任一处安放炸药；保卫者从西侧庭院回防，中路那两扇破门是双方最先交火的地方。<br>三条东西向通道由两条斜路串起：抢下中路就能两头支援，走长道或地道则要绕开彼此的门楼。整张图绕中心 180° 对称，两边的进攻距离完全相等。',
  tip: '小提示：中路双门只有 2.4 米宽，先压制再冲；包点平台可以蹲跳上箱堆架枪，但会被长道的人白给。',
  textures: ['desert'],
  tod: [{ v: 'day', label: '白天' }, { v: 'dusk', label: '黄昏' }],
  sea: false,
  nav: LAYOUT.nav,
  shadowBox: LAYOUT.shadowBox,
  radar: { halfW: 42, halfH: 26, overlays: [] },
  orbit: { cx: 0, cz: 0, rx: 52, rz: 36, y: 40, look: [0, 0, 0] },
  build: buildDust2,
};
