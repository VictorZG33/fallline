# Fall Line · 滚落线

A free 3D ski map for planning ski days, built to bring back what FATMAP did
best. Live at **https://wentaoz.com/fallline/** once GitHub Pages is on (see
[Deploy](#deploy)).

FATMAP 被 Strava 收购后下线了。滚落线把它最好用的部分做回来：3D 地形、坡度和坡向着色、全球雪道和缆车、GPX 轨迹，以及离线地图。手机上用浏览器打开，"添加到主屏幕"就像原生 app。

## What it does

- **3D terrain** you can tilt and spin, on satellite imagery, a white winter
  map, or OpenTopoMap.
- **Winter satellite** (the default): snow laid over the summer imagery in the
  browser, the way FATMAP's winter imagery looked. Forest stays dark, groomed
  runs and lift lines stay white, snow thins out from 38° and is gone by 56°
  so cliffs and rock bands show, and the snow is lit by a low winter sun. It
  shows where snow would lie, not this season's conditions.
- **Recent satellite**: real 10 m Sentinel-2 images from the last two months,
  to see this season's snow line and where rock is showing. It picks the
  latest clear day over the view on its own; step through older passes on a
  timeline coloured by cloud. The image is drawn from the raw red, green and
  blue bands with a curve that keeps snow's sun and shade, where ESA's
  ready-made true-colour image turns all snow flat white. "Snow cover" mode
  shows ESA's snow classification, sharpened to 10 m, over any base map.
- **Slope-angle shading** in 5° bands from 20° up, on the usual avalanche-terrain
  breaks (30°, 35°, 45°). Tap a band in the legend to hide it, for example to
  show only 30° and steeper.
- **Aspect shading**: which way every slope faces, to find cold north-facing
  snow or spring corn on the south faces. Tap compass sectors to filter.
- **Sun & shade**: hillshading from the real sun position for any date and
  time, with sunrise and sunset.
- **Runs and lifts** coloured by local convention (green / blue / black diamond
  in North America and China, blue / red / black in Europe, and so on). 52
  resorts ship as offline packs; everywhere else loads live from OpenStreetMap.
- **Tap a run** for the whole trail (OpenStreetMap's sections joined up): its
  length, vertical, average pitch, steepest 30 m, and an elevation profile
  coloured by the pitch along the run. Scrub the profile to see that point on
  the map. "Fly down" flies the camera down the run.
- **Tap anywhere** for elevation, slope angle and aspect at that spot.
- **GPX**: import tracks from a watch or phone (stats, profile, replay), export
  any run as GPX.
- **Offline**: install it to the home screen, then "Save this area" before you
  go. Terrain, slope shading, imagery and runs work without signal.
- **Search** 4,762 downhill ski areas worldwide, offline, plus place search.
- Chinese and English, metric and imperial.

Slope shading is a planning aid. It is not an avalanche forecast.

## How it works

No build step: plain ES modules served as static files.

| Piece | Where |
| --- | --- |
| Map engine | [MapLibre GL JS](https://maplibre.org) 6.13, vendored in `vendor/` |
| Elevation | [Mapterhorn](https://mapterhorn.com) terrain tiles (1–10 m in the US, the Alps, Japan, Scandinavia; 30 m elsewhere) |
| Slope and aspect | `js/terrain.js`, in a Web Worker: decodes the elevation tiles, takes the gradient (Horn's method) over about 12 m for slope and 40 m, smoothed, for aspect, and colours each pixel. Served to MapLibre through the `fl-shade://` protocol |
| Runs and lifts | [OpenSkiData](https://openskidata.org) packs in `data/packs/` (built by `tools/build-data.mjs`), else live from the [Overpass API](https://overpass-api.de) |
| Contours | [maplibre-contour](https://github.com/onthegomap/maplibre-contour), from the same elevation tiles |
| Imagery | Esri World Imagery; OpenTopoMap; [OpenFreeMap](https://openfreemap.org) vector tiles for the winter map and labels |
| Recent satellite | `js/recent.js` finds passes with [Earth Search](https://element84.com/earth-search/) (Element 84's STAC API); `js/sentinel.js`, in the worker, reads the red, green, blue and scene-classification images straight from the open [Sentinel-2 COGs on AWS](https://registry.opendata.aws/sentinel-2-l2a-cogs/) with range requests. No keys |
| Winter satellite | `snowTile` in `js/terrain.js`: Esri tiles plus the DEM gradient; forest is found in the image (green, not bright, with crown shadows), leafless hardwoods by colour, and runs from the piste data |
| Offline | `sw.js` caches the app, every tile you have seen (up to 6,000), and areas you save |

```
index.html          the page
css/app.css         all styles
js/app.js           settings, panels, search, wiring
js/style.js         the MapLibre style and how settings change it
js/terrain.js       elevation tiles → slope/aspect tiles, profiles, point readings
js/terrain-*.js     the worker and its main-thread client
js/sentinel.js      Sentinel-2: a small GeoTIFF reader, UTM, tile drawing (worker)
js/recent.js        Sentinel-2: finding passes, picking a clear day, the date bar
js/pistes.js        runs and lifts: packs, Overpass, colours
js/info.js          the run / lift / track / point sheet and profile chart
js/gpx.js, sun.js, i18n.js, format.js, offline.js
sw.js               service worker
data/               resorts.json, skiareas.json, packs/*.json (generated)
tools/              build-data.mjs and the resort list
```

## Run it locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

The app is a static site. With GitHub Pages on for this repository it is
served at `https://wentaoz.com/fallline/`, because project sites inherit the
custom domain of the `VictorZG33.github.io` user site.

1. Merge into `main`.
2. Settings → Pages → Build and deployment → Source: *Deploy from a branch*,
   Branch: `main`, folder `/ (root)`.

After changing any file the service worker precaches (see `SHELL_FILES` in
`sw.js`), bump `VERSION` there so installed copies pick it up.

## Refresh the trail data

OpenSkiData rebuilds daily from OpenStreetMap.

```sh
mkdir -p osd && for f in ski_areas runs lifts; do
  curl -H 'Accept-Encoding: gzip' -o osd/$f.geojson.gz https://tiles.openskimap.org/geojson/$f.geojson
done
node tools/build-data.mjs osd           # rewrites data/
node tools/build-data.mjs osd --check   # just shows what each resort matched
```

To bundle another resort, add a line to `tools/resorts.mjs` (a name pattern and
a rough centre) and rebuild. Missing runs or wrong difficulties are fixed
upstream, in [OpenStreetMap](https://www.openstreetmap.org); the next rebuild
picks them up.

## Data and licences

- Elevation © [Mapterhorn](https://mapterhorn.com/attribution) and its open-data sources.
- Runs, lifts and ski areas © OpenStreetMap contributors, via OpenSkiData, under the [ODbL](https://opendatacommons.org/licenses/odbl/).
- Imagery © Esri, Maxar, Earthstar Geographics. Topo © OpenTopoMap (CC-BY-SA). Vector tiles © OpenFreeMap, OpenMapTiles.
- MapLibre GL JS and maplibre-contour are BSD-licensed; their licences are in `vendor/`.

Saving areas offline fetches a few hundred to a few thousand tiles at once.
Keep it to the places you are actually going.

## Next

- Draw and measure your own routes (ski touring lines, with slope stats).
- Cast shadows, not just hillshade, for the sun mode.
- Sync tracks and saved routes across devices.
- A native iOS shell around the same code if the PWA falls short.
