// 碰撞世界：所有静态碰撞体都是绕 Y 轴旋转的 OBB
// 约定：three.js rotation.y = yaw，local->world: (x,z) -> (c*x + s*z, -s*x + c*z)

export class Collider {
  constructor(o) {
    this.x = o.x; this.y = o.y; this.z = o.z; // 中心
    this.hx = o.sx / 2; this.hy = o.sy / 2; this.hz = o.sz / 2;
    this.yaw = o.yaw || 0;
    this.c = Math.cos(this.yaw); this.s = Math.sin(this.yaw);
    this.mat = o.mat || 'metal';            // 命中材质：metal | wood | mesh | concrete
    this.solid = o.solid !== false;         // 是否阻挡移动
    this.bullet = o.bullet || 'block';      // block | pass | pen(可穿透)
    this.sight = o.sight !== false;         // 是否阻挡视线
    this.surface = o.surface || (this.mat === 'wood' ? 'wood' : 'metal'); // 脚步声
    this.top = this.y + this.hy; this.bottom = this.y - this.hy;
    const ex = Math.abs(this.c) * this.hx + Math.abs(this.s) * this.hz;
    const ez = Math.abs(this.s) * this.hx + Math.abs(this.c) * this.hz;
    this.minX = this.x - ex; this.maxX = this.x + ex;
    this.minZ = this.z - ez; this.maxZ = this.z + ez;
    this.stamp = 0;
    this.tag = o.tag || '';
  }
  // 世界 -> 局部（XZ）
  toLocal(wx, wz) {
    const dx = wx - this.x, dz = wz - this.z;
    return [this.c * dx - this.s * dz, this.s * dx + this.c * dz];
  }
  toWorldDir(lx, lz) { return [this.c * lx + this.s * lz, -this.s * lx + this.c * lz]; }
}

const CELL = 4;
const NDIR = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export class World {
  constructor() {
    this.colliders = [];
    this.grid = new Map();
    this.stamp = 1;
    this._cand = [];
  }
  add(o) {
    const c = o instanceof Collider ? o : new Collider(o);
    this.colliders.push(c);
    return c;
  }
  build() {
    this.grid.clear();
    for (const c of this.colliders) {
      const x0 = Math.floor(c.minX / CELL), x1 = Math.floor(c.maxX / CELL);
      const z0 = Math.floor(c.minZ / CELL), z1 = Math.floor(c.maxZ / CELL);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = x * 1000 + z;
        let arr = this.grid.get(k);
        if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(c);
      }
    }
  }
  query(minX, minZ, maxX, maxZ) {
    const out = this._cand; out.length = 0;
    const st = ++this.stamp;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const arr = this.grid.get(x * 1000 + z);
      if (!arr) continue;
      for (const c of arr) {
        if (c.stamp === st) continue;
        c.stamp = st;
        if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
        out.push(c);
      }
    }
    return out;
  }

  // 射线 vs 单个 OBB，返回 t 与局部法线
  static rayOBB(c, ox, oy, oz, dx, dy, dz, maxT, res) {
    const rx = ox - c.x, rz = oz - c.z;
    const lox = c.c * rx - c.s * rz, loz = c.s * rx + c.c * rz, loy = oy - c.y;
    const ldx = c.c * dx - c.s * dz, ldz = c.s * dx + c.c * dz, ldy = dy;
    let tmin = 0, tmax = maxT, axis = -1, sign = 0;
    // X
    if (Math.abs(ldx) < 1e-9) { if (lox < -c.hx || lox > c.hx) return false; }
    else {
      let t1 = (-c.hx - lox) / ldx, t2 = (c.hx - lox) / ldx, sg = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
      if (t1 > tmin) { tmin = t1; axis = 0; sign = sg; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    if (Math.abs(ldy) < 1e-9) { if (loy < -c.hy || loy > c.hy) return false; }
    else {
      let t1 = (-c.hy - loy) / ldy, t2 = (c.hy - loy) / ldy, sg = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
      if (t1 > tmin) { tmin = t1; axis = 1; sign = sg; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    if (Math.abs(ldz) < 1e-9) { if (loz < -c.hz || loz > c.hz) return false; }
    else {
      let t1 = (-c.hz - loz) / ldz, t2 = (c.hz - loz) / ldz, sg = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
      if (t1 > tmin) { tmin = t1; axis = 2; sign = sg; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    if (axis < 0) { // 起点在盒内
      res.t = 0; res.exit = tmax; res.nx = -dx; res.ny = -dy; res.nz = -dz; return true;
    }
    res.t = tmin; res.exit = tmax;
    let lnx = 0, lny = 0, lnz = 0;
    if (axis === 0) lnx = sign; else if (axis === 1) lny = sign; else lnz = sign;
    res.nx = c.c * lnx + c.s * lnz; res.ny = lny; res.nz = -c.s * lnx + c.c * lnz;
    return true;
  }

  // 射线检测。filter: 'move' | 'bullet' | 'sight'
  // 返回最近命中 {t, nx,ny,nz, collider, exit}
  raycast(ox, oy, oz, dx, dy, dz, maxT, mode = 'bullet', out = {}) {
    const ex = ox + dx * maxT, ez = oz + dz * maxT;
    const cands = this.query(Math.min(ox, ex) - 0.1, Math.min(oz, ez) - 0.1, Math.max(ox, ex) + 0.1, Math.max(oz, ez) + 0.1);
    let best = maxT, hit = null;
    const r = this._r || (this._r = {});
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (mode === 'bullet' && c.bullet === 'pass') continue;
      if (mode === 'sight' && !c.sight) continue;
      if (mode === 'move' && !c.solid) continue;
      if (World.rayOBB(c, ox, oy, oz, dx, dy, dz, best, r) && r.t < best) {
        best = r.t; hit = c;
        out.nx = r.nx; out.ny = r.ny; out.nz = r.nz; out.exit = r.exit;
      }
    }
    if (!hit) return null;
    out.t = best; out.collider = hit;
    return out;
  }

  // 返回沿射线所有命中（按 t 排序），用于穿透
  raycastAll(ox, oy, oz, dx, dy, dz, maxT) {
    const ex = ox + dx * maxT, ez = oz + dz * maxT;
    const cands = this.query(Math.min(ox, ex) - 0.1, Math.min(oz, ez) - 0.1, Math.max(ox, ex) + 0.1, Math.max(oz, ez) + 0.1);
    const hits = [];
    const r = {};
    for (const c of cands) {
      if (c.bullet === 'pass') continue;
      if (World.rayOBB(c, ox, oy, oz, dx, dy, dz, maxT, r)) hits.push({ t: r.t, exit: r.exit, nx: r.nx, ny: r.ny, nz: r.nz, collider: c });
    }
    hits.sort((a, b) => a.t - b.t);
    return hits;
  }

  // 圆（XZ）与 OBB 的最近点关系
  static circleOBB(c, px, pz, r, out) {
    const [lx, lz] = c.toLocal(px, pz);
    const qx = Math.max(-c.hx, Math.min(c.hx, lx));
    const qz = Math.max(-c.hz, Math.min(c.hz, lz));
    const dx = lx - qx, dz = lz - qz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return false;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      const [wx, wz] = c.toWorldDir(dx / d, dz / d);
      out.nx = wx; out.nz = wz; out.pen = r - d;
    } else {
      const px2 = c.hx - Math.abs(lx), pz2 = c.hz - Math.abs(lz);
      let lnx = 0, lnz = 0, pen;
      if (px2 < pz2) { lnx = lx >= 0 ? 1 : -1; pen = px2 + r; } else { lnz = lz >= 0 ? 1 : -1; pen = pz2 + r; }
      const [wx, wz] = c.toWorldDir(lnx, lnz);
      out.nx = wx; out.nz = wz; out.pen = pen;
    }
    return true;
  }

  // 判断胶囊空间是否被占用（用于站起/上台阶检查）
  blocked(px, py, pz, r, h) {
    const cands = this.query(px - r, pz - r, px + r, pz + r);
    const o = {};
    for (const c of cands) {
      if (!c.solid) continue;
      if (c.top <= py + 0.001 || c.bottom >= py + h - 0.001) continue;
      if (World.circleOBB(c, px, pz, r, o)) return true;
    }
    return false;
  }

  // 头顶是否压着板：只认底面悬在探测区间内的碰撞体。
  // 墙与地面块从脚下长起来，用 blocked() 判净高会把「紧挨着一面墙」误判成站不下。
  overheard(px, py, pz, r, h) {
    const cands = this.query(px - r, pz - r, px + r, pz + r);
    const o = {};
    for (const c of cands) {
      if (!c.solid) continue;
      if (c.bottom <= py + 0.05 || c.bottom >= py + h - 0.001) continue;
      if (World.circleOBB(c, px, pz, r, o)) return true;
    }
    return false;
  }

  // 脚下最高支撑面（top <= maxY），返回 {y, collider}
  support(px, pz, r, maxY) {
    const cands = this.query(px - r, pz - r, px + r, pz + r);
    let best = -Infinity, bc = null;
    const o = {};
    for (const c of cands) {
      if (!c.solid) continue;
      if (c.top > maxY || c.top <= best) continue;
      if (World.circleOBB(c, px, pz, r, o)) { best = c.top; bc = c; }
    }
    return bc ? { y: best, collider: bc } : null;
  }

  // 角色移动：ent {pos:{x,y,z}(脚底), vel, radius, height, onGround, stepHeight}
  move(ent, dt) {
    const vx = ent.vel.x, vy = ent.vel.y, vz = ent.vel.z;
    const dist = Math.hypot(vx, vy, vz) * dt;
    const n = Math.max(1, Math.ceil(dist / 0.12));
    const h = dt / n;
    const o = {};
    const r = ent.radius;
    let landed = false, landSpeed = 0;
    for (let s = 0; s < n; s++) {
      const p = ent.pos;
      // 水平
      p.x += ent.vel.x * h; p.z += ent.vel.z * h;
      for (let it = 0; it < 3; it++) {
        const cands = this.query(p.x - r, p.z - r, p.x + r, p.z + r);
        let any = false;
        for (const c of cands) {
          if (!c.solid) continue;
          const head = p.y + ent.height;
          if (c.top <= p.y + 0.001 || c.bottom >= head - 0.001) continue;
          if (!World.circleOBB(c, p.x, p.z, r, o)) continue;
          // 上台阶
          const rise = c.top - p.y;
          if (ent.onGround && rise > 0 && rise <= ent.stepHeight && !this.blocked(p.x, c.top, p.z, r * 0.95, ent.height)) {
            p.y = c.top; ent.stepped = (ent.stepped || 0) + rise; any = true; continue;
          }
          p.x += o.nx * (o.pen + 0.0005); p.z += o.nz * (o.pen + 0.0005);
          const vn = ent.vel.x * o.nx + ent.vel.z * o.nz;
          if (vn < 0) { ent.vel.x -= o.nx * vn; ent.vel.z -= o.nz * vn; }
          any = true;
        }
        if (!any) break;
      }
      // 垂直
      const prevY = p.y;
      p.y += ent.vel.y * h;
      if (ent.vel.y <= 0) {
        const probeUp = ent.onGround ? ent.stepHeight : 0.001;
        const sup = this.support(p.x, p.z, r * 0.92, prevY + 0.001);
        const snap = ent.onGround && ent.vel.y <= 0.01 ? Math.max(0.3, -ent.vel.y * h) : 0;
        if (sup && p.y <= sup.y + snap) {
          if (!ent.onGround) { landed = true; landSpeed = -ent.vel.y; }
          p.y = sup.y; ent.vel.y = 0; ent.onGround = true; ent.ground = sup.collider;
        } else {
          ent.onGround = false; ent.ground = null;
        }
        void probeUp;
      } else {
        ent.onGround = false; ent.ground = null;
        // 顶头
        const cands = this.query(p.x - r, p.z - r, p.x + r, p.z + r);
        for (const c of cands) {
          if (!c.solid) continue;
          const headPrev = prevY + ent.height, head = p.y + ent.height;
          if (c.bottom >= headPrev - 0.01 && c.bottom < head && World.circleOBB(c, p.x, p.z, r * 0.9, o)) {
            p.y = c.bottom - ent.height - 0.001; ent.vel.y = 0;
          }
        }
      }
    }
    ent.landed = landed; ent.landSpeed = landSpeed;
  }
}

// ============== 寻路网格（地面层） ==============
// 两种来源：
//  1. 由碰撞体推断（运输船那种层数少、地面平的手搭图）
//  2. 由地图数据离线算好的高度场 + 四向可走掩码（真实几何，地面起伏、台阶与断崖必须区分）
// field: { y: Int16Array(厘米，blocked 值为哨兵), link: Uint8Array(bit0 +x bit1 +z bit2 -x bit3 -z), blocked, w, h }
export class NavGrid {
  constructor(world, x0, z0, x1, z1, cell, agentR, field) {
    this.x0 = x0; this.z0 = z0; this.cell = cell;
    this.world = world;
    this.w = field ? field.w : Math.ceil((x1 - x0) / cell);
    this.h = field ? field.h : Math.ceil((z1 - z0) / cell);
    const n = this.w * this.h;
    this.block = new Uint8Array(n);
    this.cost = new Float32Array(n);
    this.ground = new Float32Array(n);
    this.link = field ? field.link : null;
    if (field) this.initField(world, field, agentR);
    else this.initColliders(world, agentR);
    // 头顶压着板（地道、阳台、集装箱顶下的夹层）的格子不可站
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
      const k = j * this.w + i;
      if (this.block[k]) continue;
      const cx = x0 + (i + 0.5) * cell, cz = z0 + (j + 0.5) * cell;
      if (world.overheard(cx, this.ground[k] + 0.4, cz, agentR * 0.8, 1.4)) this.block[k] = 1;
    }
    this.prune();
    this.open = new Int32Array(n);
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.gen = 1;
  }
  // 高度场来源：格子可走性直接取数据，靠墙代价仍由碰撞体给
  initField(world, f, agentR) {
    const y = f.y, n = this.w * this.h, sent = f.blocked;
    for (let k = 0; k < n; k++) {
      const v = y[k];
      if (v === sent) { this.block[k] = 1; this.cost[k] = 1; continue; }
      this.ground[k] = v / 100;
    }
    // 每一格都得真有一块板接着：官方导航海拔和体素实测能差到一两米，
    // 照海拔把人放下去就是站进实体里，物理再把他顶穿地板，bot 从此在地板下面无限下坠。
    // 吸附后一律以「物理实测面」为准：碰撞盒就是这块面，导航只有跟着它才不会画出走不通的路线。
    const step = f.step || 0.42;
    const LIFT = 1.0;   // 只允许吸附到「跳一下够得着」的高度：再高就是箱顶、墙顶，不是地面
    const o = {};
    // 吸附半径必须明显小于格宽：拿角色半径去搜会把隔壁箱子的顶当成这一格的地面，
    // 导航于是把 bot 领上一块根本不存在的台面，他走到那儿就掉进箱子与墙之间的缝里反复卡死。
    const SR = this.cell * 0.25;
    this.noFloor = 0;
    this.buried = 0;
    for (let k = 0; k < n; k++) {
      if (this.block[k]) continue;
      const gy = this.ground[k];
      const cx = this.x0 + ((k % this.w) + 0.5) * this.cell, cz = this.z0 + (((k / this.w) | 0) + 0.5) * this.cell;
      let sup = world.support(cx, cz, SR, gy + step);
      if (!sup || gy - sup.y > step) sup = world.support(cx, cz, SR, gy + LIFT);
      if (!(sup && sup.y - gy <= LIFT && gy - sup.y <= 1.5)) { this.block[k] = 1; this.cost[k] = 1; this.noFloor++; continue; }
      this.ground[k] = sup.y;
      // 格中心埋进了墙身：官方导航点位和 0.5m 体素列本来就对不齐，薄墙正好落在一个可走格里时，
      // 导航以为能走、角色却撞在墙上，寻路拉直后就会出现「导航通、物理不通」的长弦。
      // 只认「从脚下长起来、高过胸口」的实体：贴身一级台阶不算埋进去，那种格子照样能站人。
      for (const c of world.query(cx - 0.1, cz - 0.1, cx + 0.1, cz + 0.1)) {
        if (!c.solid || c.bottom > sup.y + 0.1 || c.top < sup.y + 1.2) continue;
        if (World.circleOBB(c, cx, cz, 0.1, o)) { this.block[k] = 1; this.cost[k] = 1; this.buried++; break; }
      }
    }
    // 海拔吸附之后高差变了，重判四连通。上行放宽到「跳得上」而不是「走得上」：
    // 官方导航认为通的门口、坡道，体素实测常有 0.5~1m 的坎，卡着台阶高判会把整片包点剪成孤岛，
    // bot 反而进不了雷区；角色本身卡住时会跳跃，坎是过得去的。下落仍限 3m。
    const UP = 1.0, FALL = 3;
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
      const k = j * this.w + i;
      if (this.block[k] || !this.link) continue;
      for (let d = 0; d < 4; d++) {
        if (!(this.link[k] & (1 << d))) continue;
        const ni = i + NDIR[d][0], nj = j + NDIR[d][1];
        const nk = ni < 0 || nj < 0 || ni >= this.w || nj >= this.h ? -1 : nj * this.w + ni;
        const dh = nk < 0 ? Infinity : this.ground[nk] - this.ground[k];
        if (nk < 0 || this.block[nk] || dh > UP || dh < -FALL) this.link[k] &= ~(1 << d);
      }
      if (!this.link[k]) { this.block[k] = 1; this.cost[k] = 1; this.noFloor++; }
    }
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
      const k = j * this.w + i;
      if (this.block[k]) continue;
      const cx = this.x0 + (i + 0.5) * this.cell, cz = this.z0 + (j + 0.5) * this.cell;
      const gy = this.ground[k];
      const cands = world.query(cx - agentR - 0.5, cz - agentR - 0.5, cx + agentR + 0.5, cz + agentR + 0.5);
      for (const c of cands) {
        if (!c.solid) continue;
        // 只认真正的墙：从当地地面往上长出至少一个台阶高，且不高过头顶
        if (c.top - gy < 0.5 || c.bottom > gy + 1.8) continue;
        if (World.circleOBB(c, cx, cz, agentR + 0.45, o)) { this.cost[k] = 1.6; break; }
      }
    }
  }
  // 只保留双向连通的最大的那块地面。海拔吸附与头顶判定会把真实几何切碎，
  // 碎片既让 bot 走进出不来的死地，也是「起终点都合法却寻不到路」的来源。
  prune() {
    if (!this.link) return 0;
    const W = this.w, H = this.h, n = W * H;
    const id = new Int32Array(n).fill(-1);
    const stack = [];
    let cid = 0, best = -1, bestSize = 0;
    for (let k0 = 0; k0 < n; k0++) {
      if (this.block[k0] || id[k0] >= 0) continue;
      id[k0] = cid; stack.length = 0; stack.push(k0);
      let size = 0;
      while (stack.length) {
        const k = stack.pop(); size++;
        const i = k % W, j = (k / W) | 0;
        for (let d = 0; d < 4; d++) {
          if (!(this.link[k] & (1 << d))) continue;
          const ni = i + NDIR[d][0], nj = j + NDIR[d][1];
          if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
          const nk = nj * W + ni;
          // 只认能走回来的一条边：单向落差（跳下去上不来）不算连通
          if (!(this.link[nk] & (1 << ((d + 2) % 4)))) continue;
          if (this.block[nk] || id[nk] >= 0) continue;
          id[nk] = cid; stack.push(nk);
        }
      }
      if (size > bestSize) { bestSize = size; best = cid; }
      cid++;
    }
    if (best < 0) return 0;
    let cut = 0;
    for (let k = 0; k < n; k++) {
      if (this.block[k] || id[k] === best) continue;
      this.block[k] = 1; this.cost[k] = 1; this.link[k] = 0; cut++;
    }
    this.dropped = { comps: cid, kept: bestSize, cut };
    return cut;
  }
  // 碰撞体来源：单层地面，靠遮挡判断
  initColliders(world, agentR) {
    const o = {};
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
      const k = j * this.w + i;
      const cx = this.x0 + (i + 0.5) * this.cell, cz = this.z0 + (j + 0.5) * this.cell;
      const cands = world.query(cx - agentR - 0.3, cz - agentR - 0.3, cx + agentR + 0.3, cz + agentR + 0.3);
      let b = 0, near = 0;
      for (const c of cands) {
        if (!c.solid) continue;
        if (c.bottom > 1.7 || c.top < 0.36) continue;
        if (World.circleOBB(c, cx, cz, agentR, o)) { b = 1; break; }
        if (World.circleOBB(c, cx, cz, agentR + 0.45, o)) near = 1;
      }
      this.block[k] = b;
      this.cost[k] = near ? 1.6 : 1;
    }
  }
  idx(x, z) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }
  center(k) { return [this.x0 + ((k % this.w) + 0.5) * this.cell, this.z0 + (((k / this.w) | 0) + 0.5) * this.cell]; }
  groundAt(x, z) {
    const k = this.idx(x, z);
    return k < 0 || this.block[k] ? 0 : this.ground[k];
  }
  walkable(k) { return k >= 0 && !this.block[k]; }
  // 相邻格之间是否真能走：高度场里屋顶也是可走格，靠 link 掩码把断崖和台阶区分开
  linkOk(k, di, dj) {
    const l = this.link[k];
    if (!l) return false;
    if (di > 0 && !(l & 1)) return false;
    if (dj > 0 && !(l & 2)) return false;
    if (di < 0 && !(l & 4)) return false;
    if (dj < 0 && !(l & 8)) return false;
    return true;
  }
  // refY：吸附目标时优先同层，避免把地上的 bot 吸到屋顶
  nearestFree(k, refY) {
    if (this.walkable(k)) return k;
    if (k < 0) return -1;
    const useY = refY !== undefined && this.link !== null;
    const search = (byY) => {
      const i0 = k % this.w, j0 = (k / this.w) | 0;
      for (let r = 1; r < 12; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
        const kk = j * this.w + i;
        if (this.block[kk]) continue;
        if (byY && Math.abs(this.ground[kk] - refY) > 1.6) continue;
        return kk;
      }
      return -1;
    };
    let f = useY ? search(true) : search(false);
    if (f < 0 && useY) f = search(false);
    return f;
  }
  // 网格视线（Bresenham 采样）
  // 采的是格中心，但角色是有半径的胶囊：直线只要离障碍近于余量就算贴墙，
  // 否则「拉直」会拉出一条导航认得到、物理走不通的弦，bot 照着撞墙卡死。
  // 真实几何的薄墙还能整个落在一个可走格里，网格看不出来，所以高度场地图再加一道碰撞体复核。
  lineFree(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.ceil(d / (this.cell * 0.5));
    const clr = this.cell * 0.45, clr2 = clr * clr;
    const phys = this.link !== null && this.world ? this.cell * 0.3 : 0;
    let prev = this.idx(ax, az);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const k = this.idx(x, z);
      if (k < 0 || this.block[k]) return false;
      if (this.link && k !== prev && prev >= 0) {
        const di = (k % this.w) - (prev % this.w), dj = ((k / this.w) | 0) - ((prev / this.w) | 0);
        if (Math.max(Math.abs(di), Math.abs(dj)) > 1) return false;
        // 斜穿两个都堵着的格角 = 胶囊过不去的窄口
        if (di && dj && (this.block[(prev / this.w | 0) * this.w + (k % this.w)] || this.block[(k / this.w | 0) * this.w + (prev % this.w)])) return false;
        if (!this.linkOk(prev, Math.sign(di), Math.sign(dj))) return false;
      }
      if (this.nearBlock(x, z, clr2)) return false;
      if (phys && this.world.blocked(x, this.ground[k] + 0.5, z, phys, 1.2)) return false;
      prev = k;
    }
    return true;
  }
  // 采样点到最近障碍格的距离是否小于余量
  nearBlock(x, z, clr2) {
    const ci = Math.floor((x - this.x0) / this.cell), cj = Math.floor((z - this.z0) / this.cell);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
      if (!this.block[j * this.w + i]) continue;
      const gx0 = this.x0 + i * this.cell, gz0 = this.z0 + j * this.cell;
      const px = Math.max(gx0 - x, 0, x - (gx0 + this.cell)), pz = Math.max(gz0 - z, 0, z - (gz0 + this.cell));
      if (px * px + pz * pz < clr2) return true;
    }
    return false;
  }
  findPath(ax, az, bx, bz, ay) {
    let s = this.idx(ax, az), e = this.idx(bx, bz);
    if (s < 0 || e < 0) return null;
    s = this.nearestFree(s, ay); e = this.nearestFree(e, ay);
    if (s < 0 || e < 0) return null;
    const gen = ++this.gen;
    const W = this.w;
    // 二叉堆：入堆时记下 f 的快照，否则 decrease-key 会破坏堆序，绕远路
    const heap = [], heapF = [];
    const g = this.g, f = this.f;
    const swap = (i, j) => { [heap[i], heap[j]] = [heap[j], heap[i]]; [heapF[i], heapF[j]] = [heapF[j], heapF[i]]; };
    const push = (k) => {
      heap.push(k); heapF.push(f[k]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heapF[p] <= heapF[i]) break; swap(p, i); i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop(), lastF = heapF.pop();
      if (heap.length) {
        heap[0] = last; heapF[0] = lastF; let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1; let m = i;
          if (l < heap.length && heapF[l] < heapF[m]) m = l;
          if (r < heap.length && heapF[r] < heapF[m]) m = r;
          if (m === i) break; swap(m, i); i = m;
        }
      }
      return top;
    };
    const ex = e % W, ez = (e / W) | 0;
    const hfn = (k) => { const dx = Math.abs(k % W - ex), dz = Math.abs(((k / W) | 0) - ez); return (dx + dz + (1.4142 - 2) * Math.min(dx, dz)); };
    g[s] = 0; f[s] = hfn(s); this.seen[s] = gen; this.parent[s] = -1; push(s);
    let found = false, iter = 0;
    // 上限要够跨图：真实地图的路线绕行很长，2 万次展开会在起终点都合法时先耗尽，bot 就原地定住
    while (heap.length && iter++ < 120000) {
      const k = pop();
      if (this.closed[k] === gen) continue;
      this.closed[k] = gen;
      if (k === e) { found = true; break; }
      const ki = k % W, kj = (k / W) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ki + di, nj = kj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= this.h) continue;
        const nk = nj * W + ni;
        if (this.block[nk] || this.closed[nk] === gen) continue;
        if (di && dj && (this.block[kj * W + ni] || this.block[nj * W + ki])) continue;
        if (this.link && !this.linkOk(k, di, dj)) continue;
        const ng = g[k] + (di && dj ? 1.4142 : 1) * this.cost[nk];
        if (this.seen[nk] !== gen || ng < g[nk]) {
          this.seen[nk] = gen; g[nk] = ng; f[nk] = ng + hfn(nk); this.parent[nk] = k; push(nk);
        }
      }
    }
    if (!found) return null;
    const raw = [];
    for (let k = e; k !== -1; k = this.parent[k]) raw.push(this.center(k));
    raw.reverse();
    // 起终点换成角色的真实坐标：贴着墙站时格中心在墙另一侧，从格中心拉直的弦会直接穿墙
    raw[0] = [ax, az];
    raw[raw.length - 1] = [bx, bz];
    // 拉直
    const out = [raw[0]];
    let a = 0;
    while (a < raw.length - 1) {
      let b = raw.length - 1;
      while (b > a + 1 && !this.lineFree(raw[a][0], raw[a][1], raw[b][0], raw[b][1])) b--;
      out.push(raw[b]); a = b;
    }
    return out;
  }
  randomFree(rnd, x0, z0, x1, z1, refY) {
    let alt = null;
    for (let t = 0; t < 60; t++) {
      const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
      const k = this.idx(x, z);
      if (!this.walkable(k)) continue;
      if (refY !== undefined && this.link && Math.abs(this.ground[k] - refY) > 1.6) { if (!alt) alt = [x, z]; continue; }
      return [x, z];
    }
    return alt;
  }
}
