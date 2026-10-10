// 第三人称士兵：刚性蒙皮 + 程序动画 + 骨骼命中盒
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { buildGunMerged } from './guns.js';
import { fbm } from './textures.js';

let ATLAS = null;
function atlas() {
  if (ATLAS) return ATLAS;
  const W = 512, H = 128;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const n = fbm(W, H, 16, 4, 4, 91);
  const img = ctx.createImageData(W, H), d = img.data;
  const camo = fbm(W, H, 8, 2, 3, 92), camo2 = fbm(W, H, 8, 2, 3, 93);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let v;
    if (x < 128) { // 布料纹理
      const weave = ((x + y) % 3 === 0 ? 0.92 : 1) * ((x - y + 300) % 4 === 0 ? 0.94 : 1);
      v = (0.82 + n[i] * 0.3) * weave;
    } else if (x < 256) { // 数码迷彩
      const qx = Math.floor(x / 4) * 4, qy = Math.floor(y / 4) * 4, qi = qy * W + qx;
      const a = camo[qi], b = camo2[qi];
      v = a > 0.56 ? 0.55 : b > 0.58 ? 1.25 : a < 0.42 ? 0.8 : 1.0;
      v *= 0.92 + n[i] * 0.15;
    } else v = 0.93 + n[i] * 0.12;
    const g = Math.min(255, v * 200);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  ATLAS = t;
  return t;
}

const OUTFIT = {
  BL: {
    pants: [0x2c2d31, 'fab'], jacket: [0x1f2124, 'fab'], vest: [0x2e3128, 'fab'], pouch: [0x3a3d30, 'fab'],
    boots: [0x141414, 'plain'], gloves: [0x18181a, 'plain'], skin: [0xb88c6c, 'plain'], mask: [0x151618, 'fab'],
    head: [0x151618, 'fab'], band: [0xa3161a, 'plain'], armband: [0xb01c1c, 'plain'], goggles: [0x1a1a1a, 'plain'], lens: [0xd66a1a, 'plain'],
    pads: [0x222326, 'plain'],
  },
  GR: {
    pants: [0x5e6b7c, 'camo'], jacket: [0x566478, 'camo'], vest: [0x27344a, 'fab'], pouch: [0x2e3c52, 'fab'],
    boots: [0x16161a, 'plain'], gloves: [0x1c1d20, 'plain'], skin: [0xc49a7a, 'plain'], mask: [0x202328, 'fab'],
    head: [0x33404f, 'plain'], band: [0x1a1a1a, 'plain'], armband: [0x1f62c8, 'plain'], goggles: [0x151515, 'plain'], lens: [0xe0c040, 'plain'],
    pads: [0x2a3340, 'plain'],
  },
};

const BONES = [
  // name, parent, x, y, z
  ['hips', -1, 0, 0.98, 0], ['spine', 0, 0, 0.12, 0], ['chest', 1, 0, 0.2, 0], ['neck', 2, 0, 0.2, 0], ['head', 3, 0, 0.08, 0],
  ['shoulderR', 2, 0.17, 0.13, 0], ['upperArmR', 5, 0.04, 0, 0], ['forearmR', 6, 0, -0.29, 0], ['handR', 7, 0, -0.26, 0],
  ['shoulderL', 2, -0.17, 0.13, 0], ['upperArmL', 9, -0.04, 0, 0], ['forearmL', 10, 0, -0.29, 0], ['handL', 11, 0, -0.26, 0],
  ['thighR', 0, 0.1, -0.05, 0], ['shinR', 13, 0, -0.44, 0], ['footR', 14, 0, -0.44, 0],
  ['thighL', 0, -0.1, -0.05, 0], ['shinL', 16, 0, -0.44, 0], ['footL', 17, 0, -0.44, 0],
];
const BI = Object.fromEntries(BONES.map((b, i) => [b[0], i]));

function bindPositions() {
  const out = [];
  for (const [, p, x, y, z] of BONES) {
    const v = new THREE.Vector3(x, y, z);
    if (p >= 0) v.add(out[p]);
    out.push(v);
  }
  return out;
}

// 构建带蒙皮属性的合并几何：按 布料 / 装具尼龙 / 金属 三组分开，才能给不同材质做不同的粗糙度与金属度
export const SURFS = [['cloth', 0.86, 0.02], ['gear', 0.62, 0.08], ['metal', 0.34, 0.78]];
const GEO_CACHE = {};
function buildGeometry(team) {
  if (GEO_CACHE[team]) return GEO_CACHE[team];
  const O = OUTFIT[team];
  const bp = bindPositions();
  const groups = { cloth: [], gear: [], metal: [] };
  const add = (geo, bone, colorKey, x, y, z, rx = 0, ry = 0, rz = 0, surf = 'cloth') => {
    const g = geo.clone();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    const [col, kind] = O[colorKey];
    const n = g.attributes.position.count;
    const color = new THREE.Color(col);
    const cols = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const uvs = new Float32Array(n * 2);
    const u0 = kind === 'fab' ? 0.02 : kind === 'camo' ? 0.27 : 0.6;
    const uw = kind === 'plain' ? 0.35 : 0.2;
    const src = g.attributes.uv;
    for (let i = 0; i < n; i++) {
      cols[i * 3] = color.r; cols[i * 3 + 1] = color.g; cols[i * 3 + 2] = color.b;
      si[i * 4] = BI[bone]; sw[i * 4] = 1;
      const su = src ? src.getX(i) : 0.5, sv = src ? src.getY(i) : 0.5;
      uvs[i * 2] = u0 + (su % 1) * uw; uvs[i * 2 + 1] = 0.05 + (sv % 1) * 0.9;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', g.attributes.position);
    out.setAttribute('normal', g.attributes.normal);
    out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    out.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    out.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    if (g.index) out.setIndex(g.index);
    groups[surf].push(out.index ? out.toNonIndexed() : out);
  };
  const cap = (r, l) => new THREE.CapsuleGeometry(r, l, 3, 10);
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  // 只有决定剪影的大件用倒角盒：一个小倒角盒 324 顶点，而 13 个角色同屏都要蒙皮变形
  const rbox = (w, h, d, r = 0.03) => new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  const sph = (r) => new THREE.SphereGeometry(r, 14, 10);
  const P = (name) => bp[BI[name]];
  // 腿
  for (const s of ['R', 'L']) {
    const sx = s === 'R' ? 1 : -1;
    const th = P('thigh' + s), sh = P('shin' + s), ft = P('foot' + s);
    add(cap(0.085, 0.3), 'thigh' + s, 'pants', th.x, th.y - 0.2, th.z);
    add(cap(0.068, 0.32), 'shin' + s, 'pants', sh.x, sh.y - 0.2, sh.z);
    add(box(0.12, 0.14, 0.1), 'shin' + s, 'pads', sh.x, sh.y - 0.02, sh.z - 0.06, 0, 0, 0, 'gear');
    add(rbox(0.12, 0.13, 0.27, 0.032), 'foot' + s, 'boots', ft.x, ft.y + 0.03, ft.z - 0.05, 0, 0, 0, 'gear');
    add(box(0.11, 0.1, 0.14), 'shin' + s, 'boots', sh.x, sh.y - 0.38, sh.z, 0, 0, 0, 'gear');
    add(box(0.09, 0.014, 0.24), 'foot' + s, 'boots', ft.x, ft.y - 0.035, ft.z - 0.05, 0, 0, 0, 'gear'); // 鞋底
    add(box(0.014, 0.09, 0.1), 'foot' + s, 'boots', ft.x + sx * 0.055, ft.y + 0.06, ft.z - 0.02, 0, 0, 0, 'gear'); // 靴筒后跟
    add(box(0.07, 0.1, 0.1), 'thigh' + s, 'pouch', th.x + sx * 0.08, th.y - 0.18, th.z, 0, 0, 0, 'gear');
    add(box(0.074, 0.012, 0.104), 'thigh' + s, 'band', th.x + sx * 0.08, th.y - 0.125, th.z, 0, 0, 0, 'metal'); // 袋盖扣带
  }
  // 躯干
  const hp = P('hips'), sp = P('spine'), ch = P('chest');
  add(rbox(0.36, 0.22, 0.24, 0.04), 'hips', 'pants', hp.x, hp.y - 0.02, hp.z);
  add(box(0.38, 0.06, 0.26), 'hips', 'band', hp.x, hp.y + 0.08, hp.z, 0, 0, 0, 'gear');
  add(box(0.06, 0.05, 0.02), 'hips', 'mask', hp.x, hp.y + 0.08, hp.z - 0.135, 0, 0, 0, 'metal'); // 腰带扣
  add(box(0.05, 0.07, 0.03), 'hips', 'pouch', hp.x - 0.14, hp.y - 0.01, hp.z - 0.02, 0, 0, 0.25, 'gear'); // 水壶
  add(box(0.33, 0.22, 0.22), 'spine', 'jacket', sp.x, sp.y + 0.1, sp.z);
  add(rbox(0.4, 0.3, 0.25, 0.045), 'chest', 'jacket', ch.x, ch.y + 0.1, ch.z);
  add(rbox(0.42, 0.34, 0.29, 0.04), 'chest', 'vest', ch.x, ch.y + 0.06, ch.z, 0, 0, 0, 'gear');
  add(box(0.42, 0.05, 0.29), 'chest', 'pouch', ch.x, ch.y + 0.235, ch.z, 0, 0, 0, 'gear'); // 背心肩线
  for (let i = 0; i < 3; i++) add(box(0.085, 0.11, 0.05), 'chest', 'pouch', ch.x - 0.1 + i * 0.1, ch.y - 0.02, ch.z - 0.16, 0, 0, 0, 'gear');
  for (let i = 0; i < 3; i++) add(box(0.078, 0.03, 0.052), 'chest', 'mask', ch.x - 0.1 + i * 0.1, ch.y + 0.036, ch.z - 0.163, 0, 0, 0, 'metal'); // 弹匣口
  add(box(0.07, 0.1, 0.045), 'chest', 'pouch', ch.x + 0.17, ch.y + 0.02, ch.z - 0.05, 0, -0.35, 0, 'gear'); // 侧挂步枪弹匣袋
  add(box(0.066, 0.09, 0.042), 'chest', 'mask', ch.x + 0.17, ch.y + 0.06, ch.z - 0.05, 0, -0.35, 0, 'metal');
  add(box(0.3, 0.34, 0.12), 'chest', 'pouch', ch.x, ch.y + 0.05, ch.z + 0.19, 0, 0, 0, 'gear'); // 背包
  add(box(0.26, 0.07, 0.13), 'chest', 'band', ch.x, ch.y + 0.235, ch.z + 0.19, 0, 0, 0, 'gear'); // 顶卷
  add(box(0.09, 0.11, 0.05), 'chest', 'mask', ch.x - 0.12, ch.y + 0.12, ch.z + 0.27, 0, 0, 0, 'gear'); // 电台
  add(box(0.03, 0.25, 0.03), 'chest', 'goggles', ch.x + 0.1, ch.y + 0.32, ch.z + 0.2, 0, 0, 0, 'metal'); // 天线
  add(box(0.02, 0.19, 0.03), 'chest', 'goggles', ch.x - 0.13, ch.y + 0.28, ch.z + 0.26, 0.25, 0, 0, 'metal'); // 天线二
  // 枪背带：斜跨胸前到左肩
  add(box(0.055, 0.44, 0.02), 'chest', 'band', ch.x - 0.03, ch.y + 0.08, ch.z - 0.155, 0, 0, 0.62, 'gear');
  add(box(0.055, 0.3, 0.02), 'chest', 'band', ch.x + 0.08, ch.y + 0.16, ch.z + 0.16, 0, 0, -0.5, 'gear');
  // 头
  const nk = P('neck'), hd = P('head');
  add(cap(0.055, 0.06), 'neck', 'skin', nk.x, nk.y + 0.04, nk.z);
  const headG = sph(0.108); headG.scale(0.95, 1.12, 1.02);
  add(headG, 'head', 'skin', hd.x, hd.y + 0.09, hd.z);
  if (team === 'GR') {
    const helm = new THREE.SphereGeometry(0.128, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55); helm.scale(1, 0.95, 1.08);
    add(helm, 'head', 'head', hd.x, hd.y + 0.12, hd.z + 0.005, 0, 0, 0, 'gear');
    add(box(0.26, 0.028, 0.27), 'head', 'head', hd.x, hd.y + 0.128, hd.z + 0.005, 0, 0, 0, 'gear'); // 盔檐
    add(box(0.05, 0.035, 0.04), 'head', 'goggles', hd.x, hd.y + 0.15, hd.z - 0.135, 0, 0, 0, 'metal'); // 夜视仪底座
    add(box(0.032, 0.026, 0.05), 'head', 'lens', hd.x, hd.y + 0.186, hd.z - 0.14, 0.3, 0, 0, 'metal');
    add(box(0.23, 0.05, 0.05), 'head', 'goggles', hd.x, hd.y + 0.155, hd.z - 0.1, 0, 0, 0, 'gear');
    add(box(0.18, 0.035, 0.02), 'head', 'lens', hd.x, hd.y + 0.155, hd.z - 0.125, 0, 0, 0, 'metal');
    const mask = sph(0.1); mask.scale(1, 0.62, 1.05);
    add(mask, 'head', 'mask', hd.x, hd.y + 0.035, hd.z - 0.02, 0, 0, 0, 'gear');
    add(box(0.02, 0.09, 0.1), 'head', 'band', hd.x + 0.118, hd.y + 0.06, hd.z + 0.02, 0, 0, 0.2, 'gear'); // 下颌带
    add(box(0.02, 0.09, 0.1), 'head', 'band', hd.x - 0.118, hd.y + 0.06, hd.z + 0.02, 0, 0, -0.2, 'gear');
  } else {
    const hood = sph(0.114); hood.scale(0.98, 1.1, 1.05);
    add(hood, 'head', 'mask', hd.x, hd.y + 0.1, hd.z + 0.008, 0, 0, 0, 'cloth');
    add(box(0.16, 0.035, 0.03), 'head', 'skin', hd.x, hd.y + 0.12, hd.z - 0.105);
    add(box(0.24, 0.035, 0.235), 'head', 'band', hd.x, hd.y + 0.185, hd.z, 0, 0, 0, 'gear'); // 头巾
    add(box(0.24, 0.012, 0.24), 'head', 'armband', hd.x, hd.y + 0.205, hd.z, 0, 0, 0, 'cloth');
    add(box(0.07, 0.022, 0.02), 'head', 'goggles', hd.x - 0.04, hd.y + 0.12, hd.z - 0.118, 0, 0, 0, 'metal');
    add(box(0.07, 0.022, 0.02), 'head', 'goggles', hd.x + 0.04, hd.y + 0.12, hd.z - 0.118, 0, 0, 0, 'metal');
    add(box(0.1, 0.06, 0.11), 'head', 'mask', hd.x, hd.y + 0.02, hd.z - 0.055, 0, 0, 0, 'cloth'); // 面罩下沿
  }
  // 手臂
  for (const s of ['R', 'L']) {
    const px = s === 'R' ? -1 : 1; // 右手手指朝身体中线（握把内侧）穿出，左手镜像
    const ua = P('upperArm' + s), fa = P('forearm' + s), hn = P('hand' + s);
    add(sph(0.085), 'upperArm' + s, 'jacket', ua.x, ua.y - 0.02, ua.z);
    add(cap(0.062, 0.2), 'upperArm' + s, 'jacket', ua.x, ua.y - 0.15, ua.z);
    add(cap(0.066, 0.05), 'upperArm' + s, 'armband', ua.x, ua.y - 0.12, ua.z);
    add(cap(0.052, 0.19), 'forearm' + s, 'jacket', fa.x, fa.y - 0.13, fa.z);
    add(box(0.02, 0.06, 0.07), 'forearm' + s, 'pads', fa.x + px * 0.045, fa.y - 0.1, fa.z, 0, 0, 0, 'gear'); // 护肘
    // 手套：掌 + 四指 + 拇指。指节沿骨骼 Y 排开，握把轴与之一致时才像握住而非拍在枪上
    add(rbox(0.078, 0.072, 0.056, 0.018), 'hand' + s, 'gloves', hn.x, hn.y - 0.036, hn.z, 0, 0, 0, 'gear');
    for (let i = 0; i < 4; i++) {
      add(box(0.042, 0.015, 0.017), 'hand' + s, 'gloves', hn.x + px * 0.036, hn.y - 0.014 - i * 0.017, hn.z + 0.002, 0, 0, px * -0.22, 'gear');
      add(box(0.016, 0.014, 0.017), 'hand' + s, 'gloves', hn.x + px * 0.056, hn.y - 0.026 - i * 0.017, hn.z + 0.002, 0, 0, px * 0.5, 'gear');
    }
    add(box(0.03, 0.015, 0.016), 'hand' + s, 'gloves', hn.x + px * 0.02, hn.y - 0.01, hn.z - 0.03, -0.5, 0, px * 0.3, 'gear');
  }
  const out = {};
  for (const [surf] of SURFS) {
    if (!groups[surf].length) continue;
    const geo = mergeAll(groups[surf]);
    geo.computeBoundingSphere();
    out[surf] = geo;
  }
  GEO_CACHE[team] = out;
  return out;
}

function mergeAll(list) {
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'uv', 'color', 'skinIndex', 'skinWeight'];
  for (const name of names) {
    const s = list[0].attributes[name];
    const Arr = s.array.constructor, isz = s.itemSize;
    const arr = new Arr(n * isz);
    let o = 0;
    for (const g of list) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, name === 'skinIndex' ? new THREE.Uint16BufferAttribute(arr, isz) : new THREE.BufferAttribute(arr, isz));
  }
  return out;
}

// 外部模型通道（models-ext.js）会复用这套判定体积，所以导出
export const HITBOXES = [
  // bone, cx, cy, cz, hx, hy, hz, part
  ['head', 0, 0.1, 0, 0.1, 0.12, 0.11, 'head'],
  ['chest', 0, 0.1, 0, 0.21, 0.18, 0.145, 'chest'],
  ['spine', 0, 0.09, 0, 0.17, 0.12, 0.12, 'stomach'],
  ['hips', 0, -0.02, 0, 0.18, 0.11, 0.13, 'stomach'],
  ['upperArmR', 0, -0.14, 0, 0.065, 0.16, 0.065, 'arm'], ['upperArmL', 0, -0.14, 0, 0.065, 0.16, 0.065, 'arm'],
  ['forearmR', 0, -0.13, 0, 0.055, 0.15, 0.055, 'arm'], ['forearmL', 0, -0.13, 0, 0.055, 0.15, 0.055, 'arm'],
  ['thighR', 0, -0.21, 0, 0.09, 0.24, 0.09, 'leg'], ['thighL', 0, -0.21, 0, 0.09, 0.24, 0.09, 'leg'],
  ['shinR', 0, -0.22, 0, 0.07, 0.24, 0.075, 'leg'], ['shinL', 0, -0.22, 0, 0.07, 0.24, 0.075, 'leg'],
];

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4();
const DOWN = new THREE.Vector3(0, -1, 0);

// 第三人称握持姿态（胸骨坐标系，-Z 是面朝方向）。每把枪的机匣长度、握把角、护木位置都不同，
// 用一套偏移会让手枪像步枪、狙击枪永远浮在胸口外侧。
export const GUN_POSES = {
  ak47: { pos: [0.085, 0.075, -0.25], rot: [-0.02, 0.36, 0], handR: 0, handL: 1.57, rel: [0.01, -0.1, 0.08], relRot: [-0.45, 0.55, 0.35] },
  m4a1: { pos: [0.085, 0.075, -0.26], rot: [-0.02, 0.36, 0], handR: 0, handL: 1.57, rel: [0.01, -0.1, 0.08], relRot: [-0.45, 0.55, 0.35] },
  mp5: { pos: [0.08, 0.08, -0.24], rot: [-0.02, 0.34, 0], handR: 0, handL: 1.57, rel: [0.01, -0.1, 0.07], relRot: [-0.4, 0.5, 0.3] },
  awm: {
    // 1.2m 的枪身比手臂长，端着跑只能斜抱：再往前伸左手就够不到护木（实测差 10cm，手会浮在枪管外）
    pos: [0.05, 0.07, -0.25], rot: [-0.02, 0.32, 0], handR: 0, handL: 1.57, rel: [-0.01, -0.11, 0.12], relRot: [-0.35, 0.7, 0.2],
    // 开镜：枪收到脸前贴腮，上身转正，左手托护木
    scoped: { pos: [0.02, 0.14, -0.23], rot: [0, 0.03, 0], handR: 0, handL: 1.57 },
  },
  deagle: { pos: [0.055, 0.115, -0.34], rot: [0, 0.16, 0], handR: 0, handL: 0, rel: [0, -0.12, 0.1], relRot: [-0.3, 0.9, 0.2] },
  knife: { pos: [0.14, 0.05, -0.24], rot: [-0.3, 0.42, 0.12], handR: -0.2, handL: 0, rel: [0, -0.05, 0.05], relRot: [0, 0, 0] },
  he: { pos: [0.13, 0.055, -0.22], rot: [-0.12, 0.3, 0.05], handR: 0, handL: 0, rel: [0, -0.06, 0.06], relRot: [-0.2, 0.3, 0] },
};
export const DEFAULT_POSE = { pos: [0.1, 0.075, -0.29], rot: [0, 0.36, 0], handR: 0, handL: 1.57, rel: [0, -0.1, 0.08], relRot: [-0.4, 0.5, 0.3] };

// 脚下队伍环：几何与材质全图共用，只有可见性随角色变化
let RING_GEO = null;
const RING_MAT = {};
function teamRing(team) {
  if (!RING_GEO) RING_GEO = new THREE.RingGeometry(0.3, 0.355, 24);
  if (!RING_MAT[team]) {
    RING_MAT[team] = new THREE.MeshBasicMaterial({
      color: OUTFIT[team].armband[0], transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false,
    });
  }
  const r = new THREE.Mesh(RING_GEO, RING_MAT[team]);
  r.rotation.x = -Math.PI / 2;
  r.position.y = 0.03;
  r.renderOrder = 2;
  return r;
}

export class Soldier {
  constructor(team) {
    this.team = team;
    this.root = new THREE.Group();
    // 骨架与三块蒙皮网格必须处在同一变换层下，共享 Skeleton 才不会各自算出不同的绑定矩阵
    this.body = new THREE.Group();
    this.root.add(this.body);
    const geos = buildGeometry(team);
    this.meshes = [];
    this.mats = [];
    this.mesh = null;
    for (const [surf, rough, metal] of SURFS) {
      if (!geos[surf]) continue;
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: atlas(), roughness: rough, metalness: metal });
      const mesh = new THREE.SkinnedMesh(geos[surf], mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.body.add(mesh);
      if (!this.mesh) this.mesh = mesh; // 主网格：外部旧代码仍按 mesh 访问
      this.meshes.push(mesh);
      this.mats.push(mat);
    }
    this.material = this.mesh.material;
    this.bones = BONES.map(([name]) => { const b = new THREE.Bone(); b.name = name; return b; });
    BONES.forEach(([, p, x, y, z], i) => {
      this.bones[i].position.set(x, y, z);
      if (p >= 0) this.bones[p].add(this.bones[i]); else this.mesh.add(this.bones[i]);
    });
    this.mesh.updateMatrixWorld(true);
    const sk = new THREE.Skeleton(this.bones);
    this.mesh.bind(sk);
    for (const m of this.meshes) {
      if (m === this.mesh) continue;
      m.updateMatrixWorld(true);
      m.bind(sk);
    }
    this.ring = teamRing(team);
    this.root.add(this.ring);
    this.B = Object.fromEntries(this.bones.map((b) => [b.name, b]));
    this.phase = Math.random() * 10;
    this.crouchK = 0;
    this.reloadK = 0;
    this.aimK = 0;
    this.deadT = -1; this.fallDir = 1; this.fallSide = 0;
    this.recoilK = 0;
    this.gun = null; this.gunId = null;
    this.invs = HITBOXES.map(() => new THREE.Matrix4());
    this.invFrame = -1;
    this.opacity = 1;
    this.flashT = 0;
  }
  setVisible(on) {
    for (const m of this.meshes) m.visible = on;
    this.ring.visible = on && this.deadT < 0;
    if (this.gun) this.gun.visible = on;
  }
  setWeapon(id) {
    if (this.gunId === id) return;
    if (this.gun) this.B.chest.remove(this.gun);
    this.aimK = 0; this.reloadK = 0; // 换枪瞬间不能带着上一把的开镜/换弹姿态
    this.gunId = id;
    this.gun = buildGunMerged(id);
    // 枪挂在胸骨上，保证瞄准方向稳定
    this.B.chest.add(this.gun);
    this.gunType = id;
  }
  // 两骨骼 IK：让手到达胸骨坐标系下的目标点
  solveArm(side, targetWorld, poleWorld) {
    const up = this.B['upperArm' + side], fore = this.B['forearm' + side];
    const S = up.getWorldPosition(new THREE.Vector3());
    const a = 0.29, b = 0.28;
    const toT = _v.copy(targetWorld).sub(S);
    let d = toT.length();
    d = Math.min(d, a + b - 0.001);
    const dir = toT.normalize();
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    const ang = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
    // 肘部方向：朝向 pole 在垂直于 dir 平面上的投影
    const pole = _v2.copy(poleWorld).sub(S);
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const elbowDir = dir.clone().multiplyScalar(Math.cos(ang)).addScaledVector(pole, Math.sin(ang)).normalize();
    const E = S.clone().addScaledVector(elbowDir, a);
    // 上臂
    const parentQ = up.parent.getWorldQuaternion(_q);
    const wq = _q2.setFromUnitVectors(DOWN, elbowDir);
    up.quaternion.copy(parentQ.invert().multiply(wq));
    up.updateMatrixWorld(true);
    const T2 = S.clone().addScaledVector(dir, d);
    const fdir = T2.sub(E).normalize();
    const pq = up.getWorldQuaternion(new THREE.Quaternion());
    fore.quaternion.copy(pq.invert().multiply(new THREE.Quaternion().setFromUnitVectors(DOWN, fdir)));
  }
  // st: {speed, fwd, side, crouch, pitch, onGround, dead, t}
  update(dt, st) {
    const B = this.B;
    if (this.deadT >= 0) { this.updateDeath(dt); return; }
    this.crouchK += ((st.crouch ? 1 : 0) - this.crouchK) * Math.min(1, dt * 10);
    this.reloadK += ((st.reloading && this.aimK < 0.5 ? 1 : 0) - this.reloadK) * Math.min(1, dt * 8);
    const ck = this.crouchK;
    const sp = st.speed;
    const moving = sp > 0.3 && st.onGround;
    this.phase += dt * (moving ? 2.2 + sp * 1.15 : 0) * (ck > 0.5 ? 0.7 : 1);
    const amp = moving ? Math.min(1, sp / 5) : 0;
    this.amp = (this.amp || 0) + (amp - (this.amp || 0)) * Math.min(1, dt * 8);
    const A = this.amp;
    const ph = this.phase;
    const back = st.fwd < -0.3 ? -1 : 1;
    // 腿
    const swing = Math.sin(ph) * 0.62 * A * back;
    const bendR = Math.max(0, Math.sin(ph + Math.PI * 0.5 * back)) * 1.0 * A;
    const bendL = Math.max(0, Math.sin(ph + Math.PI + Math.PI * 0.5 * back)) * 1.0 * A;
    let thR = swing, thL = -swing, shR = -bendR, shL = -bendL;
    // 下蹲
    thR = thR * (1 - ck) + (1.25 + swing * 0.3) * ck;
    thL = thL * (1 - ck) + (0.55 - swing * 0.3) * ck;
    shR = shR * (1 - ck) + -1.9 * ck;
    shL = shL * (1 - ck) + (-1.2 + Math.min(0, -swing)) * ck;
    if (!st.onGround) { thR = 0.7; thL = 0.25; shR = -1.1; shL = -0.6; }
    B.thighR.rotation.set(thR, 0, 0.02); B.thighL.rotation.set(thL, 0, -0.02);
    B.shinR.rotation.set(shR, 0, 0); B.shinL.rotation.set(shL, 0, 0);
    B.footR.rotation.set(-thR - shR - 0.0, 0, 0); B.footL.rotation.set(-thL - shL, 0, 0);
    if (ck > 0.01) { B.footL.rotation.x = 0.5 * ck + B.footL.rotation.x * (1 - ck); }
    // 髋部高度
    const bob = moving ? Math.abs(Math.cos(ph)) * 0.035 * A : 0;
    B.hips.position.y = 0.98 - ck * 0.38 - bob + (st.onGround ? 0 : 0.02);
    B.hips.position.z = ck * 0.08;
    B.hips.rotation.y = Math.sin(ph) * 0.08 * A;
    // 上身跟随俯仰；开镜时侧身转正、头贴枪托
    const pitch = THREE.MathUtils.clamp(st.pitch, -1.2, 1.2);
    const pose = GUN_POSES[this.gunId] || DEFAULT_POSE;
    const scp = pose.scoped && pose.scoped.pos, scr = pose.scoped && pose.scoped.rot;
    // st.scoped 由调用方判定（开镜动画已就绪才为真），这里只认这一位
    const wantAim = !!(st.scoped && pose.scoped);
    this.aimK += ((wantAim ? 1 : 0) - this.aimK) * Math.min(1, dt * 9);
    const SK = this.aimK, RL = this.reloadK;
    B.spine.rotation.set(pitch * 0.3 + ck * 0.15, (-B.hips.rotation.y - 0.25) * (1 - SK) - B.hips.rotation.y * SK, 0);
    B.chest.rotation.set(pitch * (0.45 - SK * 0.2) - this.recoilK * 0.08, -0.12 * (1 - SK), 0);
    B.neck.rotation.set(pitch * (0.2 + SK * 0.18), 0.3 * (1 - SK), 0);
    B.head.rotation.set(-SK * 0.14, 0.05 * (1 - SK), SK * 0.06);
    this.recoilK *= Math.exp(-dt * 12);
    if (this.gun) {
      const pp = pose.pos, rr = pose.rot, rel = pose.rel, relRot = pose.relRot;
      const lerp1 = (a, b) => (b === undefined ? a : a + (b - a) * SK);
      this.gun.position.set(
        lerp1(pp[0], scp && scp[0]) + rel[0] * RL,
        lerp1(pp[1], scp && scp[1]) + rel[1] * RL,
        lerp1(pp[2], scp && scp[2]) + rel[2] * RL + this.recoilK * 0.05
      );
      this.gun.rotation.set(
        lerp1(rr[0], scr && scr[0]) + relRot[0] * RL - this.recoilK * 0.12,
        lerp1(rr[1], scr && scr[1]) + relRot[1] * RL,
        lerp1(rr[2], scr && scr[2]) + relRot[2] * RL
      );
      this.mesh.updateMatrixWorld(true);
      const an = this.gun.userData.anchors;
      const gW = this.gun.localToWorld(_t1.copy(an.grip || _t2.set(0, -0.05, 0)));
      const poleR = this.B.chest.localToWorld(_t3.set(0.6, -0.5, 0.1));
      this.solveArm('R', gW, poleR);
      const gunQ = this.gun.getWorldQuaternion(_q4);
      this.setHand('R', gunQ, pose.handR);
      if (an.fore) {
        const fw = this.gun.localToWorld(_t1.copy(an.fore));
        const poleL = this.B.chest.localToWorld(_t3.set(-0.5, -0.6, 0));
        this.solveArm('L', fw, poleL);
        this.setHand('L', gunQ, pose.handL);
      } else {
        B.upperArmL.rotation.set(0.3, 0, -0.15); B.forearmL.rotation.set(0.6, 0, 0);
        B.handL.quaternion.identity();
      }
    } else {
      B.handR.quaternion.identity(); B.handL.quaternion.identity();
    }
  }
  // 手掌朝向跟着枪转：手指是绕着握把排开的，指节不对枪就只会拍成一块盒子
  setHand(side, gunWorldQ, rollX) {
    const h = this.B['hand' + side];
    _q2.setFromEuler(_e.set(rollX, 0, 0));
    _q.copy(gunWorldQ).multiply(_q2);
    h.quaternion.copy(h.parent.getWorldQuaternion(_q3).invert().multiply(_q));
  }
  kick() { this.recoilK = 1; }
  die(dirX, dirZ, headshot) {
    this.deadT = 0;
    // 倒地方向：沿子弹方向
    const fwd = new THREE.Vector3(-Math.sin(this.root.rotation.y), 0, -Math.cos(this.root.rotation.y));
    const dot = fwd.x * dirX + fwd.z * dirZ;
    this.fallDir = dot > 0 ? 1 : -1; // 被从背后打 -> 向前倒
    this.fallSide = (Math.random() - 0.5) * 0.8;
    this.fallSpeed = headshot ? 1.4 : 1;
    this.limbR = [Math.random(), Math.random(), Math.random(), Math.random()];
    this.setFade(1, false);
  }
  updateDeath(dt) {
    const B = this.B;
    this.deadT += dt;
    const t = Math.min(1, this.deadT * 1.6 * this.fallSpeed);
    const e = t * t; // 重力加速
    const ang = e * Math.PI * 0.5 * 0.96;
    for (const m of this.meshes) { m.rotation.x = -this.fallDir * ang; m.rotation.z = this.fallSide * e; }
    B.hips.position.y = 0.98 - Math.sin(t * Math.PI) * 0.25 - t * 0.3;
    const r = this.limbR;
    const k = Math.min(1, this.deadT * 3);
    B.upperArmR.rotation.x += ((r[0] * 2 - 1) * 1.5 - B.upperArmR.rotation.x) * k * 0.2;
    B.upperArmL.rotation.x += ((r[1] * 2 - 1) * 1.5 - B.upperArmL.rotation.x) * k * 0.2;
    B.forearmR.rotation.set(0.3 * r[2], 0, 0); B.forearmL.rotation.set(0.4 * r[3], 0, 0);
    B.thighR.rotation.x *= 0.9; B.thighL.rotation.x += (0.4 * r[2] - B.thighL.rotation.x) * 0.1;
    B.shinR.rotation.x *= 0.9; B.shinL.rotation.x *= 0.9;
    B.spine.rotation.x *= 0.9; B.chest.rotation.x *= 0.9; B.neck.rotation.x += (0.3 * this.fallDir - B.neck.rotation.x) * 0.1;
    if (this.gun) this.gun.visible = this.deadT < 0.25;
    this.ring.visible = false;
    if (this.deadT > 4.5) {
      this.setFade(Math.max(0, 1 - (this.deadT - 4.5) / 1.2), true);
      this.root.position.y -= dt * 0.15;
    }
  }
  setFade(op, transparent) {
    this.opacity = op;
    for (const m of this.mats) { m.transparent = transparent; m.opacity = op; }
  }
  reset() {
    this.deadT = -1;
    for (const m of this.meshes) m.rotation.set(0, 0, 0);
    this.setFade(1, false);
    this.aimK = 0; this.reloadK = 0;
    this.ring.visible = true;
    if (this.gun) this.gun.visible = true;
  }
  // 射线命中测试，返回 {t, part}
  hitTest(o, d, maxT, frame) {
    // 粗检：到髋部的距离
    const hp = this.B.hips.getWorldPosition(_v);
    const wx = hp.x - o.x, wy = hp.y + 0.3 - o.y, wz = hp.z - o.z;
    const tc = wx * d.x + wy * d.y + wz * d.z;
    if (tc < -1.5 || tc > maxT + 1.5) return null;
    const px = wx - d.x * tc, py = wy - d.y * tc, pz = wz - d.z * tc;
    if (px * px + py * py + pz * pz > 1.6) return null;
    if (this.invFrame !== frame) {
      this.mesh.updateMatrixWorld(true);
      HITBOXES.forEach((h, i) => this.invs[i].copy(this.B[h[0]].matrixWorld).invert());
      this.invFrame = frame;
    }
    let best = maxT, part = null;
    const lo = new THREE.Vector3(), ld = new THREE.Vector3();
    for (let i = 0; i < HITBOXES.length; i++) {
      const [, cx, cy, cz, hx, hy, hz, name] = HITBOXES[i];
      lo.copy(o).applyMatrix4(this.invs[i]);
      ld.copy(d).transformDirection(this.invs[i]);
      const ox = lo.x - cx, oy = lo.y - cy, oz = lo.z - cz;
      let tmin = 0, tmax = best;
      const slab = (oo, dd, h) => {
        if (Math.abs(dd) < 1e-9) return oo >= -h && oo <= h;
        let t1 = (-h - oo) / dd, t2 = (h - oo) / dd;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        return tmin <= tmax;
      };
      if (slab(ox, ld.x, hx) && slab(oy, ld.y, hy) && slab(oz, ld.z, hz) && tmin < best) { best = tmin; part = name; }
    }
    return part ? { t: best, part } : null;
  }
  muzzleWorld(out) {
    if (!this.gun) return this.B.head.getWorldPosition(out);
    return this.gun.localToWorld(out.copy(this.gun.userData.anchors.muzzle || _v.set(0, 0, -0.5)));
  }
  headWorld(out) { return this.B.head.localToWorld(out.set(0, 0.1, 0)); }
  chestWorld(out) { return this.B.chest.localToWorld(out.set(0, 0.1, 0)); }
}
