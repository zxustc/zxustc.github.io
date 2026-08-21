'use strict';

/* =========================================================
 * 天气查询台 —— 核心逻辑
 * 数据源：
 *  - Open-Meteo：聚合 30+ 数值模型（ECMWF/GFS/ICON 等），16 天预报
 *  - wttr.in：   单源聚合服务（底层 World Weather Online），最多 3 天
 * 支持双源对照（N≤3 天），N>3 天自动仅用 Open-Meteo
 * 功能：
 *  1. 多地点（经纬度）批量查询，命名地点本地保存（localStorage）
 *  2. 未来 N 天可定制（1-16 天）
 *  3. 时段：日出 / 上午 / 下午 / 夕阳（可多选）
 *  4. 逐小时云量、温度、降水概率、天气码聚合展示
 * ========================================================= */

const API_BASE = 'https://api.open-meteo.com/v1/forecast';
const AQI_API_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const WTTTR_BASE = 'https://wttr.in';
const STORAGE_KEY = 'wttr.locations.v1';
const MAX_DAYS = 16;

const DEFAULT_LOCATIONS = [
  { name: '张掖丹霞', lat: 38.91555, lon: 100.1332, note: '甘肃 · 丹霞地质公园' },
  { name: '北京', lat: 39.9042, lon: 116.4074, note: '示例' },
];

/* WMO 天气代码 → 中文描述 + emoji（Open-Meteo 用） */
const WMO = {
  0:  ['晴', '☀️'], 1: ['基本晴朗', '🌤️'], 2: ['局部多云', '⛅'], 3: ['阴天', '☁️'],
  45: ['雾', '🌫️'], 48: ['雾凇', '🌫️'],
  51: ['毛毛雨', '🌦️'], 53: ['毛毛雨', '🌦️'], 55: ['毛毛雨', '🌧️'],
  56: ['冻毛毛雨', '🌧️'], 57: ['冻毛毛雨', '🌧️'],
  61: ['小雨', '🌧️'], 63: ['中雨', '🌧️'], 65: ['大雨', '🌧️'],
  66: ['冻雨', '🌧️'], 67: ['冻雨', '🌧️'],
  71: ['小雪', '🌨️'], 73: ['中雪', '🌨️'], 75: ['大雪', '❄️'], 77: ['霰', '🌨️'],
  80: ['阵雨', '🌦️'], 81: ['阵雨', '🌦️'], 82: ['强阵雨', '⛈️'],
  85: ['阵雪', '🌨️'], 86: ['阵雪', '🌨️'],
  95: ['雷暴', '⛈️'], 96: ['雷暴伴冰雹', '⛈️'], 99: ['雷暴伴冰雹', '⛈️'],
};

/* WWO（wttr.in）天气文本 → 中文 + emoji，按优先级匹配 */
const WWO_TEXT_RULES = [
  [/thunder/i, ['雷暴', '⛈️']],
  [/heavy rain/i, ['大雨', '🌧️']],
  [/moderate rain/i, ['中雨', '🌧️']],
  [/light rain|patchy rain/i, ['小雨', '🌧️']],
  [/drizzle/i, ['毛毛雨', '🌦️']],
  [/snow/i, ['雪', '🌨️']],
  [/fog|mist|haze/i, ['雾', '🌫️']],
  [/overcast/i, ['阴天', '☁️']],
  [/cloudy/i, ['多云', '☁️']],
  [/partly/i, ['局部多云', '⛅']],
  [/clear/i, ['晴', '☀️']],
  [/sunny/i, ['晴', '☀️']],
];

const PERIODS = [
  { id: 'sunrise',  label: '日出',  hours: null }, // 由日出时刻动态计算
  { id: 'morning',  label: '上午',  hours: [6, 7, 8, 9, 10, 11] },
  { id: 'afternoon',label: '下午',  hours: [12, 13, 14, 15, 16, 17] },
  { id: 'sunset',   label: '夕阳',  hours: null }, // 由日落时刻动态计算
];

/* ===== 状态 ===== */
let locations = loadLocations();

/* ===== 工具 ===== */
const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* 十进制 = (d + m/60 + s/3600)，南纬/西经取负 */
function dmsToDecimal(d, m, s, dir) {
  let v = d + m / 60 + s / 3600;
  if (dir === 'S' || dir === 'W' || dir === 's' || dir === 'w') v = -v;
  return v;
}

/**
 * 解析用户输入坐标。
 * 支持："38.91555,100.1332"（逗号/空格分隔）、"38°54′55.98″N 100°7′59.52″E"（度分秒）
 * @returns {{lat:number, lon:number}|null}
 */
function parseCoord(input) {
  const s = input.trim();
  if (!s) return null;

  // 1) 度分秒格式：38°54′55.98″N 100°7′59.52″E
  const dmsRe = /(-?\d+(?:\.\d+)?)\s*[°度]\s*(\d+(?:\.\d+)?)\s*[′'分]\s*(\d+(?:\.\d+)?)\s*[″"秒]?\s*([NSEWnsew])/g;
  const parts = [];
  let m;
  while ((m = dmsRe.exec(s)) !== null) {
    parts.push(dmsToDecimal(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4]));
  }
  if (parts.length === 2) return { lat: parts[0], lon: parts[1] };

  // 2) 十进制：逗号或空白分隔两个数字
  const nums = s.split(/[,\s，;；]+/).map(x => parseFloat(x));
  if (nums.length === 2 && nums.every(Number.isFinite)) {
    return { lat: nums[0], lon: nums[1] };
  }
  return null;
}

function formatCoord(lat, lon) {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function cloudLevel(c) {
  if (c < 25) return '晴';
  if (c < 50) return '少云';
  if (c < 75) return '多云';
  return '阴';
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

/* 众数（出现最多的天气码），用于代表时段天气 */
function mode(arr) {
  if (!arr.length) return null;
  const cnt = new Map();
  arr.forEach(x => cnt.set(x, (cnt.get(x) || 0) + 1));
  let best = arr[0], bestN = 0;
  cnt.forEach((n, k) => { if (n > bestN) { bestN = n; best = k; } });
  return best;
}

/* ===== 地点存储 ===== */
function loadLocations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) return list;
    }
  } catch (e) { /* 存储不可用则退回默认 */ }
  return DEFAULT_LOCATIONS.map(l => ({ ...l, id: cryptoRandomId() }));
}

function saveLocations() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(locations)); }
  catch (e) { console.warn('保存地点失败', e); }
}

function cryptoRandomId() {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

/* ===== 地点搜索：Open-Meteo Geocoding（城市级）+ Nominatim（POI/景区级） ===== */
const GEO_API = 'https://geocoding-api.open-meteo.com/v1/search';
const NOMINATIM_API = 'https://nominatim.openstreetmap.org/search';
let lastNominatimTs = 0; // Nominatim 使用政策限速：≥1.1s/次

async function searchPlaces(q) {
  const items = [];
  const seen = new Set();
  const add = (name, sub, lat, lon, src) => {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (seen.has(key)) return; // 去重（两源结果可能重合）
    seen.add(key);
    items.push({ name, sub, lat, lon, src });
  };

  // 1) Open-Meteo Geocoding：城市 / 地级市级
  try {
    const url = new URL(GEO_API);
    url.searchParams.set('name', q);
    url.searchParams.set('count', '6');
    url.searchParams.set('language', 'zh');
    url.searchParams.set('format', 'json');
    const resp = await fetch(url.toString());
    if (resp.ok) {
      const data = await resp.json();
      for (const r of data.results || []) {
        const region = [r.admin1, r.admin2].filter(Boolean).join(' · ');
        add(r.name, [region, r.country].filter(Boolean).join(' · '), r.latitude, r.longitude, 'Open-Meteo');
      }
    }
  } catch (e) { /* 单源失败不影响整体 */ }

  // 2) Nominatim：POI 级（景区/地标等），遵守限速
  const now = Date.now();
  if (now - lastNominatimTs >= 1100) {
    lastNominatimTs = now;
    try {
      const url = new URL(NOMINATIM_API);
      url.searchParams.set('q', q);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '5');
      const resp = await fetch(url.toString(), { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } });
      if (resp.ok) {
        const data = await resp.json();
        for (const r of data) {
          add(r.name || r.display_name.split(',')[0], r.display_name, Number(r.lat), Number(r.lon), 'OpenStreetMap');
        }
      }
    } catch (e) { /* 忽略 */ }
  }
  return items;
}

function showSearchDropdown(items) {
  const dd = $('#loc-search-dropdown');
  dd._items = items;
  if (!items.length) {
    dd.innerHTML = '<div class="sug-empty">未找到匹配地点，请尝试其他名称或直接输入经纬度</div>';
    dd.classList.remove('hidden');
    return;
  }
  dd.innerHTML = items.map((it, i) => `
    <button type="button" class="sug" data-i="${i}">
      <span class="sug-name">${escapeHtml(it.name)} <em class="sug-src">${escapeHtml(it.src)}</em></span>
      <span class="sug-sub">${escapeHtml(it.sub)}</span>
    </button>`).join('');
  dd.querySelectorAll('.sug').forEach(btn => {
    btn.addEventListener('click', () => fillFromSearch(items[Number(btn.dataset.i)]));
  });
  dd.classList.remove('hidden');
}

/* 选中候选 → 自动填充地点名称 + 经纬度输入框 */
function fillFromSearch(item) {
  $('#loc-name').value = item.name;
  $('#loc-coord').value = `${item.lat.toFixed(5)}, ${item.lon.toFixed(5)}`;
  $('#loc-search').value = '';
  $('#loc-search-dropdown').classList.add('hidden');
  setHint(`已填入「${item.name}」（${item.src}，${formatCoord(item.lat, item.lon)}），可修改后保存`, 'ok');
  $('#loc-name').focus();
}

/* ===== 查询：Open-Meteo ===== */
async function fetchWeather(loc, days) {
  const url = new URL(API_BASE);
  url.searchParams.set('latitude', String(loc.lat));
  url.searchParams.set('longitude', String(loc.lon));
  url.searchParams.set('hourly', 'temperature_2m,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,weather_code,visibility,relative_humidity_2m,wind_speed_10m');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', String(days));
  url.searchParams.set('temperature_unit', 'celsius');

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json();
  if (data.error) throw new Error(data.reason || 'Open-Meteo 返回错误');
  return data;
}

/* ===== 查询：Open-Meteo 空气质量（逐小时，最多 7 天） ===== */
async function fetchAirQuality(loc, days) {
  const url = new URL(AQI_API_BASE);
  url.searchParams.set('latitude', String(loc.lat));
  url.searchParams.set('longitude', String(loc.lon));
  url.searchParams.set('hourly', 'pm2_5,pm10,dust,aerosol_optical_depth');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', String(days));

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    throw new Error(`空气质量 HTTP ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json();
  if (data.error) throw new Error(data.reason || '空气质量 API 返回错误');
  return data;
}

/* ===== 查询：wttr.in（j1 JSON，最多 3 天） ===== */
async function fetchWttr(loc) {
  const url = `${WTTTR_BASE}/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}?format=j1&lang=zh`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`wttr.in HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (!data.weather) throw new Error('wttr.in 返回数据异常');
  return data;
}

/* "06:34 AM" → "2026-08-18T06:34" */
function toIsoHour(date, hhmmampm) {
  if (!hhmmampm) return '';
  const m = String(hhmmampm).match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return '';
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return `${date}T${String(h).padStart(2, '0')}:${m[2]}`;
}

/* WWO 天气文本 → [中文, emoji] */
function wwoText(text) {
  for (const [re, kv] of WWO_TEXT_RULES) {
    if (re.test(text)) return kv;
  }
  return [text || '未知', '❓'];
}

/* 由日出/日落时刻计算该时段覆盖的小时集合（±1 小时） */
function hoursAround(isoTime) {
  if (!isoTime) return [];
  const h = Number(isoTime.slice(11, 13));
  return [h - 1, h, h + 1].filter(x => x >= 0 && x <= 23);
}

/**
 * 把 Open-Meteo 原始数据按「日期 × 时段」聚合成表格行。
 * @returns {Array<{date:string, weekday:string, today:boolean, sunrise:string, sunset:string, periods:Object}>}
 */
function aggregate(data, periods, opts) {
  const { todayStr, aqiHourly } = opts;
  const hourly = data.hourly;
  const daily = data.daily;
  const byDate = {};

  for (let i = 0; i < daily.time.length; i++) {
    const date = daily.time[i];
    const row = {
      date,
      today: date === todayStr,
      weekday: weekdayName(date),
      sunrise: daily.sunrise[i] || '',
      sunset: daily.sunset[i] || '',
      periods: {},
    };
    for (const p of periods) {
      const hours = periodHours(p, row.sunrise, row.sunset);
      const temps = [], clouds = [], cloudsHi = [], cloudsMid = [], cloudsLow = [], precips = [], codes = [];
      const visibs = [], humis = [], winds = [];
      const pm25s = [], pm10s = [], dusts = [], aods = [];
      for (let j = 0; j < hourly.time.length; j++) {
        const t = hourly.time[j];
        if (!t.startsWith(date)) continue;
        const hh = Number(t.slice(11, 13));
        if (hours.includes(hh)) {
          temps.push(hourly.temperature_2m[j]);
          if (hourly.cloud_cover[j] !== null) clouds.push(hourly.cloud_cover[j]);
          if (hourly.cloud_cover_low[j] !== null) cloudsLow.push(hourly.cloud_cover_low[j]);
          if (hourly.cloud_cover_mid[j] !== null) cloudsMid.push(hourly.cloud_cover_mid[j]);
          if (hourly.cloud_cover_high[j] !== null) cloudsHi.push(hourly.cloud_cover_high[j]);
          if (hourly.precipitation_probability[j] !== null) precips.push(hourly.precipitation_probability[j]);
          codes.push(hourly.weather_code[j]);
          // 通透度相关字段（API 不返回时为 undefined）
          if (hourly.visibility) {
            const v = hourly.visibility[j];
            if (Number.isFinite(v)) visibs.push(v);
          }
          if (hourly.relative_humidity_2m) {
            const h = hourly.relative_humidity_2m[j];
            if (Number.isFinite(h)) humis.push(h);
          }
          if (hourly.wind_speed_10m) {
            const w = hourly.wind_speed_10m[j];
            if (Number.isFinite(w)) winds.push(w);
          }
        }
      }
      // 空气质量字段：按小时对齐（两 API 均返回带 timezone=auto 的 ISO 小时串）
      if (aqiHourly && aqiHourly.time) {
        for (let j = 0; j < aqiHourly.time.length; j++) {
          const t = aqiHourly.time[j];
          if (!t.startsWith(date)) continue;
          const hh = Number(t.slice(11, 13));
          if (hours.includes(hh)) {
            const v = aqiHourly.pm2_5 && aqiHourly.pm2_5[j];
            if (Number.isFinite(v)) pm25s.push(v);
            const v10 = aqiHourly.pm10 && aqiHourly.pm10[j];
            if (Number.isFinite(v10)) pm10s.push(v10);
            const d = aqiHourly.dust && aqiHourly.dust[j];
            if (Number.isFinite(d)) dusts.push(d);
            const a = aqiHourly.aerosol_optical_depth && aqiHourly.aerosol_optical_depth[j];
            if (Number.isFinite(a)) aods.push(a);
          }
        }
      }
      if (temps.length) {
        const code = mode(codes) ?? 0;
        const [wtxt, wemoji] = WMO[code] || ['未知', '❓'];
        row.periods[p.id] = {
          temp: avg(temps),
          cloud: Math.round(avg(clouds) ?? 0),
          cloudHi: Math.round(avg(cloudsHi) ?? 0),
          cloudMid: Math.round(avg(cloudsMid) ?? 0),
          cloudLow: Math.round(avg(cloudsLow) ?? 0),
          precip: Math.round(avg(precips) ?? 0),
          code, wtxt, wemoji,
          // 通透度原始小时均值（用于后续 VisScore）
          visibility: visibs.length ? avg(visibs) : null,
          humidity: humis.length ? avg(humis) : null,
          windSpeed: winds.length ? avg(winds) : null,
          pm25: pm25s.length ? avg(pm25s) : null,
          pm10: pm10s.length ? avg(pm10s) : null,
          dust: dusts.length ? avg(dusts) : null,
          aod: aods.length ? avg(aods) : null,
        };
      }
    }
    byDate[date] = row;
  }
  return Object.values(byDate);
}

/**
 * 把 wttr.in j1 数据按「日期 × 时段」聚合（结构同 aggregate 输出）。
 * hourly.time 为 "0"~"2100"（3 小时间隔），降水用 chanceofrain。
 */
function aggregateWttr(data, periods, todayStr) {
  const byDate = {};
  for (const day of data.weather || []) {
    const date = day.date;
    const astro = (day.astronomy && day.astronomy[0]) || {};
    const sunrise = toIsoHour(date, astro.sunrise);
    const sunset = toIsoHour(date, astro.sunset);
    const row = {
      date,
      today: date === todayStr,
      weekday: weekdayName(date),
      sunrise, sunset,
      periods: {},
    };

    for (const p of periods) {
      const hours = periodHours(p, sunrise, sunset);
      const temps = [], clouds = [], precips = [], texts = [];
      for (const h of day.hourly || []) {
        const hh = Math.round(Number(h.time) / 100); // "1800" → 18
        if (hours.includes(hh)) {
          temps.push(Number(h.tempC));
          if (h.cloudcover !== undefined) clouds.push(Number(h.cloudcover));
          if (h.chanceofrain !== undefined) precips.push(Number(h.chanceofrain));
          if (h.weatherDesc && h.weatherDesc[0]) texts.push(h.weatherDesc[0].value);
        }
      }
      if (temps.length) {
        const [wtxt, wemoji] = wwoText(texts.join(' '));
        row.periods[p.id] = {
          temp: avg(temps),
          cloud: Math.round(avg(clouds) ?? 0),
          precip: Math.round(avg(precips) ?? 0),
          code: -1, wtxt, wemoji,
        };
      }
    }
    byDate[date] = row;
  }
  return Object.values(byDate);
}

function periodHours(p, sunrise, sunset) {
  if (p.id === 'sunrise') return hoursAround(sunrise);
  if (p.id === 'sunset') return hoursAround(sunset);
  return p.hours;
}

/* ===== 通透度指数 VisScore（0-100）=====
 * 综合六维因素，按丹霞地貌"远眺 + 色彩 + 夕照"优化权重。
 * 输入为按时段聚合的小时均值；子项缺失则按"中性 75 分"近似，避免过度扣分。
 */
function pieceLinear(x, points) {
  if (x == null || !Number.isFinite(x)) return null;
  for (let i = 0; i < points.length; i++) {
    const [x1, x2, s1, s2] = points[i];
    if (x <= x1) return s1;
    if (x < x2) return s1 + (s2 - s1) * (x - x1) / (x2 - x1);
  }
  return points[points.length - 1][3];
}

function scoreAerosol(p) {
  const subs = [];
  // PM2.5 国标 24h 一级 35、二级 75
  const pm25 = pieceLinear(p.pm25, [[0, 35, 100, 80], [35, 75, 80, 50], [75, 115, 50, 25], [115, 150, 25, 10], [150, 250, 10, 0]]);
  if (pm25 != null) subs.push(pm25);
  // PM10
  const pm10 = pieceLinear(p.pm10, [[0, 50, 100, 85], [50, 150, 85, 55], [150, 250, 55, 25], [250, 350, 25, 10], [350, 500, 10, 0]]);
  if (pm10 != null) subs.push(pm10);
  // 沙尘（西北地区关键）
  const dust = pieceLinear(p.dust, [[0, 1, 100, 95], [1, 30, 95, 70], [30, 100, 70, 35], [100, 250, 35, 5], [250, 1e9, 5, 0]]);
  if (dust != null) subs.push(dust);
  // AOD
  const aod = pieceLinear(p.aod, [[0, 0.1, 100, 90], [0.1, 0.3, 90, 70], [0.3, 0.5, 70, 45], [0.5, 1.0, 45, 15], [1.0, 3.0, 15, 0]]);
  if (aod != null) subs.push(aod);
  if (!subs.length) return 75;
  // 取短板（最低分），符合"最差因子决定通透度"的物理直觉
  return Math.min(...subs);
}

function scoreVisibility(v) {
  if (v == null || !Number.isFinite(v)) return 75;
  // v 单位 m
  const km = v / 1000;
  if (km >= 30) return 100;
  if (km >= 20) return 95;
  if (km >= 15) return 88;
  if (km >= 10) return 75;
  if (km >= 5) return 50;
  if (km >= 2) return 25;
  if (km >= 1) return 10;
  return 0;
}

function scoreCloud(period) {
  const total = period.cloud;
  const low = period.cloudLow;
  // 低云权重 0.6、总云 0.4（低云更影响远眺）
  let totalScore = null, lowScore = null;
  if (total != null) {
    totalScore = pieceLinear(total, [[0, 20, 100, 92], [20, 50, 92, 70], [50, 75, 70, 40], [75, 100, 40, 5]]);
  }
  if (low != null) {
    lowScore = pieceLinear(low, [[0, 15, 100, 85], [15, 40, 85, 55], [40, 70, 55, 25], [70, 100, 25, 0]]);
  }
  const w = [lowScore, totalScore];
  const wts = [0.6, 0.4];
  let sum = 0, totalWt = 0;
  for (let i = 0; i < w.length; i++) {
    if (w[i] != null) { sum += w[i] * wts[i]; totalWt += wts[i]; }
  }
  if (totalWt === 0) return 75;
  return sum / totalWt;
}

function scoreHumidity(h) {
  if (h == null || !Number.isFinite(h)) return 75;
  // 最佳区间 30-60%；偏离扣分
  if (h >= 30 && h <= 60) return 100;
  if (h >= 20 && h < 30) return 85;
  if (h > 60 && h <= 75) return 80;
  if (h >= 10 && h < 20) return 55; // 干燥扬尘
  if (h > 75 && h <= 85) return 40;
  if (h > 85 && h <= 95) return 15; // 雾
  if (h > 95) return 0;
  if (h < 10) return 30;
  return 50;
}

function scoreWind(w) {
  if (w == null || !Number.isFinite(w)) return 75;
  // km/h；张掖等西北地区 5-15 最佳；过强扬尘
  if (w >= 5 && w <= 15) return 100;
  if (w >= 3 && w < 5) return 85;
  if (w > 15 && w <= 25) return 85;
  if (w > 25 && w <= 40) return 55;
  if (w > 40) return 25;
  if (w < 3) return 70; // 静稳易积累污染物
  return 70;
}

function scorePrecip(p) {
  return pieceLinear(p.precip, [[0, 5, 100, 95], [5, 20, 95, 75], [20, 40, 75, 50], [40, 60, 50, 25], [60, 80, 25, 8], [80, 100, 8, 0]]);
}

/* 综合 VisScore
 * @param p 按时段聚合的指标对象（含 visibility/humidity/windSpeed/pm25/pm10/dust/aod/cloud/cloudLow/precip）
 * @param periodId 'sunrise'|'sunset'|其他
 */
function visScore(p, periodId) {
  const dims = {
    aerosol: scoreAerosol(p),
    visibility: scoreVisibility(p.visibility),
    cloud: scoreCloud(p),
    humidity: scoreHumidity(p.humidity),
    wind: scoreWind(p.windSpeed),
    precip: scorePrecip(p.precip),
  };
  // 日出/夕阳：气溶胶和云量更影响远眺与色彩，权重加大
  const isGolden = periodId === 'sunrise' || periodId === 'sunset';
  const w = isGolden
    ? { aerosol: 0.35, visibility: 0.15, cloud: 0.25, humidity: 0.10, wind: 0.08, precip: 0.07 }
    : { aerosol: 0.30, visibility: 0.20, cloud: 0.20, humidity: 0.10, wind: 0.10, precip: 0.10 };
  let score = 0;
  for (const k of Object.keys(w)) score += dims[k] * w[k];
  return { score: Math.round(score), dims };
}

function visLevel(score) {
  if (score >= 90) return { label: '极佳', icon: '✨', desc: '通透如镜，丹霞色彩饱和、远景清晰' };
  if (score >= 75) return { label: '优', icon: '👍', desc: '通透良好，观赏体验佳' };
  if (score >= 60) return { label: '良', icon: '✓', desc: '基本通透，色彩略受影响' };
  if (score >= 40) return { label: '一般', icon: '⚠️', desc: '通透度有限，建议慎重' };
  if (score >= 20) return { label: '较差', icon: '❌', desc: '不推荐观赏' };
  return { label: '极差', icon: '⛔', desc: '沙尘/雾/雨雪，不宜出游' };
}

function visColor(score) {
  if (score >= 90) return '#059669'; // 深绿
  if (score >= 75) return '#16a34a'; // 绿
  if (score >= 60) return '#facc15'; // 黄
  if (score >= 40) return '#f97316'; // 橙
  if (score >= 20) return '#ef4444'; // 红
  return '#7e0023';
}

function weekdayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}

/* 本地时区的"今天"日期（YYYY-MM-DD），避免 UTC 偏差 */
function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ===== 渲染 ===== */
function renderChips() {
  const list = $('#loc-list');
  const tpl = $('#loc-chip-tpl');
  list.innerHTML = '';

  locations.forEach((loc, i) => {
    const node = tpl.content.cloneNode(true);
    const label = node.querySelector('.chip');
    node.querySelector('.chip-name').textContent = loc.name;
    node.querySelector('.chip-coord').textContent =
      `${formatCoord(loc.lat, loc.lon)}${loc.note ? ' · ' + loc.note : ''}`;
    label.querySelector('.chip-check').checked = true;
    label.querySelector('.chip-check').dataset.idx = String(i);
    label.querySelector('.chip-del').dataset.idx = String(i);
    label.querySelector('.chip-fill').dataset.idx = String(i);
    label.addEventListener('click', (e) => {
      if (e.target.closest('.chip-del') || e.target.closest('.chip-fill')) return;
      const cb = label.querySelector('.chip-check');
      cb.checked = !cb.checked;
      label.classList.toggle('checked', cb.checked);
    });
    list.appendChild(node);
  });
}

function setHint(msg, kind) {
  const el = $('#loc-hint');
  el.textContent = msg;
  el.className = 'hint' + (kind ? ' ' + kind : '');
}

function renderResults(cards) {
  const box = $('#results');
  box.innerHTML = '';
  if (!cards.length) {
    box.innerHTML = '<div class="empty">请选择至少一个地点后查询</div>';
    return;
  }
  cards.forEach(card => box.appendChild(card));
}

/* 渲染单元格内的单源数据块 */
function renderCellBlock(cell, opts) {
  const { badge, multi, periodId } = opts;
  const cloudCls = cell.cloud >= 75 ? ' class="cloud-hi"' : '';
  const badgeHtml = multi ? `<span class="src-badge">${escapeHtml(badge)}</span>` : '';
  const layers = (cell.cloudHi !== undefined)
    ? `<div class="cloud-layers" title="高云 / 中云 / 低云">高${cell.cloudHi} 中${cell.cloudMid} 低${cell.cloudLow}</div>`
    : '';
  // 通透度 VisScore（仅 Open-Meteo 源提供 visibility 等字段）
  let visHtml = '';
  if (cell.visibility != null) {
    const { score } = visScore(cell, periodId);
    const lv = visLevel(score);
    const color = visColor(score);
    visHtml = `<div class="vis-cell" title="通透度 VisScore ${score}（${lv.desc}）"><span class="vis-badge" style="background:${color}">通透 ${score}</span><span class="vis-cell-lv">${lv.icon}${escapeHtml(lv.label)}</span></div>`;
  }
  return (
    `<div class="wemoji">${cell.wemoji}</div>` +
    `${badgeHtml}` +
    `<div class="wtxt">${escapeHtml(cell.wtxt)}</div>` +
    `<div class="t">${cell.temp.toFixed(1)}°C</div>` +
    `<div class="cloud"${cloudCls}>云 ${cell.cloud}%（${cloudLevel(cell.cloud)}）</div>` +
    `${layers}` +
    `<div class="precip">☔ ${cell.precip}%</div>` +
    `${visHtml}`
  );
}

/**
 * 渲染一个地点卡片。
 * @param loc 地点
 * @param sources [{key, label, rows}] 各数据源的聚合行
 * @param periods 选中的时段
 * @param todayStr 今天日期
 */
function buildCard(loc, sources, periods, todayStr) {
  const primary = sources[0];
  const rows = primary.rows;
  const multi = sources.length > 1;
  const rowsByDate = Object.fromEntries(sources.map(s => [s.key, new Map(s.rows.map(r => [r.date, r]))]));
  const dateList = rows.map(r => r.date);
  const hasWttr = sources.some(s => s.key === 'wttr');

  const card = document.createElement('div');
  card.className = 'loc-card';

  const head = document.createElement('div');
  head.className = 'loc-card-head';
  const h3 = document.createElement('h3');
  h3.textContent = loc.name + (loc.note ? `（${loc.note}）` : '');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const coordEl = document.createElement('span');
  coordEl.textContent = formatCoord(loc.lat, loc.lon);
  meta.appendChild(coordEl);
  const sr = document.createElement('span');
  sr.className = 'sr';
  sr.textContent = dateList.length
    ? `日出 ${formatTime(rows[0].sunrise)} · 日落 ${formatTime(rows[0].sunset)}（当地时间）${multi ? ' · ' + sources.map(s => s.label).join(' + ') : ''}`
    : '';
  meta.appendChild(sr);
  head.append(h3, meta);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'loc-card-body';
  const table = document.createElement('table');
  table.className = 'forecast';

  const thead = document.createElement('thead');
  const trH = document.createElement('tr');
  const th0 = document.createElement('th');
  th0.className = 'period';
  th0.textContent = '时段 \\ 日期';
  trH.appendChild(th0);
  rows.forEach(r => {
    const th = document.createElement('th');
    th.textContent = `${r.date.slice(5)} ${r.weekday}`;
    if (r.today) th.style.color = 'var(--accent)';
    trH.appendChild(th);
  });
  thead.appendChild(trH);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  periods.forEach(p => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.className = 'period';
    th.textContent = p.label;
    tr.appendChild(th);

    rows.forEach(r => {
      const td = document.createElement('td');
      td.className = 'cell' + (r.today ? ' today' : '');
      const blocks = sources.map(s => {
        const row = rowsByDate[s.key].get(r.date);
        const cell = row && row.periods[p.id];
        return cell ? renderCellBlock(cell, { badge: s.label, multi, periodId: p.id }) : null;
      }).filter(Boolean);

      if (!blocks.length) {
        td.innerHTML = '<span class="wtxt" style="color:var(--ink-soft)">—</span>';
      } else {
        td.innerHTML = blocks.join(multi ? '<div class="src-div"></div>' : '');
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  body.appendChild(table);
  card.appendChild(body);

  /* 通透度指数 VisScore + 出游推荐（仅 Open-Meteo） */
  const om = sources.find(s => s.key === 'open-meteo');
  if (om && om.rows && om.rows.length) {
    renderVisibility(card, om.rows, periods);
  }

  /* 逐小时趋势图（仅 Open-Meteo 提供完整逐小时 + 云量分层数据） */
  if (om && om.raw && om.raw.time && om.raw.time.length) {
    const chartWrap = document.createElement('div');
    chartWrap.className = 'chart-wrap';
    const h4 = document.createElement('h4');
    h4.textContent = '📈 逐小时趋势（Open-Meteo）';
    chartWrap.appendChild(h4);
    card.appendChild(chartWrap);
    renderChart(chartWrap, om.raw);
  }

  const legend = document.createElement('div');
  legend.className = 'legend';
  const srcNote = multi
    ? `上方为 Open-Meteo，下方为 wttr.in（WWO 模型），两者一致说明置信度高，分歧大则需谨慎。`
    : `数据源：${sources.map(s => s.label).join('、')}。`;
  legend.innerHTML =
    `云量 <b>≥75%</b> 高亮为<b>阴天</b>；温度/降水概率取时段平均；日出/夕阳时段为天文时刻 ±1 小时。${srcNote}` +
    (dateList.length ? `首日日出 ${formatTime(rows[0].sunrise)} / 日落 ${formatTime(rows[0].sunset)}。` : '') +
    (hasWttr ? ' wttr.in 逐小时为 3 小时粒度。' : '');
  card.appendChild(legend);

  return card;
}

/* 渲染「通透度分析 + 出游推荐」区块（各时段 VisScore 已内嵌到单元格，这里只做汇总） */
function renderVisibility(card, rows, periods) {
  if (!rows || !rows.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'vis-wrap';

  const dimLabels = [
    ['aerosol', '气溶胶', 'PM2.5/PM10/沙尘/AOD'],
    ['visibility', '能见度', 'visibility (m)'],
    ['cloud', '云量', '低云 / 总云'],
    ['humidity', '湿度', '相对湿度'],
    ['wind', '风速', 'wind_speed_10m'],
    ['precip', '降水', '降水概率'],
  ];

  // 找出全表最优时段（用于"最佳观赏窗口"）
  let bestCell = null;
  rows.forEach(r => {
    periods.forEach(p => {
      const period = r.periods[p.id];
      if (!period || period.visibility == null) return;
      const { score } = visScore(period, p.id);
      if (!bestCell || score > bestCell.score) {
        const lv = visLevel(score);
        bestCell = { score, label: lv.label, icon: lv.icon, desc: lv.desc, date: r.date, periodLabel: p.label };
      }
    });
  });

  // 维度构成（展示今天的全日均值）
  const todayRow = rows.find(r => r.today) || rows[0];
  let dimsHtml = '';
  if (todayRow) {
    const fullDayAvg = avgPeriodMetrics(todayRow, periods);
    dimsHtml = `
      <div class="vis-dims">
        <div class="vis-dims-head">📐 ${escapeHtml(todayRow.date)} 通透度维度构成（全日）</div>
        <div class="vis-dims-grid">
          ${dimLabels.map(([k, label, hint]) => {
            const v = (() => {
              switch (k) {
                case 'aerosol': return scoreAerosol(fullDayAvg);
                case 'visibility': return scoreVisibility(fullDayAvg.visibility);
                case 'cloud': return scoreCloud(fullDayAvg);
                case 'humidity': return scoreHumidity(fullDayAvg.humidity);
                case 'wind': return scoreWind(fullDayAvg.windSpeed);
                case 'precip': return scorePrecip(fullDayAvg.precip);
              }
            })();
            return `<div class="vis-dim"><div class="vis-dim-bar"><i style="width:${Math.round(v)}%;background:${visColor(v)}"></i></div><div class="vis-dim-meta"><b>${escapeHtml(label)}</b> <span>${Math.round(v)}</span><em>${escapeHtml(hint)}</em></div></div>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  // 出游推荐卡（基于全表最佳）
  let recHtml = '';
  if (bestCell) {
    const lv = visLevel(bestCell.score);
    const tone = bestCell.score >= 75 ? 'ok' : bestCell.score >= 60 ? 'warn' : 'err';
    recHtml = `
      <div class="vis-rec vis-rec-${tone}">
        <div class="vis-rec-icon">${lv.icon}</div>
        <div class="vis-rec-body">
          <div class="vis-rec-title">最佳观赏窗口：${escapeHtml(bestCell.date)} ${escapeHtml(bestCell.periodLabel)}（VisScore ${bestCell.score}）</div>
          <div class="vis-rec-desc">${escapeHtml(lv.desc)}</div>
        </div>
        <div class="vis-rec-tag">${escapeHtml(lv.label)}</div>
      </div>
    `;
  }

  wrap.innerHTML = `
    <h4>🌄 通透度分析 & 出游推荐</h4>
    ${dimsHtml}
    ${recHtml}
    <div class="vis-legend">每个时段的「通透 N」分值已显示在上方天气表中；数值越高越通透。VisScore 综合气溶胶（PM2.5/PM10/沙尘/AOD）、能见度、云量、湿度、风速、降水六维度；日出/夕阳时段加大气溶胶与云量权重。</div>
  `;
  card.appendChild(wrap);
}

/* 把一整天所有时段的小时均值再聚合一次（用于"全日维度构成"） */
function avgPeriodMetrics(dayRow, periods) {
  const fields = ['visibility', 'humidity', 'windSpeed', 'pm25', 'pm10', 'dust', 'aod',
                  'cloud', 'cloudLow', 'precip'];
  const acc = {};
  const cnt = {};
  for (const p of periods) {
    const period = dayRow.periods[p.id];
    if (!period) continue;
    for (const f of fields) {
      const v = period[f];
      if (v != null && Number.isFinite(v)) {
        acc[f] = (acc[f] || 0) + v;
        cnt[f] = (cnt[f] || 0) + 1;
      }
    }
  }
  const out = {};
  for (const f of fields) {
    out[f] = cnt[f] ? acc[f] / cnt[f] : null;
  }
  return out;
}

/* ISO "2026-08-18T06:34" → "06:34"；空则返回 "—" */
function formatTime(iso) {
  return iso ? iso.slice(11, 16) : '—';
}

/* ===== 逐小时趋势图（零依赖 SVG 折线图） ===== */

/* 生成"好看"的刻度序列，如 [-5, 0, 5, ...] */
function niceTicks(min, max, count) {
  const span = max - min;
  if (!(span > 0)) return [Math.round(min * 10) / 10, Math.round(max * 10) / 10];
  const mag = Math.pow(10, Math.floor(Math.log10(span / count)));
  const norm = (span / count) / mag;
  const step = ([1, 2, 2.5, 5, 10].find(s => s >= norm) || 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    ticks.push(Math.round(v * 10) / 10);
  }
  return ticks;
}

/**
 * 渲染逐小时趋势图（上下双图，共享时间轴）：
 *  - 上图：气温折线（左轴 °C）+ 降水概率柱状（右轴 %）
 *  - 下图：云层热力剖面——高 / 中 / 低三行色带，深浅 = 覆盖率
 *  - 悬停任一图的时刻，双图同步高亮并显示全部数值浮层
 * @param container 已包含 <h4> 标题的容器元素
 * @param hourly Open-Meteo hourly 原始数据
 */
function renderChart(container, hourly) {
  const time = hourly.time || [];
  const temp = hourly.temperature_2m || [];
  const precip = hourly.precipitation_probability || [];
  const ccLow = hourly.cloud_cover_low || [];
  const ccMid = hourly.cloud_cover_mid || [];
  const ccHigh = hourly.cloud_cover_high || [];
  const n = time.length;
  if (n < 2) return;

  // 降采样：16 天共 384 小时，限制 ≤128 个点避免过密
  const MAX_POINTS = 128;
  const step = Math.max(1, Math.ceil(n / MAX_POINTS));
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);

  // —— 共享几何 ——
  const W = 960, mL = 48, mR = 48;
  const pw = W - mL - mR;
  const X = (k) => mL + (k / (idx.length - 1)) * pw;
  const hotW = pw / (idx.length - 1);
  const fmtTime = (iso) => {
    const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):00/);
    return m ? `${m[1].slice(5)} ${m[2]}:00` : String(iso);
  };
  const labelEvery = Math.ceil(idx.length / 10);

  // —— 上图：温度 + 降水 ——
  const H1 = 200, mT1 = 16, mB1 = 26;
  const ph1 = H1 - mT1 - mB1;
  const temps = idx.map(i => temp[i]).filter(Number.isFinite);
  let tMin = Math.min.apply(null, temps);
  let tMax = Math.max.apply(null, temps);
  if (!Number.isFinite(tMin)) { tMin = 0; tMax = 30; }
  const pad = Math.max(2, (tMax - tMin) * 0.15);
  tMin -= pad;
  tMax += pad;
  const Yt = (v) => mT1 + ph1 - ((v - tMin) / (tMax - tMin)) * ph1;
  const Yp = (v) => mT1 + ph1 - (v / 100) * ph1;
  const tTicks = niceTicks(tMin, tMax, 5);
  const pTicks = [0, 25, 50, 75, 100];

  let inner1 = '';
  // 网格线 + 右轴（降水 %）
  for (const v of pTicks) {
    const y = Yp(v).toFixed(1);
    inner1 += `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" class="grid-line"/>`;
    inner1 += `<text x="${W - mR + 6}" y="${(Number(y) + 4).toFixed(1)}" class="axis-text">${v}%</text>`;
  }
  // 左轴（温度刻度文本）
  for (const v of tTicks) {
    inner1 += `<text x="${mL - 8}" y="${(Yt(v) + 4).toFixed(1)}" class="axis-text" text-anchor="end">${v}°</text>`;
  }
  // 轴名
  inner1 += `<text x="${mL - 16}" y="${mT1 + 4}" class="axis-text" text-anchor="middle">°C</text>`;
  inner1 += `<text x="${W - mR + 16}" y="${mT1 + 4}" class="axis-text" text-anchor="middle">%</text>`;
  // 每天 00:00 分隔虚线
  for (let k = 0; k < idx.length; k++) {
    if (idx[k] % 24 === 0) {
      const x = X(k).toFixed(1);
      inner1 += `<line x1="${x}" y1="${mT1}" x2="${x}" y2="${H1 - mB1}" class="day-line"/>`;
    }
  }
  // 降水概率柱状
  for (let k = 0; k < idx.length; k++) {
    const v = precip[idx[k]];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const bw = Math.max(2, hotW * 0.5);
    const x = X(k) - bw / 2;
    const y1 = Yp(Math.min(Math.max(v, 0), 100));
    inner1 += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${(Yp(0) - y1).toFixed(1)}" class="precip-bar"/>`;
  }
  // 气温折线（跳过 null，断线处理）
  let d = '', pen = false;
  for (let k = 0; k < idx.length; k++) {
    const v = temp[idx[k]];
    if (v === null || v === undefined || !Number.isFinite(v)) { pen = false; continue; }
    d += (pen ? ' L' : ' M') + X(k).toFixed(1) + ' ' + Yt(v).toFixed(1);
    pen = true;
  }
  if (d) {
    inner1 += `<path d="${d}" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  // 高亮竖线 + 悬停热区
  inner1 += `<rect y="${mT1}" height="${ph1}" width="${hotW.toFixed(1)}" class="vline"/>`;
  for (let k = 0; k < idx.length; k++) {
    inner1 += `<rect x="${(X(k) - hotW / 2).toFixed(1)}" y="${mT1}" width="${hotW.toFixed(1)}" height="${ph1}" class="hot" data-k="${k}"/>`;
  }

  // —— 下图：云层热力剖面 ——
  const layers = [
    { name: '高云', data: ccHigh, hue: 210, sat: 28 },
    { name: '中云', data: ccMid, hue: 265, sat: 62 },
    { name: '低云', data: ccLow, hue: 32, sat: 88 },
  ];
  const H2 = 150, mT2 = 8, mB2 = 26;
  const rowH = 32, rowGap = 6;
  const rowY = (li) => mT2 + li * (rowH + rowGap);

  let inner2 = '';
  // 层背景 + 左侧层名
  layers.forEach((L, li) => {
    const ry = rowY(li);
    inner2 += `<rect x="${mL}" y="${ry}" width="${pw}" height="${rowH}" class="layer-bg"/>`;
    inner2 += `<text x="${mL - 8}" y="${ry + rowH / 2 + 4}" class="axis-text" text-anchor="end">${L.name}</text>`;
  });
  // 每天 00:00 分隔虚线
  for (let k = 0; k < idx.length; k++) {
    if (idx[k] % 24 === 0) {
      const x = X(k).toFixed(1);
      inner2 += `<line x1="${x}" y1="${mT2}" x2="${x}" y2="${H2 - mB2}" class="day-line"/>`;
    }
  }
  // 热力格：深浅 = 覆盖率（86% 亮度 → 42%）
  for (let k = 0; k < idx.length; k++) {
    const x0 = X(k);
    const x1 = k < idx.length - 1 ? X(k + 1) : x0 + hotW;
    layers.forEach((L, li) => {
      const v = L.data[idx[k]];
      if (v === null || v === undefined || !Number.isFinite(v)) return;
      const light = 86 - (Math.min(Math.max(v, 0), 100) / 100) * 44;
      inner2 += `<rect x="${x0.toFixed(1)}" y="${rowY(li)}" width="${(x1 - x0 + 0.4).toFixed(1)}" height="${rowH}" fill="hsl(${L.hue}, ${L.sat}%, ${light.toFixed(0)}%)"/>`;
    });
  }
  // 高亮竖线 + 悬停热区
  inner2 += `<rect y="${mT2}" height="${H2 - mT2 - mB2}" width="${hotW.toFixed(1)}" class="vline"/>`;
  // X 轴时间标签（放下图）
  for (let k = 0; k < idx.length; k += labelEvery) {
    inner2 += `<text x="${X(k).toFixed(1)}" y="${H2 - mB2 + 16}" class="axis-text" text-anchor="middle">${fmtTime(time[idx[k]])}</text>`;
  }
  for (let k = 0; k < idx.length; k++) {
    inner2 += `<rect x="${(X(k) - hotW / 2).toFixed(1)}" y="${mT2}" width="${hotW.toFixed(1)}" height="${H2 - mT2 - mB2}" class="hot" data-k="${k}"/>`;
  }

  // —— 组装 ——
  const mkSvg = (inner, h, cls, label) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${h}`);
    svg.classList.add('trend', cls);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    svg.innerHTML = inner;
    return svg;
  };
  const svgTop = mkSvg(inner1, H1, 'trend-top', '气温折线与降水概率');
  const svgBottom = mkSvg(inner2, H2, 'trend-bottom', '高、中、低层云量热力剖面');

  // 图例
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML =
    '<span class="lg-item"><i class="lg-line" style="background:#ef4444"></i>气温</span>' +
    '<span class="lg-item"><i class="lg-bar" style="background:#2563eb"></i>降水概率</span>' +
    layers.map(L => `<span class="lg-item"><i class="lg-sq" style="background:hsl(${L.hue}, ${L.sat}%, 55%)"></i>${L.name}</span>`).join('') +
    '<span class="lg-item lg-tip">色块越深 = 覆盖率越高</span>';

  const tip = document.createElement('div');
  tip.className = 'chart-tip';

  container.append(legend, svgTop, svgBottom, tip);

  // —— 悬停联动 ——
  const vlines = container.querySelectorAll('.vline');
  const cRect = () => container.getBoundingClientRect();
  const seriesInfo = [
    { name: '气温', color: '#ef4444', v: i => temp[i], unit: '°C', digits: 1 },
    { name: '降水概率', color: '#2563eb', v: i => precip[i], unit: '%', digits: 0 },
    { name: '高云', color: 'hsl(210, 28%, 45%)', v: i => ccHigh[i], unit: '%', digits: 0 },
    { name: '中云', color: 'hsl(265, 62%, 45%)', v: i => ccMid[i], unit: '%', digits: 0 },
    { name: '低云', color: 'hsl(32, 88%, 45%)', v: i => ccLow[i], unit: '%', digits: 0 },
  ];

  const bindHover = (svg) => {
    svg.querySelectorAll('.hot').forEach(rect => {
      rect.addEventListener('mouseenter', () => {
        const k = Number(rect.dataset.k);
        const i = idx[k];
        // 双图同步高亮当前时刻
        vlines.forEach(vl => {
          vl.style.display = 'block';
          vl.setAttribute('x', (X(k) - hotW / 2).toFixed(1));
        });
        // 浮层
        const rows = seriesInfo.map(s => {
          const v = s.v(i);
          const str = (v === null || v === undefined || !Number.isFinite(v))
            ? '—'
            : (s.digits ? v.toFixed(s.digits) : Math.round(v)) + s.unit;
          return `<div class="tip-row"><i style="background:${s.color}"></i>${s.name}：${str}</div>`;
        }).join('');
        tip.innerHTML = `<div class="tip-time">${fmtTime(time[i])}</div>${rows}`;
        tip.style.display = 'block';

        const r = rect.getBoundingClientRect();
        const c = cRect();
        let left = r.left - c.left + r.width / 2;
        left = Math.max(4, Math.min(left, container.clientWidth - tip.offsetWidth - 4));
        tip.style.left = left + 'px';
        tip.style.top = (r.top - c.top - tip.offsetHeight - 10) + 'px';
        if (tip.offsetTop < 0) tip.style.top = (r.top - c.top + 10) + 'px';
      });
      rect.addEventListener('mouseleave', () => {
        tip.style.display = 'none';
        vlines.forEach(vl => { vl.style.display = 'none'; });
      });
    });
  };
  bindHover(svgTop);
  bindHover(svgBottom);
}

/* ===== 查询流程 ===== */
async function queryAll() {
  const days = Number($('#days').value);
  const selectedPeriods = PERIODS.filter(p =>
    $(`#periods input[value="${p.id}"]`).checked);

  const selectedIdx = [...document.querySelectorAll('#loc-list .chip-check')]
    .filter(cb => cb.checked)
    .map(cb => Number(cb.dataset.idx));

  const hint = $('#config-hint');
  if (!selectedIdx.length) {
    hint.textContent = '请至少勾选一个地点';
    hint.className = 'hint err';
    return;
  }
  if (!selectedPeriods.length) {
    hint.textContent = '请至少勾选一个时段';
    hint.className = 'hint err';
    return;
  }

  const source = document.querySelector('input[name="source"]:checked').value;
  let useOpen = source !== 'wttr';
  let useWttr = source !== 'open-meteo';

  // wttr.in 仅支持未来 3 天：N>3 时自动降级为仅 Open-Meteo
  if (useWttr && days > 3) {
    useWttr = false;
    useOpen = true;
    hint.textContent = `wttr.in 仅支持未来 3 天（当前 N=${days}），已自动仅用 Open-Meteo`;
    hint.className = 'hint';
  } else {
    hint.textContent = '';
    hint.className = 'hint';
  }

  const btn = $('#btn-query');
  btn.disabled = true;
  btn.textContent = '查询中…';

  const box = $('#results');
  box.innerHTML = '<div class="loading">⏳ 正在获取天气数据…</div>';

  const todayStr = localTodayStr();

  // 并行查询：多个地点之间、每个地点内的天气/空气质量/wttr 三路均并发，
  // 避免串行等待。单个地点失败不影响其他地点。
  const tasks = selectedIdx.map(async (idx) => {
    const loc = locations[idx];
    try {
      // 三路独立请求并发；未启用的源用 null 占位（Promise.all 会视为已 resolve）
      const pWeather = useOpen ? fetchWeather(loc, days) : null;
      const pAqi = useOpen
        ? fetchAirQuality(loc, Math.min(days, 7)).catch((e) => {
            console.warn(`空气质量数据获取失败（${loc.name}）：`, e);
            return null; // 空气质量失败仅降级，不影响天气
          })
        : null;
      const pWttr = useWttr ? fetchWttr(loc) : null;

      const [data, aqiData, wttrData] = await Promise.all([pWeather, pAqi, pWttr]);

      const sources = [];
      if (useOpen) {
        sources.push({
          key: 'open-meteo', label: 'Open-Meteo',
          rows: aggregate(data, selectedPeriods, { todayStr, aqiHourly: aqiData && aqiData.hourly }),
          raw: data.hourly,
        });
      }
      if (useWttr) {
        sources.push({ key: 'wttr', label: 'wttr.in', rows: aggregateWttr(wttrData, selectedPeriods, todayStr) });
      }
      return { card: buildCard(loc, sources, selectedPeriods, todayStr) };
    } catch (e) {
      return { error: `${loc.name}：${e.message}` };
    }
  });

  const results = await Promise.all(tasks);
  const cards = results.filter(r => r.card).map(r => r.card);
  const errors = results.filter(r => r.error).map(r => r.error);

  btn.disabled = false;
  btn.textContent = '查询天气';

  if (errors.length) {
    box.innerHTML = '';
    const errBox = document.createElement('div');
    errBox.className = 'error-box';
    errBox.textContent = '部分地点查询失败：' + errors.join('；');
    box.appendChild(errBox);
  }
  renderResults(cards);
}

/* ===== 事件绑定 ===== */
function init() {
  /* 守卫：关键元素缺失时直接跳过，避免后续 null 引用抛错 */
  if (!$('#loc-list') || !$('#loc-name') || !$('#btn-query') || !$('#results')) {
    console.warn('天气查询台：页面结构不完整，初始化已跳过');
    return;
  }
  renderChips();

  const days = $('#days');
  const daysVal = $('#days-val');
  const syncDays = () => { daysVal.textContent = days.value; };
  days.addEventListener('input', syncDays);
  syncDays();

  $('#btn-add').addEventListener('click', () => {
    const name = $('#loc-name').value.trim();
    const coordStr = $('#loc-coord').value.trim();
    if (!name) { setHint('请填写地点名称', 'err'); return; }
    const coord = parseCoord(coordStr);
    if (!coord) { setHint('经纬度格式无法识别（示例：38.91555, 100.1332）', 'err'); return; }
    if (coord.lat < -90 || coord.lat > 90 || coord.lon < -180 || coord.lon > 180) {
      setHint('经纬度超出合法范围（纬度 ±90，经度 ±180）', 'err'); return;
    }
    locations.push({ id: cryptoRandomId(), name, lat: coord.lat, lon: coord.lon });
    saveLocations();
    renderChips();
    $('#loc-name').value = '';
    $('#loc-coord').value = '';
    setHint(`已保存「${name}」（${formatCoord(coord.lat, coord.lon)}），已自动勾选，点击「查询天气」即可`, 'ok');
  });

  $('#loc-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-add').click(); });
  $('#loc-coord').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-add').click(); });

  // 地点搜索：防抖 400ms
  let searchTimer = null;
  $('#loc-search').addEventListener('input', () => {
    const q = $('#loc-search').value.trim();
    clearTimeout(searchTimer);
    if (q.length < 1) {
      $('#loc-search-dropdown').classList.add('hidden');
      return;
    }
    searchTimer = setTimeout(async () => {
      const items = await searchPlaces(q);
      showSearchDropdown(items);
    }, 400);
  });
  $('#loc-search').addEventListener('keydown', (e) => {
    const dd = $('#loc-search-dropdown');
    if (e.key === 'Enter') {
      if (!dd.classList.contains('hidden') && dd._items && dd._items.length) {
        e.preventDefault();
        fillFromSearch(dd._items[0]);
      }
    } else if (e.key === 'Escape') {
      dd.classList.add('hidden');
    }
  });
  // 点击页面其他区域收起下拉
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
      $('#loc-search-dropdown').classList.add('hidden');
    }
  });

  // 事件委托：删除 / 填入
  $('#loc-list').addEventListener('click', (e) => {
    const del = e.target.closest('.chip-del');
    const fill = e.target.closest('.chip-fill');
    if (del) {
      const idx = Number(del.dataset.idx);
      locations.splice(idx, 1);
      saveLocations();
      renderChips();
      setHint('地点已删除', '');
    } else if (fill) {
      const idx = Number(fill.dataset.idx);
      const loc = locations[idx];
      $('#loc-name').value = loc.name;
      $('#loc-coord').value = `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`;
      $('#loc-name').focus();
      setHint(`已填入「${loc.name}」，可修改后重新保存`, 'ok');
    }
  });

  $('#btn-query').addEventListener('click', queryAll);

  // Enter 快捷键
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
      queryAll();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
