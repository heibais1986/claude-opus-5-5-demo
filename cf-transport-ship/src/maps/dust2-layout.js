// de_dust2 布局数据（纯数据，不依赖 three / DOM，便于 Node 侧离线校验）
// 坐标约定与运输船一致：X 东西向（+X 为潜伏者一侧），Z 南北向，Y 向上，地面 Y=0
// 单位：米。整图 84 x 52，结构绕原点 180° 中心对称，保证两队攻防完全等价。
//
// 五个区域、八条通道（无死胡同）：
//   MID  中路走廊  z[-5.1,5.1]，x=0 是经典双门，东西贯通
//   A    北广场    z[+6,+25.5]，A 包点在中西部（长道方向）
//   B    南广场    z[-25.5,-6]，B 包点在中东部（地道方向）
//   东场 x[+26.6,42]  潜伏者出生区
//   西场 x[-42,-26.6] 保卫者出生区
//   通道：MID↔A、MID↔B 各两个开口；MID↔东/西场在 |z|<5.1 处完全敞开；
//         每个出生区向 A、B 各开一个门（|z|∈[12,18]）。
//   进攻方两个包点一近一远，防守方镜像，180° 旋转后完全重合。

const WALL_H = 6.5;      // 沙岩围墙高
const PERIM_H = 8;       // 外围挡墙高
const T = 0.6;           // 墙厚

// 盒子统一描述：中心 + 尺寸 + 绕 Y 转角（弧度）
function b(x, z, w, d, o = {}) {
  return {
    x, z, w, d,
    y: o.y ?? 0,                 // 底面高度
    h: o.h ?? WALL_H,
    yaw: o.yaw ?? 0,
    mat: o.mat || 'adobe',
    kind: o.kind || 'wall',
    // 碰撞语义
    solid: o.solid !== false,
    bullet: o.bullet || 'block',
    sight: o.sight !== false,
    top: o.top !== false,        // 是否绘制顶面
    foot: o.foot !== false,      // 是否参与地面 AO
  };
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

// 两点之间的直墙（轴对齐），o.t 控制墙厚；返回数组便于展开
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

// 成对生成：第二个是第一个绕原点旋转 180° 的结果
function pair(...boxes) {
  const out = [];
  for (const x of boxes) {
    out.push(x);
    out.push({ ...x, x: -x.x, z: -x.z });
  }
  return out;
}

export const LAYOUT = {
  id: 'dust2',
  bounds: { x: [-42, 42], z: [-26, 26] },
  nav: { x0: -41.5, z0: -25.5, x1: 41.5, z1: 25.5, cell: 0.5, r: 0.42 },
  shadowBox: { x: [-44, 44], y: [-1, 9], z: [-28, 28] },
  ground: { x: 0, z: 0, w: 84, d: 52 },

  // 出生点：东场（潜伏者）朝西出击，西场（保卫者）朝东出击
  spawns: {
    BL: [
      { x: 34, z: 0 }, { x: 30, z: 4 }, { x: 30, z: -4 },
      { x: 37, z: 4 }, { x: 37, z: -4 }, { x: 34, z: 9 },
      { x: 34, z: -9 }, { x: 40, z: 0 }, { x: 40, z: 8 }, { x: 40, z: -8 },
    ],
    GR: [
      { x: -34, z: 0 }, { x: -30, z: -4 }, { x: -30, z: 4 },
      { x: -37, z: -4 }, { x: -37, z: 4 }, { x: -34, z: -9 },
      { x: -34, z: 9 }, { x: -40, z: 0 }, { x: -40, z: -8 }, { x: -40, z: 8 },
    ],
  },
  // 出击朝向：东场向西，西场向东
  spawnYaw: { BL: Math.PI, GR: 0 },

  // ---------- 墙体 ----------
  walls: [
    // 外围
    ...run(26, -42, 42, 'x', [], { h: PERIM_H, kind: 'perim' }),
    ...run(-26, -42, 42, 'x', [], { h: PERIM_H, kind: 'perim' }),
    ...run(42, -26, 26, 'z', [], { h: PERIM_H, kind: 'perim' }),
    ...run(-42, -26, 26, 'z', [], { h: PERIM_H, kind: 'perim' }),

    // 中路走廊两道长墙：向 A / B 广场各开两个口
    ...run(5.4, -42, 42, 'x', [[-20, -14], [12, 18]]),
    ...run(-5.4, -42, 42, 'x', [[-18, -12], [14, 20]]),
    // 中央双门：门柱 + 两个 2.4m 门洞
    ...seg(0, -5.4, 0, -3.6),
    ...seg(0, -1.2, 0, 1.2, { kind: 'post' }),
    ...seg(0, 3.6, 0, 5.4),
    // 门扇（半开）
    b(-1.4, -2.4, 2.2, 0.14, { h: 3.2, mat: 'door', kind: 'door', yaw: 0.5, foot: false }),
    b(1.4, 2.4, 2.2, 0.14, { h: 3.2, mat: 'door', kind: 'door', yaw: 0.5, foot: false }),

    // 出生区与广场之间的四道门墙（每侧两个门洞，|z| 12~18）
    ...run(26, 6, 26, 'z', [[12, 18]]),
    ...run(26, -26, -6, 'z', [[-18, -12]]),
    ...run(-26, 6, 26, 'z', [[12, 18]]),
    ...run(-26, -26, -6, 'z', [[-18, -12]]),

    // A 包点：仓库隔墙（只在广场内隔出一个房间）
    ...seg(-14, 6, -14, 12, { h: 4.2, kind: 'shed' }),
    ...seg(-24, 12, -14, 12, { h: 4.2, kind: 'shed' }),
    // B 包点：镜像仓库
    ...seg(14, -6, 14, -12, { h: 4.2, kind: 'shed' }),
    ...seg(24, -12, 14, -12, { h: 4.2, kind: 'shed' }),
  ],

  // ---------- 掩体与道具箱 ----------
  props: [
    ...pair(
      // A 广场：包点平台 + 箱堆（2.3m 只能玩家爬，bot 绕行）
      b(-8, 20, 13, 6, { h: 0.35, mat: 'stone', kind: 'dais' }),
      b(-8, 20, 3.2, 3.2, { y: 0.35, h: 2.3, mat: 'crate', kind: 'site' }),
      b(-13, 20, 2.6, 2.6, { y: 0.35, h: 1.5, mat: 'crate', kind: 'site' }),
      b(-2, 16, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),
      b(6, 19, 1.1, 3.4, { h: 1.05, mat: 'stone', kind: 'cover' }),
      b(14, 15, 2.4, 2.4, { h: 1.2, mat: 'wood', kind: 'cover' }),
      b(20, 21, 3.2, 1.1, { h: 0.9, mat: 'stone', kind: 'low' }),
      b(-20, 18, 1.8, 1.8, { h: 0.9, mat: 'barrel', kind: 'cover', bullet: 'pen' }),
      // 长道（通往东场门口）的沙袋矮墙
      b(31, 15, 1.1, 4.2, { h: 0.9, mat: 'stone', kind: 'low' }),
      b(37, 20, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),
      // 中路：门两侧掩体 + 狙击平台
      b(-6, 3, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' }),
      b(13, -3, 7, 2.4, { h: 0.35, mat: 'stone', kind: 'dais' }),
      b(22, 2, 1.8, 1.8, { h: 1.1, mat: 'barrel', kind: 'cover', bullet: 'pen' }),
      // 斜向开口里的箱子
      b(15, 9, 2.2, 2.2, { h: 1.15, mat: 'wood', kind: 'cover' }),
      // 东场内衬（与出生点保持 2m 余量）
      b(32.5, 4, 1.1, 3.4, { h: 1.05, mat: 'stone', kind: 'cover' }),
      b(37, -13, 2.4, 2.4, { h: 1.2, mat: 'crate', kind: 'cover' })
    ),
    // B 广场用卡车代替箱堆（地道口的味道）
    b(8, -20, 4.6, 2.6, { y: 0.35, h: 2.1, mat: 'truck', kind: 'site' }),
  ],

  // 门楼拱门：四个出生区门口的装饰性门框（sight 开、碰撞薄）
  arches: [
    { x: 26, z: 15, axis: 'z' }, { x: 26, z: -15, axis: 'z' },
    { x: -26, z: 15, axis: 'z' }, { x: -26, z: -15, axis: 'z' },
    { x: 15, z: 5.4, axis: 'x' }, { x: -17, z: -5.4, axis: 'x' },
  ],

  // 灯柱：夜间氛围与少量点光
  lamps: [
    { x: 33, z: 0 }, { x: -33, z: 0 }, { x: 0, z: 18 }, { x: 0, z: -18 },
  ],

  // 包点标记（供 HUD / 目标提示使用）
  sites: [
    { id: 'A', x: -8, z: 20 }, { id: 'B', x: 8, z: -20 },
  ],
};

export function buildBoxes() {
  return [...LAYOUT.walls, ...LAYOUT.props];
}
