// 角色结构探针：在 Node 里检查程序化士兵的骨架/材质/握持/命中，不依赖浏览器渲染。
// 用法：node tools/probe-soldier.mjs
import * as THREE from 'three';
const noop = () => {};
function fakeCanvas() {
  const ctx = {
    canvas: null, createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop, fillRect: noop, clearRect: noop, drawImage: noop, save: noop, restore: noop,
    translate: noop, rotate: noop, scale: noop, setTransform: noop, beginPath: noop, moveTo: noop,
    lineTo: noop, closePath: noop, fill: noop, stroke: noop, arc: noop, rect: noop, measureText: () => ({ width: 10 }),
    fillText: noop, createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null, clip: noop, quadraticCurveTo: noop, bezierCurveTo: noop, ellipse: noop,
    strokeRect: noop, roundRect: noop, setLineDash: noop, arcTo: noop,
  };
  const cv = { width: 0, height: 0, style: {}, getContext: () => ctx };
  ctx.canvas = cv;
  return cv;
}
globalThis.document = { createElement: fakeCanvas };

const { Soldier, GUN_POSES, HITBOXES, SURFS, DEFAULT_POSE } = await import('../src/character.js');
const s = new Soldier('BL');
s.root.position.set(0, 0, 0);
s.root.updateMatrixWorld(true);

const skels = new Set(s.meshes.map((m) => m.skeleton.uuid));
const sum = (f) => s.meshes.reduce((n, m) => n + f(m), 0);
console.log('导出可用:', typeof GUN_POSES, HITBOXES.length, SURFS.length, typeof DEFAULT_POSE);
console.log('网格', s.meshes.length, '共享骨架', skels.size === 1, '骨骼', s.meshes[0].skeleton.bones.length,
  '顶点', sum((m) => m.geometry.attributes.position.count), '三角', sum((m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3));
console.log('材质', s.meshes.map((m) => `${m.material.roughness}/${m.material.metalness} map=${!!m.material.map}`).join(' '), '程序数', new Set(s.meshes.map((m) => m.material.id)).size);

const W = ['ak47', 'm4a1', 'mp5', 'awm', 'deagle', 'knife', 'he'];
for (const id of W) {
  s.setWeapon(id);
  for (const scoped of [false, true]) {
    for (let i = 0; i < 40; i++) s.update(1 / 30, { speed: 0, fwd: 1, crouch: false, pitch: 0, onGround: true, reloading: false, scoped: scoped && id === 'awm' });
    s.root.updateMatrixWorld(true);
    const g = s.gun, an = g.userData.anchors;
    const wp = (b) => b.getWorldPosition(new THREE.Vector3());
    const lp = (v) => g.localToWorld(v.clone());
    const hr = wp(s.B.handR), hl = wp(s.B.handL), mu = lp(an.muzzle), gr = lp(an.grip);
    const fore = an.fore ? lp(an.fore) : null;
    console.log(`${id}${scoped ? '/aim' : ''} 手R→握把 ${hr.distanceTo(gr).toFixed(3)}m` +
      (fore ? ` 手L→护木 ${hl.distanceTo(fore).toFixed(3)}m` : '') +
      ` 枪口 ${mu.x.toFixed(2)},${mu.y.toFixed(2)},${mu.z.toFixed(2)} 高 ${mu.y.toFixed(2)} 头距 ${mu.distanceTo(wp(s.B.head)).toFixed(2)}  AimK ${s.aimK.toFixed(2)}`);
  }
}
// 命中判定（腿柱中心在 x=±0.09，正对 x=0 的射线只会擦到内侧棱）
const d = new THREE.Vector3(0, 0, -1), o = new THREE.Vector3();
for (const [x, y] of [[0, 1.72], [0, 1.45], [0, 1.05], [0.09, 0.75], [0.09, 0.35]]) {
  o.set(x, y, 6);
  const r = s.hitTest(o, d, 20, 1);
  console.log(`命中 (${x},${y}) →`, r ? `${r.t.toFixed(2)} ${r.part}` : 'null');
}
// 换弹：枪身绕握把翻起，手仍被 IK 拉着
s.setWeapon('ak47');
for (const reloading of [false, true]) {
  for (let i = 0; i < 30; i++) s.update(1 / 30, { speed: 0, fwd: 1, crouch: false, pitch: 0, onGround: true, reloading });
  s.root.updateMatrixWorld(true);
  console.log(`换弹 ${reloading ? '是' : '否'} ReloadK ${s.reloadK.toFixed(2)} 枪旋转 ${s.gun.rotation.x.toFixed(2)},${s.gun.rotation.y.toFixed(2)} 手R→握把 ${s.B.handR.getWorldPosition(new THREE.Vector3()).distanceTo(s.gun.localToWorld(s.gun.userData.anchors.grip.clone())).toFixed(3)}m`);
}
// 死亡 / 隐藏 / 重生
s.die(1, 0, true);
for (let i = 0; i < 60; i++) s.update(1 / 30, {});
console.log('死亡 网格旋转', s.meshes.map((m) => `${m.rotation.x.toFixed(2)},${m.rotation.z.toFixed(2)}`).join(' '), '环', s.ring.visible, '透明', s.mats.map((m) => m.transparent));
s.setVisible(false); console.log('隐藏', s.meshes.map((m) => m.visible).join(','), s.gun.visible);
s.reset(); s.setVisible(true);
console.log('重生', s.meshes.map((m) => `${m.rotation.x.toFixed(2)}`).join(','), '环', s.ring.visible, '透明', s.mats.map((m) => m.transparent).join(','), 'opacity', s.mats.map((m) => m.opacity).join(','));
// 外部通道：接口不全必须回落到程序化士兵
const { makeSoldier } = await import('../src/models-ext.js');
globalThis.window = { SoldierFactory: () => ({ root: new THREE.Object3D() }) };
console.log('残缺工厂 →', makeSoldier('BL', Soldier).constructor.name);
globalThis.window.SoldierFactory = () => ({ root: new THREE.Object3D(), update: noop, hitTest: () => null, setWeapon: noop });
console.log('合格工厂 →', makeSoldier('BL', Soldier).constructor.name);
delete globalThis.window.SoldierFactory;
console.log('无工厂 →', makeSoldier('BL', Soldier).constructor.name);
