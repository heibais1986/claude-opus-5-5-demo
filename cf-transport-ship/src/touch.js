// 触屏控制：左侧虚拟摇杆移动，右侧滑动视角，按钮开火/跳/蹲/换弹/切枪/开镜
// 默认布局参考和平精英：左手摇杆 + 左上副开火（双手食指流）；右侧沿拇指弧线排布主开火/镜/蹲/跳
// 支持自定义布局：暂停菜单 → 自定义按键布局，拖动按钮调整位置，保存到 localStorage
const STORE = 'cf_ship_touch_layout';
const PAD_SIZE = 140, KNOB = 56;

export class TouchControls {
  constructor(game) {
    this.g = game;
    this.enabled = matchMedia('(pointer:coarse)').matches || new URLSearchParams(location.search).has('touch');
    this.editing = false; this.drag = null; this.draft = {}; this.defs = {}; this.btns = {}; this.sizes = {};
    if (!this.enabled) return;
    try { this.layout = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { this.layout = {}; }
    // 阻止浏览器手势（双指/双击缩放、下拉回弹）干扰视角拖动；菜单界面(.screen)保留滚动
    document.addEventListener('touchmove', (e) => {
      if (!(e.target instanceof Element && e.target.closest('.screen'))) e.preventDefault();
    }, { passive: false });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    const root = document.getElementById('touch');
    root.classList.remove('hidden');
    this.root = root;
    this.W = () => window.innerWidth; this.H = () => window.innerHeight;
    const P = () => this.g.player;
    const fireDown = () => { const p = P(); if (p) { p.touch.fire = true; p.touch.firePressed = true; } };
    const fireUp = () => { const p = P(); if (p) p.touch.fire = false; };

    // 摇杆
    const pad = document.createElement('div'); pad.className = 'pad';
    Object.assign(pad.style, { width: PAD_SIZE + 'px', height: PAD_SIZE + 'px' });
    const knob = document.createElement('div'); knob.className = 'pad';
    Object.assign(knob.style, { width: KNOB + 'px', height: KNOB + 'px', background: 'rgba(255,255,255,.25)', pointerEvents: 'none' });
    root.append(pad, knob);
    this.pad = pad; this.knob = knob;
    this.defs.pad = { left: 28, bottom: 40 };
    this.bindCtl(pad, 'pad', PAD_SIZE, null);

    // 按键表：位置 right 为正=锚右边缘，left=锚左边缘；bottom 自底向上
    const CTRL = [
      ['fire', '开火', { right: 45, bottom: 158 }, 92, fireDown, fireUp],
      ['fire2', '开火', { left: 212, bottom: 232 }, 62, fireDown, fireUp],
      ['scope', '镜', { right: 150, bottom: 104 }, 62, () => { const p = P(); if (p) p.mouse.rp = true; }],
      ['jump', '跳', { right: 28, bottom: 64 }, 62, () => { const p = P(); if (p) p.touch.jump = true; }],
      ['crouch', '蹲', { right: 118, bottom: 42 }, 58, () => { const p = P(); if (p) p.touch.crouch = !p.touch.crouch; }],
      ['reload', 'R', { right: 56, bottom: 272 }, 52, () => { const p = P(); if (p) p.pressed.add('KeyR'); }],
      ['swap', '切', { right: 120, bottom: 272 }, 52, () => { const p = P(); if (p) p.pressed.add('KeyQ'); }],
      ['bag', '包', { right: 184, bottom: 272 }, 52, () => { const p = P(); if (p) p.pressed.add('KeyB'); }],
    ];
    this.btns.pad = pad;
    for (const [key, label, pos, size, fn, up] of CTRL) {
      const b = document.createElement('div'); b.className = 'btn'; b.textContent = label;
      b.style.width = b.style.height = size + 'px';
      b.style.fontSize = (size >= 80 ? 17 : size >= 60 ? 15 : 13) + 'px';
      this.defs[key] = pos;
      this.bindCtl(b, key, size, fn, up);
      root.appendChild(b);
      this.btns[key] = b;
    }
    // 暂停键（触屏没有 Esc），与顶行 R/切/包 同一水平线
    const pb = document.createElement('div'); pb.className = 'btn'; pb.textContent = 'Ⅱ';
    Object.assign(pb.style, { right: '8px', bottom: '272px', width: '42px', height: '42px', fontSize: '15px', top: 'auto' });
    pb.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); if (this.g.playing && !this.g.paused && !this.editing) this.g.pause(); }, { passive: false });
    root.appendChild(pb);
    this.buildEditBar(root);

    // 自定义布局拖动
    document.addEventListener('touchmove', (e) => { if (this.drag) for (const t of e.changedTouches) this.moveDrag(t); }, { passive: false });
    document.addEventListener('touchend', () => this.endDrag());
    document.addEventListener('touchcancel', () => this.endDrag());

    // 视角 / 摇杆触摸
    let padId = null, cx = 0, cy = 0, lookId = null, lx = 0, ly = 0;
    window.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        if (t.clientX < this.W() * 0.4 && padId === null) { padId = t.identifier; const r = pad.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
        else if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
      }
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      const p = P();
      for (const t of e.changedTouches) {
        if (t.identifier === padId && p) {
          let dx = t.clientX - cx, dy = t.clientY - cy; const L = Math.hypot(dx, dy), m = 60;
          if (L > m) { dx *= m / L; dy *= m / L; }
          knob.style.left = (this.knobBase.left + dx) + 'px'; knob.style.bottom = (this.knobBase.bottom - dy) + 'px';
          p.touch.mx = dx / m; p.touch.mz = -dy / m;
        } else if (t.identifier === lookId && p) {
          p.touchLook = p.touchLook || { x: 0, y: 0 };
          p.touchLook.x += (t.clientX - lx) * 1.6; p.touchLook.y += (t.clientY - ly) * 1.6;
          lx = t.clientX; ly = t.clientY;
        }
      }
    }, { passive: true });
    const end = (e) => {
      const p = P();
      for (const t of e.changedTouches) {
        if (t.identifier === padId) { padId = null; this.resetKnob(); if (p) { p.touch.mx = 0; p.touch.mz = 0; } }
        if (t.identifier === lookId) lookId = null;
      }
    };
    window.addEventListener('touchend', end); window.addEventListener('touchcancel', end);
    this.placeAll();
  }

  // ---------- 布局 ----------
  posOf(key) { return this.layout[key] || this.defs[key]; }
  applyPos(el, key, size) {
    const p = this.posOf(key);
    el.style.top = 'auto';
    if (p.right !== undefined) { el.style.right = Math.min(Math.max(p.right, 0), this.W() - size) + 'px'; el.style.left = 'auto'; }
    else { el.style.left = Math.min(Math.max(p.left, 0), this.W() - size) + 'px'; el.style.right = 'auto'; }
    el.style.bottom = Math.min(Math.max(p.bottom, 0), this.H() - size) + 'px';
  }
  placeAll() {
    for (const [key, el] of Object.entries(this.btns)) this.applyPos(el, key, this.sizes[key] || PAD_SIZE);
    // 隐藏状态下 offsetWidth/getBoundingClientRect 均为 0，摇杆中心按布局数据解析
    const p = this.posOf('pad');
    this.padPos = { left: p.right !== undefined ? this.W() - p.right - (this.sizes.pad || PAD_SIZE) : p.left, bottom: p.bottom };
    this.knobBase = { left: this.padPos.left + (PAD_SIZE - KNOB) / 2, bottom: this.padPos.bottom + (PAD_SIZE - KNOB) / 2 };
    this.resetKnob();
  }
  resetKnob() { this.knob.style.left = this.knobBase.left + 'px'; this.knob.style.bottom = this.knobBase.bottom + 'px'; }

  // ---------- 按键事件 ----------
  bindCtl(el, key, size, fn, up) {
    this.sizes[key] = size;
    el.addEventListener('touchstart', (e) => {
      if (this.editing) {
        e.preventDefault(); e.stopPropagation();
        const t = e.changedTouches[0];
        const r = el.getBoundingClientRect();
        this.drag = { key, el, size, id: t.identifier, ox: t.clientX - r.left, oy: t.clientY - r.top, pos: null };
        return;
      }
      if (key === 'pad') return; // 摇杆触摸交给 window 层处理
      e.preventDefault(); e.stopPropagation();
      if (fn) fn();
    }, { passive: false });
    if (up) el.addEventListener('touchend', (e) => { e.preventDefault(); up(); }, { passive: false });
  }
  moveDrag(t) {
    const d = this.drag; if (!d || t.identifier !== d.id) return;
    const left = Math.min(Math.max(t.clientX - d.ox, 0), this.W() - d.size);
    const bottom = Math.min(Math.max(this.H() - (t.clientY - d.oy) - d.size, 0), this.H() - d.size);
    d.el.style.left = left + 'px'; d.el.style.right = 'auto'; d.el.style.bottom = bottom + 'px';
    d.pos = { left: Math.round(left), bottom: Math.round(bottom) };
    if (d.key === 'pad') {
      this.knobBase = { left: left + (PAD_SIZE - KNOB) / 2, bottom: bottom + (PAD_SIZE - KNOB) / 2 };
      this.resetKnob();
    }
  }
  endDrag() {
    const d = this.drag; if (!d) return;
    if (d.pos) this.draft[d.key] = d.pos;
    this.drag = null;
  }

  // ---------- 编辑模式 ----------
  buildEditBar(root) {
    const bar = document.createElement('div'); bar.className = 'editbar hidden';
    bar.innerHTML = `<span>拖动按钮和摇杆调整位置</span><button data-a="save">保存</button><button data-a="reset">恢复默认</button><button data-a="cancel">取消</button>`;
    bar.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    bar.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      if (a === 'save') {
        Object.assign(this.layout, this.draft);
        try { localStorage.setItem(STORE, JSON.stringify(this.layout)); } catch (err) { /* 忽略 */ }
      } else if (a === 'reset') {
        this.layout = {}; this.draft = {};
        try { localStorage.removeItem(STORE); } catch (err) { /* 忽略 */ }
      }
      this.endEdit();
    });
    root.appendChild(bar);
    this.editBar = bar;
  }
  enterEdit() {
    this.editing = true; this.draft = {};
    this.editBar.classList.remove('hidden');
    this.root.classList.add('editing');
    this.g.hud.show(null);
  }
  endEdit() {
    this.editing = false; this.drag = null; this.draft = {};
    this.editBar.classList.add('hidden');
    this.root.classList.remove('editing');
    this.placeAll();
    this.g.hud.show('pause');
  }
}
