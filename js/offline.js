// "Save this area": lists every tile the map needs for the area on screen and
// asks the service worker to fetch them into a cache it never evicts.

const MAX_TILES = 3000;
const SIZE_KB = { dem: 130, satellite: 22, topo: 30, ofm: 45 };

function tileRange(bbox, z) {
  const n = 2 ** z;
  const x = (lon) => Math.floor(((lon + 180) / 360) * n);
  const y = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  return [x(bbox[0]), y(bbox[3]), x(bbox[2]), y(bbox[1])];
}

// The area to save: what's on screen, but no more than ~12 km across around
// the centre (a pitched 3D view reaches the horizon).
export function saveArea(map) {
  const b = map.getBounds();
  const c = map.getCenter();
  const dLat = 6 / 111.2;
  const dLon = dLat / Math.cos((c.lat * Math.PI) / 180);
  return [
    Math.max(b.getWest(), c.lng - dLon), Math.max(b.getSouth(), c.lat - dLat),
    Math.min(b.getEast(), c.lng + dLon), Math.min(b.getNorth(), c.lat + dLat),
  ];
}

export function plan(map, basemap, bbox) {
  const urls = [];
  let kb = 0;
  const add = (source, kind, zmin, zmax) => {
    const tiles = map.getSource(source)?.tiles;
    if (!tiles?.length) return;
    for (let z = zmin; z <= zmax; z++) {
      const [x0, y0, x1, y1] = tileRange(bbox, z);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const tpl = tiles[(x + y) % tiles.length];
          urls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
          kb += SIZE_KB[kind];
        }
      }
    }
  };
  add('dem-terrain', 'dem', 8, 14);
  // The winter satellite map is drawn from the same imagery.
  if (basemap === 'satellite' || basemap === 'snow') add('satellite', 'satellite', 10, 16);
  if (basemap === 'topo') add('topo', 'topo', 10, 16);
  add('ofm', 'ofm', 8, 14);
  return { urls: urls.slice(0, MAX_TILES), mb: Math.round(kb / 1024), truncated: urls.length > MAX_TILES };
}

export function download(urls, onProgress) {
  return new Promise((resolve, reject) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return reject(new Error('no service worker'));
    const ch = new MessageChannel();
    ch.port1.onmessage = ({ data }) => {
      onProgress?.(data.done, data.total);
      if (data.done >= data.total) resolve(data);
    };
    sw.postMessage({ type: 'save', urls }, [ch.port2]);
  });
}

export async function clear() {
  for (const k of await caches.keys()) if (k.startsWith('fl-tiles') || k.startsWith('fl-offline')) await caches.delete(k);
}

export async function usedMB() {
  try {
    const est = await navigator.storage.estimate();
    return Math.round((est.usage || 0) / 1048576);
  } catch {
    return null;
  }
}
