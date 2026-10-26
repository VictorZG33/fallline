// Module worker hosting the terrain engine. Messages carry an id; replies echo it.
import { createEngine } from './terrain.js';
import { createSentinel } from './sentinel.js';

async function decode(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { width, height } = bmp;
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, width, height);
}

const engine = createEngine({ decode });
const sentinel = createSentinel();
const cancelled = new Set();

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  try {
    if (msg.type === 'tile') {
      if (cancelled.delete(msg.id)) return;
      const rgba = msg.mode === 's2' ? await sentinel.render(msg.z, msg.x, msg.y, msg.mask)
        : msg.mode === 'snow' ? await engine.snowTile(msg.z, msg.x, msg.y)
        : await engine.shadeTile(msg.mode, msg.z, msg.x, msg.y, msg.mask);
      if (cancelled.delete(msg.id)) return;
      const bitmap = await createImageBitmap(new ImageData(rgba, 512, 512));
      self.postMessage({ id: msg.id, result: bitmap }, [bitmap]);
    } else if (msg.type === 'profile') {
      self.postMessage({ id: msg.id, result: await engine.profile(msg.coords, msg.step) });
    } else if (msg.type === 'point') {
      self.postMessage({ id: msg.id, result: await engine.point(msg.lon, msg.lat) });
    } else if (msg.type === 'open') {
      engine.setOpen(msg.lines);
      self.postMessage({ id: msg.id, result: true });
    } else if (msg.type === 'heights') {
      self.postMessage({ id: msg.id, result: await engine.heights(msg.points) });
    } else if (msg.type === 'scene') {
      sentinel.setScene(msg.scene);
      self.postMessage({ id: msg.id, result: true });
    } else if (msg.type === 'sceneStats') {
      self.postMessage({ id: msg.id, result: await sentinel.stats(msg.items, msg.bbox, msg.withSnow) });
    } else if (msg.type === 'area') {
      self.postMessage({ id: msg.id, result: await engine.area(msg.rings) });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message ? err.message : err) });
  }
};

self.postMessage({ ready: true });
