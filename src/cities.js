/* src/cities.js —— 城市坐标库(D1 city_coords)+ 服务器端地理编码
 *
 * 提交页不再硬编码城市坐标:公开 /api/cities 下发 city_coords(curated 种子 +
 * 存量 approved 城市 + 审核通过写回自增长);城市不在库时 /api/geocode 代查
 * 外部 geocoder(默认 Nominatim,base 可经 env.GEOCODER_URL 切换)自动填城市中心。
 * 外部 geocode 全在 Worker 侧:浏览器 connect-src 保持 'self',无 CORS/key 暴露。
 *
 * 循环 import 先例:db.js import tags.js、tags.js import db.js;cities.js 被 db.js
 * import(seedCityCoords),故本文件只在函数体内引用 db.js 导出,顶层不执行。
 */

import { json, HttpError, checkRateLimit, clientIP } from './db.js';

/** 策展常用城市 → [纬度, 经度](WGS-84)。自 public/js/submit.js 硬编码常量平移,
 *  仅空表首建种子使用;坐标已被 admin 审核或人工核对,curated 优先于存量吸收。 */
export const CURATED_CITIES = {
  '上海': [31.2304, 121.4737], '北京': [39.904, 116.407], '天津': [39.3434, 117.3616],
  '重庆': [29.563, 106.5516], '南京': [32.0603, 118.7969], '苏州': [31.2989, 120.5853],
  '杭州': [30.2741, 120.1551], '宁波': [29.8683, 121.544], '温州': [27.9938, 120.6994],
  '广州': [23.1291, 113.2644], '深圳': [22.5431, 114.0579], '佛山': [23.0215, 113.1214],
  '东莞': [23.0207, 113.7518], '珠海': [22.271, 113.5767], '中山': [22.5176, 113.3929],
  '厦门': [24.4798, 118.0894], '福州': [26.0745, 119.2965], '泉州': [24.8741, 118.6757],
  '成都': [30.5728, 104.0668], '武汉': [30.5928, 114.3055], '长沙': [28.2282, 112.9388],
  '郑州': [34.7466, 113.6254], '西安': [34.3416, 108.9398], '兰州': [36.0611, 103.8343],
  '济南': [36.6512, 117.1201], '青岛': [36.0671, 120.3826], '沈阳': [41.8057, 123.4315],
  '大连': [38.914, 121.6147], '长春': [43.8171, 125.3235], '哈尔滨': [45.8038, 126.5349],
  '合肥': [31.8206, 117.2272], '南昌': [28.682, 115.8579], '贵阳': [26.647, 106.6302],
  '昆明': [24.8801, 102.8329], '南宁': [22.817, 108.3665], '海口': [20.0444, 110.1999],
  '三亚': [18.2528, 109.5119], '呼和浩特': [40.8424, 111.75], '银川': [38.4872, 106.2309],
  '西宁': [36.6171, 101.7782], '乌鲁木齐': [43.8256, 87.6168], '拉萨': [29.652, 91.1721],
  '台北': [25.033, 121.5654], '香港': [22.3193, 114.1694], '澳门': [22.1987, 113.5436],
  '新加坡': [1.3521, 103.8198], '吉隆坡': [3.139, 101.6869], '曼谷': [13.7563, 100.5018],
  '东京': [35.6762, 139.6503], '首尔': [37.5665, 126.978], '悉尼': [-33.8688, 151.2093],
  '墨尔本': [-37.8136, 144.9631], '奥克兰': [-36.8485, 174.7633], '伦敦': [51.5074, -0.1278],
  '巴黎': [48.8566, 2.3522], '纽约': [40.7128, -74.006], '洛杉矶': [34.0522, -118.2437],
  '旧金山': [37.7749, -122.4194], '多伦多': [43.6532, -79.3832], '温哥华': [49.2827, -123.1207],
};

/** 幂等种子:仅 city_coords 空表时执行一次(避免每次冷启动扫描)。
 *  先 INSERT OR IGNORE 60 条 curated,再吸收存量 approved 且未删演出的去重城市
 *  (单条 INSERT ... SELECT;同 city 多行取先序任一行,curated 已占位则跳过)。 */
export async function seedCityCoords(env) {
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM city_coords').all();
  if (Number(results[0].n) !== 0) return;
  for (const city of Object.keys(CURATED_CITIES)) {
    const [lat, lng] = CURATED_CITIES[city];
    await env.DB.prepare('INSERT OR IGNORE INTO city_coords (city, lat, lng) VALUES (?,?,?)')
      .bind(city, lat, lng).run();
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO city_coords (city, lat, lng)
     SELECT city, lat, lng FROM performances WHERE status = 'approved' AND is_deleted = 0`
  ).run();
}

/** 审核通过写回:city 空或坐标非法(Number() 后非有限)→ no-op;INSERT OR IGNORE 已存在不覆盖。 */
export async function rememberCity(env, city, lat, lng) {
  if (!city) return;
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return;
  await env.DB.prepare('INSERT OR IGNORE INTO city_coords (city, lat, lng) VALUES (?,?,?)')
    .bind(city, nLat, nLng).run();
}

/** GET /api/cities(公开,无鉴权无限流):全部城市坐标,按 city 排序。 */
export async function handleCities(request, env) {
  const { results } = await env.DB.prepare('SELECT city, lat, lng FROM city_coords ORDER BY city').all();
  return json({ cities: results.map((r) => ({ city: r.city, lat: Number(r.lat), lng: Number(r.lng) })) });
}

/** GET /api/geocode?q=(公开 + 限流):服务器端代理外部 geocoder。
 *  q trim 后空 / >50 → 400;同 IP 60s 内 >10 次 → 429。
 *  成功 → {results:[{label,lat,lng}]}(N≤3);upstream 任何失败(网络/超时/非 2xx/解析)
 *  一律降级为 200 {results:[]},绝不把外部故障变成 500。约 5s 超时,手写 AbortController
 *  + setTimeout(不依赖 AbortSignal.timeout)。 */
export async function handleGeocode(request, env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length > 50) throw new HttpError(400, '城市名无效');
  await checkRateLimit(env, clientIP(request), 'geocode', 60, 10);

  const base = env.GEOCODER_URL || 'https://nominatim.openstreetmap.org';
  const endpoint = `${base}/search?format=jsonv2&limit=3&accept-language=zh-CN,zh,en&q=${encodeURIComponent(q)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(endpoint, {
      headers: { 'User-Agent': 'davidtao-archive/1.0 (map-concerts.com)' },
      signal: controller.signal,
    });
    if (!res.ok) return json({ results: [] });
    const data = await res.json();
    const results = (Array.isArray(data) ? data : [])
      .map((e) => ({ label: e.display_name, lat: +e.lat, lng: +e.lon }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) &&
        r.lat >= -90 && r.lat <= 90 && r.lng >= -180 && r.lng <= 180);
    return json({ results });
  } catch (err) {
    return json({ results: [] });
  } finally {
    clearTimeout(timer);
  }
}
