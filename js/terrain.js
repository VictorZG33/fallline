// Terrain engine: fetches Mapterhorn elevation tiles, keeps them decoded in a
// small cache, and turns them into slope and aspect tiles, elevation profiles
// and point readings. It runs inside terrain-worker.js, or on the main thread
// where workers can't decode images.

export const DEM_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const DEM_SIZE = 512;
const DEM_MAX_ZOOM = 17;   // the finest zoom Mapterhorn serves anywhere (1 m data)
const PROFILE_ZOOM = 14;   // about 3 m per pixel at mid latitudes
const CACHE_TILES = 32;    // 1 MB each once decoded
const EARTH = 6378137;
const D2R = Math.PI / 180;

// Slope bands start at 20° and step every 5°; the last band is 50° and over.
export const SLOPE_BANDS = [20, 25, 30, 35, 40, 45, 50];
const SLOPE_RGB = [
  [158, 214, 104], // 20–25
  [246, 226, 60],  // 25–30
  [248, 160, 30],  // 30–35
  [232, 66, 46],   // 35–40
  [182, 22, 120],  // 40–45
  [104, 52, 170],  // 45–50
  [30, 26, 60],    // 50+
];
// Aspect sectors clockwise from north; colour marks which way the slope faces.
export const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ASPECT_RGB = [
  [37, 99, 235], [6, 182, 212], [34, 197, 94], [234, 179, 8],
  [249, 115, 22], [239, 68, 68], [217, 70, 239], [139, 92, 246],
];
const ASPECT_MIN_SLOPE = 10;

export function slopeBand(deg) {
  if (!(deg >= SLOPE_BANDS[0])) return -1;
  return Math.min(SLOPE_BANDS.length - 1, Math.floor((deg - SLOPE_BANDS[0]) / 5));
}
export const slopeColor = (band) => (band < 0 ? null : SLOPE_RGB[band]);
export const aspectSector = (deg) => Math.round(deg / 45) % 8;
export const aspectColor = (sector) => ASPECT_RGB[sector];

// Web Mercator helpers, in global pixel units at zoom z for a 512 px tile grid.
const worldSize = (z) => DEM_SIZE * 2 ** z;
const lonToX = (lon, z) => ((lon + 180) / 360) * worldSize(z);
function latToY(lat, z) {
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(z);
}
const yToLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / worldSize(z))))  / D2R;
const metersPerPixel = (lat, z) => (2 * Math.PI * EARTH * Math.cos(lat * D2R)) / worldSize(z);

export function createEngine({ decode, fetchFn = (u, o) => fetch(u, o) }) {
  const tiles = new Map();   // "z/x/y" -> Promise<Float32Array|null>, in LRU order
  const missing = new Set(); // tiles that 404; their children are missing too

  const key = (z, x, y) => `${z}/${x}/${y}`;

  function isMissing(z, x, y) {
    for (; z >= 0; z--, x >>= 1, y >>= 1) if (missing.has(key(z, x, y))) return true;
    return false;
  }

  // One decoded elevation tile, or null where Mapterhorn has nothing.
  function tile(z, x, y) {
    const n = 2 ** z;
    if (y < 0 || y >= n) return Promise.resolve(null);
    x = ((x % n) + n) % n;
    const k = key(z, x, y);
    let p = tiles.get(k);
    if (p) {
      tiles.delete(k);
      tiles.set(k, p);
      return p;
    }
    if (isMissing(z, x, y)) return Promise.resolve(null);
    p = (async () => {
      const res = await fetchFn(DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      if (res.status === 404) {
        missing.add(k);
        return null;
      }
      if (!res.ok) throw new Error(`DEM ${k}: HTTP ${res.status}`);
      const img = await decode(await res.blob());
      const px = img.data;
      const h = new Float32Array(img.width * img.height);
      for (let i = 0, j = 0; i < h.length; i++, j += 4) h[i] = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
      return h;
    })();
    p.catch(() => tiles.delete(k)); // network errors are retried next time
    tiles.set(k, p);
    while (tiles.size > CACHE_TILES) tiles.delete(tiles.keys().next().value);
    return p;
  }

  // The finest zoom at or below z that has data for the tile containing (x, y) at z.
  async function bestZoom(z, x, y) {
    let failure = null;
    for (let zd = Math.min(z, DEM_MAX_ZOOM); zd >= 0; zd--) {
      const s = z - zd;
      try {
        if (await tile(zd, x >> s, y >> s)) return zd;
      } catch (err) {
        failure = err; // offline or flaky: a coarser tile may still be cached
      }
    }
    if (failure) throw failure;
    return -1;
  }

  // Bilinear sampler over the DEM tiles at zoom zd that cover a pixel window.
  // Pixel coordinates are global at zd. Tiles that don't exist are clamped to
  // the edge of the tile the window is centred on.
  async function sampler(zd, px0, py0, px1, py1) {
    const tx0 = Math.floor(px0 / DEM_SIZE), ty0 = Math.floor(py0 / DEM_SIZE);
    const tx1 = Math.floor(px1 / DEM_SIZE), ty1 = Math.floor(py1 / DEM_SIZE);
    const cols = tx1 - tx0 + 1;
    const grid = await Promise.all(
      Array.from({ length: cols * (ty1 - ty0 + 1) }, (_, i) => tile(zd, tx0 + (i % cols), ty0 + Math.floor(i / cols)).catch(() => null))
    );
    const ctx = Math.floor((px0 + px1) / 2 / DEM_SIZE), cty = Math.floor((py0 + py1) / 2 / DEM_SIZE);
    const centre = grid[(cty - ty0) * cols + (ctx - tx0)];
    if (!centre) return null;
    const lo = (c) => c * DEM_SIZE, hi = (c) => c * DEM_SIZE + DEM_SIZE - 1;
    function at(px, py) {
      let tx = Math.floor(px / DEM_SIZE), ty = Math.floor(py / DEM_SIZE);
      let t = tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1 ? grid[(ty - ty0) * cols + (tx - tx0)] : null;
      if (!t) {
        px = Math.max(lo(ctx), Math.min(hi(ctx), px));
        py = Math.max(lo(cty), Math.min(hi(cty), py));
        tx = ctx; ty = cty; t = centre;
      }
      return t[(py - ty * DEM_SIZE) * DEM_SIZE + (px - tx * DEM_SIZE)];
    }
    return function sample(gx, gy) {
      const u = gx - 0.5, v = gy - 0.5;
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const fx = u - x0, fy = v - y0;
      const a = at(x0, y0);
      if (fx === 0 && fy === 0) return a;
      const b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
  }

  // Elevation gradient (dz/dx east, dz/dy south) over the pixels a size x size
  // tile at (z, x, y) needs, measured across `baseline` metres. It uses the
  // finest DEM zoom available but no finer than the baseline calls for: coarser
  // zooms are averages of the fine data, so that alone removes most noise.
  // `blur` passes of a 3x3 box then average neighbouring gradient vectors.
  // Where the DEM is coarser than z, the shader interpolates the gradient
  // rather than the heights, so the result stays smooth instead of faceted.
  async function gradients(z, x, y, size, baseline, blur = 0) {
    const PAD = 8;
    let zd = await bestZoom(z, x, y);
    if (zd < 0) return null;
    const tileLat = yToLat((y + 0.5) * size, z + Math.log2(size / DEM_SIZE));
    while (zd > 0 && metersPerPixel(tileLat, zd) < baseline / 6) zd--;
    const s = 2 ** (z - zd) * (size / DEM_SIZE);
    const m = blur; // extra margin so blurred edges match the neighbouring tiles
    const nx0 = Math.floor((x * size + 0.5) / s - 0.5) - m, nx1 = Math.floor(((x + 1) * size - 0.5) / s - 0.5) + 1 + m;
    const ny0 = Math.floor((y * size + 0.5) / s - 0.5) - m, ny1 = Math.floor(((y + 1) * size - 0.5) / s - 0.5) + 1 + m;
    const W = nx1 - nx0 + 1, H = ny1 - ny0 + 1;
    const sample = await sampler(zd, nx0 - PAD, ny0 - PAD, nx1 + PAD, ny1 + PAD);
    if (!sample) return null;
    const pw = W + 2 * PAD;
    const h = new Float32Array(pw * (H + 2 * PAD));
    for (let j = 0; j < H + 2 * PAD; j++) {
      for (let i = 0; i < pw; i++) h[j * pw + i] = sample(nx0 - PAD + i + 0.5, ny0 - PAD + j + 0.5);
    }
    let gx = new Float32Array(W * H), gy = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
      const mpp = metersPerPixel(yToLat(ny0 + j + 0.5, zd), zd);
      const k = Math.max(1, Math.min(PAD, Math.round(baseline / 2 / mpp)));
      const norm = 1 / (8 * k * mpp);
      for (let i = 0; i < W; i++) {
        const c = (j + PAD) * pw + (i + PAD);
        const up = c - k * pw, dn = c + k * pw;
        const a = h[up - k], b = h[up], cc = h[up + k];
        const d = h[c - k], f = h[c + k];
        const g = h[dn - k], hh = h[dn], ii = h[dn + k];
        gx[j * W + i] = (cc + 2 * f + ii - (a + 2 * d + g)) * norm;
        gy[j * W + i] = (g + 2 * hh + ii - (a + 2 * b + cc)) * norm;
      }
    }
    for (let pass = 0; pass < blur; pass++) {
      gx = box3(gx, W, H);
      gy = box3(gy, W, H);
    }
    if (m) {
      const cw = W - 2 * m, ch = H - 2 * m;
      const cx = new Float32Array(cw * ch), cy = new Float32Array(cw * ch);
      for (let j = 0; j < ch; j++) {
        cx.set(gx.subarray((j + m) * W + m, (j + m) * W + m + cw), j * cw);
        cy.set(gy.subarray((j + m) * W + m, (j + m) * W + m + cw), j * cw);
      }
      return { s, nx0: nx0 + m, ny0: ny0 + m, W: cw, H: ch, gx: cx, gy: cy };
    }
    return { s, nx0, ny0, W, H, gx, gy };
  }

  // The slope overlay and the winter satellite map want the same gradients
  // for the same tile, so keep the last few.
  const gradCache = new Map();
  function cachedGradients(z, x, y, size, baseline, blur = 0) {
    const k = `${z}/${x}/${y}/${size}/${baseline}/${blur}`;
    let p = gradCache.get(k);
    if (p) {
      gradCache.delete(k);
      gradCache.set(k, p);
      return p;
    }
    p = gradients(z, x, y, size, baseline, blur);
    p.catch(() => gradCache.delete(k));
    gradCache.set(k, p);
    while (gradCache.size > 8) gradCache.delete(gradCache.keys().next().value);
    return p;
  }

  // Slope or aspect tile as RGBA. `mask` is a bit field of visible bands/sectors.
  async function shadeTile(mode, z, x, y, mask, size = DEM_SIZE) {
    const out = new Uint8ClampedArray(size * size * 4);
    // Slope over about 12 m keeps short steep pitches; Mapterhorn's height
    // steps (1/8 m at z14) would stripe the bands any finer. Aspect only needs
    // to say which way a slope faces, so it is read over ~40 m and smoothed.
    const gr = mode === 'slope' ? await cachedGradients(z, x, y, size, 12) : await cachedGradients(z, x, y, size, 40, 2);
    if (!gr) return out;
    const { s, nx0, ny0, W, H, gx, gy } = gr;
    for (let j = 0; j < size; j++) {
      const v = Math.min(H - 1, Math.max(0, (y * size + j + 0.5) / s - 0.5 - ny0));
      const y0 = Math.min(H - 2, Math.floor(v)), fy = v - y0;
      for (let i = 0; i < size; i++) {
        const u = Math.min(W - 1, Math.max(0, (x * size + i + 0.5) / s - 0.5 - nx0));
        const x0 = Math.min(W - 2, Math.floor(u)), fx = u - x0;
        const p = y0 * W + x0;
        const dzdx = lerp2(gx[p], gx[p + 1], gx[p + W], gx[p + W + 1], fx, fy);
        const dzdy = lerp2(gy[p], gy[p + 1], gy[p + W], gy[p + W + 1], fx, fy);
        const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) / D2R;
        const o = (j * size + i) * 4;
        if (mode === 'slope') {
          const band = slopeBand(slope);
          if (band < 0 || !(mask & (1 << band))) continue;
          const rgb = SLOPE_RGB[band];
          out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
        } else {
          if (slope < ASPECT_MIN_SLOPE) continue;
          // Downhill direction, clockwise from north (image rows run south).
          const aspect = (Math.atan2(-dzdx, dzdy) / D2R + 360) % 360;
          const sector = aspectSector(aspect);
          if (!(mask & (1 << sector))) continue;
          const rgb = ASPECT_RGB[sector];
          out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2];
          out[o + 3] = Math.round(255 * Math.min(1, 0.35 + (slope - ASPECT_MIN_SLOPE) / 25));
        }
      }
    }
    return out;
  }

  // The satellite imagery under a 512 px tile at (z, x, y): its four 256 px
  // children at z + 1, stitched. Quadrants that fail stay transparent.
  async function imagery(z, x, y) {
    const out = new Uint8ClampedArray(512 * 512 * 4);
    let any = false;
    await Promise.all([0, 1, 2, 3].map(async (q) => {
      const tx = 2 * x + (q & 1), ty = 2 * y + (q >> 1);
      try {
        const res = await fetchFn(IMAGERY_URL.replace('{z}', z + 1).replace('{y}', ty).replace('{x}', tx));
        if (!res.ok) return;
        const img = await decode(await res.blob());
        if (img.width !== 256 || img.height !== 256) return;
        for (let j = 0; j < 256; j++) out.set(img.data.subarray(j * 1024, (j + 1) * 1024), ((q >> 1) * 256 + j) * 2048 + (q & 1) * 1024);
        any = true;
      } catch {}
    }));
    return any ? out : null;
  }

  // Ski runs and lift lines, which are open ground whatever the imagery
  // suggests (summer grass on a trail can look a lot like canopy).
  let open = [];
  function setOpen(lines) {
    open = lines.map((l) => {
      let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const ring of l.polygon ? l.coords : [l.coords]) for (const [lon, lat] of ring) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
      return { ...l, bbox: [w, s, e, n] };
    });
  }

  // 0..1 per pixel: how surely each pixel of the tile lies on a run or lift line.
  function openMask(z, x, y, size) {
    const mask = new Float32Array(size * size);
    const lat = yToLat((y + 0.5) * size, z);
    const mpp = metersPerPixel(lat, z);
    const west = (x * size * 360) / worldSize(z) - 180, east = ((x + 1) * size * 360) / worldSize(z) - 180;
    const north = yToLat(y * size, z), south = yToLat((y + 1) * size, z);
    const pad = 0.002;
    const px = (lon) => lonToX(lon, z) - x * size, py = (la) => latToY(la, z) - y * size;
    for (const l of open) {
      const [w, s, e, n] = l.bbox;
      if (e < west - pad || w > east + pad || n < south - pad || s > north + pad) continue;
      if (l.polygon) {
        const rings = l.coords.map((ring) => ring.map(([lo, la]) => [px(lo), py(la)]));
        let y0 = Infinity, y1 = -Infinity;
        for (const [, yy] of rings[0]) { y0 = Math.min(y0, yy); y1 = Math.max(y1, yy); }
        for (let j = Math.max(0, Math.floor(y0)); j <= Math.min(size - 1, Math.ceil(y1)); j++) {
          const yc = j + 0.5, xs = [];
          for (const ring of rings) {
            for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
              const [xa, ya] = ring[m], [xb, yb] = ring[k];
              if (ya > yc !== yb > yc) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
            }
          }
          xs.sort((a, b) => a - b);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            for (let i = Math.max(0, Math.ceil(xs[k] - 0.5)); i <= Math.min(size - 1, Math.floor(xs[k + 1] - 0.5)); i++) mask[j * size + i] = 1;
          }
        }
        continue;
      }
      // Lines: a soft-edged stroke `half` metres either side of the centre line.
      const half = l.half / mpp, soft = 6 / mpp;
      const pts = l.coords.map(([lo, la]) => [px(lo), py(la)]);
      for (let k = 1; k < pts.length; k++) {
        const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
        const r = half + soft;
        const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), i1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + r));
        const j0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), j1 = Math.min(size - 1, Math.ceil(Math.max(ay, by) + r));
        if (i0 > i1 || j0 > j1) continue;
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const cx = i + 0.5 - ax, cy = j + 0.5 - ay;
            const t = Math.max(0, Math.min(1, (cx * dx + cy * dy) / len2));
            const d = Math.hypot(cx - t * dx, cy - t * dy);
            const v = d <= half ? 1 : 1 - (d - half) / soft;
            if (v > mask[j * size + i]) mask[j * size + i] = v;
          }
        }
      }
    }
    return mask;
  }

  // Simulated mid-winter imagery: snow laid over the summer satellite image
  // wherever it would lie. Forest stays dark: it is picked out of the image as
  // green, not bright, and holding the deep shadows that tree crowns cast
  // (grass of the same colour is smooth), and never on a mapped run or lift
  // line. Snow thins out between 38° and 56°, going first from the darkest
  // rock, so cliffs and rock ribs show through. It is lit by a low winter sun
  // from the south-east (north-east below the equator), the way a real
  // morning satellite pass sees it.
  async function snowTile(z, x, y) {
    const size = 512, N = size * size;
    const out = new Uint8ClampedArray(N * 4);
    const [img, gr] = await Promise.all([imagery(z, x, y), cachedGradients(z, x, y, size, 12)]);
    // No imagery at all (offline beyond what was saved): fail, and MapLibre
    // stretches the parent tile instead of showing blank snow.
    if (!img) throw new Error(`No imagery for ${z}/${x}/${y}`);

    // Per-pixel image measures for the forest test.
    const Yv = new Float32Array(N), Y2 = new Float32Array(N), Gv = new Float32Array(N), Sv = new Float32Array(N);
    for (let k = 0, o = 0; k < N; k++, o += 4) {
      const a = img[o + 3] ? 1 : 0;
      const r = a ? img[o] : 200, g = a ? img[o + 1] : 200, b = a ? img[o + 2] : 200;
      Yv[k] = 0.3 * r + 0.59 * g + 0.11 * b;
      Y2[k] = Yv[k] * Yv[k];
      Gv[k] = g;
      Sv[k] = r + g + b;
    }
    const gcc = boxMean(Gv, size, 2), sum = boxMean(Sv, size, 2), Ym = boxMean(Yv, size, 3), Ymin = minFilter(Yv, size, 2);
    const Y5 = boxMean(Yv, size, 2), Y25 = boxMean(Y2, size, 2);
    let tree = new Float32Array(N), bare = new Float32Array(N);
    for (let k = 0, o = 0; k < N; k++, o += 4) {
      const share = gcc[k] / Math.max(1, sum[k]);
      tree[k] = smooth(0.35, 0.375, share) * smooth(80, 50, Ymin[k]) * smooth(140, 100, Ym[k]);
      // Leafless hardwoods (imagery shot with the leaves off): brownish,
      // fairly dark from the shadows between trunks, not green. Bright tan
      // summer grass is too light to count.
      const warm = img[o + 3] ? img[o] - img[o + 2] : 0;
      bare[k] = smooth(0.355, 0.34, share) * smooth(3, 16, warm) * smooth(150, 112, Ym[k]);
    }
    tree = boxMean(tree, size, 1);
    bare = boxMean(bare, size, 2);
    const openGround = open.length ? openMask(z, x, y, size) : null;

    const lat = yToLat((y + 0.5) * size, z);
    const az = (lat >= 0 ? 150 : 30) * D2R, alt = 25 * D2R;
    const sx = Math.sin(az) * Math.cos(alt), sy = Math.cos(az) * Math.cos(alt), sz = Math.sin(alt);
    for (let j = 0; j < size; j++) {
      let y0 = 0, fy = 0;
      if (gr) {
        const v = Math.min(gr.H - 1, Math.max(0, (y * size + j + 0.5) / gr.s - 0.5 - gr.ny0));
        y0 = Math.min(gr.H - 2, Math.floor(v)); fy = v - y0;
      }
      for (let i = 0; i < size; i++) {
        let dzdx = 0, dzdy = 0;
        if (gr) {
          const u = Math.min(gr.W - 1, Math.max(0, (x * size + i + 0.5) / gr.s - 0.5 - gr.nx0));
          const x0 = Math.min(gr.W - 2, Math.floor(u)), fx = u - x0;
          const p = y0 * gr.W + x0, W = gr.W;
          dzdx = lerp2(gr.gx[p], gr.gx[p + 1], gr.gx[p + W], gr.gx[p + W + 1], fx, fy);
          dzdy = lerp2(gr.gy[p], gr.gy[p + 1], gr.gy[p + W], gr.gy[p + W + 1], fx, fy);
        }
        const k = j * size + i, o = k * 4;
        // Surface normal (east, north, up); image rows run south, so north is -dzdy.
        const nl = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
        const light = (-dzdx * sx + dzdy * sy + sz) / nl / sz; // 1 on flat ground
        const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) / D2R;

        const has = img[o + 3];
        const r = has ? img[o] : 200, g = has ? img[o + 1] : 200, b = has ? img[o + 2] : 200;
        const Y = Yv[k];

        // Snow: white in sun, pale blue in shade, with a trace of the image's
        // own detail so roads, lift lines and buildings still read. Where the
        // image is rough but not green (leafless hardwoods, boulder fields),
        // its darker pixels grey the snow, like the speckle of trunks and
        // rocks in real winter imagery. Groomed runs stay smooth.
        const t = clamp01(0.35 + 0.6 * light);
        const sd = Math.sqrt(Math.max(0, Y25[k] - Y5[k] * Y5[k]));
        const rough = smooth(10, 26, sd) * (1 - tree[k]) * (openGround ? 1 - openGround[k] : 1);
        const speckle = 1 - rough * 0.8 * (1 - clamp01(0.55 + (0.5 * Y) / Math.max(1, Ym[k])));
        const tex = (0.94 + 0.06 * Math.min(1.25, Y / 150)) * speckle;
        const snowR = (178 + 76 * t) * tex, snowG = (192 + 63 * t) * tex, snowB = (218 + 38 * t) * tex;
        // Rock: the image, darker, cooler and flatter, as rock looks against snow.
        const grey = Y * 0.78;
        const rockR = grey + (r - Y) * 0.45, rockG = grey + (g - Y) * 0.45, rockB = grey + (b - Y) * 0.45 + 5;
        // Forest: dark blue-green, still shaded by the terrain.
        const shade = 0.7 + 0.3 * clamp01(light);
        const treeR = (Y * 0.48 + 12) * shade, treeG = (Y * 0.58 + 22) * shade, treeB = (Y * 0.54 + 22) * shade;

        // Winter hardwoods: grey-brown, snow on the ground showing between trunks.
        const hardR = Y * 0.9 + 55, hardG = Y * 0.88 + 58, hardB = Y * 0.88 + 66;
        const cover = 1 - smooth(38, 56, slope);
        const dark = 1 - clamp01(Y / 200);
        const snow = smooth(0.35, 0.65, cover + 0.35 * (0.5 - dark));
        const clear = openGround ? 1 - openGround[k] : 1;
        const forest = tree[k] * clear;
        const leafless = bare[k] * clear * (1 - tree[k]) * 0.85;

        let br = rockR + (snowR - rockR) * snow, bg = rockG + (snowG - rockG) * snow, bb = rockB + (snowB - rockB) * snow;
        br += (hardR * shade - br) * leafless; bg += (hardG * shade - bg) * leafless; bb += (hardB * shade - bb) * leafless;
        out[o] = br + (treeR - br) * forest;
        out[o + 1] = bg + (treeG - bg) * forest;
        out[o + 2] = bb + (treeB - bb) * forest;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  // How brightly a sun at (azimuth, altitude) lights each pixel of a tile,
  // relative to flat ground: 1 on the flat, below 0 on slopes facing away.
  // Gives Sentinel-2 snow back the relief its true-colour image loses where
  // it saturates.
  async function lightTile(z, x, y, azimuth, altitude) {
    const size = DEM_SIZE;
    const gr = await cachedGradients(z, x, y, size, 12);
    if (!gr) return null;
    const { s, nx0, ny0, W, H, gx, gy } = gr;
    const az = azimuth * D2R, alt = Math.max(2, altitude) * D2R;
    const sx = Math.sin(az) * Math.cos(alt), sy = Math.cos(az) * Math.cos(alt), sz = Math.sin(alt);
    const out = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
      const v = Math.min(H - 1, Math.max(0, (y * size + j + 0.5) / s - 0.5 - ny0));
      const y0 = Math.min(H - 2, Math.floor(v)), fy = v - y0;
      for (let i = 0; i < size; i++) {
        const u = Math.min(W - 1, Math.max(0, (x * size + i + 0.5) / s - 0.5 - nx0));
        const x0 = Math.min(W - 2, Math.floor(u)), fx = u - x0;
        const p = y0 * W + x0;
        const dzdx = lerp2(gx[p], gx[p + 1], gx[p + W], gx[p + W + 1], fx, fy);
        const dzdy = lerp2(gy[p], gy[p + 1], gy[p + W], gy[p + W + 1], fx, fy);
        const nl = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
        out[j * size + i] = (-dzdx * sx + dzdy * sy + sz) / nl / sz;
      }
    }
    return out;
  }

  // Loads what's needed to read elevation at many points, then returns a
  // synchronous reader: (lon, lat) -> { ele, slope, aspect } or null.
  async function reader(points, zMax = PROFILE_ZOOM) {
    const zoomFor = new Map(); // zMax tile -> best zoom
    const need = new Map();    // zd tile key -> [zd, tx, ty]
    const offs = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [lon, lat] of points) {
      const tx = Math.floor(lonToX(lon, zMax) / DEM_SIZE), ty = Math.floor(latToY(lat, zMax) / DEM_SIZE);
      const k = key(zMax, tx, ty);
      if (!zoomFor.has(k)) zoomFor.set(k, await bestZoom(zMax, tx, ty).catch(() => -1));
      const zd = zoomFor.get(k);
      if (zd < 0) continue;
      const gx = lonToX(lon, zd), gy = latToY(lat, zd);
      for (const [ox, oy] of offs) {
        const t = [zd, Math.floor((gx + ox * 4) / DEM_SIZE), Math.floor((gy + oy * 4) / DEM_SIZE)];
        need.set(key(...t), t);
      }
    }
    const loaded = new Map();
    await Promise.all([...need.values()].map(async ([zd, tx, ty]) => loaded.set(key(zd, tx, ty), await tile(zd, tx, ty).catch(() => null))));

    function height(zd, gx, gy) {
      const u = gx - 0.5, v = gy - 0.5;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      const at = (px, py) => {
        const t = loaded.get(key(zd, Math.floor(px / DEM_SIZE), Math.floor(py / DEM_SIZE)));
        if (!t) return NaN;
        return t[(py - Math.floor(py / DEM_SIZE) * DEM_SIZE) * DEM_SIZE + (px - Math.floor(px / DEM_SIZE) * DEM_SIZE)];
      };
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }

    return function read(lon, lat) {
      const tx = Math.floor(lonToX(lon, zMax) / DEM_SIZE), ty = Math.floor(latToY(lat, zMax) / DEM_SIZE);
      const zd = zoomFor.get(key(zMax, tx, ty));
      if (zd === undefined || zd < 0) return null;
      const gx = lonToX(lon, zd), gy = latToY(lat, zd);
      const ele = height(zd, gx, gy);
      if (Number.isNaN(ele)) return null;
      // Gradient over about 12 m, as in the shaded tiles.
      const mpp = metersPerPixel(lat, zd);
      const step = Math.max(1, Math.min(4, 6 / mpp));
      const dzdx = (height(zd, gx + step, gy) - height(zd, gx - step, gy)) / (2 * step * mpp);
      const dzdy = (height(zd, gx, gy + step) - height(zd, gx, gy - step)) / (2 * step * mpp);
      if (Number.isNaN(dzdx) || Number.isNaN(dzdy)) return { ele, slope: null, aspect: null };
      return {
        ele,
        slope: Math.atan(Math.hypot(dzdx, dzdy)) / D2R,
        aspect: (Math.atan2(-dzdx, dzdy) / D2R + 360) % 360,
      };
    };
  }

  // Resamples a line every `step` metres and reads the DEM along it.
  async function profile(coords, step = 20) {
    const pts = [];
    const dist = [];
    let total = 0;
    for (let i = 0; i < coords.length; i++) {
      if (i === 0) {
        pts.push(coords[0]);
        dist.push(0);
        continue;
      }
      const [a, b] = [coords[i - 1], coords[i]];
      const seg = haversine(a, b);
      const nSteps = Math.max(1, Math.ceil(seg / step));
      for (let s = 1; s <= nSteps; s++) {
        const t = s / nSteps;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        dist.push(total + seg * t);
      }
      total += seg;
    }
    const read = await reader(pts);
    const ele = [], slope = [];
    for (const p of pts) {
      const r = read(p[0], p[1]);
      ele.push(r ? Math.round(r.ele * 10) / 10 : null);
      slope.push(r && r.slope !== null ? Math.round(r.slope * 10) / 10 : null);
    }
    return { dist, ele, slope, pts: pts.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]) };
  }

  async function point(lon, lat) {
    const read = await reader([[lon, lat]], 15);
    return read(lon, lat);
  }

  // Elevation at many points (null where there is no data).
  async function heights(points) {
    const read = await reader(points);
    return points.map(([lon, lat]) => {
      const r = read(lon, lat);
      return r ? Math.round(r.ele * 10) / 10 : null;
    });
  }

  // Slope statistics over a polygon (outer ring first), on a grid of about 15 m.
  async function area(rings) {
    const outer = rings[0];
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    const midLat = (s + n) / 2;
    let spacing = 15;
    const widthM = (e - w) * 111320 * Math.cos(midLat * D2R), heightM = (n - s) * 110540;
    while ((widthM / spacing) * (heightM / spacing) > 4000) spacing *= 1.5;
    const dLon = spacing / (111320 * Math.cos(midLat * D2R)), dLat = spacing / 110540;
    const pts = [];
    for (let y = s + dLat / 2; y < n; y += dLat) for (let x = w + dLon / 2; x < e; x += dLon) if (inPolygon([x, y], rings)) pts.push([x, y]);
    if (!pts.length) return null;
    const read = await reader(pts);
    const slopes = [], eles = [];
    for (const p of pts) {
      const r = read(p[0], p[1]);
      if (!r) continue;
      eles.push(r.ele);
      if (r.slope !== null) slopes.push(r.slope);
    }
    if (!eles.length) return null;
    slopes.sort((a, b) => a - b);
    const q = (f) => slopes[Math.min(slopes.length - 1, Math.floor(f * slopes.length))];
    return {
      top: Math.max(...eles),
      bottom: Math.min(...eles),
      slopeMean: slopes.reduce((t, v) => t + v, 0) / (slopes.length || 1),
      slopeP90: q(0.9),
      slopeMax: slopes[slopes.length - 1],
      areaM2: pts.length * spacing * spacing,
    };
  }

  return { shadeTile, snowTile, lightTile, setOpen, profile, point, heights, area };
}

// One pass of a 3x3 box filter, edges clamped.
function box3(src, W, H) {
  const out = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const j0 = j > 0 ? j - 1 : 0, j1 = j < H - 1 ? j + 1 : H - 1;
    for (let i = 0; i < W; i++) {
      const i0 = i > 0 ? i - 1 : 0, i1 = i < W - 1 ? i + 1 : W - 1;
      out[j * W + i] = (src[j0 * W + i0] + src[j0 * W + i] + src[j0 * W + i1] + src[j * W + i0] + src[j * W + i] + src[j * W + i1] + src[j1 * W + i0] + src[j1 * W + i] + src[j1 * W + i1]) / 9;
    }
  }
  return out;
}

// Mean over a (2r+1)² window (edges clamped), via a summed-area table.
function boxMean(src, size, r) {
  const S = new Float64Array((size + 1) * (size + 1));
  for (let j = 0; j < size; j++) {
    let row = 0;
    for (let i = 0; i < size; i++) {
      row += src[j * size + i];
      S[(j + 1) * (size + 1) + i + 1] = S[j * (size + 1) + i + 1] + row;
    }
  }
  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const j0 = Math.max(0, j - r), j1 = Math.min(size, j + r + 1);
    for (let i = 0; i < size; i++) {
      const i0 = Math.max(0, i - r), i1 = Math.min(size, i + r + 1);
      out[j * size + i] = (S[j1 * (size + 1) + i1] - S[j0 * (size + 1) + i1] - S[j1 * (size + 1) + i0] + S[j0 * (size + 1) + i0]) / ((j1 - j0) * (i1 - i0));
    }
  }
  return out;
}

// Minimum over a (2r+1)² window, separably.
function minFilter(src, size, r) {
  const tmp = new Float32Array(size * size), out = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let m = Infinity;
      for (let k = Math.max(0, i - r); k <= Math.min(size - 1, i + r); k++) m = Math.min(m, src[j * size + k]);
      tmp[j * size + i] = m;
    }
  }
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let m = Infinity;
      for (let k = Math.max(0, j - r); k <= Math.min(size - 1, j + r); k++) m = Math.min(m, tmp[k * size + i]);
      out[j * size + i] = m;
    }
  }
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// Smoothstep from edge a to edge b (b may be below a, for a falling edge).
function smooth(a, b, v) {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

const lerp2 = (a, b, c, d, fx, fy) => a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;

export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * D2R, dLon = (b[0] - a[0]) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function inPolygon(p, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
