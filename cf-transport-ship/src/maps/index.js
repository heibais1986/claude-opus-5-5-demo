// 地图注册表：新增地图只需在这里挂一个描述符
// 描述符字段：id / name / en / brief / story / textures / tod / sea / nav / shadowBox / radar / build
import { shipMap } from './ship.js';
import { dust2Map } from './dust2.js';

export const MAPS = [shipMap, dust2Map];
const BY_ID = Object.fromEntries(MAPS.map((m) => [m.id, m]));

export function pickMap(id) { return BY_ID[id] || shipMap; }
