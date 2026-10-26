// Recent Sentinel-2 imagery, read straight from the cloud-optimised GeoTIFFs
// that Element 84 keeps on AWS (sentinel-cogs, no key needed). Only the image
// tiles a map tile needs are fetched, with HTTP range requests, and inflated
// here. DOM-free: it runs in a terrain worker.

const D2R = Math.PI / 180;
const SIZE = 512;

// ---- A small cloud-optimised GeoTIFF reader ------------------------------------
// Enough for these files: classic TIFF, tiled, 8- or 16-bit pixel-interleaved
// samples, deflate with or without the horizontal predictor.

function parseHeader(buf) {
  const dv = new DataView(buf);
  const le = dv.getUint16(0) === 0x4949;
  if (dv.getUint16(2, le) !== 42) throw new Error('Not a classic TIFF');
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };
  const levels = [];
  let need = 0; // how far the header reaches past what was read
  const value = (type, count, at) => {
    const size = SIZES[type];
    if (!size) return null;
    const read = (o) => (type === 3 ? dv.getUint16(o, le) : type === 4 ? dv.getUint32(o, le) : type === 12 ? dv.getFloat64(o, le) : dv.getUint8(o));
    let off = at;
    if (count * size > 4) {
      off = dv.getUint32(at, le);
      if (off + count * size > buf.byteLength) {
        need = Math.max(need, off + count * size);
        return null;
      }
    }
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = read(off + i * size);
    return count === 1 ? out[0] : out;
  };
  let geo = null;
  for (let ifd = dv.getUint32(4, le); ifd; ) {
    if (ifd + 2 > buf.byteLength) { need = Math.max(need, ifd + 2); break; }
    const n = dv.getUint16(ifd, le);
    if (ifd + 2 + n * 12 + 4 > buf.byteLength) { need = Math.max(need, ifd + 2 + n * 12 + 4); break; }
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      tags[dv.getUint16(e, le)] = value(dv.getUint16(e + 2, le), dv.getUint32(e + 4, le), e + 8);
    }
    // Pixel size and the top-left corner, from the first image's GeoTIFF tags.
    if (!geo && tags[33550] && tags[33922]) geo = { res: tags[33550][0], x0: tags[33922][3], y0: tags[33922][4] };
    levels.push({
      width: tags[256], height: tags[257], tw: tags[322], th: tags[323],
      offsets: [].concat(tags[324]), counts: [].concat(tags[325]),
      samples: tags[277] || 1, bits: [].concat(tags[258] || 8)[0],
      compression: tags[259] || 1, predictor: tags[317] || 1,
    });
    ifd = dv.getUint32(ifd + 2 + n * 12, le);
  }
  return { levels, geo, le, need };
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- Web Mercator tiles to UTM -----------------------------------------------------

const lonOf = (px, z) => (px / (SIZE * 2 ** z)) * 360 - 180;
const latOf = (py, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / (SIZE * 2 ** z)))) / D2R;

// WGS84 to UTM (Snyder's series: well under a metre inside a zone and the few
// degrees past it that Sentinel-2 granules reach).
export function utm(lon, lat, zone, south) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), e4 = e2 * e2, e6 = e4 * e2;
  const phi = lat * D2R, lam0 = ((zone - 1) * 6 - 177) * D2R;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * sin * sin);
  const T = tan * tan, C = ep2 * cos * cos, A = cos * (lon * D2R - lam0);
  const M = a * ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const y = k0 * (M + N * tan * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return [x, south ? y + 10000000 : y];
}

// UTM coordinates of every pixel centre of a map tile: exact on a 17 x 17
// grid, bilinear in between (the projection is all but affine over 32 px).
const GRID = 16;
function tileUtm(z, x, y, epsg) {
  const zone = epsg % 100, south = epsg > 32700;
  const n = GRID + 1, ge = new Float64Array(n * n), gn = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const lat = latOf(y * SIZE + (j * SIZE) / GRID, z);
    for (let i = 0; i < n; i++) [ge[j * n + i], gn[j * n + i]] = utm(lonOf(x * SIZE + (i * SIZE) / GRID, z), lat, zone, south);
  }
  const E = new Float64Array(SIZE * SIZE), N = new Float64Array(SIZE * SIZE);
  const step = SIZE / GRID;
  for (let py = 0; py < SIZE; py++) {
    const gy = (py + 0.5) / step, j = Math.min(GRID - 1, Math.floor(gy)), fy = gy - j;
    for (let px = 0; px < SIZE; px++) {
      const gx = (px + 0.5) / step, i = Math.min(GRID - 1, Math.floor(gx)), fx = gx - i;
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      const k = py * SIZE + px;
      E[k] = (ge[a] * (1 - fx) + ge[b] * fx) * (1 - fy) + (ge[c] * (1 - fx) + ge[d] * fx) * fy;
      N[k] = (gn[a] * (1 - fx) + gn[b] * fx) * (1 - fy) + (gn[c] * (1 - fx) + gn[d] * fx) * fy;
    }
  }
  return { E, N, ge, gn };
}

// ---- Colour ---------------------------------------------------------------------------

// The red, green and blue bands are surface reflectance x 10000 (Element 84's
// COGs already have the offset taken out). ESA's ready-made true-colour image
// maps 0-0.255 straight to 0-255, so all snow, sunlit or shaded, comes out
// the same flat white. This curve keeps that slope in the shadows, so forest
// and rock look the same, and rolls off to reach white only at 0.85, fresh
// snow in full sun, so snow keeps its relief: it is ~0.3 in shade.
const KNEE = 0.25, WHITE = 0.85;
const curve = (r) => (r * (1 + KNEE)) / (r + KNEE);
const tone = (r) => (r <= 0 ? 0 : curve(r) / curve(WHITE));
const SATURATION = 1.1;
// The bands are 2 bytes a pixel and three of them: a map tile up to twice as
// coarse as the 10 m pixels (zoom 12, far off in a tilted view) reads the
// 20 m overview, a quarter of the data, and looks no different.
const BAND_SLACK = 2.2;

// Catmull-Rom weights, for drawing 10 m pixels on a finer map tile.
function cubic(t, w) {
  const t2 = t * t, t3 = t2 * t;
  w[0] = (-t3 + 2 * t2 - t) / 2;
  w[1] = (3 * t3 - 5 * t2 + 2) / 2;
  w[2] = (-3 * t3 + 4 * t2 + t) / 2;
  w[3] = (t3 - t2) / 2;
}

// ---- The reader --------------------------------------------------------------------

export function createSentinel({ fetchFn = (u, o) => fetch(u, o) } = {}) {
  const headers = new Map(); // url -> Promise<header>
  const tiles = new Map();   // key -> { p: Promise<typed array|null>, bytes }
  let tileBytes = 0;
  const TILE_BUDGET = 96 * 1024 * 1024;

  // A byte range, tried twice: a hole in the image would stay for good.
  async function range(url, from, to, retry = true) {
    try {
      const res = await fetchFn(url, { headers: { Range: `bytes=${from}-${to}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (!retry) throw err;
      await new Promise((r) => setTimeout(r, 800));
      return range(url, from, to, false);
    }
  }

  function header(url) {
    let p = headers.get(url);
    if (!p) {
      p = (async () => {
        // These headers run to under 4 KB; read more only if one doesn't.
        let h = parseHeader(await range(url, 0, 8191));
        if (h.need) h = parseHeader(await range(url, 0, h.need + 4095));
        if (!h.levels.length || !h.geo || h.need) throw new Error(`Unreadable header: ${url}`);
        return h;
      })();
      p.catch(() => headers.delete(url));
      headers.set(url, p);
      if (headers.size > 200) headers.delete(headers.keys().next().value);
    }
    return p;
  }

  // One decoded image tile, tw x th x samples values (Uint8Array or
  // Uint16Array), or null where the file has none.
  function tile(url, h, level, tx, ty) {
    const key = `${url}#${level}/${tx}/${ty}`;
    const hit = tiles.get(key);
    if (hit) {
      tiles.delete(key);
      tiles.set(key, hit);
      return hit.p;
    }
    const L = h.levels[level];
    const entry = { bytes: 0 };
    entry.p = (async () => {
      const i = ty * Math.ceil(L.width / L.tw) + tx;
      const off = L.offsets[i], len = L.counts[i];
      if (!len) return null;
      let bytes = new Uint8Array(await range(url, off, off + len - 1));
      if (L.compression === 8 || L.compression === 32946) bytes = await inflate(bytes);
      else if (L.compression !== 1) throw new Error(`TIFF compression ${L.compression} not supported`);
      let data = bytes;
      if (L.bits === 16) {
        if (!h.le) for (let k = 0; k + 1 < bytes.length; k += 2) [bytes[k], bytes[k + 1]] = [bytes[k + 1], bytes[k]];
        data = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
      }
      if (L.predictor === 2) {
        const row = L.tw * L.samples, mask = L.bits === 16 ? 0xffff : 0xff;
        for (let r = 0; r < L.th; r++) {
          const o = r * row;
          for (let k = o + L.samples; k < o + row; k++) data[k] = (data[k] + data[k - L.samples]) & mask;
        }
      }
      entry.bytes = data.byteLength;
      tileBytes += data.byteLength;
      for (const [k, old] of tiles) {
        if (tileBytes <= TILE_BUDGET) break;
        if (old === entry || !old.bytes) continue;
        tiles.delete(k);
        tileBytes -= old.bytes;
      }
      return data;
    })();
    entry.p.catch(() => tiles.delete(key));
    tiles.set(key, entry);
    return entry.p;
  }

  // The image tiles that cover a window of pixels of one overview level, in
  // one or more files laid out alike (the bands of a granule). at(c, r)
  // returns the offset of a pixel in each of `w.data[0..]` (set as a side
  // effect, to keep the per-pixel loops free of allocation), or -1.
  async function window(urls, hs, level, c0, r0, c1, r1) {
    const L = hs[0].levels[level];
    c0 = Math.max(0, Math.floor(c0)); r0 = Math.max(0, Math.floor(r0));
    c1 = Math.min(L.width - 1, Math.ceil(c1)); r1 = Math.min(L.height - 1, Math.ceil(r1));
    if (c0 > c1 || r0 > r1) return null;
    const { tw, th, samples } = L;
    const tx0 = Math.floor(c0 / tw), tx1 = Math.floor(c1 / tw), ty0 = Math.floor(r0 / th), ty1 = Math.floor(r1 / th);
    const nx = tx1 - tx0 + 1;
    const coords = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) coords.push([tx, ty]);
    const lists = await Promise.all(urls.map((u, n) => Promise.all(coords.map(([tx, ty]) => tile(u, hs[n], level, tx, ty).catch(() => null)))));
    const sets = coords.map((_, i) => (lists.every((l) => l[i]) ? lists.map((l) => l[i]) : null));
    if (!sets.some(Boolean)) return null;
    const w = {
      data: null,
      at(c, r) {
        if (c < c0 || c > c1 || r < r0 || r > r1) return -1;
        const tx = (c / tw) | 0, ty = (r / th) | 0;
        const set = sets[(ty - ty0) * nx + (tx - tx0)];
        if (!set) return -1;
        w.data = set;
        return ((r - ty * th) * tw + (c - tx * tw)) * samples;
      },
    };
    return w;
  }

  // The coarsest overview whose pixels are no bigger than `mpp` x `slack`.
  function pickLevel(h, mpp, slack = 1.5) {
    const w0 = h.levels[0].width;
    for (let l = h.levels.length - 1; l > 0; l--) if (h.geo.res * (w0 / h.levels[l].width) <= mpp * slack) return l;
    return 0;
  }

  // The dates the map has asked for lately, by version: tiles of a date seen
  // before can still be drawn after the next one is chosen.
  const scenes = new Map();
  function setScene(s) {
    scenes.delete(s.version);
    scenes.set(s.version, s);
    if (scenes.size > 16) scenes.delete(scenes.keys().next().value);
  }

  // The pixels of some files under a map tile, at the overview that suits it.
  async function cover(urls, g, mpp, slack) {
    const hs = await Promise.all(urls.map((u) => header(u).catch(() => null)));
    if (!hs.every(Boolean)) return null;
    const h = hs[0];
    const level = pickLevel(h, mpp, slack);
    if (hs.some((o) => o.levels[level]?.width !== h.levels[level].width || o.levels[level].tw !== h.levels[level].tw)) return null;
    const res = h.geo.res * (h.levels[0].width / h.levels[level].width);
    const { x0, y0 } = h.geo;
    let cmin = Infinity, cmax = -Infinity, rmin = Infinity, rmax = -Infinity;
    for (let k = 0; k < g.ge.length; k++) {
      const c = (g.ge[k] - x0) / res, r = (y0 - g.gn[k]) / res;
      if (c < cmin) cmin = c;
      if (c > cmax) cmax = c;
      if (r < rmin) rmin = r;
      if (r > rmax) rmax = r;
    }
    const w = await window(urls, hs, level, cmin - 2, rmin - 2, cmax + 2, rmax + 2);
    return w && { w, res, x0, y0 };
  }

  // A 512 px Web Mercator tile of the chosen date, RGBA. In photo mode it is
  // the red, green and blue bands through `tone`; in snow mode, the scene
  // classification, sharpened from 20 m to 10 m with the green band: snow in
  // ice blue, cloud hatched, snow-free ground tinted brown (over the winter
  // base map, whose snow is simulated), clear only where there is no image.
  async function render(z, x, y, version) {
    const out = new Uint8ClampedArray(SIZE * SIZE * 4);
    const s = scenes.get(version);
    if (!s || !s.items.length) return out;
    const west = lonOf(x * SIZE, z), east = lonOf((x + 1) * SIZE, z);
    const north = latOf(y * SIZE, z), south = latOf((y + 1) * SIZE, z);
    const mpp = (2 * Math.PI * 6378137 * Math.cos(((north + south) / 2) * D2R)) / (SIZE * 2 ** z);
    const snowMode = s.mode === 'snow';
    const filled = new Uint8Array(SIZE * SIZE);
    let left = SIZE * SIZE;
    const grids = new Map();
    const wx = new Float64Array(4), wy = new Float64Array(4);
    for (const item of s.items) {
      if (!left) break;
      const [bw, bs, be, bn] = item.bbox;
      if (be < west || bw > east || bn < south || bs > north) continue;
      if (!grids.has(item.epsg)) grids.set(item.epsg, tileUtm(z, x, y, item.epsg));
      const g = grids.get(item.epsg), { E, N } = g;

      if (snowMode) {
        const [scl, grn] = await Promise.all([cover([item.scl], g, mpp), cover([item.green], g, mpp, BAND_SLACK)]);
        if (!scl) continue;
        for (let k = 0; k < SIZE * SIZE; k++) {
          if (filled[k]) continue;
          const sc = Math.floor((E[k] - scl.x0) / scl.res), sr = Math.floor((scl.y0 - N[k]) / scl.res);
          const o = scl.w.at(sc, sr);
          if (o < 0) continue;
          let cls = scl.w.data[0][o];
          if (!cls) continue; // no data
          if (grn && (cls < 8 || cls > 10)) {
            const og = grn.w.at(Math.floor((E[k] - grn.x0) / grn.res), Math.floor((grn.y0 - N[k]) / grn.res));
            if (og >= 0) cls = refine(cls, grn.w.data[0][og] / 10000, scl.w, sc, sr);
          }
          filled[k] = 1;
          left--;
          sclColor(cls, (k & 511) + (k >> 9), out, k * 4);
        }
        continue;
      }

      const img = await cover([item.red, item.green, item.blue], g, mpp, BAND_SLACK);
      if (!img) continue;
      const { w, res, x0, y0 } = img;
      // Finer than the image: bicubic, so 10 m pixels don't show as diamonds.
      const smooth = res > mpp * 1.2;
      const taps = smooth ? 4 : 2, back = smooth ? 1 : 0;
      for (let k = 0; k < SIZE * SIZE; k++) {
        if (filled[k]) continue;
        const fc = (E[k] - x0) / res - 0.5, fr = (y0 - N[k]) / res - 0.5;
        const c = Math.floor(fc), r = Math.floor(fr), fx = fc - c, fy = fr - r;
        if (smooth) {
          cubic(fx, wx);
          cubic(fy, wy);
        } else {
          wx[0] = 1 - fx; wx[1] = fx;
          wy[0] = 1 - fy; wy[1] = fy;
        }
        // Weighted over the taps that have data (0 is no data at granule edges).
        let R = 0, G = 0, B = 0, W = 0;
        for (let j = 0; j < taps; j++) {
          for (let i = 0; i < taps; i++) {
            const o = w.at(c + i - back, r + j - back);
            if (o < 0) continue;
            const d = w.data, rv = d[0][o], gv = d[1][o], bv = d[2][o];
            if (!rv && !gv && !bv) continue;
            const wt = wx[i] * wy[j];
            R += rv * wt; G += gv * wt; B += bv * wt; W += wt;
          }
        }
        if (W < 0.5) continue;
        const tr = tone(R / W / 10000), tg = tone(G / W / 10000), tb = tone(B / W / 10000);
        const m = (tr + tg + tb) / 3;
        const q = k * 4;
        out[q] = 255 * (m + (tr - m) * SATURATION);
        out[q + 1] = 255 * (m + (tg - m) * SATURATION);
        out[q + 2] = 255 * (m + (tb - m) * SATURATION);
        out[q + 3] = 255;
        filled[k] = 1;
        left--;
      }
    }
    return out;
  }

  // One file's pixels at a list of [lon, lat] points, nearest, from the
  // overview that suits `mpp`: at(k) is an offset into `w.data[0]`, or -1.
  async function points(url, epsg, pts, mpp) {
    const h = await header(url).catch(() => null);
    if (!h) return null;
    const zone = epsg % 100, south = epsg > 32700;
    const level = pickLevel(h, mpp);
    const res = h.geo.res * (h.levels[0].width / h.levels[level].width);
    const cr = new Float64Array(pts.length * 2);
    let cmin = Infinity, cmax = -Infinity, rmin = Infinity, rmax = -Infinity;
    pts.forEach(([lon, lat], k) => {
      const [e, n] = utm(lon, lat, zone, south);
      const c = (e - h.geo.x0) / res, r = (h.geo.y0 - n) / res;
      cr[k * 2] = c; cr[k * 2 + 1] = r;
      cmin = Math.min(cmin, c); cmax = Math.max(cmax, c); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r);
    });
    const w = await window([url], [h], level, cmin, rmin, cmax, rmax);
    return w && { w, at: (k) => w.at(Math.floor(cr[k * 2]), Math.floor(cr[k * 2 + 1])) };
  }

  // Shares of cloud, snow and missing data over a bounding box, from the scene
  // classification read at about 160 m. Snow only with `withSnow`, which also
  // reads the green band, to count snow in shadow.
  async function stats(items, bbox, withSnow = false) {
    const n = 48, pts = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push([bbox[0] + ((i + 0.5) / n) * (bbox[2] - bbox[0]), bbox[3] - ((j + 0.5) / n) * (bbox[3] - bbox[1])]);
    const cls = new Uint8Array(pts.length);
    for (const item of items) {
      const [scl, grn] = await Promise.all([points(item.scl, item.epsg, pts, 107), withSnow ? points(item.green, item.epsg, pts, 107) : null]);
      if (!scl) continue;
      for (let k = 0; k < pts.length; k++) {
        if (cls[k]) continue;
        const o = scl.at(k);
        if (o < 0) continue;
        cls[k] = scl.w.data[0][o];
        if (grn && shaded(cls[k])) {
          const og = grn.at(k);
          if (og >= 0 && grn.w.data[0][og] / 10000 >= SHADE_SNOW) cls[k] = 11;
        }
      }
    }
    let valid = 0, cloud = 0, snow = 0;
    for (const c of cls) {
      if (!c) continue;
      valid++;
      if (c >= 8 && c <= 10) cloud++;
      else if (c === 11) snow++;
    }
    return { cover: valid / cls.length, cloud: valid ? cloud / valid : 1, snow: withSnow && valid ? snow / valid : null };
  }

  return { setScene, render, stats };
}

// Sen2Cor doesn't look for snow in terrain shadow: it calls it dark area (2),
// cloud shadow (3), unclassified (7) or saturated (1). In the green band snow
// in shade is still above ~0.12, where rock and forest in shade are below 0.08.
const shaded = (cls) => cls === 1 || cls === 2 || cls === 3 || cls === 7;
const SHADE_SNOW = 0.12;

// A 20 m class, sharpened with the 10 m green reflectance `g` under it: dark
// trees and rock inside a snow pixel aren't snow, bright snow at the edge of
// a snow pixel's neighbour is.
function refine(cls, g, sclWindow, sc, sr) {
  if (cls === 11) return g >= 0.09 ? 11 : 5;
  if (shaded(cls)) return g >= SHADE_SNOW ? 11 : cls;
  if (g >= 0.35 && (cls === 4 || cls === 5)) {
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = sclWindow.at(sc + dc, sr + dr);
      if (o >= 0 && sclWindow.data[0][o] === 11) return 11;
    }
  }
  return cls;
}

// Scene classification classes: 6 water, 8 and 9 cloud, 10 thin cirrus,
// 11 snow or ice; the rest is ground without snow.
function sclColor(cls, diag, out, q) {
  let c;
  if (cls === 11) c = [86, 204, 255, 210];
  else if (cls === 8 || cls === 9) c = diag % 12 < 3 ? [255, 255, 255, 200] : [226, 230, 236, 120];
  else if (cls === 10) c = diag % 12 < 2 ? [255, 255, 255, 150] : null; // thin cirrus: could be either
  else if (cls === 6) c = [40, 70, 110, 120];
  else c = [120, 92, 64, 130];
  if (!c) return;
  out[q] = c[0]; out[q + 1] = c[1]; out[q + 2] = c[2]; out[q + 3] = c[3];
}
