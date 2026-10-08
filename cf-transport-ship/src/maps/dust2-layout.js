// de_dust2 布局数据（纯数据，不依赖 three / DOM，便于 Node 侧离线校验）
// 坐标：X 东西向（+X 东），Z 南北向（+Z 北），Y 向上，地面 Y=0，单位米。
// 方位按真实 de_dust2：潜伏者（T）在南场出生朝北出击，保卫者（CT）在东北出生回防；
// A 包点在东北，B 包点在西北，中路在两包点正中偏南。参考 Valve 雷达换算（整图约 114x114）。
//
// 三条进攻线（不对称，这是 dust2 的骨架）：
//   LONG  东侧长道：T 场东门 → 外长道 → 长道双门 → A Main → A 点（东北）
//   MID   中路：T 场北门 → 中路走廊 → 中路双门 → CT 中场 / Catwalk 高台 → A Short → A 点
//   TUNNEL 西侧地道：T 场西门 → 外地道 → 拱门洞口 → 沿西侧北行 → B 点（西北）；
//           地道在中路双门西侧开一个出口拱门（俗称窗口），是中路与 B 点的快速通道。
// 防守方 CT 出生点旋转两个包点更近，进攻方必须选线 —— 真实地图就是这样的不对等。
//
// 导航是单层 2D 网格：只有「顶面 ≤0.36m」的台面和「底面 >1.7m」的顶棚不影响可走性。
// 所以所有 bot 要走的通道高差都做成 0.35m 台阶；地道顶棚、Catwalk 栏杆放在 1.7m 以上或作为隔墙。

const WALL_H = 6.5;   // 主围墙
const IN_H = 4.6;     // 场内建筑隔断
const PERIM_H = 9;    // 外围挡墙
const T = 0.6;        // 墙厚
const ROOF_Y = 3.4;   // 地道顶棚底高（>1.7 才不会挡住导航格）

// 盒子统一描述：中心 + 尺寸 + 绕 Y 转角（弧度）
function b(x, z, w, d, o = {}) {
  return {
    x, z, w, d,
    y: o.y ?? 0,
    h: o.h ?? WALL_H,
    yaw: o.yaw ?? 0,
    mat: o.mat || 'adobe',
    kind: o.kind || 'wall',
    solid: o.solid !== false,
    bullet: o.bullet || 'block',
    sight: o.sight !== false,
    top: o.top !== false,
    foot: o.foot !== false,
  };
}

// 两点之间的直墙（轴对齐），返回数组便于展开
function seg(x0, z0, x1, z1, o = {}) {
  const t = o.t ?? T;
  const horizontal = Math.abs(z1 - z0) < 1e-6;
  const w = horizontal ? Math.abs(x1 - x0) + t : t;
  const d = horizontal ? t : Math.abs(z1 - z0) + t;
  return [b((x0 + x1) / 2, (z0 + z1) / 2, w, d, {
    h: o.h ?? WALL_H, mat: o.mat || 'adobe', kind: o.kind || 'wall', y: o.y ?? 0,
    solid: o.solid, bullet: o.bullet, sight: o.sight, top: o.top, foot: o.foot,
  })];
}

// 沿单轴排列的墙段：固定轴坐标、另一轴范围与开口区间
function run(fixed, from, to, axis, gaps = [], o = {}) {
  const mk = (a0, a1) => (axis === 'x' ? seg(a0, fixed, a1, fixed, o) : seg(fixed, a0, fixed, a1, o));
  const out = [];
  let cursor = from;
  for (const [g0, g1] of gaps.slice().sort((p, q) => p[0] - q[0])) {
    if (g0 > cursor) out.push(...mk(cursor, g0));
    cursor = Math.max(cursor, g1);
  }
  if (to > cursor) out.push(...mk(cursor, to));
  return out;
}

// 实心填充块：把不可玩的街区填成建筑体块（俯视读起来像密布的土房）
function fill(x0, x1, z0, z1, o = {}) {
  return b((x0 + x1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(z1 - z0), {
    h: o.h ?? IN_H, mat: o.mat || 'adobe', kind: o.kind || 'block',
  });
}

// 一扇双开木门：两扇门板分别铰在门洞两端，朝同一侧半开
function doors(cx, cz, axis, gap, o = {}) {
  const s = o.swing ?? 0.5;              // 内开弧度
  const th = axis === 'x' ? 0 : -Math.PI / 2;
  const wu = Math.cos(th), wv = -Math.sin(th);   // 门洞轴向
  const L = gap * 0.47;
  const out = [];
  for (const dir of [-1, 1]) {
    const yaw = (dir < 0 ? th : th + Math.PI) + s;
    const hx = cx + dir * (gap / 2) * wu, hz = cz + dir * (gap / 2) * wv;
    out.push(b(hx + (L / 2) * Math.cos(yaw), hz - (L / 2) * Math.sin(yaw), L, 0.14, {
      h: 3.3, mat: 'door', kind: 'doorLeaf', yaw, foot: false,
    }));
  }
  return out;
}

// 顶棚：底面高于 1.7m，导航视为通透，视觉上形成隧道/檐下
function roof(x, z, w, d, y = ROOF_Y) {
  return b(x, z, w, d, { y, h: 0.4, mat: 'adobeDark', kind: 'roof', foot: false });
}

export const LAYOUT = {
  id: 'dust2',
  bounds: { x: [-57, 57], z: [-57, 57] },
  nav: { x0: -54, z0: -54, x1: 54, z1: 54, cell: 0.6, r: 0.42 },
  shadowBox: { x: [-58, 58], y: [-1, 11], z: [-58, 58] },
  ground: { x: 0, z: 0, w: 112, d: 112 },

  // 出生点：南场（潜伏者）向北出击，东北场（保卫者）向南回防
  spawns: {
    BL: [
      { x: -20, z: -48 }, { x: -12, z: -48 }, { x: -4, z: -48 }, { x: 4, z: -48 },
      { x: -20, z: -42 }, { x: -12, z: -42 }, { x: -4, z: -42 }, { x: 4, z: -42 },
      { x: -16, z: -38 }, { x: 0, z: -38 },
    ],
    GR: [
      { x: 6, z: 38 }, { x: 12, z: 38 }, { x: 18, z: 38 },
      { x: 6, z: 44 }, { x: 12, z: 44 }, { x: 18, z: 44 },
      { x: 8, z: 50 }, { x: 14, z: 50 }, { x: 17, z: 46 }, { x: 0, z: 33 },
    ],
  },
  // forward = (-sin yaw, -cos yaw)：+Z 为北，故朝北 = π，朝南 = 0
  spawnYaw: { BL: Math.PI, GR: 0 },

  // ---------- 墙体 ----------
  walls: [
    // 外围（整个街区 108x108；每边拆成两段，小地图才画得下）
    ...run(-54, -54, 0, 'x', [], { h: PERIM_H, kind: 'perim' }),
    ...run(-54, 0, 54, 'x', [], { h: PERIM_H, kind: 'perim' }),
    ...run(54, -54, 0, 'x', [], { h: PERIM_H, kind: 'perim' }),
    ...run(54, 0, 54, 'x', [], { h: PERIM_H, kind: 'perim' }),
    ...run(-54, -54, 0, 'z', [], { h: PERIM_H, kind: 'perim' }),
    ...run(-54, 0, 54, 'z', [], { h: PERIM_H, kind: 'perim' }),
    ...run(54, -54, 0, 'z', [], { h: PERIM_H, kind: 'perim' }),
    ...run(54, 0, 54, 'z', [], { h: PERIM_H, kind: 'perim' }),

    // ---- T 出生场 x[-24,+16] z[-52,-36]：北口通中路、东口通长道、西口通外地道 ----
    ...run(-36, -24, 16, 'x', [[-8, -2]]),                     // 中路门洞
    ...run(16, -52, -36, 'z', [[-48, -42]]),                   // 长道门洞
    ...run(-24, -52, -36, 'z', [[-46, -40]]),                  // 外地道门洞

    // ---- 外地道 x[-46,-24] z[-52,-36] 与 地道 x[-46,-32] z[-36,+24] ----
    ...run(-36, -46, -24, 'x', [[-42, -36]]),                  // 地道拱门入口
    ...run(-46, -36, 24, 'z', []),                             // 地道西墙
    ...run(-32, -36, 24, 'z', [[6, 11]]),                      // 地道东墙（z6~11 是通往中路的出口）
    ...run(6, -32, -12, 'x', []),                              // 出口支道南墙
    ...run(11, -32, -12, 'x', []),                             // 出口支道北墙
    roof(-39, -6, 14, 60),                                     // 地道顶棚
    roof(-22, 8.5, 20, 5),                                     // 出口支道顶棚

    // ---- 中路 x[-12,+2]（北段放宽到 +10 作 Xbox 角），z[-36,+14] ----
    ...run(-12, -36, 14, 'z', [[6, 11]]),                      // 中路西墙：支道口在 z6~11
    ...run(2, -36, 4, 'z', []),                                // 中路东墙（南段，隔开通长道的街区）
    ...run(4, 2, 10, 'x', []),                                 // Xbox 角南墙
    ...run(10, 4, 14, 'z', []),                                // Xbox 角东墙

    // ---- 中路门墙 z=+14：双门 + Catwalk 入口（西端起于地道东墙，避免绕门） ----
    ...run(14, -32, 10, 'x', [[-6, 1], [4, 9]]),

    // ---- CT 中场 x[-24,+2] z[+14,+32] ----
    ...run(-24, 14, 36, 'z', [[24, 30]]),                      // 西墙：B 门洞 z24~30
    ...run(36, -24, 2, 'x', [[-2, 2]]),                        // 北口进 CT 出生场
    ...run(2, 14, 32, 'z', []),                                // 中路与 Catwalk 之间的隔墙（到 z32 合并）

    // ---- Catwalk x[+2,+10] z[+14,+32]（台面 0.35，bot 可通行）----
    ...run(10, 14, 32, 'z', []),                               // Catwalk 东墙
    b(6, 21, 8, 30, { y: 0, h: 0.35, mat: 'stone', kind: 'catwalk' }),  // 高台台面（z6~36）

    // ---- A Short 连接带 x[+2,+24] z[+32,+36] ----
    ...run(32, 10, 24, 'x', []),                               // 带北街区的南墙
    ...run(36, 10, 24, 'x', [[14, 20]]),                       // A Short 北墙（接 CT 出生场）

    // ---- 东侧长道 x[+16,+34] z[-52,+26] ----
    ...run(-10, 16, 34, 'x', [[20, 26]]),                      // 长道双门墙
    ...run(26, 16, 54, 'x', [[28, 34]]),                       // A 点南墙：A Main 口
    ...run(34, -52, 26, 'z', []),                              // 长道东墙
    ...run(16, -36, 26, 'z', [[-32, -26]]),                    // 长道西墙（南段接 T 场东口）

    // ---- A 包点 x[+24,+54] z[+26,+54] ----
    ...run(54, 24, 54, 'x', []),                               // A 点北墙（外围）
    ...run(24, 26, 54, 'z', [[32, 38]]),                       // A 点西墙：A Short 口

    // ---- B 包点 x[-54,-24] z[+24,+54] ----
    ...run(24, -54, -24, 'x', [[-44, -34]]),                   // B 点南墙：地道口
    ...run(54, -54, -24, 'x', []),                             // B 点北墙（外围）

    // ---- 街区填充：把不可玩的空地补成建筑体块 ----
    fill(2, 16, -36, 4),          // 中路与长道之间的整块建筑
    fill(10, 16, 4, 32),          // Catwalk 与长道之间
    fill(16, 24, 26, 32),         // A Main 与 A Short 之间
    fill(-32, -12, -36, 6),       // 中路与地道之间
    fill(-32, -12, 11, 14),       // 出口支道以北的建筑
    fill(-32, -24, 14, 24),       // CT 中场与 B 门之间的街区
    fill(34, 54, -54, 26),        // 长道以东到底
    fill(-54, -46, -54, 24),      // 地道以西到底
    fill(20, 24, 38, 54),         // CT 出生场与 A 点西墙之间
  ],

  // ---------- 掩体与标志性地标 ----------
  props: [
    // --- 中路：双门两侧的箱子、Xbox（跳上 Catwalk 的垫脚箱）---
    b(-4, 10, 2.2, 2.2, { h: 1.5, mat: 'crate', kind: 'xbox' }),
    b(-1, 1.5, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),
    b(-9, -6, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),
    b(-6, -20, 1.1, 4.2, { h: 0.9, mat: 'stone', kind: 'low' }),
    b(0, -30, 2.6, 2.6, { h: 1.2, mat: 'wood', kind: 'cover' }),
    // 门洞两侧的矮墙，挡不住人但挡住对射视线
    b(-8, 14, 2.2, 0.9, { h: 1.15, mat: 'stone', kind: 'low' }),

    // --- Catwalk：与 CT 中场之间由 x=2 隔墙分开，只在北端经 A Short 连通 ---

    // --- A 包点：平台 + 箱堆 + 油桶 + 蓝色集装箱 + 电梯角 ---
    // 箱堆按跳跃高度排（起跳约 1.15m，可两级跳上 2.4m 与 3.15m 的架枪点）
    b(40, 42, 18, 9, { h: 0.35, mat: 'stone', kind: 'dais' }),
    b(40, 44, 3.4, 3.4, { y: 0.35, h: 2.05, mat: 'crate', kind: 'site' }),
    b(35, 40, 2.8, 2.8, { y: 0.35, h: 1.05, mat: 'crate', kind: 'site' }),
    b(46, 44, 2.0, 2.0, { y: 0.35, h: 1.1, mat: 'crate', kind: 'cover' }),
    b(48, 32, 1.8, 4.2, { h: 1.0, mat: 'barrel', kind: 'barrel' }),
    b(38, 32, 9, 4, { h: 2.7, mat: 'container', kind: 'container' }),   // 蓝色集装箱：压住 A 点西侧，但留出 A Main 通路
    b(50, 50, 5, 5, { h: 2.4, mat: 'crate', kind: 'cover' }),           // 电梯角
    b(30, 45, 2.4, 2.4, { h: 1.2, mat: 'wood', kind: 'cover' }),
    // A Main 到 A 点的拐角掩体
    b(36, 28, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),

    // --- 长道：双门掩体、坑（低围栏的凹地）、外长道箱子 ---
    b(22, -6, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),
    ...run(3, 24, 33, 'x', [[26, 29]], { h: 1.05, mat: 'stone', kind: 'pit' }),
    ...run(-6, 24, 33, 'x', [[29, 32]], { h: 1.05, mat: 'stone', kind: 'pit' }),
    ...seg(24, -6, 24, 3, { h: 1.05, mat: 'stone', kind: 'pit' }),
    b(30, -16, 1.1, 4.2, { h: 0.9, mat: 'stone', kind: 'low' }),
    b(20, -30, 2.6, 2.6, { h: 1.3, mat: 'crate', kind: 'cover' }),
    b(29, -44, 2.4, 2.4, { h: 1.2, mat: 'wood', kind: 'cover' }),
    b(20, -20, 2.2, 2.2, { h: 1.1, mat: 'crate', kind: 'cover' }),

    // --- B 包点：平台 + 三级可跳箱堆 + 废弃汽车 + 木平台 + 墙洞（B Window）---
    b(-40, 44, 15, 8, { h: 0.35, mat: 'stone', kind: 'dais' }),
    b(-38, 41.2, 3.0, 2.2, { y: 0.35, h: 0.75, mat: 'crate', kind: 'site' }),      // 台面 1.1
    b(-38, 45.4, 4.7, 4.1, { y: 0.35, h: 1.8, mat: 'crate', kind: 'site' }),      // 台面 2.15
    b(-38, 45.4, 2.6, 2.6, { y: 2.15, h: 1.0, mat: 'crate', kind: 'site' }),      // 台面 3.15，三级跳上去架枪
    b(-28, 36, 4.6, 2.4, { h: 1.9, mat: 'truck', kind: 'car' }),
    b(-30, 30, 4.3, 4.0, { h: 2.2, mat: 'crate', kind: 'site' }),
    b(-46, 34, 1.8, 4.2, { h: 1.0, mat: 'barrel', kind: 'barrel' }),
    b(-44, 51, 6, 4, { h: 1.05, mat: 'wood', kind: 'scaffold' }),                  // 木板平台，跳上去可俯瞰地道口
    ...seg(-49, 30, -49, 40, { h: 1.4, mat: 'metal', kind: 'fence', bullet: 'pen', sight: false }),
    // B 点内的砖墙隔断：1.1~2.0m 开一个 7m 宽的洞（B Window），站北边能看见包点
    b(-28.5, 47, 7.0, 0.6, { h: 1.1, kind: 'part' }),
    b(-28.5, 47, 7.0, 0.6, { y: 2.0, h: 1.6, kind: 'partTop' }),

    // --- 地道：入口掩体、转角箱、出口拱门下 ---
    b(-38, -30, 2.6, 2.6, { h: 1.3, mat: 'crate', kind: 'cover' }),
    b(-40, -10, 2.4, 2.4, { h: 1.2, mat: 'wood', kind: 'cover' }),
    b(-38, 14, 2.2, 2.2, { h: 1.1, mat: 'crate', kind: 'cover' }),
    b(-22, -44, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),
    // 出口支道（窗口）里的对望掩体
    b(-16, 9, 2.2, 2.2, { h: 1.15, mat: 'stone', kind: 'cover' }),

    // --- T 出生场周边的沙袋与箱组（与出生点保持 2m 余量）---
    b(-16, -45, 1.1, 3.4, { h: 1.05, mat: 'stone', kind: 'cover' }),
    b(8, -40, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),
    b(-8, -48, 2.6, 2.6, { h: 1.3, mat: 'wood', kind: 'cover' }),
    // CT 出生场周边
    b(2, 46, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),
    b(8, 41, 1.1, 3.4, { h: 1.05, mat: 'stone', kind: 'cover' }),
  ],

  // 门楼拱门：地道入口、长道双门、B 门（柱子落在门洞两侧）
  arches: [
    { x: -39, z: -36, axis: 'x' },
    { x: 23, z: -10, axis: 'x' },
    { x: -24, z: 27, axis: 'z' },
  ],

  // 木门（三处经典：中路双门 / 长道双门 / B 门）
  doorSets: [
    { cx: -2.5, cz: 14, axis: 'x', gap: 6.5 },
    { cx: 23, cz: -10, axis: 'x', gap: 6 },
    { cx: -24, cz: 27, axis: 'z', gap: 6 },
  ],

  // 灯柱
  lamps: [
    { x: -4, z: -44 }, { x: -40, z: -20 }, { x: -4, z: 6 }, { x: 25, z: -30 },
    { x: 6, z: 24 }, { x: 36, z: 36 }, { x: -34, z: 34 }, { x: 12, z: 44 },
  ],

  // 包点标记（安放炸药的理论点位）
  sites: [
    { id: 'A', x: 40, z: 42 }, { id: 'B', x: -38, z: 44 },
  ],

  // 离线校验锚点（tools/floorplan.mjs 用）
  checks: {
    anchors: {
      'spawn.BL': { x: -12, z: -48 }, 'spawn.GR': { x: 14, z: 40 },
      'mid.gate': { x: -5, z: -34 }, 'tun.gate': { x: -39, z: -34 },
      'long.gate': { x: 14, z: -45 },
      'door.mid': { x: -2.5, z: 14 }, 'door.long': { x: 23, z: -10 }, 'door.B': { x: -24, z: 27 },
      'tun.exit': { x: -20, z: 8.5 }, 'catwalk': { x: 6, z: 22 },
      'A.site': { x: 40, z: 40 }, 'B.site': { x: -34, z: 43 },
      'A.main': { x: 30, z: 20 }, 'A.short': { x: 16, z: 34 },
      'CT.mid': { x: -12, z: 24 }, 'CT.spawn': { x: 10, z: 38 },
      'long.pit': { x: 29, z: -2 }, 'tun.north': { x: -39, z: 20 },
    },
    // 关键视线：出生点不该被远程秒杀，门后不该一眼看穿两个包点
    sight: [
      { label: 'T场->CT场', a: [-4, -40], b: [10, 33] },
      { label: '门->A点', a: [-2.5, 14], b: [40, 42] },
      { label: '门->B点', a: [-2.5, 14], b: [-36, 38] },
      { label: '长道门->A点', a: [23, -10], b: [40, 42] },
      { label: '窗口->CT中场', a: [-20, 8.5], b: [-12, 24] },
    ],
  },
};

export function buildBoxes() {
  const out = [...LAYOUT.walls, ...LAYOUT.props];
  for (const d of LAYOUT.doorSets) out.push(...doors(d.cx, d.cz, d.axis, d.gap, { swing: d.swing }));
  return out;
}
