// Radiance .hdr（RGBE）-> 缩小、对齐日照方位、色调映射后的 equirect PNG。
// 环境里没有 ffmpeg / Pillow，而把 5.4 MB 的 .hdr 直接 base64 进单文件产物不可接受，
// 所以在这里一次性离线转成小尺寸 8 位贴图；运行时只走 three 的 TextureLoader。
// 解码复用 three 自带的 HDRLoader（工具不参与打包，不会增大产物）。
// 用法：node tools/hdr2png.mjs <in.hdr> <out.png> [--size=1024] [--exposure=1] [--align-azim=128]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FloatType } from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const argv = process.argv.slice(2);
const src = argv[0];
const dst = argv[1];
if (!src || !dst) { console.error('用法：node tools/hdr2png.mjs <in.hdr> <out.png> [--size=1024] [--exposure=1] [--align-azim=deg]'); process.exit(1); }
const opt = (k, d) => { const a = argv.find((s) => s.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const SIZE = opt('size', 1024);           // 目标宽（高等于宽/2）
const EXPOSURE = opt('exposure', 1);
const ALIGN = argv.some((s) => s.startsWith('--align-azim=')) ? opt('align-azim', null) : null;

// ---------------- .hdr 解码 ----------------
function readHdr(file) {
  const loader = new HDRLoader();
  loader.setDataType(FloatType);
  const b = fs.readFileSync(file);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const tex = loader.parse(ab);
  const w = tex.width, h = tex.height;
  const rgba = tex.data;
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
  }
  return { w, h, rgb };
}

// three 运行时的 equirect 约定：u = atan(z,x)/2π + .5，v = asin(y)/π + .5。
// 转换时沿用同一式子，对齐后的全景在 PMREM 里才会把高光落在 DirectionalLight 的方向上。
// three 运行时的 equirect 约定：u = atan(z,x)/2π + .5，v = asin(y)/π + .5。
// 转换时沿用同一式子，对齐后的全景在 PMREM 里才会把高光落在 DirectionalLight 的方向上。
// Radiance 的第 0 行是天顶，而 HDRLoader 返回 flipY:true，所以行号要取反。
const dirToLon = (x, z) => Math.atan2(z, x);

// 峰值找太阳在 RGBE 量化下会遇到大片等值平台（换个平移就跳到别处），
// 所以用「亮度过 frac*峰值且在地平线以上」的亮度加权质心，结果对平移不敏感。
// frac 默认 0.6 用于线性 HDR；回读 8 位图时太阳已削顶，需要接近 1 的阈值才不被云干扰。
function sunOf(img, frac = 0.6) {
  let peak = -1;
  for (let i = 0; i < img.rgb.length; i += 3) {
    const l = img.rgb[i] * 0.2126 + img.rgb[i + 1] * 0.7152 + img.rgb[i + 2] * 0.0722;
    if (l > peak) peak = l;
  }
  const th = peak * frac;
  let sx = 0, sy = 0, sz = 0, sw = 0, n = 0;
  for (let y = 0; y < img.h; y++) {
    const v = 1 - (y + 0.5) / img.h;
    const lat = (v - 0.5) * Math.PI;
    if (lat < 0.2) continue; // 只看地平线以上，避免地面反光干扰
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 3;
      const l = img.rgb[i] * 0.2126 + img.rgb[i + 1] * 0.7152 + img.rgb[i + 2] * 0.0722;
      if (l < th) continue;
      const lon = (((x + 0.5) / img.w) - 0.5) * Math.PI * 2;
      sx += l * cl * Math.cos(lon); sy += l * sl; sz += l * cl * Math.sin(lon); sw += l; n++;
    }
  }
  if (!sw) return { peak, elev: NaN, azim: NaN, n: 0 };
  const d = [sx / sw, sy / sw, sz / sw];
  const len = Math.hypot(d[0], d[1], d[2]);
  return { peak, elev: Math.asin(d[1] / len) * 180 / Math.PI, azim: dirToLon(d[0] / len, d[2] / len) * 180 / Math.PI, n };
}

// 上下半球平均亮度：地面那半如果太暗，直接当环境图会把金属压黑
function hemispheres(img) {
  let up = 0, dn = 0, nu = 0, nd = 0;
  for (let y = 0; y < img.h; y++) {
    const isUp = (y + 0.5) / img.h < 0.5;
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 3;
      const l = img.rgb[i] * 0.2126 + img.rgb[i + 1] * 0.7152 + img.rgb[i + 2] * 0.0722;
      if (isUp) { up += l; nu++; } else { dn += l; nd++; }
    }
  }
  return { up: up / nu, down: dn / nd };
}

// 绕 Y 旋转全景 = 按 u 循环平移（双线性会糊掉太阳，用整数平移最干净）
function yawShift(img, deg) {
  const dx = Math.round((deg / 360) * img.w);
  if (!dx) return img;
  const out = new Float32Array(img.rgb.length);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 3, s = (y * img.w + ((x - dx + img.w * 2) % img.w)) * 3;
    out[i] = img.rgb[s]; out[i + 1] = img.rgb[s + 1]; out[i + 2] = img.rgb[s + 2];
  }
  return { w: img.w, h: img.h, rgb: out };
}

// 线性空间面积重采样（盒式），保证缩小后辐照度不变
function downscale(img, w, h) {
  const out = new Float32Array(w * h * 3);
  const sx = img.w / w, sy = img.h / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * img.w + xx) * 3; r += img.rgb[i]; g += img.rgb[i + 1]; b += img.rgb[i + 2]; n++;
    }
    const o = (y * w + x) * 3;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
  }
  return { w, h, rgb: out };
}

const CHAN = (v) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
const RRT = (x) => x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14); // ACES 近似
function tonemap(img, exposure) {
  const out = new Float32Array(img.rgb.length);
  for (let i = 0; i < img.rgb.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, RRT(img.rgb[i + c] * exposure));
      out[i + c] = CHAN(Math.min(v, 1));
    }
  }
  return { w: img.w, h: img.h, rgb: out };
}

// ---------------- PNG 编码 ----------------
// 逐行在 5 种滤波里挑「绝对差之和」最小的一种：平滑但带细云的全景，
// 自适应滤波实测比一律 None 小一半。
function png(w, h, rgbBytes) {
  const bpp = 3, stride = w * bpp;
  const enc = Buffer.alloc(h * (stride + 1));
  const filt = (ft, y) => {
    const row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const v = rgbBytes[y * stride + i];
      const a = i >= bpp ? rgbBytes[y * stride + i - bpp] : 0;
      const b = y ? rgbBytes[(y - 1) * stride + i] : 0;
      const c = y && i >= bpp ? rgbBytes[(y - 1) * stride + i - bpp] : 0;
      let p = 0;
      if (ft === 1) p = a; else if (ft === 2) p = b; else if (ft === 3) p = (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = (v - p) & 255;
    }
    return row;
  };
  const cost = (x) => { let s = 0; for (let i = 0; i < x.length; i++) { const v = x[i]; s += v > 127 ? 256 - v : v; } return s; };
  for (let y = 0; y < h; y++) {
    let bestFt = 0, bestCost = Infinity, bestRow = null;
    for (const ft of [0, 1, 2, 3, 4]) {
      const r = filt(ft, y), c = cost(r);
      if (c < bestCost) { bestCost = c; bestFt = ft; bestRow = r; }
    }
    enc[y * (stride + 1)] = bestFt;
    bestRow.copy(enc, y * (stride + 1) + 1);
  }
  const raw = enc;
  const crc = zlib.crc32 || ((t) => { let c, crct = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crct[n] = c >>> 0; } return (b) => { let x = 0xffffffff; for (let i = 0; i < b.length; i++) x = crct[(x ^ b[i]) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; }; })();
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body) >>> 0);
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const img = readHdr(src);
const before = sunOf(img);
const hemi = hemispheres(img);
console.log(`源 ${img.w}x${img.h} 峰值亮度 ${before.peak.toFixed(0)}  太阳质心 仰角 ${before.elev.toFixed(1)}° 方位 ${before.azim.toFixed(1)}°（${before.n} 个采样点）`);
console.log(`上半球均亮 ${hemi.up.toFixed(2)} / 下半球 ${hemi.down.toFixed(3)}（下太暗就别直接当 env，会压黑金属）`);
if (before.elev <= 0) console.warn('!! 太阳在水平面以下：纵向行序假设与 three 的 equirect 约定不符，先别用这份输出');

let work = img;
if (ALIGN !== null) {
  // 把太阳经度旋到目标方位角：反射里的高光方向就和 DirectionalLight 一致
  const d = ((ALIGN - before.azim + 540) % 360) - 180;
  work = yawShift(img, d);
  const after = sunOf(work);
  const err = ((after.azim - ALIGN + 540) % 360) - 180;
  console.log(`方位对齐 ${before.azim.toFixed(1)}° -> ${after.azim.toFixed(1)}°（目标 ${ALIGN}°，平移 ${d.toFixed(1)}°，残差 ${err.toFixed(2)}°）`);
  if (Math.abs(err) > 1.5) console.warn('!! 对齐残差超过 1.5°');
}
const small = downscale(work, SIZE, SIZE / 2);
const ldr = tonemap(small, EXPOSURE);
{ // 曝光是否合适：8 位图上天空均值应落在 0.4~0.6，太阳削顶但要保住一小块圆盘
  let s = 0, clip = 0, mx = 0;
  for (let i = 0; i < ldr.rgb.length; i += 3) {
    const l = ldr.rgb[i] * 0.2126 + ldr.rgb[i + 1] * 0.7152 + ldr.rgb[i + 2] * 0.0722;
    s += l; if (l > mx) mx = l; if (l >= 0.98) clip++;
  }
  console.log(`exposure ${EXPOSURE} -> LDR 天空均值 ${(s / (SIZE * SIZE / 2)).toFixed(3)} 峰值 ${mx.toFixed(3)}，近削顶像素 ${clip}（占 ${((clip / (SIZE * SIZE / 2)) * 100).toFixed(3)}%）`);
}
// 不加抖动：8 位天空会有极轻的条带，但 1 LSB 抖动让 PNG 从 3 KB 涨到 120 KB，
// 而这张图只以 environmentIntensity 0.5 参与反射，不值这个体积。
const bytes = Buffer.alloc(SIZE * (SIZE / 2) * 3);
for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, ldr.rgb[i])) * 255);
const out = png(SIZE, SIZE / 2, bytes);
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, out);
console.log(`输出 ${dst}：${SIZE}x${SIZE / 2}，${(out.length / 1024).toFixed(1)} KB（base64 约 ${((out.length * 4) / 3 / 1024).toFixed(1)} KB）`);

// ---------------- 回读校验：按通用 PNG 解码器的方式重解一遍，确认太阳真的落在目标方位 ----------------
function readPng(file) {
  const b = fs.readFileSync(file);
  if (b.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') throw new Error('PNG 签名不符');
  let o = 8, w = 0, h = 0; const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o); const type = b.subarray(o + 4, o + 8).toString('latin1');
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 2) throw new Error('只支持 8 位 RGB'); }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 3, px = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? cur[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0;
      let v = row[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1; else if (ft === 4) v += paeth(a, b, c);
      cur[i] = v & 255;
    }
    if (ft > 4) throw new Error('未知滤波类型 ' + ft);
  }
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h * 3; i++) rgb[i] = px[i] / 255;
  return { w, h, rgb };
}
if (ALIGN !== null) {
  const back = sunOf(readPng(dst), 0.98);
  // 8 位图上太阳已削顶，质心会被阈值略微带偏，所以这里的容差不按像素尺寸而按 3°：
  // 真正决定对齐质量的是上面线性空间的残差。
  const err = ((back.azim - ALIGN + 540) % 360) - 180;
  console.log(`回读校验：太阳方位 ${back.azim.toFixed(1)}° 仰角 ${back.elev.toFixed(1)}°，与目标残差 ${err.toFixed(2)}°（削顶质心允许 3°）`);
  if (Math.abs(err) > 3) console.warn('!! 回读残差过大，别用这份输出');
}

