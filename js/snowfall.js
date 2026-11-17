// New snow from weather models: how much fell in the last 24 hours and how
// much is forecast for the next 24. Open-Meteo (free, no key) gives hourly
// precipitation, temperature and freezing level for a grid of points over the
// view, from the best model it has for each place (HRRR in the US, ICON-D2 and
// AROME in the Alps, JMA's in Japan, ECMWF or GFS elsewhere). Each point
// becomes a table of snow depth by elevation: rain below the snow line, snow
// above it, lighter and deeper the colder it is. The terrain worker then
// colours each pixel at its own height from the DEM, so the snow line follows
// the terrain rather than the model's grid.
import { terrain, shadeUrl } from './terrain-client.js';
import { NEW_SNOW_BANDS, newSnowColor, newSnowDepth } from './terrain.js';
import { t } from './i18n.js';
import * as fmt from './format.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const N = 8;                     // grid points a side: one request, 64 locations
const E0 = 0, DE = 100, NB = 61; // elevation bins: every 100 m up to 6,000 m
const LAPSE = 0.0065;            // °C per metre
const SNOW_LINE = 300;           // snow usually reaches ~300 m below the 0 °C level
const MAX_AGE = 3600e3;          // fetch again after an hour
const MIN_ZOOM = 7;
const DAY = 864e5;

// Snow-to-liquid ratio: wet snow near 0 °C is about 10:1, -5 °C about 12:1
// (the mountain West's average is 12-13:1), dry snow at -12 °C and colder 15:1.
const ratio = (temp) => Math.max(8, Math.min(15, 10 - 0.4 * temp));
const smoothstep = (a, b, v) => {
  const x = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return x * x * (3 - 2 * x);
};
// Half the height of the box to fetch, in degrees, for a zoom: ~22 km at
// zoom 12 (about 3 km between points), 180 km at zoom 9.
const reach = (zoom) => Math.min(1.6, Math.max(0.12, 0.2 * 2 ** (12 - zoom)));

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

async function fetchGrid(box, signal) {
  const lats = [], lons = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      lats.push((box.north - (j * (box.north - box.south)) / (N - 1)).toFixed(4));
      lons.push((box.west + (i * (box.east - box.west)) / (N - 1)).toFixed(4));
    }
  }
  const url = `${API}?latitude=${lats}&longitude=${lons}&hourly=precipitation,temperature_2m,freezing_level_height`
    + '&past_days=1&forecast_days=2&timezone=GMT&timeformat=unixtime';
  const res = await fetch(url, { signal });
  if (res.status === 429) throw Object.assign(new Error('Open-Meteo daily limit'), { limit: true });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : [body];
  if (list.length !== N * N || !list.every((p) => p.hourly?.time)) throw new Error('Open-Meteo: unexpected reply');
  return list;
}

// Depth tables for the 24 hours before and after `now`, plus the snow line
// and mean precipitation of each, for the legend.
function tables(list, now) {
  const depth = { past: new Float32Array(N * N * NB), next: new Float32Array(N * N * NB) };
  const sums = { past: [0, 0], next: [0, 0] }; // Σ precipitation × snow line, Σ precipitation
  list.forEach((p, k) => {
    const h = p.hourly, ep = p.elevation ?? 0;
    for (let q = 0; q < h.time.length; q++) {
      // Each hourly value is the hour up to its time.
      const ts = h.time[q] * 1000;
      const win = ts > now - DAY && ts <= now ? 'past' : ts > now && ts <= now + DAY ? 'next' : null;
      const P = h.precipitation[q];
      if (!win || !(P > 0)) continue;
      const T = h.temperature_2m[q] ?? 0;
      const fl = h.freezing_level_height?.[q];
      const line = (fl > 0 ? fl : ep + T / LAPSE) - SNOW_LINE;
      const out = depth[win];
      for (let b = 0; b < NB; b++) {
        const e = E0 + b * DE;
        const snow = smoothstep(line - 200, line + 200, e);
        if (snow) out[k * NB + b] += (P * snow * ratio(T + (ep - e) * LAPSE)) / 10;
      }
      sums[win][0] += P * line;
      sums[win][1] += P;
    }
  });
  const line = (w) => (sums[w][1] > 0 ? sums[w][0] / sums[w][1] : null);
  const precip = (w) => sums[w][1] / (N * N);
  return { depth, line: { past: line('past'), next: line('next') }, precip: { past: precip('past'), next: precip('next') } };
}

export function createSnowfall({ map, settings, legend, onChange }) {
  let box = null;       // the box the data is for
  let data = null;
  let fetchedAt = 0;
  let status = 'idle';  // loading, ok, error, limit, zoom
  let version = 0;
  let gen = 0;
  let controller = null;
  let blockedUntil = 0; // after a 429, wait before asking again
  let timer = 0;

  const grid = (depth) => ({ west: box.west, east: box.east, south: box.south, north: box.north, nx: N, ny: N, e0: E0, de: DE, nb: NB, depth });

  function draw() {
    const g = { ...grid(data.depth[settings.newSnowWindow]), version: ++version };
    terrain.setNewSnow(g).catch(() => {});
    map.getSource('newsnow')?.setTiles([shadeUrl('newsnow', version)]);
    render();
  }

  // Fetches again when the view has moved out of the middle of the box, zoomed
  // far enough to want a box of another size, or the data is an hour old.
  async function refresh() {
    if (settings.overlay !== 'newsnow') return;
    const zoom = map.getZoom();
    if (zoom < MIN_ZOOM) {
      status = 'zoom';
      return render();
    }
    const c = map.getCenter(), half = reach(zoom);
    const fits = box && Math.abs(c.lat - box.lat) < box.half / 2 && Math.abs(c.lng - box.lng) < box.halfLon / 2
      && half / box.half < 1.6 && half / box.half > 0.4;
    if (data && fits && Date.now() - fetchedAt < MAX_AGE) {
      if (status !== 'ok') {
        status = 'ok';
        render();
      }
      return;
    }
    if (Date.now() < blockedUntil) {
      status = 'limit';
      return render();
    }
    controller?.abort();
    controller = new AbortController();
    const my = ++gen;
    const halfLon = half / Math.max(0.2, Math.cos((c.lat * Math.PI) / 180));
    const want = { lat: c.lat, lng: c.lng, half, halfLon, west: c.lng - halfLon, east: c.lng + halfLon, south: c.lat - half, north: c.lat + half };
    status = 'loading';
    render();
    try {
      const list = await fetchGrid(want, controller.signal);
      if (my !== gen) return;
      fetchedAt = Date.now();
      box = want;
      data = tables(list, fetchedAt);
      status = 'ok';
      draw();
    } catch (err) {
      if (my !== gen || err.name === 'AbortError') return;
      if (err.limit) blockedUntil = Date.now() + 10 * 60e3;
      status = err.limit ? 'limit' : 'error';
      render();
    }
  }

  function update() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  }

  function render() {
    if (settings.overlay !== 'newsnow') return;
    const w = settings.newSnowWindow;
    let foot = { loading: t('newsnow.loading'), error: t('newsnow.error'), limit: t('newsnow.limit'), zoom: t('newsnow.zoom') }[status] || '';
    if (!foot && data) {
      const line = data.line[w];
      foot = data.precip[w] < 0.5 || line == null ? t('newsnow.dry') : t('newsnow.line', { h: fmt.elevation(Math.round(line / 50) * 50) });
      foot += ` · ${t('newsnow.asOf', { t: fmt.time(new Date(fetchedAt)) })}`;
    }
    const last = NEW_SNOW_BANDS.length - 1;
    legend.innerHTML = `<div class="legend-head"><strong>${t('legend.newsnow')} <span class="muted">(${fmt.snowUnit()})</span></strong>
      <div class="seg compact ns-window" role="radiogroup">${['past', 'next'].map((k) => `<button type="button" role="radio" data-window="${k}" aria-checked="${k === w}">${t(`newsnow.${k}`)}</button>`).join('')}</div></div>
      <div class="bands">${NEW_SNOW_BANDS.map((cm, i) => `<span class="band" style="--c:${rgb(newSnowColor(i))}"><i></i>${fmt.snow(cm, false)}${i === last ? '+' : ''}</span>`).join('')}</div>
      <p class="legend-foot${status === 'limit' || status === 'error' ? ' warn' : ''}">${esc(foot)}</p>`;
  }

  legend.addEventListener('click', (e) => {
    const b = e.target.closest('[data-window]');
    if (!b || b.dataset.window === settings.newSnowWindow) return;
    settings.newSnowWindow = b.dataset.window;
    onChange();
    if (data) draw();
    else render();
  });

  // New snow at a place and elevation for both windows, or null without data there.
  function at(lon, lat, ele) {
    if (!data) return null;
    const past = newSnowDepth(grid(data.depth.past), lon, lat, ele);
    if (Number.isNaN(past)) return null;
    return { past, next: newSnowDepth(grid(data.depth.next), lon, lat, ele) };
  }

  return { update, render, at };
}
