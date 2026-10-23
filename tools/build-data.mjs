#!/usr/bin/env node
// Builds the app's bundled data from an OpenSkiData download (ODbL, built
// daily from OpenStreetMap; see https://openskidata.org):
//
//   data/skiareas.json        every named downhill ski area in the world, for search
//   data/resorts.json         the resorts in tools/resorts.mjs and the bbox of each pack
//   data/packs/<slug>.json    runs and lifts for each of those resorts (GeoJSON)
//
// Usage:
//   mkdir -p osd && for f in ski_areas runs lifts; do
//     curl -H 'Accept-Encoding: gzip' -o osd/$f.geojson.gz https://tiles.openskimap.org/geojson/$f.geojson
//   done
//   node tools/build-data.mjs osd            # writes ./data
//   node tools/build-data.mjs osd --check    # only prints which ski areas each resort matched

import { createReadStream, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESORTS } from './resorts.mjs';

const SRC = process.argv[2];
const CHECK = process.argv.includes('--check');
if (!SRC) {
  console.error('usage: node tools/build-data.mjs <dir with ski_areas/runs/lifts .geojson.gz> [--check]');
  process.exit(1);
}
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const MARGIN_KM = 1.5;

// The files hold one feature per line, separated by lines holding a comma.
async function* features(name) {
  const lines = createInterface({ input: createReadStream(join(SRC, `${name}.geojson.gz`)).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line[0] !== '{' || line.startsWith('{"type": "FeatureCollection"')) continue;
    yield JSON.parse(line.endsWith(',') ? line.slice(0, -1) : line);
  }
}

function km(a, b) {
  const r = Math.PI / 180;
  const x = (b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r);
  const y = (b[1] - a[1]) * r;
  return Math.hypot(x, y) * 6371;
}

function bboxOf(geom) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  (function walk(c) {
    if (typeof c[0] === 'number') {
      if (c[0] < b[0]) b[0] = c[0];
      if (c[1] < b[1]) b[1] = c[1];
      if (c[0] > b[2]) b[2] = c[0];
      if (c[1] > b[3]) b[3] = c[1];
    } else c.forEach(walk);
  })(geom.coordinates);
  return b;
}

function grow(b, kmMargin) {
  const dy = kmMargin / 111.2;
  const dx = dy / Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180);
  return [b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy];
}

const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const inside = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// Drop elevation (the app samples its own DEM) and round to about a metre.
function flat(geom) {
  const f = (c) => (typeof c[0] === 'number' ? [r5(c[0]), r5(c[1])] : c.map(f));
  return { type: geom.type, coordinates: f(geom.coordinates) };
}

function compact(o) {
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined || o[k] === false) delete o[k];
  return o;
}

function placeOf(p) {
  const pl = (p.places || [])[0];
  if (!pl) return ['', ''];
  return [pl.iso3166_1Alpha2 || '', pl.localized?.en?.region || ''];
}

// ---- Pass 1: ski areas ------------------------------------------------------

const matched = new Map(RESORTS.map((r) => [r.slug, { resort: r, areas: [], bbox: null }]));
const index = [];
const entryById = new Map();
// Sum of bottom-to-top lift vectors per ski area, so the camera can open looking uphill.
const uphill = new Map();

for await (const f of features('ski_areas')) {
  const p = f.properties;
  if (p.status !== 'operating' || !p.name) continue;
  const center = p.viewportHint?.center || [(bboxOf(f.geometry)[0] + bboxOf(f.geometry)[2]) / 2, (bboxOf(f.geometry)[1] + bboxOf(f.geometry)[3]) / 2];

  for (const m of matched.values()) {
    const r = m.resort;
    if (r.match.test(p.name) && km(center, r.near) <= r.km) {
      m.areas.push({ id: p.id, name: p.name, geometry: f.geometry, center, convention: p.runConvention });
    }
  }

  if (!(p.activities || []).includes('downhill')) continue;
  const st = p.statistics || {};
  const dh = st.runs?.byActivity?.downhill?.byDifficulty || {};
  const runKm = Object.values(dh).reduce((s, d) => s + (d.lengthInKm || 0), 0);
  const top = Math.max(st.runs?.maxElevation ?? -Infinity, st.lifts?.maxElevation ?? -Infinity);
  const bottom = Math.min(st.runs?.minElevation ?? Infinity, st.lifts?.minElevation ?? Infinity);
  const vert = Number.isFinite(top) && Number.isFinite(bottom) ? Math.round(top - bottom) : 0;
  const [cc, region] = placeOf(p);
  const h = p.viewportHint || {};
  const span = Math.round(Math.max(h.rotatedWidthMeters || 0, h.rotatedHeightMeters || 0));
  // [name, lon, lat, country, region, vertical m, km of runs, uphill bearing, span m, colour convention]
  const conv = { north_america: 'n', japan: 'j' }[p.runConvention] || 'e';
  const entry = [p.name, r4(center[0]), r4(center[1]), cc, region, vert, Math.round(runKm * 10) / 10, 0, span, conv];
  index.push(entry);
  entryById.set(p.id, entry);
}

for (const m of matched.values()) {
  if (!m.areas.length) continue;
  m.bbox = grow(m.areas.map((a) => (a.geometry.type === 'Point' ? [...a.center, ...a.center] : bboxOf(a.geometry))).reduce(union), MARGIN_KM);
}

if (CHECK) {
  for (const m of matched.values()) {
    console.log(`${m.resort.slug.padEnd(18)} ${m.areas.length ? m.areas.map((a) => a.name).join(' | ') : '!! no match'}`);
  }
  process.exit(0);
}

// ---- Pass 2: runs and lifts ---------------------------------------------------

const packs = [...matched.values()].filter((m) => m.bbox);
for (const m of packs) m.features = [];

function assign(f, props) {
  const b = bboxOf(f.geometry);
  const c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  for (const m of packs) {
    if (inside(c, m.bbox)) m.features.push({ type: 'Feature', properties: props, geometry: flat(f.geometry) });
  }
}

const osmId = (p) => (p.sources || []).find((s) => s.type === 'openstreetmap')?.id || null;

for await (const f of features('runs')) {
  const p = f.properties;
  if (p.status && p.status !== 'operating') continue;
  assign(f, compact({
    kind: 'run',
    name: p.name,
    ref: p.ref,
    use: (p.uses || [])[0] || 'downhill',
    difficulty: p.difficulty,
    convention: p.difficultyConvention,
    grooming: p.grooming,
    gladed: p.gladed,
    lit: p.lit,
    patrolled: p.patrolled,
    oneway: p.oneway,
    area: p.skiAreas?.[0]?.properties?.name,
    osm: osmId(p),
  }));
}

for await (const f of features('lifts')) {
  const p = f.properties;
  if (p.status && p.status !== 'operating') continue;
  if (f.geometry.type === 'LineString' && f.geometry.coordinates.length > 1) {
    const c = f.geometry.coordinates;
    let [a, b] = [c[0], c[c.length - 1]];
    if ((a[2] ?? 0) > (b[2] ?? 0)) [a, b] = [b, a];
    const e = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
    const n = b[1] - a[1];
    for (const sa of p.skiAreas || []) {
      const id = sa.properties?.id;
      const v = uphill.get(id) || [0, 0];
      uphill.set(id, [v[0] + e, v[1] + n]);
    }
  }
  assign(f, compact({
    kind: 'lift',
    name: p.name,
    ref: p.ref,
    liftType: p.liftType,
    occupancy: p.occupancy,
    capacity: p.capacity,
    duration: p.duration,
    heating: p.heating,
    bubble: p.bubble,
    detachable: p.detachable,
    access: p.access,
    osm: osmId(p),
  }));
}

const bearingOf = (v) => (v && Math.hypot(v[0], v[1]) > 0 ? Math.round(((Math.atan2(v[0], v[1]) * 180) / Math.PI + 360) % 360) : 0);
for (const [id, v] of uphill) {
  const entry = entryById.get(id);
  if (entry) entry[7] = bearingOf(v);
}

// ---- Write ----------------------------------------------------------------------

rmSync(join(OUT, 'packs'), { recursive: true, force: true });
mkdirSync(join(OUT, 'packs'), { recursive: true });

const resorts = [];
for (const m of packs) {
  const r = m.resort;
  const conventions = m.areas.map((a) => a.convention).filter(Boolean);
  const up = m.areas.map((a) => uphill.get(a.id)).filter(Boolean).reduce((s, v) => [s[0] + v[0], s[1] + v[1]], [0, 0]);
  const pack = {
    type: 'FeatureCollection',
    slug: r.slug,
    generated: new Date().toISOString().slice(0, 10),
    features: m.features,
  };
  writeFileSync(join(OUT, 'packs', `${r.slug}.json`), JSON.stringify(pack));
  resorts.push({
    slug: r.slug,
    group: r.group,
    name: { en: r.en, zh: r.zh },
    bbox: m.bbox.map(r4),
    center: [r4((m.bbox[0] + m.bbox[2]) / 2), r4((m.bbox[1] + m.bbox[3]) / 2)],
    bearing: bearingOf(up),
    convention: conventions[0] || 'europe',
    runs: m.features.filter((f) => f.properties.kind === 'run').length,
    lifts: m.features.filter((f) => f.properties.kind === 'lift').length,
  });
  console.log(`${r.slug.padEnd(18)} ${String(m.features.length).padStart(5)} features  ${m.areas.map((a) => a.name).join(' | ')}`);
}

index.sort((a, b) => b[6] - a[6]);
writeFileSync(join(OUT, 'resorts.json'), JSON.stringify(resorts, null, 1));
writeFileSync(join(OUT, 'skiareas.json'), JSON.stringify(index));
console.log(`${resorts.length} packs, ${index.length} ski areas in the search index`);
