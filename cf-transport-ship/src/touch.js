// 触屏控制：左侧虚拟摇杆移动，右侧滑动视角，按钮开火/跳/蹲/换弹/切枪/开镜
// 默认布局参考和平精英：左手摇杆 + 左上副开火（双手食指流）；右侧沿拇指弧线排布主开火/镜/蹲/跳
// 支持自定义布局：暂停菜单 → 自定义按键布局，拖动调整位置、滑杆调整大小，保存到 localStorage
const STORE = 'cf_ship_touch_layout';
const PAD_SIZE = 140, KNOB = 56;
const PAD_TRAVEL = 60, LOOK_SCALE = 1.6;
const MIN_SCALE = 60, MAX_SCALE = 160, SCALE_STEP = 5;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export class TouchControls {
  constructor(game) {
    this.g = game;
    this.enabled = matchMedia('(pointer:coarse)').matches || new URLSearchParams(location.search).has('touch');
    this.editing = false; this.drag = null; this.draft = null; this.defs = {}; this.btns = {};
    if (!this.enabled) return;
    this.touches = new Map();
    this.inputPlayer = null;
    // 阻止浏览器手势（双指/双击缩放、下拉回弹）干扰视角拖动；菜单界面(.screen)保留滚动
    document.addEventListener('touchmove', (e) => {
      if (!(e.target instanceof Element && e.target.closest('.screen, .editbar'))) e.preventDefault();
    }, { passive: false });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    const root = document.getElementById('touch');
    root.classList.remove('hidden');
    this.root = root;
    this.W = () => window.innerWidth; this.H = () => window.innerHeight;
    const P = () => this.g.player;

    // 摇杆
    const pad = document.createElement('div'); pad.className = 'pad';
    const knob = document.createElement('div'); knob.className = 'pad';
    Object.assign(knob.style, { background: 'rgba(255,255,255,.25)', pointerEvents: 'none' });
    root.append(pad, knob);
    this.pad = pad; this.knob = knob;
    this.defs.pad = { left: 28, bottom: 40, size: PAD_SIZE };
    this.bindCtl(pad, 'pad', null);

    // 按键表：位置 right 为正=锚右边缘，left=锚左边缘；bottom 自底向上
    const CTRL = [
      ['fire', '开火', { right: 45, bottom: 158 }, 92],
      ['fire2', '开火', { left: 212, bottom: 232 }, 62],
      ['scope', '镜', { right: 150, bottom: 104 }, 62, () => { const p = P(); if (p) p.mouse.rp = true; }],
      ['jump', '跳', { right: 28, bottom: 64 }, 62, () => { const p = P(); if (p) p.touch.jump = true; }],
      ['crouch', '蹲', { right: 118, bottom: 42 }, 58, () => { const p = P(); if (p) p.touch.crouch = !p.touch.crouch; }],
      ['reload', 'R', { right: 56, bottom: 272 }, 52, () => { const p = P(); if (p) p.pressed.add('KeyR'); }],
      ['swap', '切', { right: 120, bottom: 272 }, 52, () => { const p = P(); if (p) p.pressed.add('KeyQ'); }],
      ['bag', '包', { right: 184, bottom: 272 }, 52, () => { const p = P(); if (p) p.pressed.add('KeyB'); }],
      ['pause', 'Ⅱ', { right: 8, bottom: 272 }, 42, () => this.g.pause()],
    ];
    this.btns.pad = pad;
    for (const [key, label, pos, size, fn] of CTRL) {
      const b = document.createElement('div'); b.className = 'btn'; b.textContent = label;
      this.defs[key] = { ...pos, size };
      this.bindCtl(b, key, fn);
      root.appendChild(b);
      this.btns[key] = b;
    }
    this.layout = this.readLayout();
    this.buildEditBar(root);

    // 按键只登记触点；位移与释放统一处理，主开火不会再叠加一份 look。
    const canvas = document.getElementById('c');
    window.addEventListener('touchstart', (e) => {
      this.startTouches([...e.changedTouches].filter((t) => t.target === canvas), 'surface');
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (this.editing) {
        for (const t of e.changedTouches) this.moveDrag(t);
        return;
      }
      this.moveTouches(e.changedTouches);
    }, { passive: true });
    const end = (e) => {
      for (const t of e.changedTouches) if (this.drag && t.identifier === this.drag.id) this.endDrag();
      this.endTouches(e.changedTouches, e.type === 'touchcancel');
    };
    window.addEventListener('touchend', end, { capture: true });
    window.addEventListener('touchcancel', end, { capture: true });
    const reset = () => { this.resetInput(); this.endDrag(); };
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
    window.addEventListener('resize', () => {
      this.endDrag();
      this.resetInput();
      this.placeAll();
      if (this.editing) this.syncEditor();
    });
    this.placeAll();
  }

  // ---------- 触点归属 ----------
  canPlay() {
    const g = this.g;
    return g.playing && !g.paused && !g.ended && !g.inLoadout && g.player &&
      !this.editing && !document.hidden;
  }
  playerForInput() {
    if (!this.canPlay()) { this.resetInput(); return null; }
    if (this.inputPlayer !== this.g.player) this.resetInput();
    this.inputPlayer = this.g.player;
    return this.inputPlayer;
  }
  resetInput() {
    this.touches.clear();
    const p = this.inputPlayer;
    if (p) {
      p.touch.mx = p.touch.mz = 0;
      p.touch.fire = p.touch.firePressed = p.touch.jump = false;
      if (p.touchLook) p.touchLook.x = p.touchLook.y = 0;
    }
    this.inputPlayer = null;
    this.resetKnob();
  }
  touchFor(key) { return [...this.touches.values()].find((t) => t.key === key); }
  syncFire(p, cancelled = false) {
    const fire = !!(this.touchFor('fire') || this.touchFor('fire2'));
    if (fire && !p.touch.fire) p.touch.firePressed = true;
    if (cancelled && !fire) p.touch.firePressed = false;
    p.touch.fire = fire;
  }
  startTouches(touches, key) {
    const p = this.playerForInput(); if (!p) return;
    for (const t of touches) {
      if (this.touches.has(t.identifier)) continue;
      let role = key;
      if (key === 'surface') role = t.clientX < this.W() * 0.4 && !this.touchFor('pad') ? 'pad' : 'look';
      if ((role === 'pad' || role === 'look') && this.touchFor(role)) continue;
      const state = { key: role, x: t.clientX, y: t.clientY };
      if (role === 'pad') {
        const r = this.boundsFor('pad');
        state.cx = r.left + r.size / 2; state.cy = this.H() - r.bottom - r.size / 2;
      }
      this.touches.set(t.identifier, state);
    }
    this.syncFire(p);
  }
  moveTouches(touches) {
    const p = this.playerForInput(); if (!p) return;
    // 主开火优先持有视角；其他候选只更新坐标，接力时不会跳变。
    const look = this.touchFor('fire') || this.touchFor('look');
    for (const t of touches) {
      const state = this.touches.get(t.identifier); if (!state) continue;
      if (state.key === 'pad') {
        let dx = t.clientX - state.cx, dy = t.clientY - state.cy;
        const length = Math.hypot(dx, dy);
        const travel = PAD_TRAVEL * this.sizeFor('pad') / PAD_SIZE;
        if (length > travel) { dx *= travel / length; dy *= travel / length; }
        this.positionKnob(dx, dy);
        p.touch.mx = dx / travel; p.touch.mz = -dy / travel;
      } else if (state === look) {
        p.touchLook = p.touchLook || { x: 0, y: 0 };
        p.touchLook.x += (t.clientX - state.x) * LOOK_SCALE;
        p.touchLook.y += (t.clientY - state.y) * LOOK_SCALE;
      }
      state.x = t.clientX; state.y = t.clientY;
    }
  }
  endTouches(touches, cancelled) {
    const p = this.playerForInput(); if (!p) return;
    let endedFire = false;
    for (const t of touches) {
      const state = this.touches.get(t.identifier); if (!state) continue;
      this.touches.delete(t.identifier);
      if (state.key === 'pad') { this.resetKnob(); p.touch.mx = p.touch.mz = 0; }
      if (state.key === 'fire' || state.key === 'fire2') endedFire = true;
    }
    if (endedFire) this.syncFire(p, cancelled);
  }

  // ---------- 布局 ----------
  readLayout() {
    const raw = localStorage.getItem(STORE);
    if (raw === null) return {};
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('保存的按键布局必须是对象');
    const layout = {};
    for (const [key, pos] of Object.entries(saved)) {
      const def = this.defs[key];
      if (!Object.hasOwn(this.defs, key) || !pos || typeof pos !== 'object' || Array.isArray(pos)) {
        throw new Error(`保存的按键布局无效：${key}`);
      }
      const anchors = ['left', 'right'].filter((field) => Object.hasOwn(pos, field));
      const validPosition = anchors.length === 1 && [pos[anchors[0]], pos.bottom].every((n) => Number.isFinite(n) && n >= 0);
      // 旧布局仅保存坐标；缺少 size 时沿用该按键的默认尺寸。
      const size = pos.size === undefined ? def.size : pos.size;
      if (!validPosition || !Number.isFinite(size) || size < def.size * MIN_SCALE / 100 || size > def.size * MAX_SCALE / 100) {
        throw new Error(`保存的按键位置或大小无效：${key}`);
      }
      layout[key] = { [anchors[0]]: pos[anchors[0]], bottom: pos.bottom, size };
    }
    return layout;
  }
  configFor(key) { return (this.editing ? this.draft[key] : this.layout[key]) ?? this.defs[key]; }
  sizeFor(key) { return Math.min(this.configFor(key).size, this.W(), this.H()); }
  boundsFor(key) {
    const p = this.configFor(key), size = this.sizeFor(key);
    const left = p.right === undefined ? p.left : this.W() - p.right - size;
    return { left: clamp(left, 0, this.W() - size), bottom: clamp(p.bottom, 0, this.H() - size), size };
  }
  placeControl(key) {
    const el = this.btns[key], p = this.boundsFor(key);
    Object.assign(el.style, { top: 'auto', right: 'auto', left: p.left + 'px', bottom: p.bottom + 'px', width: p.size + 'px', height: p.size + 'px' });
    if (key === 'pad') {
      const knobSize = KNOB * p.size / PAD_SIZE;
      this.knob.style.width = this.knob.style.height = knobSize + 'px';
      this.resetKnob();
      return;
    }
    const base = this.defs[key].size;
    const font = key === 'pause' ? 15 : base >= 80 ? 17 : base >= 60 ? 15 : 13;
    el.style.fontSize = font * p.size / base + 'px';
  }
  placeAll() { for (const key of Object.keys(this.btns)) this.placeControl(key); }
  positionKnob(dx, dy) {
    const p = this.boundsFor('pad'), knobSize = KNOB * p.size / PAD_SIZE;
    this.knob.style.left = p.left + (p.size - knobSize) / 2 + dx + 'px';
    this.knob.style.bottom = p.bottom + (p.size - knobSize) / 2 - dy + 'px';
  }
  resetKnob() { this.positionKnob(0, 0); }

  // ---------- 按键事件 ----------
  bindCtl(el, key, fn) {
    const names = { pad: '摇杆', fire: '主开火', fire2: '副开火', pause: '暂停' };
    el.dataset.control = key;
    el.setAttribute('aria-label', names[key] ?? el.textContent);
    el.addEventListener('click', () => { if (this.editing) this.selectControl(key); });
    el.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      const touches = [...e.changedTouches].filter((t) => el.contains(t.target));
      if (!touches.length) return;
      if (this.editing) {
        if (this.drag) return;
        this.selectControl(key);
        const t = touches[0], r = el.getBoundingClientRect();
        this.drag = { key, id: t.identifier, ox: t.clientX - r.left, oy: t.clientY - r.top };
        return;
      }
      if (key === 'pad' || key === 'fire' || key === 'fire2') { this.startTouches(touches, key); return; }
      if (this.playerForInput() && fn) fn();
    }, { passive: false });
  }
  moveDrag(t) {
    const d = this.drag; if (!d || t.identifier !== d.id) return;
    const size = this.sizeFor(d.key);
    const left = clamp(Math.round(t.clientX - d.ox), 0, this.W() - size);
    const bottom = clamp(Math.round(this.H() - (t.clientY - d.oy) - size), 0, this.H() - size);
    this.draft = { ...this.draft, [d.key]: { left, bottom, size: this.configFor(d.key).size } };
    this.placeControl(d.key);
  }
  endDrag() { this.drag = null; }

  // ---------- 编辑模式 ----------
  buildEditBar(root) {
    const bar = document.createElement('div'); bar.className = 'editbar hidden';
    bar.innerHTML = `<div class="editbar-main"><span class="editbar-hint">拖动调整位置，选中后调整大小</span><div class="editbar-actions"><button data-a="save">保存</button><button data-a="reset">恢复默认</button><button data-a="cancel">取消</button></div></div>
      <div class="editbar-controls"><label>按键 <select class="edit-control" aria-label="选择按键"></select></label><label class="edit-size">大小 <input type="range" min="${MIN_SCALE}" max="${MAX_SCALE}" step="${SCALE_STEP}" aria-label="按键大小"><output></output></label></div>
      <p class="edit-error hidden" role="alert"></p>`;
    this.controlSelect = bar.querySelector('select');
    this.sizeSlider = bar.querySelector('input');
    this.sizeOutput = bar.querySelector('output');
    this.editError = bar.querySelector('.edit-error');
    for (const [key, el] of Object.entries(this.btns)) {
      const option = document.createElement('option');
      option.value = key; option.textContent = el.getAttribute('aria-label');
      this.controlSelect.appendChild(option);
    }
    this.controlSelect.addEventListener('change', () => this.selectControl(this.controlSelect.value));
    this.sizeSlider.addEventListener('input', () => this.resizeSelected(Number(this.sizeSlider.value)));
    bar.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    bar.addEventListener('click', (e) => {
      const action = e.target.dataset.a;
      if (action === 'save') this.saveLayout();
      else if (action === 'reset') {
        this.endDrag(); this.draft = {};
        this.placeAll(); this.syncEditor();
      } else if (action === 'cancel') this.endEdit();
    });
    root.appendChild(bar);
    this.editBar = bar;
  }
  selectControl(key) {
    if (!Object.hasOwn(this.btns, key)) throw new Error(`未知按键：${key}`);
    this.endDrag();
    this.selected = key;
    for (const [name, el] of Object.entries(this.btns)) el.classList.toggle('selected', name === key);
    this.syncEditor();
  }
  syncEditor() {
    this.controlSelect.value = this.selected;
    const scale = Math.round(this.configFor(this.selected).size / this.defs[this.selected].size * 100);
    this.sizeSlider.value = scale;
    this.sizeOutput.textContent = `${scale}% · ${Math.round(this.sizeFor(this.selected))}px`;
  }
  resizeSelected(scale) {
    if (!Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) throw new RangeError('按键缩放比例超出范围');
    this.endDrag();
    const key = this.selected, size = this.defs[key].size * scale / 100;
    this.draft = { ...this.draft, [key]: { ...this.configFor(key), size } };
    this.placeControl(key); this.syncEditor();
  }
  saveLayout() {
    this.endDrag();
    try {
      if (Object.keys(this.draft).length) localStorage.setItem(STORE, JSON.stringify(this.draft));
      else localStorage.removeItem(STORE);
    } catch (error) {
      this.editError.textContent = '保存失败，请检查浏览器存储权限后重试；当前修改尚未保存。';
      this.editError.classList.remove('hidden');
      console.error('按键布局保存失败', error);
      return;
    }
    this.layout = this.draft;
    this.endEdit();
  }
  enterEdit() {
    this.resetInput();
    this.editing = true; this.draft = { ...this.layout };
    this.editError.classList.add('hidden');
    this.editBar.classList.remove('hidden');
    this.root.classList.add('editing');
    this.selectControl('fire');
    this.g.hud.show(null);
  }
  endEdit() {
    this.editing = false; this.drag = null; this.draft = null;
    this.editBar.classList.add('hidden');
    this.root.classList.remove('editing');
    for (const el of Object.values(this.btns)) el.classList.remove('selected');
    this.placeAll();
    this.g.hud.show('pause');
  }
}
