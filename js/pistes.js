// Runs and lifts. Bundled resort packs (from OpenSkiData) load when the view
// reaches them; everywhere else is fetched live from OpenStreetMap through the
// Overpass API, one z11 tile at a time.
import { haversine } from './terrain.js';

const COLORS = {
  green: '#1f9d4c', blue: '#1d6ae5', red: '#de2b2b', black: '#0d0f12',
  orange: '#f08a00', grey: '#7d8794', teal: '#0e8f92', violet: '#7b4fd6', brown: '#9a6a3a',
};

// Which colour a difficulty gets depends on the regional convention.
const CONVENTION = {
  north_america: { novice: 'green', easy: 'green', intermediate: 'blue', advanced: 'black', expert: 'black' },
  japan: { novice: 'green', easy: 'green', intermediate: 'red', advanced: 'black', expert: 'black' },
  europe: { novice: 'green', easy: 'blue', intermediate: 'red', advanced: 'black', expert: 'black' },
};
const RANK = { novice: 1, easy: 2, intermediate: 3, advanced: 4, expert: 5, freeride: 6, extreme: 7 };

export function difficultyColorName(difficulty, convention) {
  if (difficulty === 'freeride' || difficulty === 'extreme') return 'orange';
  return CONVENTION[convention || 'europe']?.[difficulty] || null;
}

function decorate(p) {
  if (p.kind === 'lift') return p;
  const use = p.use || 'downhill';
  let color;
  if (use === 'downhill') color = COLORS[difficultyColorName(p.difficulty, p.convention)] || COLORS.grey;
  else if (use === 'nordic') color = COLORS.teal;
  else if (use === 'skitour') color = COLORS.violet;
  else if (use === 'sled' || use === 'sleigh') color = COLORS.brown;
  else color = COLORS.grey;
  p.color = color;
  p.style = use !== 'downhill' && use !== 'snow_park' ? 'dot'
    : p.difficulty === 'freeride' || p.difficulty === 'extreme' || p.grooming === 'backcountry' ? 'dash' : 'solid';
  p.rank = RANK[p.difficulty] || 0;
  const label = [p.ref, p.name].filter(Boolean).join(' ');
  if (label) p.label = label;
  return p;
}

// ---- Overpass -------------------------------------------------------------------

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const SKIP_LIFTS = /^(pylon|station|goods|zip_line|yes)$/;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function osmProps(tags, convention, id) {
  if (tags.aerialway || tags.railway === 'funicular') {
    return {
      kind: 'lift', name: tags.name, ref: tags.ref, liftType: tags.aerialway || 'funicular',
      occupancy: num(tags['aerialway:occupancy']), capacity: num(tags['aerialway:capacity']),
      duration: num(tags['aerialway:duration']) ? num(tags['aerialway:duration']) * 60 : undefined,
      heating: tags['aerialway:heating'] === 'yes' || undefined, bubble: tags['aerialway:bubble'] === 'yes' || undefined,
      detachable: tags['aerialway:detachable'] === 'yes' || undefined, osm: id,
    };
  }
  return {
    kind: 'run', name: tags['piste:name'] || tags.name, ref: tags['piste:ref'] || tags.ref,
    use: tags['piste:type'], difficulty: tags['piste:difficulty'], convention, grooming: tags['piste:grooming'],
    gladed: tags.gladed === 'yes' || undefined, lit: tags['piste:lit'] === 'yes' || tags.lit === 'yes' || undefined,
    oneway: tags.oneway === 'yes' || undefined, osm: id,
  };
}

function osmToFeatures(json, conventionAt) {
  const out = [];
  const byWay = new Map();
  for (const w of json.elements.filter((e) => e.type === 'way' && e.geometry)) {
    if (w.tags.aerialway && SKIP_LIFTS.test(w.tags.aerialway)) continue;
    const coords = w.geometry.map((g) => [g.lon, g.lat]);
    const closed = coords.length > 3 && w.nodes?.[0] === w.nodes?.[w.nodes.length - 1];
    const polygon = closed && !w.tags.aerialway && (w.tags.area === 'yes' || w.tags['piste:type'] === 'snow_park');
    const f = {
      type: 'Feature',
      properties: osmProps(w.tags, conventionAt(coords[0]), `way/${w.id}`),
      geometry: polygon ? { type: 'Polygon', coordinates: [coords] } : { type: 'LineString', coordinates: coords },
    };
    byWay.set(w.id, f);
    out.push(f);
  }
  // Piste route relations often carry the name and difficulty for untagged member ways.
  for (const r of json.elements.filter((e) => e.type === 'relation' && e.tags?.['piste:type'])) {
    const multipolygon = r.tags.type === 'multipolygon';
    const outers = [];
    for (const m of r.members || []) {
      if (m.type !== 'way' || !m.geometry) continue;
      if (multipolygon) {
        if (m.role !== 'inner') outers.push(m.geometry.map((g) => [g.lon, g.lat]));
        continue;
      }
      const existing = byWay.get(m.ref);
      if (existing) {
        const p = existing.properties;
        if (p.kind === 'run') {
          p.name = p.name || r.tags['piste:name'] || r.tags.name;
          p.difficulty = p.difficulty || r.tags['piste:difficulty'];
          p.ref = p.ref || r.tags['piste:ref'] || r.tags.ref;
        }
      } else {
        const coords = m.geometry.map((g) => [g.lon, g.lat]);
        const f = { type: 'Feature', properties: osmProps(r.tags, conventionAt(coords[0]), `relation/${r.id}/${m.ref}`), geometry: { type: 'LineString', coordinates: coords } };
        byWay.set(m.ref, f);
        out.push(f);
      }
    }
    for (const ring of outers) {
      if (ring.length > 3) out.push({ type: 'Feature', properties: osmProps(r.tags, conventionAt(ring[0]), `relation/${r.id}`), geometry: { type: 'Polygon', coordinates: [ring] } });
    }
  }
  return out;
}

async function overpass(bbox) {
  const [w, s, e, n] = bbox.map((v) => v.toFixed(4));
  const q = `[out:json][timeout:25][bbox:${s},${w},${n},${e}];(way["piste:type"];way["aerialway"];way["railway"="funicular"];relation["piste:type"];);out body geom;`;
  let last;
  for (const ep of OVERPASS) {
    try {
      const res = await fetch(`${ep}?data=${encodeURIComponent(q)}`);
      if (res.ok) return await res.json();
      last = new Error(`Overpass HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

// ---- The store the map draws from ------------------------------------------------

const tile2lon = (x, zz) => (x / 2 ** zz) * 360 - 180;
const tile2lat = (y, zz) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zz))) * 180) / Math.PI;
const CELL_Z = 11;
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const inBox = (lng, lat, b) => lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

export function createPisteStore(map, { resorts, nearestConvention, ready, onStatus, onChange }) {
  const features = new Map(); // fid -> feature with its full geometry (tiles clip what the map returns)
  const seenOsm = new Set();
  const loadedPacks = new Set();
  const loadedCells = new Set();
  const failedCells = new Set();
  let nextFid = 1;
  let pendingFlush = 0;
  let inFlight = 0;

  function add(list) {
    for (const f of list) {
      const p = f.properties;
      if (p.osm && seenOsm.has(p.osm)) continue;
      if (p.osm) seenOsm.add(p.osm);
      p.fid = nextFid++;
      decorate(p);
      features.set(p.fid, f);
      if (p.kind === 'lift' && f.geometry.type === 'LineString') {
        const c = f.geometry.coordinates;
        for (const [i, pt] of [c[0], c[c.length - 1]].entries()) {
          features.set(`s${p.fid}.${i}`, { type: 'Feature', properties: { kind: 'station', lift: p.fid }, geometry: { type: 'Point', coordinates: pt } });
        }
      }
    }
    cancelAnimationFrame(pendingFlush);
    pendingFlush = requestAnimationFrame(() => {
      const all = [...features.values()];
      map.getSource('pistes')?.setData({ type: 'FeatureCollection', features: all });
      onChange?.(all);
    });
  }

  async function loadPack(r) {
    if (loadedPacks.has(r.slug)) return;
    loadedPacks.add(r.slug);
    try {
      const res = await fetch(`data/packs/${r.slug}.json`);
      if (!res.ok) throw new Error(res.status);
      add((await res.json()).features);
    } catch {
      loadedPacks.delete(r.slug);
    }
  }

  async function loadCell(x, y) {
    const k = `${x}/${y}`;
    if (loadedCells.has(k) || failedCells.has(k)) return;
    loadedCells.add(k);
    const bbox = [tile2lon(x, CELL_Z), tile2lat(y + 1, CELL_Z), tile2lon(x + 1, CELL_Z), tile2lat(y, CELL_Z)];
    onStatus?.(++inFlight);
    try {
      const json = await overpass(bbox);
      await ready; // colour conventions come from the ski area index
      add(osmToFeatures(json, nearestConvention));
    } catch {
      loadedCells.delete(k);
      failedCells.add(k);
      setTimeout(() => failedCells.delete(k), 60_000);
    } finally {
      onStatus?.(--inFlight);
    }
  }

  function update() {
    const b = map.getBounds();
    const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const zoom = map.getZoom();
    if (zoom < 9) return;
    resorts.filter((r) => intersects(view, r.bbox)).forEach(loadPack);
    if (zoom < 11.5) return;
    // At a bundled resort the pack has it all; elsewhere ask OpenStreetMap.
    // In 3D the bounds reach the horizon, so only fetch around the centre.
    const c = map.getCenter();
    if (resorts.some((r) => inBox(c.lng, c.lat, r.bbox))) return;
    const n = 2 ** CELL_Z;
    const r = (c.lat * Math.PI) / 180;
    const cx = Math.floor(((c.lng + 180) / 360) * n);
    const cy = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        const cell = [tile2lon(x, CELL_Z), tile2lat(y + 1, CELL_Z), tile2lon(x + 1, CELL_Z), tile2lat(y, CELL_Z)];
        if (intersects(cell, view)) loadCell(x, y);
      }
    }
  }

  // OpenStreetMap splits a trail wherever it branches or its tags change, so
  // one signed run is often several features. Join the tapped one with
  // same-named runs that continue from either end, stopping at forks.
  function trail(fid) {
    const f = features.get(fid);
    const p = f?.properties;
    if (!f || f.geometry.type !== 'LineString' || !p.name) return f;
    const others = [];
    for (const g of features.values()) {
      const q = g.properties;
      if (g !== f && q.kind === 'run' && q.name === p.name && (q.use || 'downhill') === (p.use || 'downhill') && g.geometry.type === 'LineString') others.push(g);
    }
    const near = (a, b) => haversine(a, b) < 30;
    let line = f.geometry.coordinates.slice();
    const parts = [f];
    for (let grew = true; grew;) {
      grew = false;
      for (const atEnd of [true, false]) {
        const tip = atEnd ? line[line.length - 1] : line[0];
        const next = others.filter((g) => !parts.includes(g) && (near(g.geometry.coordinates[0], tip) || near(g.geometry.coordinates.at(-1), tip)));
        if (next.length !== 1) continue;
        let c = next[0].geometry.coordinates;
        if (atEnd) {
          if (!near(c[0], tip)) c = c.slice().reverse();
          line = line.concat(c.slice(1));
        } else {
          if (!near(c.at(-1), tip)) c = c.slice().reverse();
          line = c.slice(0, -1).concat(line);
        }
        parts.push(next[0]);
        grew = true;
      }
    }
    if (parts.length === 1) return f;
    // The hardest section sets the badge; the trail map would show the same.
    const hardest = parts.reduce((a, b) => ((b.properties.rank || 0) > (a.properties.rank || 0) ? b : a));
    return {
      type: 'Feature',
      properties: { ...p, difficulty: hardest.properties.difficulty, color: hardest.properties.color, segments: parts.length },
      geometry: { type: 'LineString', coordinates: line },
    };
  }

  map.on('moveend', update);
  return { update, loadPack, get: (fid) => features.get(fid), trail };
}
