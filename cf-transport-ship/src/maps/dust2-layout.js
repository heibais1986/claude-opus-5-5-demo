// de_dust2 语义布局：只写「走哪条线、占哪个点、面朝哪边」这类战术信息。
// 墙体/掩体/高度/碰撞/导航都由 tools/dust2-geo.mjs 从真实 CS2 地图数据生成（见 ./dust2-geo.js），
// 这里的每个点位都会吸附到 Valve 官方导航节点，保证 bot 目标一定落在真实可走的地面上。
//
// 坐标：X 东西向（+X 东），Z 南北向（+Z 北），Y 向上，单位米，地图中心在原点。
// 由 map-data 的地图系换算而来：world_x = map_x + 5.2277，world_z = -map_z - 24.638，
// 所以潜伏者（BL）在南场出生朝北出击，保卫者（GR）在东北出生回防，A 包点在东北、B 包点在西北。
//
// 三条进攻线（不对称，这是 dust2 的骨架）：
//   LONG   东侧长道：T 场东门 → 长道双门 → A Long（坑）→ A Main → A 点
//   MID    中路：T 场北门 → 中路走廊 → 中路双门 → 高台（Catwalk）→ A Short → A 点
//   TUNNEL 西侧地道：T 场西门 → B Tunnels → B 点，中途在西路西侧留着一个枪洞（窗口）
import { NAV_NODES, MESH_SITES, MESH_LABELS } from './dust2-geo.js';

// 吸附到最近的 Valve 导航节点：宁可偏一米，也不要落在墙里
function node(x, z) {
  let best = null, bd = Infinity;
  for (const n of NAV_NODES) {
    const d = (n[0] - x) ** 2 + (n[1] - z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return [+(best[0].toFixed(1)), +(best[1].toFixed(1))];
}

const LAB = {};
for (const l of MESH_LABELS) LAB[l.text.toLowerCase().replace(/ /g, '.')] = [l.x, l.z];

// 关键报点：Valve 标签给了 8 个，其余按经典 dust2  geography 补，统一吸附导航点
const RAW = {
  'T.spawn': LAB['t.spawn'], 'CT.spawn': LAB['ct.spawn'],
  A: LAB.a, B: LAB.b, MID: LAB.mid, LONG: LAB['long.a'], TUNNELS: LAB.tunnels, CATWALK: LAB.catwalk,
  'long.doors': [40.4, -18.3], 'long.pit': [40.4, -5.0], 'A.main': [37.6, 20.1],
  'A.short': [16.9, 26.1], 'mid.doors': [-4.4, 16.6], 'upper.mid': [-6.6, 14.2],
  'mid.window': [-24.6, 13.0], 'B.door': [-29.7, 29.8], 'T.top': [-12.0, -41.6],
  'B.tunnel.out': [-33.5, 40.7],
};
export const ANCHOR = {};
for (const k in RAW) ANCHOR[k] = node(...RAW[k]);
const P = (k) => ANCHOR[k];

const N = Math.PI;   // 朝北（+Z）
const S = 0;         // 朝南（-Z）
const E = Math.PI / 2;   // 朝东（+X）
const W = -Math.PI / 2;  // 朝西（-X）

// bot 路线图：不对称地图不能再用「己方坐标取反」，两套目标点直接给世界坐标
const BOT = {
  BL: {
    // 开局占线：外长道 / 外中路 / 外地道
    lanes: [[43.4, -10.0], [-6.8, 4.3], [-38.2, 0.4]].map(([x, z]) => node(x, z)),
    // 绕地道打 B 点，三段推进
    flank: [[-38.2, 0.4], [-37.0, 20.0], [-33.5, 40.7]].map(([x, z]) => node(x, z)),
    holds: [
      [...P('long.doors'), N], [...P('MID'), N], [...P('TUNNELS'), N],
      [...P('A'), S], [...P('CATWALK'), S],
    ],
    sites: [P('A'), [30, 40], [26, 44], P('B'), [-37, 45], P('B.door')].map(([x, z]) => node(x, z)),
  },
  GR: {
    // 回防：B 门 / 中门后 / A 点
    lanes: [P('B.door'), P('mid.doors'), P('A')].map(([x, z]) => node(x, z)),
    // 从 B 反压地道口
    flank: [P('B'), [-35.9, 20.5], P('TUNNELS')].map(([x, z]) => node(x, z)),
    holds: [
      [...P('mid.doors'), S], [...P('A'), S], [...P('B'), S],
      [...P('long.pit'), S], [...P('CATWALK'), S],
    ],
    sites: [P('A'), [30, 40], P('B'), P('B.door'), P('A.short'), P('mid.doors')].map(([x, z]) => node(x, z)),
  },
};

export const LAYOUT = {
  id: 'dust2',
  bounds: { x: [-53, 53], z: [-57, 57] },
  // 导航场尺寸与 tools/dust2-geo.mjs 的采样窗口一致；高度场和方向可走掩码在构建时附上
  nav: { x0: -52.5, z0: -56.5, x1: 52.5, z1: 56.3, cell: 0.6, r: 0.42 },
  shadowBox: { x: [-55, 55], y: [-1, 12], z: [-59, 59] },
  bot: BOT,

  // forward = (-sin yaw, -cos yaw)：+Z 为北，故朝北 = π，朝南 = 0
  spawnYaw: { BL: Math.PI, GR: 0 },
  sites: [
    { id: 'A', x: MESH_SITES.A.x, z: MESH_SITES.A.z, r: MESH_SITES.A.r },
    { id: 'B', x: MESH_SITES.B.x, z: MESH_SITES.B.z, r: MESH_SITES.B.r },
  ],

  story: '这张图的几何不是手绘的：墙体、台阶、地道顶棚全部取自 CS2 版 de_dust2 的官方地图数据（24.6 万个三角面，逐面带穿透材质），出生点、包点与 bot 目标点也吸附在 Valve 自己的导航网格上。北非某座被战争遗忘的土城，潜伏者在南场出生，保卫者在东北出生，A 包点在东北、B 包点在西北。<br>从南场出来有三条路：<b>长道</b>沿东侧一路向北，撞开长道双门进入 A Long，坑（Pit）和箱堆是这条线上的招牌掩体；<b>中路</b>穿过土城正中的走廊，挤过那两扇半开的中门，再经高台（Catwalk）摸向 A Short；<b>地道</b>从西侧拱门钻进去，头顶压着真实的棚顶，一路向北出口直通 B 点，中途还在西路留了一个俗称「窗口」的枪洞。整张图不对称：保卫者离两个包点都近，潜伏者必须先决定走哪条线。',
  tip: '小提示：木门和薄墙按真实厚度吃子弹，先扫门板再冲；A 点的箱堆、B 点的大箱都能踩着上顶架枪。中门对狙是这张图的传统节目，高台谁先站住谁两头都能支援。',

  // 离线校验锚点（tools/floorplan.mjs 用）：全部是吸附后的导航点
  checks: {
    anchors: (() => {
      const a = { 'spawn.BL': { x: LAB['t.spawn'][0], z: LAB['t.spawn'][1] }, 'spawn.GR': { x: LAB['ct.spawn'][0], z: LAB['ct.spawn'][1] } };
      for (const k in ANCHOR) a[k] = { x: ANCHOR[k][0], z: ANCHOR[k][1] };
      for (const team of ['BL', 'GR']) for (const key of ['lanes', 'flank', 'holds', 'sites']) {
        BOT[team][key].forEach((p, i) => { a[`bot.${team}.${key}${i}`] = { x: p[0], z: p[1] }; });
      }
      return a;
    })(),
    // 关键视线：出生点不该被远程秒杀；两条主通道各自能看到什么
    sight: [
      { label: 'T场->CT场', a: LAB['t.spawn'], b: LAB['ct.spawn'] },
      { label: '中路->A点', a: P('MID'), b: P('A') },
      { label: '中路->B点', a: P('MID'), b: P('B') },
      { label: '长道->A点', a: P('long.pit'), b: P('A') },
      { label: 'A主道->A点', a: P('A.main'), b: P('A') },
      { label: '地道->B点', a: P('TUNNELS'), b: P('B') },
      { label: 'A小->A点', a: P('CATWALK'), b: P('A') },
      { label: '窗口->上中路', a: P('mid.window'), b: P('upper.mid') },
    ],
  },
};
