// "Recent satellite": the latest Sentinel-2 passes over the view. Earth Search
// (Element 84's STAC API) lists them; the terrain worker reads the images and
// their scene classification straight from the open archive on AWS.
import { terrain, shadeUrl } from './terrain-client.js';
import { saveArea } from './offline.js';
import { t, getLang } from './i18n.js';

const STAC = 'https://earth-search.aws.element84.com/v1/search';
const COGS = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs';
const DAYS = 60;
const MIN_ZOOM = 8.5;
const CLEAR = 0.25; // the most cloud over the view that still counts as a clear day
const REACH = 0.3;  // half the searched box, in degrees of latitude

// S2C_18TXQ_20261023_0_L2A lives in .../18/T/XQ/2026/10/S2C_18TXQ_20261023_0_L2A/
function cogBase(id) {
  const m = /^S2[A-Z]_(\d{1,2})([A-Z])([A-Z]{2})_(\d{4})(\d{2})\d{2}_\d+_L2A$/.exec(id);
  return m && `${COGS}/${m[1]}/${m[2]}/${m[3]}/${m[4]}/${+m[5]}/${id}`;
}

// Passes over a box in the last DAYS days, grouped by day, newest first.
async function search(bbox, signal) {
  const end = new Date();
  const body = {
    collections: ['sentinel-2-l2a'],
    bbox,
    datetime: `${new Date(end - DAYS * 864e5).toISOString()}/${end.toISOString()}`,
    limit: 200,
    query: { 'eo:cloud_cover': { lt: 95 } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    // The asset list is most of each item; the file names follow from the id.
    fields: { include: ['id', 'bbox', 'properties.datetime', 'properties.eo:cloud_cover', 'properties.proj:epsg'], exclude: ['assets', 'links', 'geometry'] },
  };
  const post = () => fetch(STAC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  // Earth Search sometimes times out at the gateway; one more try usually works.
  let res = await post().catch((err) => (err.name === 'AbortError' ? Promise.reject(err) : null));
  if (!res?.ok) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await post();
  }
  if (!res.ok) throw new Error(`Earth Search ${res.status}`);
  const { features = [] } = await res.json();
  const days = new Map();
  for (const f of features) {
    const base = cogBase(f.id);
    const epsg = f.properties['proj:epsg'];
    if (!base || !epsg) continue;
    // The local calendar day: passes are mid-morning, local solar time.
    const lon = (f.bbox[0] + f.bbox[2]) / 2;
    const day = new Date(Date.parse(f.properties.datetime) + lon * 240000).toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, { day, items: [], stats: null, est: 1 });
    const d = days.get(day);
    d.items.push({
      id: f.id, epsg, bbox: f.bbox, cloud: f.properties['eo:cloud_cover'] / 100,
      red: `${base}/B04.tif`, green: `${base}/B03.tif`, blue: `${base}/B02.tif`, scl: `${base}/SCL.tif`,
    });
    d.est = Math.min(d.est, f.properties['eo:cloud_cover'] / 100);
  }
  for (const d of days.values()) d.items.sort((a, b) => a.cloud - b.cloud);
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

const pct = (v) => Math.round(v * 100);
const daysAgo = (day) => {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - Date.parse(`${day}T00:00:00Z`)) / 864e5);
};

export function createRecent({ map, settings, onChange }) {
  const $ = (sel) => document.querySelector(sel);
  const bar = $('#s2bar');
  let dates = [];
  let idx = -1;
  let searched = null;     // the box the dates are for
  let gen = 0;             // bumps on every new search, to drop stale work
  let controller = null;
  let message = '';
  let busy = false;
  const versions = new Map(); // scene key -> version, so MapLibre reuses tiles it has
  const stats = new Map();    // `${day}|${box}|${withSnow}` -> Promise<stats>

  // Cloud cover is read for every day on the timeline; snow, which needs the
  // image too, only for the day on show.
  function statsFor(d, box, withSnow = false) {
    const key = `${d.day}|${box.map((v) => v.toFixed(3)).join(',')}|${withSnow}`;
    if (!stats.has(key)) {
      const p = terrain.sceneStats(d.items, box, withSnow);
      p.catch(() => stats.delete(key));
      stats.set(key, p);
      if (stats.size > 400) stats.delete(stats.keys().next().value);
    }
    return stats.get(key);
  }

  function draw() {
    const d = dates[idx];
    const items = d ? d.items : [];
    const key = `${settings.recentMode}|${items.map((i) => i.id).join(',')}`;
    let version = versions.get(key);
    if (!version) versions.set(key, (version = versions.size + 1));
    // Sent every time: the worker only keeps the last few.
    terrain.setScene({ version, mode: settings.recentMode, items });
    setTiles(shadeUrl('s2', version));
    render();
  }

  // The search can finish before the style has loaded.
  let pendingUrl = null;
  function setTiles(url) {
    const src = map.getSource('s2');
    if (src) return src.setTiles([url]);
    if (!pendingUrl) map.once('styledata', () => setTiles(pendingUrl));
    pendingUrl = url;
  }

  function select(i) {
    if (i < 0 || i >= dates.length) return;
    idx = i;
    draw();
    refreshStats();
  }

  // Passes at the edge of a swath can miss the view entirely; stepping skips them.
  const misses = (d) => d.stats && d.stats.cover < 0.05;
  function neighbour(dir) {
    for (let i = idx + dir; i >= 0 && i < dates.length; i += dir) if (!misses(dates[i])) return i;
    return -1;
  }

  // Cloud and snow over the view for the chosen day first, then the rest of
  // the timeline. Cheap after the first time: the classification tiles stay cached.
  let statsToken = 0;
  async function refreshStats() {
    const my = ++statsToken;
    const box = saveArea(map);
    const order = [idx, ...dates.keys()].filter((i, k, a) => i >= 0 && a.indexOf(i) === k);
    for (const i of order) {
      const d = dates[i];
      const s = await statsFor(d, box, i === idx).catch(() => null);
      if (my !== statsToken) return;
      d.stats = s;
      render();
    }
  }

  async function pickDefault(my) {
    busy = true;
    message = t('s2.choosing');
    render();
    const box = saveArea(map);
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < Math.min(dates.length, 12); i++) {
      const s = await statsFor(dates[i], box).catch(() => null);
      if (my !== gen) return;
      dates[i].stats = s;
      if (!s || s.cover < 0.3) continue;
      if (s.cloud < CLEAR && s.cover > 0.6) { best = i; break; }
      const score = s.cloud + (1 - s.cover) / 2;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    busy = false;
    message = '';
    // Unless a day was tapped meanwhile.
    if (idx < 0) select(best);
    else render();
  }

  async function find() {
    controller?.abort();
    controller = new AbortController();
    const my = ++gen;
    const c = map.getCenter();
    const dLon = REACH / Math.max(0.2, Math.cos((c.lat * Math.PI) / 180));
    const box = [c.lng - dLon, c.lat - REACH, c.lng + dLon, c.lat + REACH];
    const keep = dates[idx]?.day;
    busy = true;
    message = t('s2.searching');
    render();
    try {
      const found = await search(box, controller.signal);
      if (my !== gen) return;
      searched = box;
      dates = found;
      idx = -1;
      busy = false;
      message = dates.length ? '' : t('s2.none', { d: DAYS });
      const again = dates.findIndex((d) => d.day === keep);
      if (again >= 0) select(again);
      else if (dates.length) pickDefault(my);
      else draw();
    } catch (err) {
      if (my !== gen || err.name === 'AbortError') return;
      busy = false;
      message = t('s2.error');
      render();
    }
  }

  // After the map moves: search again once the centre nears the edge of the
  // searched box, otherwise just recount cloud and snow for the new view.
  function update() {
    if (!settings.recent) return;
    if (map.getZoom() < MIN_ZOOM) {
      message = t('s2.zoom');
      render();
      return;
    }
    const c = map.getCenter();
    const inside = searched && Math.abs(c.lng - (searched[0] + searched[2]) / 2) < (searched[2] - searched[0]) / 4
      && Math.abs(c.lat - (searched[1] + searched[3]) / 2) < (searched[3] - searched[1]) / 4;
    if (!inside) return find();
    if (message === t('s2.zoom')) message = '';
    refreshStats();
  }
  let moveTimer = 0;
  map.on('moveend', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(update, 400);
  });

  function cloudClass(d) {
    if (misses(d)) return 'none';
    const c = d.stats ? (d.stats.cover < 0.3 ? 1 : d.stats.cloud) : d.est;
    return `${c < CLEAR ? 'clear' : c < 0.6 ? 'part' : 'cloudy'}${d.stats ? '' : ' est'}`;
  }

  function render() {
    if (bar.hidden) return;
    const lang = getLang() === 'zh' ? 'zh-CN' : 'en-US';
    const d = dates[idx];
    $('#s2-prev').disabled = !d || neighbour(1) < 0;
    $('#s2-next').disabled = !d || neighbour(-1) < 0;
    bar.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.recentMode)));
    if (d && !busy) {
      const n = daysAgo(d.day);
      $('#s2-day').textContent = new Date(`${d.day}T12:00:00Z`).toLocaleDateString(lang, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
      $('#s2-ago').textContent = n <= 0 ? t('s2.today') : n === 1 ? t('s2.yesterday') : t('s2.ago', { n });
    } else {
      $('#s2-day').textContent = '';
      $('#s2-ago').textContent = '';
    }
    const s = d?.stats;
    // A day under cloud is a white blanket; say so rather than leave it to look like snow.
    const overcast = !message && s && !misses(d) && s.cloud >= 0.6;
    $('#s2-meta').classList.toggle('warn', !!overcast);
    $('#s2-meta').textContent = message || (s && misses(d) ? t('s2.outside') : overcast ? t('s2.overcast', { p: pct(s.cloud) }) : s
      ? [t('s2.cloud', { p: pct(s.cloud) }), s.snow != null ? t('s2.snowShare', { p: pct(s.snow) }) : '', s.cover < 0.95 ? t('s2.partial', { p: pct(s.cover) }) : ''].filter(Boolean).join(' · ')
      : d ? '…' : '');
    $('#s2-days').innerHTML = dates.map((x, i) => {
      const left = Math.max(0, Math.min(100, (1 - daysAgo(x.day) / DAYS) * 100));
      const label = new Date(`${x.day}T12:00:00Z`).toLocaleDateString(lang, { month: 'short', day: 'numeric', timeZone: 'UTC' });
      return `<button type="button" class="s2-dot ${cloudClass(x)}${i === idx ? ' on' : ''}" data-i="${i}" style="left:${left.toFixed(2)}%" title="${label}" aria-label="${label}"></button>`;
    }).join('');
  }

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 's2-prev') select(neighbour(1));
    else if (b.id === 's2-next') select(neighbour(-1));
    else if (b.dataset.i) select(+b.dataset.i);
    else if (b.dataset.mode && b.dataset.mode !== settings.recentMode) {
      settings.recentMode = b.dataset.mode;
      draw();
      onChange();
    }
  });

  function setOn(on) {
    settings.recent = on;
    bar.hidden = !on;
    if (on) {
      render();
      update();
    } else {
      controller?.abort();
      gen++;
      statsToken++;
      // A search or choice cut short starts over next time.
      if (busy) {
        searched = null;
        busy = false;
        message = '';
      }
    }
    onChange();
  }

  return { setOn, render };
}
