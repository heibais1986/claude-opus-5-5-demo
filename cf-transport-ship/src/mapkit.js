// 地图通用构建工具：按材质合批的几何 + 碰撞体登记，运输船与 dust2 共用
import * as THREE from 'three';
import { mulberry32 } from './textures.js';

export const FACE = {
  px: { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  nx: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  py: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  ny: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  pz: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  nz: { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
};

// 按材质合批的几何缓冲
export class Batch {
  constructor() { this.p = []; this.n = []; this.uv = []; this.idx = []; this.count = 0; }
  quad(v0, v1, v2, v3, nrm, uvs) {
    const b = this.count;
    this.p.push(...v0, ...v1, ...v2, ...v3);
    for (let i = 0; i < 4; i++) this.n.push(nrm[0], nrm[1], nrm[2]);
    this.uv.push(...uvs);
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    this.count += 4;
  }
  geom(g, m4) {
    const gi = g.index ? g : g;
    const pos = gi.attributes.position, nor = gi.attributes.normal, uv = gi.attributes.uv;
    const b = this.count;
    const v = new THREE.Vector3(), nn = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(m4);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m4);
      this.p.push(v.x, v.y, v.z);
      nn.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      this.n.push(nn.x, nn.y, nn.z);
      if (uv) this.uv.push(uv.getX(i), uv.getY(i)); else this.uv.push(0, 0);
    }
    if (gi.index) for (let i = 0; i < gi.index.count; i++) this.idx.push(b + gi.index.getX(i));
    else for (let i = 0; i < pos.count; i++) this.idx.push(b + i);
    this.count += pos.count;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

export function createBuilder(scene, T, world, seed = 2024) {
  const rnd = mulberry32(seed);
  const batches = new Map();
  const matDefs = {};
  const footprints = []; // 落地物体投影，供地面 AO 烘焙
  const lampSpots = [];
  const anim = [];

  const std = (p) => new THREE.MeshStandardMaterial(p);
  function defMat(key, mat, uv = 'unit', flags = {}) { matDefs[key] = { mat, uv, ...flags }; }
  const batch = (key) => {
    let b = batches.get(key);
    if (!b) { b = new Batch(); batches.set(key, b); }
    return b;
  };

  // 盒子：faces 为 {px,nx,py,ny,pz,nz: matKey|null} 或单一 matKey
  function box(cx, cy, cz, sx, sy, sz, yaw, faces, uvOff) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const half = [sx / 2, sy / 2, sz / 2], size = [sx, sy, sz];
    const off = uvOff ?? [rnd(), rnd()];
    for (const fk in FACE) {
      const key = typeof faces === 'string' ? faces : faces[fk];
      if (!key) continue;
      const F = FACE[fk], def = matDefs[key];
      const su = Math.abs(F.u[0] * size[0] + F.u[1] * size[1] + F.u[2] * size[2]);
      const sv = Math.abs(F.v[0] * size[0] + F.v[1] * size[1] + F.v[2] * size[2]);
      const ctr = [F.n[0] * half[0], F.n[1] * half[1], F.n[2] * half[2]];
      const corner = (a, b) => {
        const lx = ctr[0] + F.u[0] * su * a + F.v[0] * sv * b;
        const ly = ctr[1] + F.u[1] * su * a + F.v[1] * sv * b;
        const lz = ctr[2] + F.u[2] * su * a + F.v[2] * sv * b;
        return [cx + c * lx + s * lz, cy + ly, cz - s * lx + c * lz];
      };
      const n = [c * F.n[0] + s * F.n[2], F.n[1], -s * F.n[0] + c * F.n[2]];
      let u0 = 0, v0 = 0, u1 = 1, v1 = 1;
      if (def.uv !== 'unit' && def.uv !== 'custom') {
        const tu = Array.isArray(def.uv) ? def.uv[0] : def.uv, tv = Array.isArray(def.uv) ? def.uv[1] : def.uv;
        u0 = off[0]; v0 = Array.isArray(def.uv) ? 0 : off[1];
        u1 = u0 + su / tu; v1 = v0 + sv / tv;
      }
      batch(key).quad(corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5), n, [u0, v0, u1, v0, u1, v1, u0, v1]);
    }
  }
  function solid(cx, cy, cz, sx, sy, sz, yaw, props = {}) {
    return world.add({ x: cx, y: cy, z: cz, sx, sy, sz, yaw, ...props });
  }
  function foot(cx, cz, sx, sz, yaw, dark = 0.6) { footprints.push({ cx, cz, sx, sz, yaw, dark }); }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), vs = new THREE.Vector3(1, 1, 1);
  function geom(key, g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    e.set(rx, ry, rz); q.setFromEuler(e); vs.set(sx, sy, sz);
    m4.compose(new THREE.Vector3(x, y, z), q, vs);
    batch(key).geom(g, m4);
  }
  // 两点之间的圆柱
  const up = new THREE.Vector3(0, 1, 0);
  function rod(key, x0, y0, z0, x1, y1, z1, r) {
    const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0); const L = d.length(); d.normalize();
    q.setFromUnitVectors(up, d); vs.set(r, L, r);
    m4.compose(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), q, vs);
    batch(key).geom(cylG8, m4);
  }
  // 自定义 UV 的矩形贴片（标识牌）
  function decal(key, cx, cy, cz, w, h, yaw, pitch, rect, texW = 1024) {
    const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // 局部：u 沿 +X，v 沿 +Y，法线 +Z；先绕 X 俯仰再绕 Y 偏航
    const tr = (lx, ly) => {
      const y1 = ly * cp, z1 = ly * sp;
      return [cx + c * lx + s * z1, cy + y1, cz - s * lx + c * z1];
    };
    const nz = [s * cp, -sp, c * cp];
    const [rx, ry, rw, rh] = rect;
    const u0 = rx / texW, u1 = (rx + rw) / texW, v1 = 1 - ry / texW, v0 = 1 - (ry + rh) / texW;
    batch(key).quad(tr(-w / 2, -h / 2), tr(w / 2, -h / 2), tr(w / 2, h / 2), tr(-w / 2, h / 2), nz, [u0, v0, u1, v0, u1, v1, u0, v1]);
  }

  const cylG = new THREE.CylinderGeometry(1, 1, 1, 16, 1);
  const cylG8 = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  const sphG = new THREE.SphereGeometry(1, 10, 8);
  const torG = new THREE.TorusGeometry(0.32, 0.07, 8, 20);

  // 把合批缓冲落成网格
  function flush() {
    const meshes = [];
    for (const [key, b] of batches) {
      if (!b.count) continue;
      const def = matDefs[key];
      const g = b.build();
      const mesh = new THREE.Mesh(g, def.mat);
      mesh.castShadow = def.shadow !== false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      if (def.alpha) {
        mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: def.mat.map, alphaTest: 0.5 });
      }
      mesh.name = key;
      scene.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }

  return {
    rnd, batches, matDefs, footprints, lampSpots, anim,
    std, defMat, batch, box, solid, foot, geom, rod, decal, flush,
    cylG, cylG8, sphG, torG,
  };
}
