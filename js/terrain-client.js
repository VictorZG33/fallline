// Main-thread side of the terrain engine: a request/reply wrapper around the
// worker, the `fl-shade://` MapLibre protocol for slope and aspect tiles, and a
// main-thread fallback for browsers whose workers can't draw to a canvas.
import { createEngine } from './terrain.js';

let nextId = 1;
const pending = new Map();
let worker = null;
let local = null;

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
  for (const [id, p] of pending) {
    pending.delete(id);
    runLocal(p.msg).then(p.resolve, p.reject);
  }
}

async function runLocal(msg) {
  if (msg.type === 'tile') return createImageBitmap(new ImageData(await local.shadeTile(msg.mode, msg.z, msg.x, msg.y, msg.mask), 512, 512));
  if (msg.type === 'profile') return local.profile(msg.coords, msg.step);
  if (msg.type === 'point') return local.point(msg.lon, msg.lat);
  if (msg.type === 'heights') return local.heights(msg.points);
  if (msg.type === 'area') return local.area(msg.rings);
}

if (typeof OffscreenCanvas !== 'undefined') {
  try {
    worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.ready) return;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    worker.onerror = () => {
      worker = null;
      startLocal();
    };
  } catch {
    worker = null;
  }
}
if (!worker) startLocal();

function call(msg, signal) {
  if (local && !worker) return runLocal(msg);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { msg, resolve, reject });
    worker.postMessage({ ...msg, id });
    signal?.addEventListener('abort', () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      worker?.postMessage({ type: 'cancel', id });
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

export const terrain = {
  profile: (coords, step = 20) => call({ type: 'profile', coords, step }),
  point: (lon, lat) => call({ type: 'point', lon, lat }),
  heights: (points) => call({ type: 'heights', points }),
  area: (rings) => call({ type: 'area', rings }),
};

const SHADE_URL = /^fl-shade:\/\/(slope|aspect)\/(\d+)\/(\d+)\/(\d+)\?m=(\d+)/;

export function registerShadeProtocol(maplibregl) {
  maplibregl.addProtocol('fl-shade', async (params, abortController) => {
    const m = SHADE_URL.exec(params.url);
    if (!m) throw new Error(`Bad shade URL ${params.url}`);
    const bitmap = await call({ type: 'tile', mode: m[1], z: +m[2], x: +m[3], y: +m[4], mask: +m[5] }, abortController.signal);
    return { data: bitmap };
  });
}

export const shadeUrl = (mode, mask) => `fl-shade://${mode}/{z}/{x}/{y}?m=${mask}`;
