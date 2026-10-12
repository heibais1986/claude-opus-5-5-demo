// CC0 采样接线检查：用 Web Audio 桩件在 Node 里跑真实的 src/audio.js，
// 确认解码发生在 init 之后、脚步/撞击何时走采样何时回落合成，且没有异常被吞掉。
// 用法：node tools/probe-audio.mjs
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = 'dist/.probe-audio.mjs';
fs.mkdirSync('dist', { recursive: true });
await esbuild.build({
  entryPoints: ['src/audio.js'],
  bundle: true, format: 'esm', target: 'es2020', write: true, outfile: out,
  // 与 build.mjs 同样的内联方式，探针拿到的就是运行时那份字符串
  loader: { '.ogg': 'base64' },
});

// ---------------- Web Audio 桩件 ----------------
const rec = { started: [], buffers: {}, nodes: 0 };
class Param {
  constructor(v = 0) { this.value = v; this.calls = 0; }
  setValueAtTime(v) { this.calls++; this.value = v; return this; }
  linearRampToValueAtTime(v) { this.calls++; this.value = v; return this; }
  exponentialRampToValueAtTime(v) { if (v === 0) throw new Error('指数衰减到 0 会报错'); this.calls++; this.value = v; return this; }
  setTargetAtTime() { this.calls++; return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}
class Node {
  constructor(kind) { this.kind = kind; this.outs = 0; rec.nodes++; }
  connect() { this.outs++; }
  disconnect() { this.outs = Math.max(0, this.outs - 1); }
  start(t) { rec.started.push({ kind: this.kind, t, buf: this.buffer && this.buffer.name }); }
  stop() {}
}
const mk = (kind, extra = {}) => Object.assign(new Node(kind), extra);
class FakeCtx {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.currentTime = 1.25; this.destination = mk('dest'); }
  createGain() { return mk('gain', { gain: new Param(1) }); }
  createBiquadFilter() { return mk('biquad', { type: 'lowpass', frequency: new Param(1000), Q: new Param(1), detune: new Param(0), gain: new Param(0) }); }
  createPanner() { return mk('panner', { positionX: new Param(), positionY: new Param(), positionZ: new Param(), panningModel: 'HRTF', distanceModel: 'inverse' }); }
  createStereoPanner() { return mk('stereo', { pan: new Param() }); }
  createOscillator() { return mk('osc', { type: 'sine', frequency: new Param(440), detune: new Param(0) }); }
  createBufferSource() { return mk('src', { buffer: null, playbackRate: new Param(1), loop: false, onended: null }); }
  createConvolver() { return mk('conv', { buffer: null, normalize: true }); }
  createWaveShaper() { return mk('shaper', { curve: null, oversample: 'none' }); }
  createDynamicsCompressor() { return mk('comp', { threshold: new Param(), knee: new Param(), ratio: new Param(), attack: new Param(), release: new Param(), reduction: 0 }); }
  createChannelMerger() { return mk('merger'); }
  createChannelSplitter() { return mk('splitter'); }
  createAnalyser() { return mk('analyser', { fftSize: 2048 }); }
  createBuffer(ch, len) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: this.sampleRate, duration: len / this.sampleRate, getChannelData: (i) => data[i] };
  }
  decodeAudioData(ab) {
    const head = Buffer.from(ab).subarray(0, 4).toString('latin1');
    if (head !== 'OggS') return Promise.reject(new Error('非 Ogg：' + head));
    const n = (rec.buffers.n = (rec.buffers.n || 0) + 1);
    return Promise.resolve({ name: `buf${n}`, numberOfChannels: 2, sampleRate: 44100, length: 33075, duration: 0.75, getChannelData: () => new Float32Array(33075) });
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
globalThis.AudioContext = FakeCtx;
globalThis.window = globalThis;
globalThis.self = globalThis;

const { audio } = await import(pathToFileURL(path.resolve(out)).href);

// ---------------- 1) 解码前必须走合成、且不抛 ----------------
const ctx1 = new FakeCtx();
audio.ctx = null;
audio.init(ctx1);
// init 会起 100ms 兜底定时器（真机用于暂停时继续调度）；Node 里它会让进程永不退出，
// 也会往 rec.started 里塞心跳事件，所以立刻关掉。
if (audio._timer) { clearInterval(audio._timer); audio._timer = 0; }
const before = rec.started.length;
audio.playFootstep({ x: 1, y: 0, z: 2 }, 'concrete', { run: false });
console.log('解码前 采样缓冲数:', audio._bufs ? Object.keys(audio._bufs).length : 0, '发声节点:', rec.started.length - before, '异常:', [...audio._warned]);

await audio._bufQ;
const keys = Object.keys(audio._bufs || {});
console.log('解码完成:', keys.length, '条 ->', keys.join(' '));

// ---------------- 2) 各地面该走采样还是合成 ----------------
// 注意：合成噪声同样用 BufferSource；桩件的 start() 已把 buffer 折成名字（采样才有），
// 所以 buf 为非空字符串即采样。
const named = (s) => s.kind === 'src' && typeof s.buf === 'string' && s.buf.length > 0;
function once(fn, ...a) {
  rec.started.length = 0;
  fn.call(audio, ...a);
  return {
    smp: rec.started.filter(named).length,
    noise: rec.started.filter((s) => s.kind === 'src' && !named(s)).length,
    osc: rec.started.filter((s) => s.kind === 'osc').length,
  };
}
for (const surf of ['concrete', 'sand', 'wood', 'crate', 'metal', 'grate', 'container', 'mesh']) {
  const r = once(audio.playFootstep, { x: 0, y: 0, z: 0 }, surf, { run: true });
  console.log(`脚步 ${surf.padEnd(10)} 采样=${r.smp} 噪声层=${r.noise} 振荡器=${r.osc}`);
}
for (const mat of ['metal', 'wood', 'concrete', 'flesh', 'mesh']) {
  const r = once(audio.playImpact, { x: 0, y: 0, z: 0 }, mat);
  console.log(`弹着 ${mat.padEnd(10)} 采样=${r.smp} 噪声层=${r.noise} 振荡器=${r.osc}`);
}
{
  const r = once(audio.playLand, { x: 0, y: 0, z: 0 }, 'sand', 0.8);
  console.log(`落地 sand 采样=${r.smp} 噪声层=${r.noise} 振荡器=${r.osc}`);
}

// ---------------- 3) 变体轮换 + 调度时刻 ----------------
const seen = new Set();
for (let i = 0; i < 30; i++) {
  rec.started.length = 0;
  audio.playFootstep({ x: 0, y: 0, z: 0 }, 'concrete', {});
  for (const s of rec.started) if (named(s)) seen.add(s.buf);
}
console.log('30 步里用到的不同 concrete 采样:', seen.size, '（组内有 5 条，应 >=4）');
rec.started.length = 0;
audio.playFootstep({ x: 5, y: 0, z: 5 }, 'wood', {});
audio.playFootstep({ x: 5, y: 0, z: 5 }, 'wood', { crouch: true });
console.log('采样调度时刻:', rec.started.filter(named).map((s) => s.t.toFixed(3)).join(' /'), '（应 >= ctx.currentTime 1.25）');

// ---------------- 4) 节点回收：连打 60 步不应无限堆积 ----------------
rec.nodes = 0;
for (let i = 0; i < 60; i++) {
  audio.playFootstep({ x: 0, y: 0, z: 0 }, 'concrete', { run: true });
  for (const v of audio.voices.slice()) { for (const s of v.src) { if (s.onended) s.onended(); } }
  audio.update(0.05);
}
console.log('60 步后 活动 voice:', audio.voices.length, '新建节点:', rec.nodes, '异常:', [...audio._warned]);
