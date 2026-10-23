// The map style: basemaps, elevation, shading overlays, pistes and labels.
// buildStyle() makes the initial style; applyView() pushes later setting
// changes onto the live map without reloading it.
import { DEM_URL } from './terrain.js';
import { shadeUrl } from './terrain-client.js';

const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
const FONT_ITALIC = ['Noto Sans Italic'];

const ATTR = {
  dem: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
  esri: 'Imagery © <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics',
  topo: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  ofm: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a>',
  osm: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  ski: 'Pistes: <a href="https://openskidata.org">OpenSkiData</a> (ODbL)',
};

export const BASEMAPS = ['satellite', 'winter', 'topo'];

const z = (stops) => ['interpolate', ['linear'], ['zoom'], ...stops];

export function buildStyle(s) {
  const dem = { type: 'raster-dem', tiles: [DEM_URL], tileSize: 512, encoding: 'terrarium', maxzoom: 14, attribution: ATTR.dem };
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      'dem-terrain': dem,
      'dem-shade': { ...dem },
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 18,
        attribution: ATTR.esri,
      },
      topo: {
        type: 'raster',
        tiles: ['a', 'b', 'c'].map((h) => `https://${h}.tile.opentopomap.org/{z}/{x}/{y}.png`),
        tileSize: 256,
        maxzoom: 17,
        attribution: ATTR.topo,
      },
      ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: `${ATTR.ofm} ${ATTR.osm}` },
      slope: { type: 'raster', tiles: [shadeUrl('slope', s.slopeMask)], tileSize: 512, minzoom: 9, maxzoom: 16 },
      aspect: { type: 'raster', tiles: [shadeUrl('aspect', s.aspectMask)], tileSize: 512, minzoom: 9, maxzoom: 16 },
      pistes: { type: 'geojson', data: empty(), attribution: `${ATTR.ski} ${ATTR.osm}`, tolerance: 0.2 },
      tracks: { type: 'geojson', data: empty() },
      selection: { type: 'geojson', data: empty() },
    },
    terrain: { source: 'dem-terrain', exaggeration: s.exaggeration },
    sky: {
      'sky-color': '#7fb3e6',
      'horizon-color': '#dfe9f3',
      'fog-color': '#eef3f8',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.9,
      'atmosphere-blend': z([0, 1, 9, 1, 12, 0]),
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#eef1f4' } },
      { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-fade-duration': 150, 'raster-saturation': -0.1, 'raster-contrast': 0.05 } },
      { id: 'topo', type: 'raster', source: 'topo', paint: { 'raster-fade-duration': 150 } },

      // Winter basemap: snow white, forest in grey-green, ice faintly blue.
      { id: 'w-wood', type: 'fill', source: 'ofm', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': '#cfdccf', 'fill-opacity': 0.75 } },
      { id: 'w-ice', type: 'fill', source: 'ofm', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'ice'], paint: { 'fill-color': '#f6fbff' } },
      { id: 'w-water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': '#9fc0de' } },
      { id: 'w-waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway', minzoom: 11, paint: { 'line-color': '#9fc0de', 'line-width': z([11, 0.5, 15, 1.5]) } },
      { id: 'hillshade', type: 'hillshade', source: 'dem-shade', paint: { 'hillshade-method': 'igor', 'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#3d4f6b', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#5b6d88' } },
      { id: 'w-building', type: 'fill', source: 'ofm', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': '#c9ced6' } },
      {
        id: 'w-road', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 10,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#a3a9b3', 'line-width': z([10, 0.4, 14, 1.4, 17, 4]) },
      },

      // Real sun position, set from the sun panel.
      { id: 'sun', type: 'hillshade', source: 'dem-shade', layout: { visibility: 'none' }, paint: { 'hillshade-method': 'basic', 'hillshade-exaggeration': 1, 'hillshade-shadow-color': 'rgba(12,20,48,0.9)', 'hillshade-highlight-color': 'rgba(255,214,150,0.18)', 'hillshade-illumination-anchor': 'map' } },

      { id: 'slope', type: 'raster', source: 'slope', paint: { 'raster-opacity': s.slopeOpacity, 'raster-fade-duration': 120, 'raster-resampling': 'linear' } },
      { id: 'aspect', type: 'raster', source: 'aspect', paint: { 'raster-opacity': s.aspectOpacity, 'raster-fade-duration': 120 } },

      // Contour layers are added once maplibre-contour has registered its protocol.

      // Pistes
      { id: 'run-area', type: 'fill', source: 'pistes', filter: ['all', ['==', ['get', 'kind'], 'run'], ['==', ['geometry-type'], 'Polygon']], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.22 } },
      { id: 'run-area-edge', type: 'line', source: 'pistes', filter: ['all', ['==', ['get', 'kind'], 'run'], ['==', ['geometry-type'], 'Polygon']], paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.6 } },
      {
        id: 'run-casing', type: 'line', source: 'pistes', minzoom: 11,
        filter: ['all', ['==', ['get', 'kind'], 'run'], ['==', ['geometry-type'], 'LineString']],
        layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'rank'] },
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.85, 'line-width': z([11, 1.5, 13, 3, 16, 7]) },
      },
      runLine('run-line', 'solid', null),
      runLine('run-line-dash', 'dash', [2.2, 1.4]),
      runLine('run-line-dot', 'dot', [0.6, 1.6]),
      {
        id: 'lift-casing', type: 'line', source: 'pistes', minzoom: 11, filter: ['==', ['get', 'kind'], 'lift'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': z([11, 2, 13, 3.5, 16, 6]) },
      },
      {
        id: 'lift-line', type: 'line', source: 'pistes', minzoom: 11, filter: ['==', ['get', 'kind'], 'lift'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#15181d', 'line-width': z([11, 0.8, 13, 1.5, 16, 2.6]) },
      },
      {
        id: 'lift-station', type: 'circle', source: 'pistes', minzoom: 13, filter: ['==', ['get', 'kind'], 'station'],
        paint: { 'circle-radius': z([13, 2.5, 16, 4.5]), 'circle-color': '#ffffff', 'circle-stroke-color': '#15181d', 'circle-stroke-width': 1.5 },
      },
      { id: 'tracks-casing', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': z([10, 3, 16, 7]) } },
      { id: 'tracks', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff2d8a', 'line-width': z([10, 1.5, 16, 4]) } },
      { id: 'selection-glow', type: 'line', source: 'selection', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.7, 'line-blur': 3, 'line-width': z([11, 8, 16, 16]) } },
      { id: 'selection', type: 'line', source: 'selection', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['coalesce', ['get', 'color'], '#ff2d8a'], 'line-width': z([11, 3, 16, 6]) } },

      // Labels
      {
        id: 'place-label', type: 'symbol', source: 'ofm', 'source-layer': 'place',
        filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'hamlet'], true, false],
        layout: { 'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin']], 'text-font': FONT_BOLD, 'text-size': ['match', ['get', 'class'], 'city', 15, 'town', 13, 12], 'text-max-width': 8 },
        paint: { 'text-color': '#1d232b', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 },
      },
      {
        id: 'peak-label', type: 'symbol', source: 'ofm', 'source-layer': 'mountain_peak', minzoom: 10,
        filter: ['has', 'name'],
        layout: {
          'text-field': peakLabel('m'),
          'text-font': FONT_ITALIC, 'text-size': 12, 'text-anchor': 'bottom', 'text-max-width': 8,
          'symbol-sort-key': ['get', 'rank'], 'text-padding': 10,
        },
        paint: { 'text-color': '#2a2f36', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 },
      },
      {
        id: 'lift-label', type: 'symbol', source: 'pistes', minzoom: 13.5, filter: ['all', ['==', ['get', 'kind'], 'lift'], ['has', 'name']],
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT_ITALIC, 'text-size': 11, 'text-offset': [0, -0.8] },
        paint: { 'text-color': '#15181d', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      },
      runLabel('run-label', 'LineString', 'line'),
      runLabel('run-area-label', 'Polygon', 'point'),
    ],
  };
}

function peakLabel(units) {
  const ele = units === 'ft' ? ['concat', '\n', ['to-string', ['get', 'ele_ft']], ' ft'] : ['concat', '\n', ['to-string', ['get', 'ele']], ' m'];
  return ['format', '▲ ', { 'font-scale': 0.7 }, ['get', 'name'], {}, ['case', ['has', 'ele'], ele, ''], { 'font-scale': 0.85 }];
}

function runLine(id, style, dash) {
  return {
    id, type: 'line', source: 'pistes', minzoom: 10,
    filter: ['all', ['==', ['get', 'kind'], 'run'], ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'style'], style]],
    layout: { 'line-cap': dash ? 'butt' : 'round', 'line-join': 'round', 'line-sort-key': ['get', 'rank'] },
    paint: { 'line-color': ['get', 'color'], 'line-width': z([10, 1, 13, 1.8, 16, 3.6]), ...(dash ? { 'line-dasharray': dash } : {}) },
  };
}

function runLabel(id, geometry, placement) {
  return {
    id, type: 'symbol', source: 'pistes', minzoom: 13.5,
    filter: ['all', ['==', ['get', 'kind'], 'run'], ['==', ['geometry-type'], geometry], ['has', 'label']],
    layout: { 'symbol-placement': placement, 'text-field': ['get', 'label'], 'text-font': FONT_BOLD, 'text-size': 11, 'text-letter-spacing': 0.02 },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
  };
}

export const empty = () => ({ type: 'FeatureCollection', features: [] });

const vis = (on) => (on ? 'visible' : 'none');
const WINTER_LAYERS = ['w-wood', 'w-ice', 'w-water', 'w-waterway', 'hillshade', 'w-building', 'w-road'];
const PISTE_LAYERS = ['run-area', 'run-area-edge', 'run-casing', 'run-line', 'run-line-dash', 'run-line-dot', 'lift-casing', 'lift-line', 'lift-station', 'lift-label', 'run-label', 'run-area-label'];
export const CLICKABLE = ['lift-line', 'run-line', 'run-line-dash', 'run-line-dot', 'tracks', 'run-area'];

// Pushes the settings onto the live map. Cheap enough to call on every change.
export function applyView(map, s) {
  const set = (id, prop, value) => map.getLayer(id) && map.setLayoutProperty(id, prop, value);
  const paint = (id, prop, value) => map.getLayer(id) && map.setPaintProperty(id, prop, value);

  set('satellite', 'visibility', vis(s.basemap === 'satellite'));
  set('topo', 'visibility', vis(s.basemap === 'topo'));
  for (const id of WINTER_LAYERS) set(id, 'visibility', vis(s.basemap === 'winter'));
  set('slope', 'visibility', vis(s.overlay === 'slope'));
  set('aspect', 'visibility', vis(s.overlay === 'aspect'));
  paint('slope', 'raster-opacity', s.slopeOpacity);
  paint('aspect', 'raster-opacity', s.aspectOpacity);
  for (const id of PISTE_LAYERS) set(id, 'visibility', vis(s.pistes));
  for (const id of ['place-label', 'peak-label']) set(id, 'visibility', vis(s.labels));
  for (const id of ['contour-line', 'contour-label']) set(id, 'visibility', vis(s.contours));

  set('peak-label', 'text-field', peakLabel(s.units));

  const dark = s.basemap === 'satellite';
  for (const id of ['place-label', 'peak-label']) {
    paint(id, 'text-color', dark ? '#ffffff' : '#1d232b');
    paint(id, 'text-halo-color', dark ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)');
  }
  paint('contour-line', 'line-color', dark ? 'rgba(255,255,255,0.32)' : 'rgba(60,74,98,0.38)');
  paint('contour-label', 'text-color', dark ? 'rgba(255,255,255,0.85)' : '#4a5568');
  paint('contour-label', 'text-halo-color', dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)');
  paint('background', 'background-color', s.basemap === 'winter' ? '#f3f5f7' : '#20252b');

  if (map.getTerrain()?.exaggeration !== s.exaggeration) map.setTerrain({ source: 'dem-terrain', exaggeration: s.exaggeration });
}

export function setMasks(map, s) {
  map.getSource('slope')?.setTiles([shadeUrl('slope', s.slopeMask)]);
  map.getSource('aspect')?.setTiles([shadeUrl('aspect', s.aspectMask)]);
}

// Contours from maplibre-contour, drawn from the same Mapterhorn tiles. Call
// again after a units change to swap the intervals.
let demSource = null;
export async function addContours(map, maplibregl, s) {
  if (!demSource) {
    const { default: mlcontour } = await import('../vendor/maplibre-contour/maplibre-contour.mjs');
    demSource = new mlcontour.DemSource({ url: DEM_URL, encoding: 'terrarium', maxzoom: 12, worker: true, cacheSize: 60 });
    demSource.setupMaplibre(maplibregl);
  }
  for (const id of ['contour-label', 'contour-line']) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('contours')) map.removeSource('contours');
  map.addSource('contours', {
    type: 'vector',
    tiles: [demSource.contourProtocolUrl({
      multiplier: s.units === 'ft' ? 3.28084 : 1,
      thresholds: s.units === 'ft'
        ? { 11: [200, 1000], 12: [100, 500], 13: [100, 500], 14: [50, 250], 15: [20, 100] }
        : { 11: [100, 500], 12: [50, 250], 13: [50, 250], 14: [20, 100], 15: [10, 50] },
      elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours',
    })],
    maxzoom: 15,
  });
  const before = map.getLayer('run-area') ? 'run-area' : undefined;
  map.addLayer({
    id: 'contour-line', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: 11,
    paint: { 'line-color': 'rgba(60,74,98,0.38)', 'line-width': ['match', ['get', 'level'], 1, 1, 0.5] },
  }, before);
  map.addLayer({
    id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 12.5,
    filter: ['>', ['get', 'level'], 0],
    layout: { 'symbol-placement': 'line', 'text-field': ['number-format', ['get', 'ele'], {}], 'text-font': FONT, 'text-size': 10 },
    paint: { 'text-color': '#4a5568', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1 },
  }, before);
  applyView(map, s);
}
