// Main-thread side of the terrain engine: a request/reply wrapper around the
// workers, the `fl-shade://` MapLibre protocol for slope, aspect, winter
// satellite and Sentinel-2 tiles, and a main-thread fallback for browsers whose
// workers can't draw to a canvas.
import { createEngine } from './terrain.js';
import { createSentinel } from './sentinel.js';

let nextId = 1;
const pending = new Map();
let workers = [];
let local = null;
let localSentinel = null;
let lastOpen = null;
let lastScene = null;
// Two workers where there are cores to spare: the winter satellite map makes
// every visible tile a fair amount of work.
const POOL = (navigator.hardwareConcurrency || 2) >= 4 ? 2 : 1;

function startLocal() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  local = createEngine({
    decode: async (blob) => {
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height);
    },
  });
  localSentinel = createSentinel();
  if (lastOpen) local.setOpen(lastOpen);
  if (lastScene) localSentinel.setScene(lastScene);
  for (const [id, p] of pending) {
    pending.delete(id);
    runLocal(p.msg).then(p.resolve, p.reject);
  }
}

async function runLocal(msg) {
  if (msg.type === 'tile') {
    const rgba = msg.mode === 's2' ? await localSentinel.render(msg.z, msg.x, msg.y, msg.mask)
      : msg.mode === 'snow' ? await local.snowTile(msg.z, msg.x, msg.y)
      : await local.shadeTile(msg.mode, msg.z, msg.x, msg.y, msg.mask);
    return createImageBitmap(new ImageData(rgba, 512, 512));
  }
  if (msg.type === 'scene') return localSentinel.setScene(msg.scene);
  if (msg.type === 'sceneStats') return localSentinel.stats(msg.items, msg.bbox, msg.withSnow);
  if (msg.type === 'profile') return local.profile(msg.coords, msg.step);
  if (msg.type === 'point') return local.point(msg.lon, msg.lat);
  if (msg.type === 'heights') return local.heights(msg.points);
  if (msg.type === 'open') return local.setOpen(msg.lines);
  if (msg.type === 'area') return local.area(msg.rings);
}

function onMessage({ data }) {
  if (data.ready) return;
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.error) p.reject(new Error(data.error));
  else p.resolve(data.result);
}

if (typeof OffscreenCanvas !== 'undefined') {
  try {
    for (let i = 0; i < POOL; i++) {
      const w = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = onMessage;
      // A worker that can't run (no module workers, no 2D OffscreenCanvas):
      // drop them all and do the work here instead.
      w.onerror = () => {
        if (!workers.length) return;
        workers.forEach((x) => x.terminate());
        workers = [];
        startLocal();
      };
      workers.push(w);
    }
  } catch {
    workers = [];
  }
}
if (!workers.length) startLocal();

// Neighbouring tiles share DEM tiles, so 2x2 blocks of tiles go to one worker.
// Sentinel-2 work all goes to the last one: one image tile serves many map
// tiles, and it should be fetched and kept once.
function pick(msg) {
  if (msg.type === 'scene' || msg.type === 'sceneStats' || msg.mode === 's2') return workers[workers.length - 1];
  if (msg.type !== 'tile' || workers.length < 2) return workers[0];
  return workers[((msg.x >> 1) + (msg.y >> 1)) % workers.length];
}

function call(msg, signal, worker = pick(msg)) {
  if (!workers.length) return runLocal(msg);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { msg, resolve, reject });
    worker.postMessage({ ...msg, id });
    signal?.addEventListener('abort', () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      worker.postMessage({ type: 'cancel', id });
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

export const terrain = {
  profile: (coords, step = 20) => call({ type: 'profile', coords, step }),
  point: (lon, lat) => call({ type: 'point', lon, lat }),
  heights: (points) => call({ type: 'heights', points }),
  // Runs and lift lines the winter satellite map keeps clear of forest; every worker needs them.
  setOpen: (lines) => {
    lastOpen = lines;
    if (!workers.length) return runLocal({ type: 'open', lines });
    return Promise.all(workers.map((w) => call({ type: 'open', lines }, null, w)));
  },
  area: (rings) => call({ type: 'area', rings }),
  // The Sentinel-2 date to draw: { version, mode, items }.
  setScene: (scene) => {
    lastScene = scene;
    return call({ type: 'scene', scene });
  },
  sceneStats: (items, bbox, withSnow) => call({ type: 'sceneStats', items, bbox, withSnow }),
};

const SHADE_URL = /^fl-shade:\/\/(slope|aspect|snow|s2)\/(\d+)\/(\d+)\/(\d+)\?m=(\d+)/;

export function registerShadeProtocol(maplibregl) {
  maplibregl.addProtocol('fl-shade', async (params, abortController) => {
    const m = SHADE_URL.exec(params.url);
    if (!m) throw new Error(`Bad shade URL ${params.url}`);
    const bitmap = await call({ type: 'tile', mode: m[1], z: +m[2], x: +m[3], y: +m[4], mask: +m[5] }, abortController.signal);
    return { data: bitmap };
  });
}

export const shadeUrl = (mode, mask) => `fl-shade://${mode}/{z}/{x}/{y}?m=${mask}`;
