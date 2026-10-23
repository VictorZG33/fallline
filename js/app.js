// Fall Line: wires the map, the panels and the settings together.
import * as maplibregl from '../vendor/maplibre-gl/maplibre-gl.mjs';
import { registerShadeProtocol, terrain } from './terrain-client.js';
import { buildStyle, applyView, setMasks, addContours, CLICKABLE } from './style.js';
import { SLOPE_BANDS, ASPECTS, slopeColor, aspectColor } from './terrain.js';
import { createPisteStore } from './pistes.js';
import { createInfo } from './info.js';
import { parseGpx, trackStore } from './gpx.js';
import { sunPosition, sunTimes } from './sun.js';
import { t, setLang, defaultLang, translatePage, getLang } from './i18n.js';
import * as fmt from './format.js';
import * as offline from './offline.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- Settings -------------------------------------------------------------------

const DEFAULTS = {
  basemap: 'satellite', overlay: 'slope', slopeMask: 0b1111111, aspectMask: 0b11111111,
  slopeOpacity: 0.6, aspectOpacity: 0.6, exaggeration: 1, pistes: true, labels: true, contours: true,
  units: null, lang: null,
};
function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
const settings = { ...DEFAULTS, ...load('fl.settings', {}) };
settings.lang ||= defaultLang();
settings.units ||= (navigator.language || '').toLowerCase() === 'en-us' ? 'ft' : 'm';
setLang(settings.lang);
fmt.setUnits(settings.units);
translatePage();

// ---- Map --------------------------------------------------------------------------

registerShadeProtocol(maplibregl);
const resorts = await fetch('data/resorts.json').then((r) => r.json()).catch(() => []);
const stowe = resorts.find((r) => r.slug === 'stowe');
// A shared link (#zoom/lat/lon/bearing/pitch) wins, then where you left off, then Stowe.
function viewFromHash() {
  const m = location.hash.slice(1).split('/').map(Number);
  if (m.length < 3 || m.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
  return { zoom: m[0], center: [m[2], m[1]], bearing: m[3] || 0, pitch: m[4] || 0 };
}
const startView = viewFromHash() || load('fl.view', null) || { center: stowe ? stowe.center : [-72.79, 44.53], zoom: 13.4, pitch: 62, bearing: stowe ? stowe.bearing : 290 };

const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(settings),
  ...startView,
  hash: true,
  maxPitch: 85,
  attributionControl: { compact: true },
  localIdeographFontFamily: '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  cancelPendingTileRequestsWhileZooming: true,
});
window.fallline = { map };

const scale = new maplibregl.ScaleControl({ unit: settings.units === 'ft' ? 'imperial' : 'metric' });
map.addControl(scale, 'bottom-right');
const geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true });
map.addControl(geolocate, 'top-right');

let saveViewTimer = 0;
map.on('moveend', () => {
  clearTimeout(saveViewTimer);
  saveViewTimer = setTimeout(() => {
    const c = map.getCenter();
    save('fl.view', { center: [+c.lng.toFixed(5), +c.lat.toFixed(5)], zoom: +map.getZoom().toFixed(2), pitch: Math.round(map.getPitch()), bearing: Math.round(map.getBearing()) });
  }, 500);
});

// ---- Ski area index (search and colour conventions) -----------------------------------

let index = null;
const indexReady = fetch('data/skiareas.json').then((r) => r.json()).then((d) => (index = d)).catch(() => (index = []));

const CONV = { n: 'north_america', j: 'japan', e: 'europe' };
const convCache = new Map();
function nearestConvention([lon, lat]) {
  const key = `${lon.toFixed(1)},${lat.toFixed(1)}`;
  if (convCache.has(key)) return convCache.get(key);
  let best = null, bestD = 0.6 ** 2;
  for (const e of index || []) {
    const d = (e[1] - lon) ** 2 * Math.cos((lat * Math.PI) / 180) ** 2 + (e[2] - lat) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  const conv = best ? CONV[best[9]] : lon < -30 ? 'north_america' : lon > 128.5 && lon < 146 && lat > 30 && lat < 46 ? 'japan' : 'europe';
  convCache.set(key, conv);
  return conv;
}

// ---- Pistes, tracks, info -------------------------------------------------------------

const status = $('#status');
function showStatus(text) {
  status.textContent = text || '';
  status.hidden = !text;
}

const pistes = createPisteStore(map, {
  resorts,
  nearestConvention,
  ready: indexReady,
  onStatus: (n) => showStatus(n > 0 ? t('status.pistes') : navigator.onLine ? '' : t('status.offline')),
});

let tracks = [];
function drawTracks() {
  map.getSource('tracks')?.setData({
    type: 'FeatureCollection',
    features: tracks.map((tr) => ({ type: 'Feature', properties: { id: tr.id }, geometry: { type: 'LineString', coordinates: tr.points.map((p) => [p[0], p[1]]) } })),
  });
  const list = $('#track-list');
  list.innerHTML = tracks.map((tr) => `<li><button type="button" class="track-item" data-id="${esc(tr.id)}"><i></i>${esc(tr.name)}</button></li>`).join('');
  $('#no-tracks').hidden = tracks.length > 0;
}

const info = createInfo({
  map,
  terrain,
  sheet: $('#sheet-info'),
  body: $('#info-body'),
  onClose: () => document.body.classList.remove('has-info'),
  onDeleteTrack: async (id) => {
    tracks = tracks.filter((tr) => tr.id !== id);
    await trackStore.remove(id);
    drawTracks();
  },
});

// ---- Panels -----------------------------------------------------------------------

const sheets = { search: $('#sheet-search'), layers: $('#sheet-layers') };
function openSheet(name) {
  info.close();
  for (const [k, el] of Object.entries(sheets)) el.hidden = k !== name;
  document.body.classList.toggle('has-sheet', !!name);
  if (name === 'search') {
    renderSearch();
    if (matchMedia('(min-width: 900px)').matches) $('#search-input').focus();
  }
  if (name === 'layers') refreshOffline();
}
function closeSheets() {
  for (const el of Object.values(sheets)) el.hidden = true;
  document.body.classList.remove('has-sheet');
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
  if (b.closest('#sheet-info')) info.close();
  else closeSheets();
}));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (info.isOpen()) info.close();
  else closeSheets();
});
$('#open-search').addEventListener('click', () => openSheet('search'));
$('#btn-layers').addEventListener('click', () => openSheet(sheets.layers.hidden ? 'layers' : null));

function showInfo() {
  closeSheets();
  document.body.classList.add('has-info');
}

// ---- Map controls -------------------------------------------------------------------

const btn3d = $('#btn-3d');
const needle = $('#needle');
function syncCamera() {
  btn3d.textContent = map.getPitch() > 5 ? '2D' : '3D';
  needle.style.transform = `rotate(${-map.getBearing()}deg)`;
}
map.on('rotate', syncCamera);
map.on('pitch', syncCamera);
syncCamera();
btn3d.addEventListener('click', () => map.easeTo(map.getPitch() > 5 ? { pitch: 0, bearing: 0 } : { pitch: 62 }));
$('#btn-north').addEventListener('click', () => map.easeTo({ bearing: 0 }));
$('#btn-locate').addEventListener('click', () => geolocate.trigger());
geolocate.on('error', (e) => e.code === 1 && showStatus(t('locate.denied')));

// ---- Map clicks ---------------------------------------------------------------------

map.on('click', (e) => {
  if (!sheets.search.hidden || !sheets.layers.hidden) {
    closeSheets();
    return;
  }
  const r = 8;
  const box = [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]];
  const hits = map.queryRenderedFeatures(box, { layers: CLICKABLE.filter((id) => map.getLayer(id)) });
  hits.sort((a, b) => CLICKABLE.indexOf(a.layer.id) - CLICKABLE.indexOf(b.layer.id));
  const hit = hits[0];
  if (hit?.layer.id === 'tracks') {
    const tr = tracks.find((x) => x.id === hit.properties.id);
    if (tr) { showInfo(); info.showTrack(tr); return; }
  }
  if (hit?.properties.fid) {
    const f = hit.properties.kind === 'run' ? pistes.trail(hit.properties.fid) : pistes.get(hit.properties.fid);
    if (f) { showInfo(); info.show(f); return; }
  }
  showInfo();
  info.showPoint(e.lngLat);
});
for (const id of CLICKABLE) {
  map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
}

// ---- Legend -----------------------------------------------------------------------------

const legend = $('#legend');
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
function renderLegend() {
  legend.hidden = settings.overlay === 'none';
  if (settings.overlay === 'slope') {
    legend.innerHTML = `<div class="legend-head"><strong>${t('legend.slope')}</strong><span class="muted">${t('legend.tap')}</span></div>
      <div class="bands">${SLOPE_BANDS.map((b, i) => `<button type="button" class="band${settings.slopeMask & (1 << i) ? '' : ' off'}" data-band="${i}" aria-pressed="${!!(settings.slopeMask & (1 << i))}" style="--c:${rgb(slopeColor(i))}"><i></i>${b}°${i === SLOPE_BANDS.length - 1 ? '+' : ''}</button>`).join('')}</div>`;
    legend.querySelectorAll('[data-band]').forEach((el) => el.addEventListener('click', () => {
      settings.slopeMask ^= 1 << +el.dataset.band;
      commit({ masks: true });
    }));
  } else if (settings.overlay === 'aspect') {
    const wedge = (i) => {
      const a0 = ((i * 45 - 22.5 - 90) * Math.PI) / 180, a1 = ((i * 45 + 22.5 - 90) * Math.PI) / 180;
      const p = (a, r) => `${(50 + r * Math.cos(a)).toFixed(2)} ${(50 + r * Math.sin(a)).toFixed(2)}`;
      return `M${p(a0, 16)}L${p(a0, 46)}A46 46 0 0 1 ${p(a1, 46)}L${p(a1, 16)}A16 16 0 0 0 ${p(a0, 16)}Z`;
    };
    legend.innerHTML = `<div class="legend-head"><strong>${t('legend.aspect')}</strong><span class="muted">${t('legend.tap')}</span></div>
      <div class="aspect-legend"><svg viewBox="0 0 100 100" class="rose">${ASPECTS.map((a, i) => `<path d="${wedge(i)}" data-sector="${i}" class="${settings.aspectMask & (1 << i) ? '' : 'off'}" fill="${rgb(aspectColor(i))}"><title>${t(`aspect.${a}`)}</title></path>`).join('')}<text x="50" y="54" text-anchor="middle">N</text></svg>
      <div class="rose-labels">${ASPECTS.map((a, i) => `<button type="button" class="band${settings.aspectMask & (1 << i) ? '' : ' off'}" data-sector="${i}" style="--c:${rgb(aspectColor(i))}"><i></i>${getLang() === 'zh' ? t(`aspect.${a}`) : a}</button>`).join('')}</div></div>`;
    legend.querySelectorAll('[data-sector]').forEach((el) => el.addEventListener('click', () => {
      settings.aspectMask ^= 1 << +el.dataset.sector;
      commit({ masks: true });
    }));
  }
}

// ---- Layers panel ------------------------------------------------------------------------

function syncPanel() {
  document.querySelectorAll('[data-setting]').forEach((group) => {
    group.querySelectorAll('[data-value]').forEach((b) => b.setAttribute('aria-checked', String(String(settings[group.dataset.setting]) === b.dataset.value)));
  });
  document.querySelectorAll('[data-toggle]').forEach((el) => (el.checked = !!settings[el.dataset.toggle]));
  const op = $('#opacity');
  op.value = settings.overlay === 'aspect' ? settings.aspectOpacity : settings.slopeOpacity;
  op.disabled = settings.overlay === 'none';
  $('#toggle-sun').checked = sun.on;
}

function commit({ masks = false, relabel = false } = {}) {
  save('fl.settings', settings);
  if (masks) setMasks(map, settings);
  applyView(map, settings);
  // The real-sun hillshade replaces the winter map's fixed one.
  if (sun.on) map.setLayoutProperty('hillshade', 'visibility', 'none');
  renderLegend();
  syncPanel();
  if (relabel) {
    translatePage();
    drawTracks();
    if (!sheets.search.hidden) renderSearch();
    updateSun();
  }
}

document.querySelectorAll('[data-setting]').forEach((group) => {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    const key = group.dataset.setting;
    const v = key === 'exaggeration' ? +b.dataset.value : b.dataset.value;
    if (settings[key] === v) return;
    settings[key] = v;
    if (key === 'lang') setLang(v);
    if (key === 'units') {
      fmt.setUnits(v);
      scale.setUnit(v === 'ft' ? 'imperial' : 'metric');
      addContours(map, maplibregl, settings).catch(() => {});
    }
    commit({ relabel: key === 'lang' || key === 'units' });
  });
});
document.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('change', () => {
  settings[el.dataset.toggle] = el.checked;
  commit();
}));
$('#opacity').addEventListener('input', (e) => {
  settings[settings.overlay === 'aspect' ? 'aspectOpacity' : 'slopeOpacity'] = +e.target.value;
  commit();
});

// ---- Sun & shade -----------------------------------------------------------------------

const sun = { on: false, date: new Date() };
const sunbar = $('#sunbar');
const sunTime = $('#sun-time');
const sunDate = $('#sun-date');
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function setSun(on) {
  sun.on = on;
  sunbar.hidden = !on;
  map.setLayoutProperty('sun', 'visibility', on ? 'visible' : 'none');
  if (on) {
    sun.date = new Date();
    sunDate.value = localDay(sun.date);
    sunTime.value = sun.date.getHours() * 60 + sun.date.getMinutes();
  }
  commit();
  updateSun();
}

function updateSun() {
  if (!sun.on) return;
  const c = map.getCenter();
  const [y, m, d] = (sunDate.value || localDay(new Date())).split('-').map(Number);
  const mins = +sunTime.value;
  sun.date = new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  const pos = sunPosition(sun.date, c.lat, c.lng);
  const up = pos.altitude > 0;
  map.setPaintProperty('sun', 'hillshade-illumination-direction', pos.azimuth);
  map.setPaintProperty('sun', 'hillshade-illumination-altitude', Math.max(1, pos.altitude));
  map.setPaintProperty('sun', 'hillshade-shadow-color', up ? 'rgba(12,20,48,0.85)' : 'rgba(6,10,26,0.92)');
  map.setPaintProperty('sun', 'hillshade-highlight-color', up ? 'rgba(255,214,150,0.22)' : 'rgba(6,10,26,0.6)');
  const times = sunTimes(sun.date, c.lat, c.lng);
  const dir = ASPECTS[Math.round(pos.azimuth / 45) % 8];
  $('#sun-clock').textContent = fmt.time(sun.date);
  $('#sun-desc').textContent = up ? t('sun.at', { alt: Math.round(pos.altitude), dir: t(`aspect.${dir}`) }) : t('sun.night');
  const dayStart = times.start.valueOf();
  const frac = (dt) => ((dt.valueOf() - dayStart) / 864e5) * 100;
  $('#sun-day').innerHTML = times.rise && times.set
    ? `<i style="left:${frac(times.rise)}%;width:${frac(times.set) - frac(times.rise)}%"></i><span style="left:${frac(times.rise)}%">${t('sun.rise', { t: fmt.time(times.rise) })}</span><span class="end" style="left:${frac(times.set)}%">${t('sun.set', { t: fmt.time(times.set) })}</span>`
    : '';
}
$('#toggle-sun').addEventListener('change', (e) => setSun(e.target.checked));
$('#sun-close').addEventListener('click', () => setSun(false));
sunTime.addEventListener('input', updateSun);
sunDate.addEventListener('change', updateSun);
$('#sun-now').addEventListener('click', () => {
  const now = new Date();
  sunDate.value = localDay(now);
  sunTime.value = now.getHours() * 60 + now.getMinutes();
  updateSun();
});
map.on('moveend', updateSun);

// ---- Search ------------------------------------------------------------------------------

const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const GROUPS = ['ne', 'west', 'alps', 'asia', 'china'];
const countryNames = new Map();
function countryName(code) {
  const key = `${getLang()}:${code}`;
  if (!countryNames.has(key)) {
    let name = code || '';
    try {
      if (code) name = new Intl.DisplayNames([getLang() === 'zh' ? 'zh-CN' : 'en'], { type: 'region' }).of(code) || code;
    } catch {}
    countryNames.set(key, name);
  }
  return countryNames.get(key);
}

function resortRow(r) {
  return `<li><button type="button" class="result" data-pack="${esc(r.slug)}">
    <span class="r-name">${esc(r.name[getLang()] || r.name.en)}${getLang() === 'zh' && r.name.zh !== r.name.en ? `<small>${esc(r.name.en)}</small>` : ''}</span>
    <span class="r-meta"><span class="pill">${t('search.pack')}</span>${t('search.runsLifts', { r: fmt.count(r.runs), l: fmt.count(r.lifts) })}</span>
  </button></li>`;
}

function areaRow(e, i) {
  const country = countryName(e[3]);
  const meta = [e[4], country].filter(Boolean).join(', ');
  const size = [e[5] ? t('search.vert', { v: fmt.elevation(e[5]) }) : '', e[6] ? t('search.km', { k: fmt.count(Math.round(e[6])) }) : ''].filter(Boolean).join(' · ');
  return `<li><button type="button" class="result" data-area="${i}">
    <span class="r-name">${esc(e[0])}</span>
    <span class="r-meta">${esc(meta)}${size ? ` · ${esc(size)}` : ''}</span>
  </button></li>`;
}

let searchToken = 0;
async function renderSearch() {
  const q = fold($('#search-input').value.trim());
  const out = $('#search-results');
  const my = ++searchToken;
  if (!q) {
    out.innerHTML = GROUPS.map((g) => {
      const list = resorts.filter((r) => r.group === g);
      return list.length ? `<h3>${t(`group.${g}`)}</h3><ul>${list.map(resortRow).join('')}</ul>` : '';
    }).join('');
    return;
  }
  await indexReady;
  if (my !== searchToken) return;
  const words = q.split(/\s+/);
  const packs = resorts.filter((r) => words.every((w) => fold(`${r.name.en} ${r.name.zh} ${r.slug}`).includes(w)));
  const scored = [];
  for (let i = 0; i < index.length && scored.length < 400; i++) {
    const e = index[i];
    const name = fold(e[0]);
    const hay = `${name} ${fold(e[4] || '')} ${e[3].toLowerCase()} ${fold(countryName(e[3]))}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const score = (name.startsWith(q) ? 3 : name.includes(q) ? 2 : 1) * 1000 + Math.min(999, e[6]);
    scored.push([score, i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  out.innerHTML = `${packs.length ? `<h3>${t('search.packs')}</h3><ul>${packs.map(resortRow).join('')}</ul>` : ''}
    <h3>${t('search.results')}</h3>
    ${scored.length ? `<ul>${scored.slice(0, 40).map(([, i]) => areaRow(index[i], i)).join('')}</ul>` : `<p class="muted small">${t('search.none')}</p>`}
    <button type="button" class="btn ghost" id="search-places"><svg class="i" aria-hidden="true"><use href="#i-pin"/></svg>${esc(t('search.places', { q: $('#search-input').value.trim() }))}</button>
    <ul id="place-results"></ul>`;
}

$('#search-input').addEventListener('input', renderSearch);
$('#search-results').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.pack) {
    const r = resorts.find((x) => x.slug === b.dataset.pack);
    pistes.loadPack(r);
    flyToBox(r.bbox, r.bearing);
  } else if (b.dataset.area) {
    const a = index[+b.dataset.area];
    const half = Math.max(1500, (a[8] || 3000) * 0.6);
    const dLat = half / 111200, dLon = dLat / Math.cos((a[2] * Math.PI) / 180);
    flyToBox([a[1] - dLon, a[2] - dLat, a[1] + dLon, a[2] + dLat], a[7]);
  } else if (b.id === 'search-places') {
    const q = $('#search-input').value.trim();
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=${getLang()}&q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => []);
    $('#place-results').innerHTML = res.map((p) => `<li><button type="button" class="result" data-lon="${p.lon}" data-lat="${p.lat}"><span class="r-name">${esc(p.name || p.display_name.split(',')[0])}</span><span class="r-meta">${esc(p.display_name)}</span></button></li>`).join('');
    return;
  } else if (b.dataset.lon) {
    map.flyTo({ center: [+b.dataset.lon, +b.dataset.lat], zoom: 13, pitch: 60, duration: 3000 });
  } else return;
  closeSheets();
});

function flyToBox(bbox, bearing = 0) {
  const cam = map.cameraForBounds(bbox, { bearing, padding: 40 });
  if (!cam) return;
  // Tilted, the view reaches much further than the flat fit; zoom in to compensate.
  map.flyTo({ ...cam, zoom: Math.min(15, cam.zoom + 0.8), pitch: 60, duration: 4000, essential: true });
}

// ---- GPX -----------------------------------------------------------------------------

$('#import-gpx').addEventListener('click', () => $('#gpx-input').click());
$('#gpx-input').addEventListener('change', async (e) => {
  await importFiles([...e.target.files]);
  e.target.value = '';
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  importFiles([...e.dataTransfer.files].filter((f) => /\.gpx$/i.test(f.name)));
});

async function importFiles(files) {
  let last = null;
  for (const file of files) {
    const parsed = parseGpx(await file.text(), file.name.replace(/\.gpx$/i, ''));
    if (!parsed.length) {
      showStatus(t('gpx.bad'));
      setTimeout(() => showStatus(''), 3000);
      continue;
    }
    for (const tr of parsed) {
      tr.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      tracks.push(tr);
      await trackStore.put(tr);
      last = tr;
    }
  }
  drawTracks();
  if (last) zoomToTrack(last);
}

function zoomToTrack(tr) {
  const b = tr.points.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  const cam = map.cameraForBounds(b, { padding: 60, bearing: map.getBearing() });
  if (cam) map.flyTo({ ...cam, pitch: 55, duration: 2500 });
  showInfo();
  info.showTrack(tr);
}

$('#track-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  const tr = b && tracks.find((x) => x.id === b.dataset.id);
  if (tr) zoomToTrack(tr);
});

// ---- Offline ---------------------------------------------------------------------------

async function refreshOffline() {
  const p = offline.plan(map, settings.basemap, offline.saveArea(map));
  $('#offline-estimate').textContent = t('layers.estimate', { n: fmt.count(p.urls.length), mb: fmt.count(p.mb) });
  const mb = await offline.usedMB();
  if (mb !== null && $('#offline-status').dataset.busy !== '1') $('#offline-status').textContent = t('layers.storage', { mb: fmt.count(mb) });
}
$('#offline-save').addEventListener('click', async () => {
  const p = offline.plan(map, settings.basemap, offline.saveArea(map));
  const bar = $('#offline-progress');
  const st = $('#offline-status');
  bar.hidden = false;
  st.dataset.busy = '1';
  try {
    await offline.download(p.urls, (done, total) => {
      bar.value = done / total;
      st.textContent = t('layers.saving', { done: fmt.count(done), total: fmt.count(total) });
    });
    st.textContent = t('layers.saved', { n: fmt.count(p.urls.length) });
  } catch {
    st.textContent = '—';
  }
  st.dataset.busy = '';
  bar.hidden = true;
});
$('#offline-clear').addEventListener('click', async () => {
  await offline.clear();
  refreshOffline();
});
window.addEventListener('offline', () => showStatus(t('status.offline')));
window.addEventListener('online', () => showStatus(''));

// ---- Start ---------------------------------------------------------------------------

map.on('load', async () => {
  // Start with the attribution folded away; it opens from its (i) button.
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  commit();
  pistes.update();
  tracks = await trackStore.all();
  drawTracks();
  addContours(map, maplibregl, settings).catch(() => {});
});
syncPanel();
renderLegend();
if (!navigator.onLine) showStatus(t('status.offline'));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
