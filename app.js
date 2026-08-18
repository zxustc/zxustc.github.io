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
  url.searchParams.set('hourly', 'temperature_2m,cloud_cover,precipitation_probability,weather_code');
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
function aggregate(data, periods, todayStr) {
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
      const temps = [], clouds = [], precips = [], codes = [];
      for (let j = 0; j < hourly.time.length; j++) {
        const t = hourly.time[j];
        if (!t.startsWith(date)) continue;
        const hh = Number(t.slice(11, 13));
        if (hours.includes(hh)) {
          temps.push(hourly.temperature_2m[j]);
          if (hourly.cloud_cover[j] !== null) clouds.push(hourly.cloud_cover[j]);
          if (hourly.precipitation_probability[j] !== null) precips.push(hourly.precipitation_probability[j]);
          codes.push(hourly.weather_code[j]);
        }
      }
      if (temps.length) {
        const code = mode(codes) ?? 0;
        const [wtxt, wemoji] = WMO[code] || ['未知', '❓'];
        row.periods[p.id] = {
          temp: avg(temps),
          cloud: Math.round(avg(clouds) ?? 0),
          precip: Math.round(avg(precips) ?? 0),
          code, wtxt, wemoji,
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
function renderCellBlock(cell, badge, multi) {
  const cloudCls = cell.cloud >= 75 ? ' class="cloud-hi"' : '';
  const badgeHtml = multi ? `<span class="src-badge">${escapeHtml(badge)}</span>` : '';
  return (
    `<div class="wemoji">${cell.wemoji}</div>` +
    `${badgeHtml}` +
    `<div class="wtxt">${escapeHtml(cell.wtxt)}</div>` +
    `<div class="t">${cell.temp.toFixed(1)}°C</div>` +
    `<div class="cloud"${cloudCls}>云 ${cell.cloud}%（${cloudLevel(cell.cloud)}）</div>` +
    `<div class="precip">☔ ${cell.precip}%</div>`
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
        return cell ? renderCellBlock(cell, s.label, multi) : null;
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

/* ISO "2026-08-18T06:34" → "06:34"；空则返回 "—" */
function formatTime(iso) {
  return iso ? iso.slice(11, 16) : '—';
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
  const cards = [];
  const errors = [];

  for (const idx of selectedIdx) {
    const loc = locations[idx];
    try {
      const sources = [];
      if (useOpen) {
        const data = await fetchWeather(loc, days);
        sources.push({ key: 'open-meteo', label: 'Open-Meteo', rows: aggregate(data, selectedPeriods, todayStr) });
      }
      if (useWttr) {
        const data = await fetchWttr(loc);
        sources.push({ key: 'wttr', label: 'wttr.in', rows: aggregateWttr(data, selectedPeriods, todayStr) });
      }
      cards.push(buildCard(loc, sources, selectedPeriods, todayStr));
    } catch (e) {
      errors.push(`${loc.name}：${e.message}`);
    }
  }

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
