// Terrain engine: fetches Mapterhorn elevation tiles, keeps them decoded in a
// small cache, and turns them into slope and aspect tiles, elevation profiles
// and point readings. It runs inside terrain-worker.js, or on the main thread
// where workers can't decode images.

export const DEM_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
const DEM_SIZE = 512;
const DEM_MAX_ZOOM = 17;   // the finest zoom Mapterhorn serves anywhere (1 m data)
const PROFILE_ZOOM = 14;   // about 3 m per pixel at mid latitudes
const CACHE_TILES = 40;    // 1 MB each once decoded
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

  // Elevation gradient (dz/dx east, dz/dy south) at native DEM resolution over
  // the pixels a size x size tile at (z, x, y) needs, from the finest zoom
  // available. Where that zoom is coarser than z, the shader interpolates the
  // gradient rather than the heights, so slopes stay smooth instead of faceted.
  async function gradients(z, x, y, size) {
    const PAD = 8;
    const zd = await bestZoom(z, x, y);
    if (zd < 0) return null;
    const s = 2 ** (z - zd) * (size / DEM_SIZE);
    const nx0 = Math.floor((x * size + 0.5) / s - 0.5), nx1 = Math.floor(((x + 1) * size - 0.5) / s - 0.5) + 1;
    const ny0 = Math.floor((y * size + 0.5) / s - 0.5), ny1 = Math.floor(((y + 1) * size - 0.5) / s - 0.5) + 1;
    const W = nx1 - nx0 + 1, H = ny1 - ny0 + 1;
    const sample = await sampler(zd, nx0 - PAD, ny0 - PAD, nx1 + PAD, ny1 + PAD);
    if (!sample) return null;
    const pw = W + 2 * PAD;
    const h = new Float32Array(pw * (H + 2 * PAD));
    for (let j = 0; j < H + 2 * PAD; j++) {
      for (let i = 0; i < pw; i++) h[j * pw + i] = sample(nx0 - PAD + i + 0.5, ny0 - PAD + j + 0.5);
    }
    const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
      const mpp = metersPerPixel(yToLat(ny0 + j + 0.5, zd), zd);
      // Measure slope over about 12 m, so 1 m data doesn't turn every rock into
      // a cliff and Mapterhorn's height steps (1/8 m at z14) don't stripe the bands.
      const k = Math.max(1, Math.min(PAD, Math.round(6 / mpp)));
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
    return { s, nx0, ny0, W, H, gx, gy };
  }

  // Slope or aspect tile as RGBA. `mask` is a bit field of visible bands/sectors.
  async function shadeTile(mode, z, x, y, mask, size = DEM_SIZE) {
    const out = new Uint8ClampedArray(size * size * 4);
    const gr = await gradients(z, x, y, size);
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

  return { shadeTile, profile, point, area };
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
