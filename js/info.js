// The info sheet for whatever was tapped: a run, a lift, a GPX track or a spot
// on the terrain. Each reads the DEM through the terrain worker and draws an
// elevation profile coloured by slope angle.
import * as maplibregl from '../vendor/maplibre-gl/maplibre-gl.mjs';
import { t } from './i18n.js';
import * as fmt from './format.js';
import { slopeBand, slopeColor, aspectSector, ASPECTS, haversine } from './terrain.js';
import { difficultyColorName } from './pistes.js';
import { trackStats, toGpx, download } from './gpx.js';

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const FLAT = '#5d6b7e';

// ---- Profile maths ----------------------------------------------------------------

const PITCH_WINDOW = 30; // metres of run the pitch is measured over
const deg = (rise, run) => (Math.atan(Math.abs(rise) / run) * 180) / Math.PI;

// Stats for a DEM profile. Everything about steepness is measured along the
// line itself (the pitch you ski), so the numbers and the chart agree.
export function analyze({ dist, ele }) {
  const dv = [], ev = [];
  ele.forEach((e, i) => e !== null && (dv.push(dist[i]), ev.push(e)));
  if (dv.length < 2) return null;
  const length = dist[dist.length - 1];
  const eleAt = (d) => {
    let i = dv.findIndex((x) => x >= d);
    if (i <= 0) return ev[i < 0 ? ev.length - 1 : 0];
    const f = (d - dv[i - 1]) / (dv[i] - dv[i - 1] || 1);
    return ev[i - 1] + (ev[i] - ev[i - 1]) * f;
  };
  // Pitch at each sample over a 30 m window centred on it (shifted to fit at the ends).
  const w = Math.min(PITCH_WINDOW, length);
  const pitch = dist.map((d) => {
    if (w < 5) return null;
    const a = Math.max(0, Math.min(length - w, d - w / 2));
    return deg(eleAt(a + w) - eleAt(a), w);
  });
  const maxPitch = Math.max(0, ...pitch.filter((p) => p !== null));
  const top = Math.max(...ev), bottom = Math.min(...ev);
  return {
    top, bottom, length, vertical: top - bottom,
    avgPitch: length > 0 ? deg(top - bottom, length) : 0,
    maxPitch, pitch,
    downhill: ev[0] >= ev[ev.length - 1],
  };
}

// The same profile run the other way.
function reversed(p) {
  const L = p.dist[p.dist.length - 1];
  return { dist: p.dist.map((d) => L - d).reverse(), ele: p.ele.slice().reverse(), slope: p.slope.slice().reverse(), pts: p.pts.slice().reverse() };
}

function profileSvg(p, stats) {
  const W = 600, H = 150, T = 6, B = 6;
  const xs = (d) => (d / (p.dist[p.dist.length - 1] || 1)) * W;
  const span = Math.max(20, stats.top - stats.bottom);
  const ys = (e) => T + (1 - (e - stats.bottom) / span) * (H - T - B);
  let fills = '';
  let line = '';
  for (let i = 1; i < p.dist.length; i++) {
    const [e0, e1] = [p.ele[i - 1], p.ele[i]];
    if (e0 === null || e1 === null) continue;
    const c = slopeColor(slopeBand(((stats.pitch[i - 1] ?? 0) + (stats.pitch[i] ?? 0)) / 2));
    const [x0, x1] = [xs(p.dist[i - 1]), xs(p.dist[i])];
    fills += `<path d="M${x0.toFixed(1)} ${H}V${ys(e0).toFixed(1)}L${x1.toFixed(1)} ${ys(e1).toFixed(1)}V${H}Z" fill="${c ? rgb(c) : FLAT}" stroke="${c ? rgb(c) : FLAT}" stroke-width="0.6"/>`;
    line += `${line ? 'L' : 'M'}${x0.toFixed(1)} ${ys(e0).toFixed(1)}L${x1.toFixed(1)} ${ys(e1).toFixed(1)}`;
  }
  return `<div class="profile-wrap">
    <svg class="profile" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t('info.profile'))}">
      ${fills}<path d="${line}" fill="none" stroke="#fff" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
      <line class="profile-cursor" x1="0" x2="0" y1="0" y2="${H}" stroke="#fff" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0"/>
    </svg>
    <span class="ax ax-top">${fmt.elevation(stats.top)}</span>
    <span class="ax ax-bottom">${fmt.elevation(stats.bottom)}</span>
  </div>
  <div class="profile-axis"><span>0</span><span class="profile-read"></span><span>${fmt.distance(stats.length)}</span></div>
  <p class="profile-note">${esc(t('info.profileNote'))}</p>`;
}

// ---- Camera flight along a line ---------------------------------------------------------

// Candidate camera placements relative to the point: degrees off straight
// behind, and distance back. Straight behind and far is preferred; the others
// win when they see the line from a lower, more oblique angle.
const PLACES = [0, -45, 45, -90, 90].flatMap((off) => [600, 420, 280].map((back) => ({ off, back })));
const AHEAD = 120;             // the camera looks this far down the line
const CLEARANCE = 35;          // metres of air the sight line keeps over the terrain
// Where the sight line is checked, as fractions of the way from the look point
// to the camera; dense near the look point, where a small rise hides it.
const SIGHT = [0.01, 0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

// A chase camera planned before take-off. For points along the line it tries
// each placement, raising the camera until the straight sight line to where it
// looks clears the DEM everywhere in between (in a couloir the summit ridge,
// not the ground under the camera, is what gets in the way). Then it keeps the
// placement that looks down least steeply. On a run straight down the fall
// line that is usually off to the side, where the slope doesn't climb away
// behind the skier. The heights come from the terrain worker, so tiles the map
// hasn't loaded yet are accounted for.
function flyAlong(map, terrain, coords, onEnd) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1];
  if (total < 30) return () => {};
  const at = (d) => {
    d = Math.max(0, Math.min(total, d));
    const i = cum.findIndex((c) => c >= d);
    if (i <= 0) return coords[0];
    const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f];
  };
  const R = 6371008.8, D2R = Math.PI / 180;
  const bearingTo = (a, b) => {
    const y = Math.sin((b[0] - a[0]) * D2R) * Math.cos(b[1] * D2R);
    const x = Math.cos(a[1] * D2R) * Math.sin(b[1] * D2R) - Math.sin(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.cos((b[0] - a[0]) * D2R);
    return Math.atan2(y, x);
  };
  const offset = (p, brg, m) => [p[0] + (m * Math.sin(brg)) / (R * Math.cos(p[1] * D2R)) / D2R, p[1] + (m * Math.cos(brg)) / R / D2R];

  let stopped = false;
  let raf = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    map.off('mousedown', stop); map.off('touchstart', stop); map.off('wheel', stop);
    onEnd?.();
  };

  (async () => {
    // Keyframes along the line, each with a heading averaged over ±80 m so the
    // camera swings smoothly rather than following every kink.
    const n = Math.max(2, Math.min(150, Math.ceil(total / 10)));
    const ds = Array.from({ length: n + 1 }, (_, i) => (total * i) / n);
    const raw = ds.map((d) => bearingTo(at(d - 40), at(d + 120)));
    const win = Math.max(1, Math.round(80 / (total / n)));
    const heading = raw.map((_, i) => {
      let sx = 0, sy = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(n, i + win); j++) { sx += Math.sin(raw[j]); sy += Math.cos(raw[j]); }
      return Math.atan2(sx, sy);
    });
    const targets = ds.map(at);
    const looks = ds.map((d) => at(d + AHEAD));

    // Every point whose height matters: each look point, and the sight line
    // from it back to each candidate camera position.
    const pts = [...looks];
    const cams = PLACES.map(({ off, back }) => targets.map((t, i) => offset(t, heading[i] + Math.PI + off * D2R, back)));
    for (const row of cams) {
      row.forEach((c, i) => {
        for (const f of SIGHT) pts.push([looks[i][0] + (c[0] - looks[i][0]) * f, looks[i][1] + (c[1] - looks[i][1]) * f]);
      });
    }
    const h = await terrain.heights(pts).catch(() => null);
    if (stopped) return;
    if (!h) return stop();
    // Heights are drawn exaggerated, so the camera works in the same units.
    const ex = map.getTerrain()?.exaggeration ?? 1;
    const lookAlt = looks.map((_, i) => (h[i] ?? 0) * ex);

    // Lowest camera altitude per keyframe for each candidate distance.
    const plans = cams.map((row, b) => row.map((c, i) => {
      const base = looks.length + (b * targets.length + i) * SIGHT.length;
      const hl = lookAlt[i];
      const reach = haversine(c, looks[i]);
      let need = hl + 150;
      SIGHT.forEach((f, k) => {
        const g = h[base + k];
        if (g == null) return;
        // The margin grows from 2 m at the look point to the full clearance.
        const margin = Math.min(CLEARANCE, 2 + 0.25 * f * reach);
        need = Math.max(need, hl + (g * ex + margin - hl) / f);
      });
      return need;
    }));
    // Score each placement by how steeply it mostly looks down (90th
    // percentile over the flight), with a little extra for leaving straight
    // behind or coming in close, and keep the best.
    const score = plans.map((alts, b) => {
      const { off, back } = PLACES[b];
      const angles = alts.map((a, i) => Math.atan2(a - lookAlt[i], haversine(cams[b][i], looks[i])) / D2R).sort((x, y) => x - y);
      return angles[Math.floor(angles.length * 0.9)] + (Math.abs(off) / 45) * 6 + ((600 - back) / 180) * 2;
    });
    const pick = score.indexOf(Math.min(...score));
    // Smooth the altitude without dipping under what any keyframe needs: take
    // the running maximum, then average it.
    const need = plans[pick];
    const w = Math.max(1, Math.round(60 / (total / n)));
    const env = need.map((_, i) => Math.max(...need.slice(Math.max(0, i - w), i + w + 1)));
    const alt = env.map((_, i) => {
      const s = env.slice(Math.max(0, i - w), i + w + 1);
      return s.reduce((a, b) => a + b, 0) / s.length;
    });
    const camPos = cams[pick];

    const lerp = (a, b, f) => a + (b - a) * f;
    // `lift` raises the camera straight up, which only ever lifts the sight line.
    const frameAt = (d, lift = 0) => {
      const x = Math.max(0, Math.min(n, (d / total) * n));
      const i = Math.min(n - 1, Math.floor(x)), f = x - i;
      const c = [lerp(camPos[i][0], camPos[i + 1][0], f), lerp(camPos[i][1], camPos[i + 1][1], f)];
      const l = [lerp(looks[i][0], looks[i + 1][0], f), lerp(looks[i][1], looks[i + 1][1], f)];
      return map.calculateCameraOptionsFromTo(maplibregl.LngLat.convert(c), lerp(alt[i], alt[i + 1], f) + lift, maplibregl.LngLat.convert(l), lerp(lookAlt[i], lookAlt[i + 1], f));
    };

    // Arrive high above the first camera position (MapLibre's own flight
    // path knows nothing about the terrain), then sink onto the planned
    // altitude during the first moments of the run.
    const ARRIVE = 500, SETTLE = 1500;
    const ms = Math.max(9000, Math.min(45000, (total / 45) * 1000));
    let start = null;
    const frame = (now) => {
      if (stopped) return;
      start ??= now;
      const t = now - start;
      const f = Math.min(1, t / ms);
      const eased = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
      const lift = ARRIVE * (1 - Math.min(1, t / SETTLE)) ** 2;
      map.jumpTo(frameAt(total * eased, lift));
      if (f < 1) raf = requestAnimationFrame(frame);
      else stop();
    };
    map.flyTo({ ...frameAt(0, ARRIVE), duration: 1800, essential: true });
    map.once('moveend', () => !stopped && (raf = requestAnimationFrame(frame)));
    setTimeout(() => { if (!stopped) { map.on('mousedown', stop); map.on('touchstart', stop); map.on('wheel', stop); } }, 1900);
  })();
  return stop;
}

// ---- The sheet --------------------------------------------------------------------

export function createInfo({ map, terrain, sheet, body, onClose, onDeleteTrack }) {
  let token = 0;
  let stopFlight = null;
  // While flying, the sheet and legend step aside; a button (or any touch on
  // the map) ends the flight and brings them back.
  let flight = 0;
  function fly(path) {
    stopFlight?.();
    const id = ++flight;
    document.body.classList.add('flying');
    // Leave the class on briefly so the tap that stopped the flight isn't
    // also read as a tap on the map.
    stopFlight = flyAlong(map, terrain, path, () => setTimeout(() => id === flight && document.body.classList.remove('flying'), 350));
  }
  document.getElementById('flight-stop')?.addEventListener('click', () => stopFlight?.());
  const cursor = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'cursor-dot' }) });

  function open(html, selection) {
    body.innerHTML = html;
    sheet.hidden = false;
    sheet.scrollTop = 0;
    map.getSource('selection')?.setData({ type: 'FeatureCollection', features: selection ? [selection] : [] });
  }

  function close() {
    token++;
    sheet.hidden = true;
    stopFlight?.();
    cursor.remove();
    map.getSource('selection')?.setData({ type: 'FeatureCollection', features: [] });
    onClose?.();
  }

  const stat = (label, value, extra = '') => `<div class="stat"><dt>${esc(label)}</dt><dd>${value}${extra}</dd></div>`;
  const chip = (deg) => {
    const c = slopeColor(slopeBand(deg));
    return `<i class="chip" style="background:${c ? rgb(c) : 'transparent'}"></i>`;
  };

  function wireProfile(p, st, coords) {
    const svg = body.querySelector('.profile');
    const read = body.querySelector('.profile-read');
    const line = body.querySelector('.profile-cursor');
    if (!svg) return;
    const coordAt = (d) => {
      let cum = 0;
      for (let i = 1; i < coords.length; i++) {
        const seg = haversine(coords[i - 1], coords[i]);
        if (cum + seg >= d) {
          const f = (d - cum) / (seg || 1);
          return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f];
        }
        cum += seg;
      }
      return coords[coords.length - 1];
    };
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const d = f * p.dist[p.dist.length - 1];
      let i = p.dist.findIndex((x) => x >= d);
      if (i < 0) i = p.dist.length - 1;
      line.setAttribute('x1', f * 600);
      line.setAttribute('x2', f * 600);
      line.setAttribute('opacity', '1');
      read.innerHTML = `${fmt.distance(d)} · ${fmt.elevation(p.ele[i])} · ${chip(st.pitch[i])}${fmt.degrees(st.pitch[i])}`;
      cursor.setLngLat(coordAt(d)).addTo(map);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => {
      line.setAttribute('opacity', '0');
      read.textContent = '';
      cursor.remove();
    });
  }

  function flags(p) {
    const f = [];
    if (p.grooming === 'classic' || p.grooming === 'skating' || p.grooming === 'classic+skating' || p.grooming === 'classic;skating') f.push(t('info.groomed'));
    if (p.grooming === 'backcountry') f.push(t('info.backcountry'));
    if (p.grooming === 'mogul') f.push(t('info.mogul'));
    if (p.gladed) f.push(t('info.gladed'));
    if (p.lit) f.push(t('info.lit'));
    if (p.patrolled) f.push(t('info.patrolled'));
    return f.map((x) => `<span class="tag">${esc(x)}</span>`).join('');
  }

  function difficultyBadge(p) {
    if ((p.use || 'downhill') !== 'downhill') return `<span class="badge" style="--c:${p.color}">${esc(t(`use.${p.use}`))}</span>`;
    const name = difficultyColorName(p.difficulty, p.convention);
    const label = !p.difficulty ? t('diff.unknown')
      : p.difficulty === 'freeride' || p.difficulty === 'extreme' ? t(`diff.${p.difficulty}`)
      : t(`diff.${p.difficulty}.${p.convention || 'europe'}`);
    const shape = p.convention === 'north_america'
      ? { green: '●', blue: '■', black: p.difficulty === 'expert' ? '◆◆' : '◆', orange: '◆' }[name] || '●'
      : '●';
    return `<span class="badge" style="--c:${p.color}"><b>${shape}</b>${esc(label)}</span>`;
  }

  async function showRun(f) {
    const p = f.properties;
    const my = ++token;
    const title = [p.ref, p.name].filter(Boolean).join(' ') || t('info.unnamed');
    const head = `<p class="eyebrow">${esc(p.area || t('info.run'))}</p><h2>${esc(title)}</h2><div class="badges">${difficultyBadge(p)}${flags(p)}</div>`;
    open(`${head}<p class="muted">${t('info.loading')}</p>`, { type: 'Feature', properties: { color: p.color }, geometry: f.geometry });

    if (f.geometry.type === 'Polygon') {
      const a = await terrain.area(f.geometry.coordinates).catch(() => null);
      if (my !== token) return;
      body.innerHTML = a
        ? `${head}<dl class="stats">${stat(t('info.top'), fmt.elevation(a.top))}${stat(t('info.bottom'), fmt.elevation(a.bottom))}${stat(t('info.vertical'), fmt.elevation(a.top - a.bottom))}${stat(t('info.meanSlope'), `${chip(a.slopeMean)}${fmt.degrees(a.slopeMean)}`)}${stat(t('info.maxSlope'), `${chip(a.slopeP90)}${fmt.degrees(a.slopeP90)}`)}${stat(t('info.area'), fmt.area(a.areaM2))}</dl>`
        : `${head}<p class="muted">${t('info.noDem')}</p>`;
      return;
    }

    const coords = f.geometry.coordinates;
    const total = coords.slice(1).reduce((s, c, i) => s + haversine(coords[i], c), 0);
    const prof = await terrain.profile(coords, Math.max(8, Math.min(30, total / 400))).catch(() => null);
    if (my !== token) return;
    const first = prof && analyze(prof);
    if (!first) {
      body.innerHTML = `${head}<p class="muted">${t('info.noDem')}</p>`;
      return;
    }
    // Draw and fly it downhill.
    const shown = first.downhill ? prof : reversed(prof);
    const st = first.downhill ? first : analyze(shown);
    body.innerHTML = `${head}
      ${p.segments > 1 ? `<p class="muted small">${esc(t('info.segments', { n: p.segments }))}</p>` : ''}
      <dl class="stats">
        ${stat(t('info.length'), fmt.distance(st.length))}
        ${stat(t('info.vertical'), fmt.elevation(st.vertical))}
        ${stat(t('info.avgPitch'), `${chip(st.avgPitch)}${fmt.degrees(st.avgPitch)}`)}
        ${stat(t('info.maxPitch'), `${chip(st.maxPitch)}${fmt.degrees(st.maxPitch)}`)}
        ${stat(t('info.top'), fmt.elevation(st.top))}
        ${stat(t('info.bottom'), fmt.elevation(st.bottom))}
      </dl>
      ${profileSvg(shown, st)}
      <div class="actions">
        <button type="button" class="btn primary" data-act="fly">${t((p.use || 'downhill') === 'downhill' ? 'info.flyDown' : 'info.flyAlong')}</button>
        <button type="button" class="btn" data-act="gpx">${t('info.gpx')}</button>
      </div>`;
    wireProfile(shown, st, shown.pts);
    body.querySelector('[data-act=fly]').onclick = () => fly(shown.pts);
    body.querySelector('[data-act=gpx]').onclick = () => download(`${title.replace(/[^\p{L}\p{N}]+/gu, '-')}.gpx`, toGpx(title, shown.pts, shown.ele));
  }

  async function showLift(f) {
    const p = f.properties;
    const my = ++token;
    const kind = [t(`lift.${p.liftType}`)];
    if (p.detachable) kind.push(t('lift.detachable'));
    if (p.bubble) kind.push(t('lift.bubble'));
    if (p.heating) kind.push(t('lift.heated'));
    const head = `<p class="eyebrow">${esc(kind.join(' · '))}</p><h2>${esc(p.name || t('info.unnamed'))}</h2>`;
    open(`${head}<p class="muted">${t('info.loading')}</p>`, { type: 'Feature', properties: { color: '#ffffff' }, geometry: f.geometry });
    const coords = f.geometry.coordinates;
    const prof = await terrain.profile(coords, 20).catch(() => null);
    if (my !== token) return;
    const st = prof && analyze(prof);
    const lengthM = st?.length ?? coords.slice(1).reduce((s, c, i) => s + haversine(coords[i], c), 0);
    // Ride it uphill.
    let path = prof ? prof.pts : coords;
    if (st?.downhill) path = path.slice().reverse();
    const ride = p.duration || null;
    body.innerHTML = `${head}
      <dl class="stats">
        ${stat(t('info.length'), fmt.distance(lengthM))}
        ${stat(t('info.vertical'), st ? fmt.elevation(st.vertical) : '–')}
        ${stat(t('info.top'), st ? fmt.elevation(st.top) : '–')}
        ${p.capacity ? stat(t('info.capacity'), t('info.perHour', { n: fmt.count(p.capacity) })) : ''}
        ${ride ? stat(t('info.ride'), fmt.duration(ride)) : ''}
        ${p.occupancy ? stat(t('info.seats'), String(p.occupancy)) : ''}
      </dl>
      <div class="actions"><button type="button" class="btn primary" data-act="fly">${t('info.flyUp')}</button></div>`;
    body.querySelector('[data-act=fly]').onclick = () => fly(path);
  }

  async function showTrack(track) {
    const my = ++token;
    const coords = track.points.map((p) => [p[0], p[1]]);
    const s = trackStats(track.points);
    const head = `<p class="eyebrow">${t('info.track')}</p><h2>${esc(track.name)}</h2>`;
    open(`${head}<p class="muted">${t('info.loading')}</p>`, { type: 'Feature', properties: { color: '#ff2d8a' }, geometry: { type: 'LineString', coordinates: coords } });
    // Thin long recordings to about 600 points for the DEM read.
    const stride = Math.max(1, Math.floor(coords.length / 600));
    const thin = coords.filter((_, i) => i % stride === 0 || i === coords.length - 1);
    const prof = await terrain.profile(thin, Math.max(10, s.distance / 500)).catch(() => null);
    if (my !== token) return;
    const st = prof && analyze(prof);
    body.innerHTML = `${head}
      <dl class="stats">
        ${stat(t('info.distance'), fmt.distance(s.distance))}
        ${stat(t('info.duration'), fmt.duration(s.duration))}
        ${stat(t('info.descent'), fmt.elevation(s.descent || (st ? st.vertical : null)))}
        ${stat(t('info.ascent'), fmt.elevation(s.ascent))}
        ${stat(t('info.maxSpeed'), fmt.speed(s.maxSpeed))}
        ${stat(t('info.maxPitch'), st ? `${chip(st.maxPitch)}${fmt.degrees(st.maxPitch)}` : '–')}
      </dl>
      ${st ? profileSvg(prof, st) : ''}
      <div class="actions">
        <button type="button" class="btn primary" data-act="fly">${t('info.flyAlong')}</button>
        <button type="button" class="btn danger" data-act="del">${t('info.delete')}</button>
      </div>`;
    if (st) wireProfile(prof, st, prof.pts);
    body.querySelector('[data-act=fly]').onclick = () => fly(prof ? prof.pts : thin);
    body.querySelector('[data-act=del]').onclick = () => { onDeleteTrack?.(track.id); close(); };
  }

  async function showPoint(lngLat) {
    const my = ++token;
    open(`<p class="eyebrow">${t('info.point')}</p><p class="muted">${t('info.loading')}</p>`, null);
    cursor.setLngLat(lngLat).addTo(map);
    const r = await terrain.point(lngLat.lng, lngLat.lat).catch(() => null);
    if (my !== token) return;
    const dir = r?.aspect != null ? ASPECTS[aspectSector(r.aspect)] : null;
    body.innerHTML = `<p class="eyebrow">${t('info.point')} · ${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}</p>
      ${r ? `<dl class="stats">
        ${stat(t('info.elevation'), fmt.elevation(r.ele))}
        ${stat(t('info.slope'), `${chip(r.slope)}${fmt.degrees(r.slope, 1)}`)}
        ${stat(t('info.aspect'), dir && r.slope >= 3 ? `${esc(t(`aspect.${dir}`))} · ${fmt.degrees(r.aspect)}` : '–')}
      </dl>` : `<p class="muted">${t('info.noDem')}</p>`}`;
  }

  function show(f) {
    stopFlight?.();
    cursor.remove();
    if (f.properties.kind === 'lift') return showLift(f);
    return showRun(f);
  }

  return { show, showTrack, showPoint, close, isOpen: () => !sheet.hidden };
}
