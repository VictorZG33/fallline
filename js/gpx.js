// GPX import/export, and a small IndexedDB store so imported tracks survive reloads.
import { haversine } from './terrain.js';

export function parseGpx(text, fallbackName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return [];
  const tracks = [];
  const read = (pts) =>
    [...pts].map((p) => {
      const ele = p.getElementsByTagName('ele')[0];
      const time = p.getElementsByTagName('time')[0];
      return [
        +(+p.getAttribute('lon')).toFixed(6),
        +(+p.getAttribute('lat')).toFixed(6),
        ele ? +(+ele.textContent).toFixed(1) : null,
        time ? Date.parse(time.textContent) || null : null,
      ];
    }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const nameOf = (el) => [...el.children].find((c) => c.localName === 'name')?.textContent?.trim();

  for (const trk of doc.getElementsByTagName('trk')) {
    const points = [...trk.getElementsByTagName('trkseg')].flatMap((seg) => read(seg.getElementsByTagName('trkpt')));
    if (points.length > 1) tracks.push({ name: nameOf(trk) || fallbackName, points });
  }
  for (const rte of doc.getElementsByTagName('rte')) {
    const points = read(rte.getElementsByTagName('rtept'));
    if (points.length > 1) tracks.push({ name: nameOf(rte) || fallbackName, points });
  }
  return tracks;
}

// Distance, climb and descent (with a 3 m hysteresis against GPS noise), time and top speed.
export function trackStats(points) {
  let distance = 0, ascent = 0, descent = 0, maxSpeed = 0;
  let ref = points.find((p) => p[2] !== null)?.[2] ?? null;
  for (let i = 1; i < points.length; i++) {
    distance += haversine(points[i - 1], points[i]);
    const e = points[i][2];
    if (e !== null && ref !== null) {
      if (e - ref > 3) { ascent += e - ref; ref = e; }
      else if (ref - e > 3) { descent += ref - e; ref = e; }
    }
  }
  // Top speed over windows of at least 10 s, so single bad fixes don't count.
  const timed = points.filter((p) => p[3]);
  for (let i = 0, j = 0, d = 0; i < timed.length; i++) {
    if (i > 0) d += haversine(timed[i - 1], timed[i]);
    while (j < i && timed[i][3] - timed[j + 1][3] >= 10000) {
      d -= haversine(timed[j], timed[j + 1]);
      j++;
    }
    const dt = (timed[i][3] - timed[j][3]) / 1000;
    if (dt >= 10) maxSpeed = Math.max(maxSpeed, d / dt);
  }
  const duration = timed.length > 1 ? (timed[timed.length - 1][3] - timed[0][3]) / 1000 : null;
  return { distance, ascent, descent, duration, maxSpeed: timed.length > 1 ? maxSpeed : null };
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function toGpx(name, coords, eles) {
  const pts = coords
    .map((c, i) => `<trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${eles?.[i] != null ? `<ele>${eles[i].toFixed(1)}</ele>` : ''}</trkpt>`)
    .join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Fall Line https://wentaoz.com/fallline/" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
      ${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function download(filename, text, type = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- IndexedDB -----------------------------------------------------------------

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fallline', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tracks', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('tracks', mode);
    const out = fn(t.objectStore('tracks'));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
  });
}

export const trackStore = {
  all: () => tx('readonly', (s) => s.getAll()).catch(() => []),
  put: (track) => tx('readwrite', (s) => s.put(track)).catch(() => {}),
  remove: (id) => tx('readwrite', (s) => s.delete(id)).catch(() => {}),
};
