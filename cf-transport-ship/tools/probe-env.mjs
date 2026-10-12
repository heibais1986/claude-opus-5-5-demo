// 环境贴图接线检查：在 Node 里跑真实的 src/env.js（渲染器与 PMREM 用桩件），
// 确认白天预设确实换成摄影全景、黄昏仍走解析天空、data URL 前缀正确且全景只解码一次。
// 用法：node tools/probe-env.mjs
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = 'dist/.probe-env.mjs';
fs.mkdirSync('dist', { recursive: true });
await esbuild.build({
  entryPoints: ['src/env.js'],
  bundle: true, format: 'esm', target: 'es2020', write: true, outfile: out,
  loader: { '.png': 'base64' }, // 与 build.mjs 一致，探针拿到的是运行时那份字符串
});

const ASSET = 'assets/cc0/polyhaven/kloofendal-day-puresky_512.png';
const expectB64 = fs.readFileSync(ASSET).toString('base64');

// ---------------- 图片解码桩件 ----------------
const imgs = [];
class FakeImg {
  constructor() { this._h = {}; this.width = 0; this.height = 0; imgs.push(this); }
  addEventListener(t, cb) { (this._h[t] = this._h[t] || []).push(cb); }
  removeEventListener() {}
  set src(v) {
    this._src = v;
    queueMicrotask(() => {
      const comma = v.indexOf(',');
      const head = v.slice(0, comma);
      const b64 = v.slice(comma + 1);
      this.prefix = head;
      this.ok = head === 'data:image/png;base64' && b64 === expectB64;
      if (!this.ok) this.bad = `${head} / 前 24 字节 ${b64.slice(0, 24)}`;
      this.width = 512; this.height = 256;
      for (const cb of this._h.load || []) cb({ type: 'load', target: this });
    });
  }
  get src() { return this._src; }
}
globalThis.document = { createElementNS: (ns, tag) => (tag === 'img' ? new FakeImg() : { style: {} }) };
globalThis.window = globalThis;

const { Environment, PRESETS } = await import(pathToFileURL(path.resolve(out)).href);
// 探针只需要 scene 的 add / environment / environmentIntensity / fog 四个口子，
// 自己搭一个就够，免得再拉一份 three 进来（会触发 Multiple instances 警告）
const fakeScene = () => ({ children: [], add(...o) { this.children.push(...o); }, fog: null, environment: null, environmentIntensity: 0 });

console.log('预设 hdri 标记:', Object.entries(PRESETS).map(([k, v]) => `${k}=${v.hdri ?? '-'}`).join(' '));

// ---------------- 构造时先挡住 buildEnvMap（真 PMREM 需要 GL 上下文） ----------------
const proto = Environment.prototype;
const realBuild = proto.buildEnvMap;
proto.buildEnvMap = function () { this._ctorSkipped = true; };
const scene = fakeScene();
const env = new Environment({ toneMappingExposure: 0 }, scene, 'high');
proto.buildEnvMap = realBuild;

let analytic = 0, equirect = 0;
env.pmrem = {
  fromScene: () => { analytic++; return { texture: { tag: `analytic${analytic}` }, dispose() {} }; },
  fromEquirectangular: (tex) => { equirect++; return { texture: { tag: `hdri${equirect}`, src: tex }, dispose() {} }; },
};
const extra = fakeScene();
env.extraScenes = [extra];

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------- 1) 白天：解析环境之后要被全景覆盖 ----------------
env.apply('day');
console.log(`apply day 同步后 environment=${scene.environment && scene.environment.tag} 强度=${scene.environmentIntensity}`);
await tick(); await tick();
console.log(`全景到位后 environment=${scene.environment && scene.environment.tag} 强度=${scene.environmentIntensity} extra=${extra.environment && extra.environment.tag} 解码次数=${imgs.length} 前缀=${imgs[0] && imgs[0].prefix} 字节一致=${imgs[0] && imgs[0].ok}`);
if (imgs[0] && !imgs[0].ok) console.warn('!! 内联的全景与仓库文件不一致：', imgs[0].bad);

// ---------------- 2) 黄昏：不许用全景 ----------------
env.apply('dusk');
console.log(`apply dusk environment=${scene.environment.tag}（应为 analytic）`);

// ---------------- 3) 切回白天：复用缓存，不再解一次图 ----------------
env.apply('day');
await tick(); await tick();
console.log(`再次 apply day environment=${scene.environment.tag} 解码次数=${imgs.length}（应为 1） 复用缓存=${scene.environment.tag === 'hdri2'}`);

// ---------------- 4) 海洋地图与陆地地图都要走到同一条分支 ----------------
for (const id of ['ship', 'dust2']) {
  const s2 = fakeScene();
  proto.buildEnvMap = function () {};
  const e2 = new Environment({ toneMappingExposure: 0 }, s2, 'high', { id, sea: id === 'ship', seaY: -7.5, shadowBox: { x: [-58, 40], y: [-1, 26], z: [-15, 15] }, tod: [{ v: 'day' }] });
  proto.buildEnvMap = realBuild;
  e2.pmrem = env.pmrem;
  e2.apply('day');
  await tick(); await tick();
  console.log(`${id}_day 全景=${e2.preset.hdri ?? '无'} environment=${s2.environment.tag}`);
}
console.log('完成');
