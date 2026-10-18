// 玩家：输入、镜头
import * as THREE from 'three';
import { Actor } from './actor.js';

// ---------- 鼠标灵敏度 ----------
// 刻度和 CS 1.6 / Source 的 sensitivity 对齐：1 个鼠标计数 = sens × m_yaw 度，
// m_yaw 默认 0.022（GoldSrc、Source 都是这个数）。所以面板里填几，手感和 CS 1.6
// 里填几一样：同样的 DPI 下，转 360° 需要的鼠标距离相同。
// 以前这里是 0.0022 弧度/计数 = 0.126°/计数 ≈ CS 的 5.7，默认值就快了将近 6 倍，
// 「稍微动一下就太多、往回拉又过了」就是这儿来的。
export const SENS_DEFAULT = 2;                        // 默认手感（CS 1.6 里常见 1~3）
export const SENS_MIN = 0.1, SENS_MAX = 6, SENS_STEP = 0.01;
export const SENS_RAD = 0.022 * Math.PI / 180;        // 每点灵敏度、每计数转多少弧度

// 单条 mousemove 的封顶值（计数）。真甩枪一帧最多也就几百到一两千，
// 超过这个数基本是浏览器异常（切窗口、系统弹窗之后补的位移），削掉免得视角乱跳。
const STEP_MAX = 3000;
const clampStep = (v) => (v > STEP_MAX ? STEP_MAX : v < -STEP_MAX ? -STEP_MAX : v);

export class Player extends Actor {
  constructor(game, o) {
    super(game, { ...o, isPlayer: true });
    this.keys = new Set();
    this.mouse = { l: false, r: false, lp: false, rp: false, dx: 0, dy: 0, wheel: 0 };
    this.pressed = new Set();
    this.lookDX = 0; this.lookDY = 0;
    this.bobT = 0; this.land = 0; this.shakeT = 0;
    this.camRoll = 0;
    this.deathCam = null;
    this.touch = { mx: 0, mz: 0, fire: false, jump: false, crouch: false };
  }
  // 输入监听只绑定一次，始终路由到当前玩家
  bind(canvas) {
    const g = this.game;
    if (g._inputBound) return;
    g._inputBound = true;
    const P = () => (g.playing ? g.player : null);
    window.addEventListener('keydown', (e) => {
      const p = P(); if (!p) return;
      if (['Tab', 'Space', 'KeyB', 'KeyF', 'KeyQ', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      p.keys.add(e.code); p.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => { const p = g.player; if (p) p.keys.delete(e.code); });
    window.addEventListener('blur', () => { const p = g.player; if (p) { p.keys.clear(); p.mouse.l = p.mouse.r = false; } });
    canvas.addEventListener('mousedown', (e) => {
      const p = P(); if (!p) return;
      if (!g.locked && !g.touchMode) { g.lock(); return; }
      if (e.button === 0) { p.mouse.l = true; p.mouse.lp = true; }
      if (e.button === 2) { p.mouse.r = true; p.mouse.rp = true; }
    });
    window.addEventListener('mouseup', (e) => { const p = g.player; if (!p) return; if (e.button === 0) p.mouse.l = false; if (e.button === 2) p.mouse.r = false; });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      const p = P(); if (!p || !g.locked) return;
      // 刚锁定那一瞬间浏览器会补一记「光标从原位置跳回屏幕中心」的大位移，直接吞掉。
      if (performance.now() - g.lockAt < 120) return;
      // 单条位移只封顶（钳制），不再整条丢掉：快速甩枪时浏览器会把一帧里攒下的位移
      // 合成一条送过来（高 DPI 下轻松过千），整条丢掉就变成「甩了没反应、再往回拉又过头」。
      p.mouse.dx += clampStep(e.movementX); p.mouse.dy += clampStep(e.movementY);
    });
    window.addEventListener('wheel', (e) => { const p = P(); if (p && g.locked) p.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
  }
  consumePressed(code) { const p = this.pressed.has(code); this.pressed.delete(code); return p; }
  update(dt) {
    const g = this.game, K = this.keys;
    const sens = g.opts.sens * SENS_RAD;
    let dx = this.mouse.dx, dy = this.mouse.dy;
    this.mouse.dx = this.mouse.dy = 0;
    if (this.touchLook) { dx += this.touchLook.x; dy += this.touchLook.y; this.touchLook.x = this.touchLook.y = 0; }
    this.lookDX = dx; this.lookDY = dy;
    const fovK = this.scoped ? g.renderer.camera.fov / g.opts.fov : 1;
    if (this.alive) {
      this.yaw -= dx * sens * fovK;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sens * fovK, -1.5, 1.5);
      // 移动
      let f = 0, s = 0;
      if (K.has('KeyW') || K.has('ArrowUp')) f += 1;
      if (K.has('KeyS') || K.has('ArrowDown')) f -= 1;
      if (K.has('KeyD') || K.has('ArrowRight')) s += 1;
      if (K.has('KeyA') || K.has('ArrowLeft')) s -= 1;
      f += this.touch.mz; s += this.touch.mx;
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      const wx = -sy * f + cy * s, wz = -cy * f - sy * s;
      const jump = K.has('Space') || this.touch.jump;
      const crouch = K.has('KeyC') || this.touch.crouch;
      this.walk = K.has('ShiftLeft') || K.has('ShiftRight');
      this.move(dt, wx, wz, jump, crouch, this.walk);
      if (this.touch.jump) this.touch.jump = false;
      // 武器
      let sw = null;
      for (let i = 1; i <= 4; i++) if (this.consumePressed('Digit' + i)) sw = i - 1;
      if (this.consumePressed('KeyQ')) sw = this.lastSlot;
      if (this.mouse.wheel) {
        const dir = this.mouse.wheel > 0 ? 1 : -1; this.mouse.wheel = 0;
        let n = this.slot;
        for (let k = 0; k < 4; k++) { n = (n + dir + 4) % 4; if (this.inv[n] && !(this.inv[n].def.type === 'grenade' && this.inv[n].mag <= 0)) break; }
        sw = n;
      }
      if (sw !== null && this.inv[sw] && this.inv[sw].def.type === 'grenade' && this.inv[sw].mag <= 0) { g.hud.toast('没有手雷了', 1.2); sw = null; }
      const lp = this.mouse.lp || this.touch.firePressed, rp = this.mouse.rp;
      this.mouse.lp = this.mouse.rp = false; this.touch.firePressed = false;
      this.weaponUpdate(dt, { fire: this.mouse.l || this.touch.fire, firePressed: lp, alt: this.mouse.r, altPressed: rp, reload: this.consumePressed('KeyR'), sw });
      if (this.consumePressed('KeyF')) g.vm.inspect();
    } else {
      this.pressed.delete('KeyR'); this.mouse.lp = this.mouse.rp = false;
    }
    if (this.consumePressed('KeyB')) g.toggleLoadout();
    this.pressed.clear();
    this.updateCamera(dt);
  }
  updateCamera(dt) {
    const g = this.game, cam = g.renderer.camera;
    if (!this.alive) {
      // 死亡镜头：抬高并看向击杀者
      const dc = this.deathCam;
      if (dc) {
        dc.t += dt;
        const k = Math.min(1, dc.t * 1.2);
        const e = 1 - (1 - k) * (1 - k);
        cam.position.lerpVectors(dc.from, dc.to, e);
        if (dc.killer && dc.killer.alive) dc.look.lerp(dc.killer.soldier.headWorld(new THREE.Vector3()), Math.min(1, dt * 3));
        cam.lookAt(dc.look);
      }
      cam.fov += (g.opts.fov - cam.fov) * Math.min(1, dt * 8); cam.updateProjectionMatrix();
      return;
    }
    // 晃动
    const sp = this.onGround ? this.speed : 0;
    this.bobT += dt * (sp > 0.5 ? 6 + sp * 0.9 : 0);
    const bobK = Math.min(1, sp / 6) * (this.scoped ? 0.2 : 1);
    const by = Math.abs(Math.sin(this.bobT)) * 0.028 * bobK, bx = Math.cos(this.bobT) * 0.012 * bobK;
    if (this.landed && this.landSpeed > 3) this.land = Math.min(0.14, this.landSpeed * 0.012);
    this.land *= Math.exp(-dt * 7);
    const shake = g.fx.shake * 0.06;
    this.eye(cam.position);
    cam.position.y += by - this.land + (Math.random() - 0.5) * shake;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    cam.position.x += cy * bx + (Math.random() - 0.5) * shake;
    cam.position.z += -sy * bx;
    this.camRoll += ((this.keys.has('KeyA') ? 0.008 : 0) - (this.keys.has('KeyD') ? 0.008 : 0) - this.camRoll) * Math.min(1, dt * 6);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(this.pitch + this.punchP * 0.75 + this.aimPunch, this.yaw + this.punchY * 0.75, this.camRoll);
    // FOV：狙击镜
    const w = this.weapon;
    let fov = g.opts.fov;
    if (w && w.def.type === 'sniper' && this.scoped) fov = w.def.zoom[this.scoped - 1];
    const fk = this.scoped ? 1 : Math.min(1, dt * 10);
    cam.fov += (fov - cam.fov) * fk;
    cam.updateProjectionMatrix();
  }
  startDeathCam(killer) {
    const cam = this.game.renderer.camera;
    const from = cam.position.clone();
    const head = this.pos.clone().add(new THREE.Vector3(0, 1.2, 0));
    const want = new THREE.Vector3(Math.sin(this.yaw) * 2.2, 1.4, Math.cos(this.yaw) * 2.2);
    const L = want.length(); want.divideScalar(L);
    const hit = this.game.world.raycast(head.x, head.y, head.z, want.x, want.y, want.z, L, 'move');
    const to = head.clone().addScaledVector(want, hit ? Math.max(0.2, hit.t - 0.35) : L);
    const look = this.pos.clone().add(new THREE.Vector3(0, 0.4, 0));
    this.deathCam = { t: 0, from, to, look, killer: killer && killer !== this ? killer : null };
    this.soldier.root.visible = true;
  }
}
