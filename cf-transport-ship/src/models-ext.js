// 可选的外部角色模型通道：把真实蒙皮模型（GLTF/GLB 等）接进来，缺实现时完全回落到程序化士兵。
// 本项目是单文件打包，包内不内置 GLTFLoader（约 180 KB），所以这里只定义挂载点：
// 需要外部模型时，在页面里先赋值 window.SoldierFactory，再加载 dist/index.html。例如：
//   <script type="importmap">{ "imports": { "three": "/node_modules/three/build/three.module.js" } }</script>
//   <script type="module">
//     import { GLTFLoader } from '/node_modules/three/addons/loaders/GLTFLoader.js';
//     import { GUN_POSES, HITBOXES } from '/src/character.js';
//     window.SoldierFactory = (team) => new MyGltfSoldier(team, GLTFLoader);
//   </script>
// （/src/character.js 用裸标识符 'three'，因此必须提供上面那条 importmap，且版本要和打包用的
//   node_modules/three 完全一致，否则两个 THREE 实例的 Skeleton / 材质类互不兼容。）
// 工厂返回值必须满足这套接口（Actor / Game 只用这些）：
//   root                      THREE.Object3D，会被 add 进场景，位置与朝向由外部写入
//   meshes?                   可空数组，仅用于统计
//   setWeapon(id)             切换手持枪（id 见 guns.js builders）
//   setVisible(on)            出生保护闪烁、死亡隐藏
//   setFade(op, transparent)  尸体淡出
//   update(dt, st)            st = {speed, fwd, crouch, pitch, onGround, reloading, scoped}
//   kick()                    开火后坐
//   die(dx, dz, headshot)     倒地
//   reset()                   重生复用
//   hitTest(o, d, maxT, frame) -> {t, part} | null   part ∈ head|chest|stomach|arm|leg
//   headWorld(out) / chestWorld(out) / muzzleWorld(out)
// 想复用本项目的判定与握持，可从 character.js 取 HITBOXES / GUN_POSES / SURFS。
export function makeSoldier(team, Fallback) {
  const F = typeof window !== 'undefined' ? window.SoldierFactory : null;
  if (F) {
    try {
      const s = F(team);
      if (s && s.root && s.update && s.hitTest && s.setWeapon) return s;
      console.warn('window.SoldierFactory 未实现完整接口，回落到程序化士兵');
    } catch (e) {
      console.warn('外部角色模型初始化失败，回落到程序化士兵', e);
    }
  }
  return new Fallback(team);
}
