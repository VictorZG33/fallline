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

export function analyze({ dist, ele, slope }) {
  const idx = ele.map((e, i) => (e === null ? -1 : i)).filter((i) => i >= 0);
  if (idx.length < 2) return null;
  const eles = idx.map((i) => ele[i]);
  const top = Math.max(...eles), bottom = Math.min(...eles);
  const length = dist[dist.length - 1];
  let maxPitch = 0;
  let maxPitchAt = idx[0];
  // Steepest 30 m along the line.
  for (let a = 0, b = 0; a < idx.length; a++) {
    while (b < idx.length - 1 && dist[idx[b]] - dist[idx[a]] < 30) b++;
    const dd = dist[idx[b]] - dist[idx[a]];
    if (dd >= 25) {
      const p = (Math.atan(Math.abs(ele[idx[b]] - ele[idx[a]]) / dd) * 180) / Math.PI;
      if (p > maxPitch) { maxPitch = p; maxPitchAt = idx[a]; }
    }
  }
  const slopes = slope.filter((s) => s !== null);
  return {
    top, bottom, length, vertical: top - bottom,
    avgPitch: length > 0 ? (Math.atan((top - bottom) / length) * 180) / Math.PI : 0,
    maxPitch, maxPitchAt,
    maxSlope: slopes.length ? Math.max(...slopes) : null,
    downhill: eles[0] >= eles[eles.length - 1],
  };
}

function profileSvg(p, stats) {
  const W = 600, H = 150, L = 4, R = 4, T = 10, B = 18;
  const xs = (d) => L + (d / (p.dist[p.dist.length - 1] || 1)) * (W - L - R);
  const span = Math.max(20, stats.top - stats.bottom);
  const ys = (e) => T + (1 - (e - stats.bottom) / span) * (H - T - B);
  let fills = '';
  let line = '';
  for (let i = 1; i < p.dist.length; i++) {
    const [e0, e1] = [p.ele[i - 1], p.ele[i]];
    if (e0 === null || e1 === null) continue;
    const s = Math.max(p.slope[i - 1] ?? 0, p.slope[i] ?? 0);
    const c = slopeColor(slopeBand(s));
    const [x0, x1] = [xs(p.dist[i - 1]), xs(p.dist[i])];
    fills += `<path d="M${x0.toFixed(1)} ${H - B}V${ys(e0).toFixed(1)}L${x1.toFixed(1)} ${ys(e1).toFixed(1)}V${H - B}Z" fill="${c ? rgb(c) : FLAT}" stroke="${c ? rgb(c) : FLAT}" stroke-width="0.6"/>`;
    line += `${line ? 'L' : 'M'}${x0.toFixed(1)} ${ys(e0).toFixed(1)}L${x1.toFixed(1)} ${ys(e1).toFixed(1)}`;
  }
  return `<svg class="profile" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t('info.profile'))}">
    ${fills}<path d="${line}" fill="none" stroke="#fff" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <line class="profile-cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#fff" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0"/>
  </svg>
  <div class="profile-axis"><span>${fmt.elevation(stats.top)}</span><span class="profile-read"></span><span>${fmt.distance(stats.length)}</span></div>`;
}

// ---- Camera flight along a line ---------------------------------------------------------

// A chase camera: it trails the point along the line, stays clear of the
// terrain between itself and the point, and looks a little way ahead.
function flyAlong(map, coords, eles, onEnd) {
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
    return Math.atan2(y, x) / D2R;
  };
  const offset = (p, brg, m) => [p[0] + (m * Math.sin(brg * D2R)) / (R * Math.cos(p[1] * D2R)) / D2R, p[1] + (m * Math.cos(brg * D2R)) / R / D2R];
  // Elevation along the line from the DEM profile, for terrain the map hasn't loaded yet.
  const eleAt = (d) => {
    const i = Math.max(0, cum.findIndex((c) => c >= d));
    return eles?.[i] ?? 0;
  };
  let base = 0;
  const ground = (p) => map.queryTerrainElevation(p) ?? base;
  const BACK = 620, AHEAD = 160;

  let bearing = bearingTo(at(0), at(150));
  let alt = null;
  const camera = (d) => {
    const target = at(d);
    base = eleAt(d);
    let delta = ((bearingTo(at(d - 50), at(d + 150)) - bearing + 540) % 360) - 180;
    bearing += delta * 0.05;
    const cam = offset(target, bearing + 180, BACK);
    // Highest ground between the camera and the point, plus some air.
    let floor = -Infinity;
    for (let k = 0; k <= 6; k++) floor = Math.max(floor, ground(offset(target, bearing + 180, (BACK * k) / 6)));
    const want = Math.max(floor + 120, ground(target) + 260);
    alt = alt === null ? want : Math.max(want, alt + (want - alt) * 0.08);
    const look = at(d + AHEAD);
    return map.calculateCameraOptionsFromTo(maplibregl.LngLat.convert(cam), alt, maplibregl.LngLat.convert(look), ground(look));
  };

  const ms = Math.max(9000, Math.min(45000, (total / 45) * 1000));
  let start = null;
  let raf = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    map.off('mousedown', stop); map.off('touchstart', stop); map.off('wheel', stop);
    onEnd?.();
  };
  const frame = (now) => {
    if (stopped) return;
    start ??= now;
    const f = Math.min(1, (now - start) / ms);
    const eased = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    map.jumpTo(camera(total * eased));
    if (f < 1) raf = requestAnimationFrame(frame);
    else stop();
  };
  map.flyTo({ ...camera(0), duration: 1800, essential: true });
  map.once('moveend', () => (raf = requestAnimationFrame(frame)));
  setTimeout(() => { map.on('mousedown', stop); map.on('touchstart', stop); map.on('wheel', stop); }, 1900);
  return stop;
}

// ---- The sheet --------------------------------------------------------------------

export function createInfo({ map, terrain, sheet, body, onClose, onDeleteTrack }) {
  let token = 0;
  let stopFlight = null;
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

  function wireProfile(p, coords) {
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
      line.setAttribute('x1', 4 + f * 592);
      line.setAttribute('x2', 4 + f * 592);
      line.setAttribute('opacity', '1');
      read.innerHTML = `${fmt.elevation(p.ele[i])} · ${chip(p.slope[i])}${fmt.degrees(p.slope[i])}`;
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

    let coords = f.geometry.coordinates;
    const total = coords.slice(1).reduce((s, c, i) => s + haversine(coords[i], c), 0);
    const prof = await terrain.profile(coords, Math.max(8, Math.min(30, total / 400))).catch(() => null);
    if (my !== token) return;
    const st = prof && analyze(prof);
    if (!st) {
      body.innerHTML = `${head}<p class="muted">${t('info.noDem')}</p>`;
      return;
    }
    // Draw and fly it downhill.
    let shown = prof;
    if (!st.downhill) {
      coords = coords.slice().reverse();
      const L = prof.dist[prof.dist.length - 1];
      shown = { dist: prof.dist.map((d) => L - d).reverse(), ele: prof.ele.slice().reverse(), slope: prof.slope.slice().reverse(), pts: prof.pts.slice().reverse() };
    }
    body.innerHTML = `${head}
      <dl class="stats">
        ${stat(t('info.length'), fmt.distance(st.length))}
        ${stat(t('info.vertical'), fmt.elevation(st.vertical))}
        ${stat(t('info.avgPitch'), `${chip(st.avgPitch)}${fmt.degrees(st.avgPitch)}`)}
        ${stat(t('info.maxPitch'), `${chip(st.maxPitch)}${fmt.degrees(st.maxPitch)}`)}
        ${stat(t('info.maxSlope'), `${chip(st.maxSlope)}${fmt.degrees(st.maxSlope)}`)}
        ${stat(t('info.top'), fmt.elevation(st.top))}
      </dl>
      ${profileSvg(shown, st)}
      <div class="actions">
        <button type="button" class="btn primary" data-act="fly">${t((p.use || 'downhill') === 'downhill' ? 'info.flyDown' : 'info.flyAlong')}</button>
        <button type="button" class="btn" data-act="gpx">${t('info.gpx')}</button>
      </div>`;
    wireProfile(shown, coords);
    body.querySelector('[data-act=fly]').onclick = () => { stopFlight?.(); stopFlight = flyAlong(map, shown.pts, shown.ele); };
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
    let eles = prof ? prof.ele : null;
    if (st?.downhill) { path = path.slice().reverse(); eles = eles?.slice().reverse(); }
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
    body.querySelector('[data-act=fly]').onclick = () => { stopFlight?.(); stopFlight = flyAlong(map, path, eles); };
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
        ${stat(t('info.maxSlope'), st ? `${chip(st.maxSlope)}${fmt.degrees(st.maxSlope)}` : '–')}
      </dl>
      ${st ? profileSvg(prof, st) : ''}
      <div class="actions">
        <button type="button" class="btn primary" data-act="fly">${t('info.flyAlong')}</button>
        <button type="button" class="btn danger" data-act="del">${t('info.delete')}</button>
      </div>`;
    if (st) wireProfile(prof, thin);
    body.querySelector('[data-act=fly]').onclick = () => { stopFlight?.(); stopFlight = flyAlong(map, prof ? prof.pts : thin, prof?.ele); };
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
