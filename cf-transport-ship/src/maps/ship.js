// 运输船（原版地图）描述符：几何构建仍在 ../map.js，这里只提供游戏主循环需要的元数据
import { buildMap } from '../map.js';

export const shipMap = {
  id: 'ship',
  name: '运输船',
  en: 'TRANSPORT SHIP',
  brief: '废弃货轮甲板：三条战线 + 上下两层管道',
  story: '联合国维和行动在监视非法军火出口时，发现一艘从俄罗斯驶往尼日利亚的可疑货轮。保卫者（Global Risk）奉命登船突击检查，却遭到潜伏者（Black List）伏击。<br>船头船尾两个船舱出生，中路 V 形斜放集装箱、两侧 L 形箱堆，左右各有一条只能从己方出生点进入的集装箱管道，管道顶上就是可以架枪的二楼。',
  tip: '小提示：蹲下再跳（蹲跳）可以跳得更高，踩着木箱就能爬上对面集装箱的二楼。',
  textures: ['ship'],
  tod: [{ v: 'day', label: '白天' }, { v: 'dusk', label: '黄昏' }],
  sea: true,
  seaY: -7.5,
  nav: { x0: -36.2, z0: -12.1, x1: 36.2, z1: 12.1, cell: 0.5, r: 0.42 },
  shadowBox: { x: [-58, 40], y: [-1, 26], z: [-15, 15] },
  radar: {
    halfW: 37, halfH: 13,
    // 管道顶棚（二楼）用虚线表示
    overlays: [
      { x: -11.2, z: 10.62, w: 36.6, d: 2.44 },
      { x: 11.2, z: -10.62, w: 36.6, d: 2.44 },
    ],
  },
  // 菜单里的环绕镜头
  orbit: { cx: -6, cz: 0, rx: 46, rz: 34, y: 13, look: [-4, 1.5, 0] },
  build: buildMap,
};
