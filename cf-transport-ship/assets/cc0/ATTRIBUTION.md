# CC0 第三方素材

本目录是仓库里**唯一**的外部素材。其余（角色、枪械、地图、纹理、全部音效）都由
`src/` 里的代码在运行时程序化生成，不含任何 Valve / CS2 派生资源。

## kenney-impact-sounds/ — 脚步与弹着撞击（11 个 .ogg，共 68 KB）

- 来源：Kenney「Impact Sounds」1.0，https://kenney.nl/assets/impact-sounds
- 许可：CC0 1.0 Universal（https://creativecommons.org/publicdomain/zero/1.0/），
  个人/商业项目均可自由使用，署名非强制（此处即为署名）。
- 制作者：www.kenney.nl，原始内容日期 2019-12-19。
- 格式：Ogg/Vorbis，立体声 44.1 kHz。
- 用法：`src/audio.js` 里脚步（concrete/sand/wood 等地面）与金属/木质弹着撞击
  优先播放这些采样，解码失败或尚未解码完成时回落到原来的程序合成路径。
  金属甲板/格栅/集装箱脚步、混凝土撞击、肉体命中仍为纯合成——包里没有对应的
  CC0 录音，不打算为此引入任何游戏出处素材。
- 说明：文件取自本机已有的一份把该 CC0 素材重新打包进产品的构建产物；上游许可
  为 CC0，重打包不改变其公有领域状态。原始出处以 kenney.nl 的素材页为准。

## polyhaven/ — 白天环境反射全景（1 个 PNG，115 KB）

- 文件：`polyhaven/kloofendal-day-puresky_512.png`（equirect 512x256，8 位 sRGB）。
- 上游：Poly Haven「Kloofendal 48d Partly Cloudy (Pure Sky)》，
  https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky
  作者 Greg Zaal、Jarod Guest，许可 CC0 1.0 Universal。
- 原始文件是 2k Radiance `.hdr`（5 451 493 字节，
  sha256 `5244534e9cf5b606f2ff513aa00ddb161b0a4826ffd88a0d3bd03ac29247d198`，
  与 Poly Haven 下载一致）。仓库里不放 `.hdr`，只放转换结果。
- 转换：`node tools/hdr2png.mjs <daylight.hdr> assets/cc0/polyhaven/kloofendal-day-puresky_512.png
  --size=512 --exposure=0.35 --align-azim=128`
  —— 线性空间面积降采样、ACES 近似色调映射、逐行自适应 PNG 滤波；
  `--align-azim` 把太阳经度旋到 `ship_day` 预设的方位角 128°，这样反射高光的方向
  和场景里的 DirectionalLight 对得上（工具会回读 PNG 校验残差）。
- 用法：`src/env.js` 只给白天预设（`ship_day`、`dust2_day`）用它替换
  `scene.environment`（PMREM），背景仍是原来的解析 `Sky`。黄昏预设不挂：
  一张正午全景无法同时充当低角度暖色的环境光。
  `dust2_day` 的方位角是 96°，与烘焙的 128° 差 32°，属于可接受的折中；
  要精确对齐就用 `--align-azim=96` 再转一张。

## 为什么没有别的文件

从 Counter-Strike 2 导出的模型、皮肤、手臂、骨骼动作、枪声、地图网格与图标均属
Valve 及其创作者，未获重新授权，不得复制进本项目；即使某个产品把它们打包在一起
分发也不行。需要真实第三人称角色时，只接受 CC0/自有许可的模型包，并通过
`src/models-ext.js` 的 `window.SoldierFactory` 通道在页面内挂载，不落库。
