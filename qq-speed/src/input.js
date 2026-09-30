// 键位：尽量还原 QQ飞车端游默认键位
// ↑↓←→ 驾驶 · Shift 漂移 · Ctrl 氮气/道具 · ↑(出弯点按) 或 W 小喷 · Alt 道具换位 · R 复位
const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'AltLeft', 'AltRight', 'PageUp', 'PageDown', 'Tab', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyW', 'KeyR']);

export class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    this.touchButtons = new Map();
    this.onKey = null; // 非驾驶类按键回调（暂停、视角等）
    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      if (e.ctrlKey && (e.code === 'KeyW' || e.code === 'KeyR')) e.preventDefault();
      this.down.add(e.code);
      if (!e.repeat) {
        this.pressed.add(e.code);
        if (this.onKey) this.onKey(e.code, e);
      }
    }, { passive: false });
    window.addEventListener('keyup', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      this.down.delete(e.code);
    });
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
  }

  has(...codes) { return codes.some((c) => this.down.has(c)); }
  was(...codes) { return codes.some((c) => this.pressed.has(c)); }
  hasTouch(key) {
    for (const button of this.touchButtons.values()) {
      if (button.key === key && button.touches.size) return true;
    }
    return false;
  }

  // 渲染帧只采样；边沿事件由游戏在实际消费后清除，避免高刷新率下丢键。
  frame() {
    return {
      up: this.has('ArrowUp'),
      down: this.has('ArrowDown') || this.hasTouch('down'),
      left: this.has('ArrowLeft') || this.hasTouch('left'),
      right: this.has('ArrowRight') || this.hasTouch('right'),
      shift: this.has('ShiftLeft', 'ShiftRight') || this.hasTouch('shift'),
      upPressed: this.was('ArrowUp', 'TouchBoost'),
      wPressed: this.was('KeyW'),
      nitroPressed: this.was('ControlLeft', 'ControlRight', 'Space', 'TouchNitro'),
      swapPressed: this.was('AltLeft', 'AltRight', 'TouchSwap'),
      resetPressed: this.was('KeyR', 'TouchReset'),
    };
  }

  clearPressed() { this.pressed.clear(); }

  reset() {
    this.down.clear();
    this.clearPressed();
    for (const [el, button] of this.touchButtons) {
      button.touches.clear();
      el.classList.remove('on');
    }
  }

  bindTouch(root) {
    const btn = (sel, key, edge) => {
      const el = root.querySelector(sel);
      const touches = new Set();
      this.touchButtons.set(el, { key, touches });
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const wasDown = touches.size > 0;
        for (const t of e.changedTouches) touches.add(t.identifier);
        el.classList.toggle('on', touches.size > 0);
        if (!wasDown && edge) this.pressed.add(edge);
      }, { passive: false });
      const off = (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) touches.delete(t.identifier);
        el.classList.toggle('on', touches.size > 0);
        if (e.type === 'touchcancel' && !touches.size && edge) this.pressed.delete(edge);
      };
      el.addEventListener('touchend', off, { passive: false });
      el.addEventListener('touchcancel', off, { passive: false });
    };
    btn('#t-left', 'left');
    btn('#t-right', 'right');
    btn('#t-drift', 'shift');
    btn('#t-brake', 'down');
    btn('#t-reset', null, 'TouchReset');
    btn('#t-nitro', null, 'TouchNitro');
    btn('#t-boost', null, 'TouchBoost');
    btn('#t-swap', null, 'TouchSwap');
  }
}
