# bible terrain — 以色列 3D 聖經地形地圖

Static, build-free web app rendering real DEM terrain of Israel in Three.js with a
free-flight aerial camera, 16 clickable biblical site markers, a **metric-correct
Hong Kong overlay** for size comparison, a **2D top-down map mode**, and **touch /
6-axis gyroscope flight controls for phones and tablets**.

No CDN, no npm, no network at runtime: three.js is vendored in `vendor/`.

Live site: <https://appstester0919.github.io/bible-terrain/>

## Features

### 1. Hong Kong overlay (metric-correct, tiled over the whole map)
Press the **香港地圖** button (or `M`) to tile a semi-transparent, true-scale
silhouette of Hong Kong's 18 districts across the entire map plane.

* The Hong Kong raster is **aspect-correct**: `img_w = 1024`, `img_h = 742`
  (derived from the GeoJSON bbox, never hard-coded), so every ground pixel is
  square (`m/px` ratio `1.0005`).
* Real Hong Kong size: **62.428 km × 45.214 km**. On screen, one Hong Kong tile
  measures `62.428 km` wide to within `3e-8` relative error, and `45.214 km` tall.
* The tile is repeated `2.655404 × 5.132988` times across the map, so the
  ground is completely covered.
* Because the map is Web-Mercator, ground distances are divided by `cos(latitude)`;
  the tile is therefore built at `cos(32.09524°) = 0.847166`, giving a tile world
  size of `73.69 km × 53.37 km` in map metres.

### 2. 2D / 3D map switch
The **3D 視角** button (or `V`) swaps the perspective camera for an orthographic
top-down camera that reuses the *same* terrain and water meshes — no duplicated
scene, no extra vertex cost. North is up. Fog is disabled in the flat view.

### 3. Flight controls for phones and tablets
* On-screen flight pad (forward / back / left / right / up / down) plus a
  **加速 (boost)** button.
* **6-axis gyroscope flight**: on iOS a tap requests `DeviceOrientationEvent`
  permission; if permission is refused, or the device has no gyroscope, the
  touch pad remains fully functional.
* Reaching the map edge turns the camera back towards the centre automatically.
* Velocity uses exponential damping, with a speed cap so the camera can never
  run away.

### 4. Metric-correct scale bar
The scale bar is measured empirically, not algebraically: a ray is marched against
the terrain to find the ground point under the screen centre, two ground points are
projected to screen pixels, and the true great-circle distance between them is
divided by the pixel distance. This stays correct under any pitch, altitude, zoom
or vertical exaggeration — which the previous algebraic derivation did not
(it was off by ~1.5x at oblique angles).

## Data sources

| data | source | licence |
|---|---|---|
| Terrain DEM | AWS Terrain Tiles (SRTM), terrarium encoding, z=10, tiles x 610-614 / y 412-418 | AWS Open Data |
| Hong Kong 18 districts | GADM-derived GeoJSON (`hk_districts.geojson`, cached in `data/cache/`) | GADM — free for non-commercial use, attribution required |
| Water outlines / rivers | Natural Earth 10m, OSM waterways (cached in `data/cache/`) | Natural Earth (public domain), ODbL |
| Biblical site coordinates | `data/sites.json` (elevation cross-checked against DEM) | — |

## Run locally

Serve the folder over http (ES modules will not load from `file://`):

    python3 -m http.server 8765

then open <http://127.0.0.1:8765/>.

## Files

| file | purpose |
|---|---|
| index.html | full-screen canvas + HUD, site panel, legend, scale bar, labels, mobile flight pad |
| app.js | terrain mesh, hypsometric colours, flight controls, markers, HK overlay, 2D mode, gyro input |
| vendor/three.module.js | three.js r160 (vendored) |
| vendor/earcut.module.js | earcut 3.2.4 (vendored, polygon triangulation for water vectors) |
| data/heightmap_water.png | 1280x1792 decoded DEM, 16-bit value packed in R/G, with the final water carve |
| data/elev.json | min/max elevation, bbox, metres-per-pixel, tile provenance |
| data/sites.json | 16 biblical sites: Chinese / English / Hebrew names + coords |
| data/water_vector.json | vector water outlines with the two site holes (Capernaum, Tiberias) |
| data/water_meta.json | authoritative water levels and areas per basin |
| data/hk_overlay.png | RGBA 1024x742 Hong Kong raster (fill alpha 200, opaque white district borders) |
| data/hk_overlay_meta.json | image size, real-world size, tile world size, repeat and offset |
| data/tiles/ | the 36 source terrarium tiles (z=10) used to build the heightmap |
| tools/ | reproducible build scripts (water vector, site holes, carve, HK overlay) |

## Rebuild

The build is fully offline-capable (all network inputs are cached in `data/cache/`):

    bash tools/israel3d_build_water.sh

## Controls

| key | action |
|---|---|
| W/S or Up/Down | fly forward / backward |
| A/D or Left/Right | strafe left / right |
| Q/E (or R/F) | descend / ascend |
| Shift | boost |
| Mouse drag | look around (yaw / pitch) |
| Mouse wheel | raise / lower altitude |
| Click a marker or list entry | fly to that site |
| M | toggle the Hong Kong overlay |
| V | toggle 2D / 3D view |
| H | toggle the help panel |

Altitude is clamped to terrain + 50 m, so you cannot fly through the ground.

## Honest caveats

* Vertical exaggeration defaults to 3x for legibility (true 1:1 relief is
  invisible from the air). Override with `?exag=1`. HUD altitude always reports
  true metres.
* z=10 terrarium/SRTM peaks at 1282 m inside this window; Mount Hermon's true
  2236 m summit lies just outside the tile bbox, so its coordinates are clamped
  to the coverage edge and its marker height is corrected from an external
  reference.
* Water bodies are drawn at their authoritative modern levels (Dead Sea
  `-401 m`, Sea of Galilee `-209 m`, Mediterranean `0 m`); they are not a
  reconstruction of first-century shorelines.
* The Mediterranean is map-frame coastline only — no separate area figure is
  claimed for it.
