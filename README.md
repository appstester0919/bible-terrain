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

#### Gyroscope feel (tuned the way mobile flight games do it)

The raw sensor is far too twitchy to feed straight into the camera, so the
input goes through four stages:

| stage | setting | why |
|---|---|---|
| **dead zone** | 5 deg of tilt, 5 deg/s of rotation rate | a hand at rest must not drift |
| **response curve** | quadratic (tilt squared) | small tilts give fine control, large tilts give full deflection |
| **low-pass filter** | frame-rate independent, `k = 1 - exp(-dt*8)` | removes sensor jitter |
| **rate cap** | 42 deg/s turn, 20 deg/s pitch (before the sensitivity multiplier) | a flick can never snap the camera around |

A **靈敏度 (sensitivity)** button scales the result: 低 0.6x, 中 1.0x, 高 1.5x.
A **校準 (calibrate)** button sets the current pose as the neutral pose, so the
phone can be held at a comfortable angle.

#### Which rotation-rate channel drives which axis

The attribute names of `DeviceMotionEvent.rotationRate` are **not** consistent
across engines and versions, so they cannot be hard-coded:

* the current W3C spec (6.3.2) and MDN define `alpha` = X axis (front to
  back), `beta` = Y axis (side to side), `gamma` = Z axis (twist);
* older engines shipped the opposite order;
* Chrome for Android compensates the *orientation angles* for the screen
  orientation while the *rotation rate* stays in the raw device frame, so which
  raw channel ends up on the screen-horizontal axis depends on the device, the
  engine and how the phone is held.

The app therefore **detects** the mapping at runtime instead of assuming it.
Every candidate channel (`alpha`, `beta`, `gamma`, `x`, `y`, `z`) is scored
against the rate of change of the tilt angle it should correspond to, using
two independent pieces of evidence:

| evidence | what it tests | why it is needed |
|---|---|---|
| **magnitude match** | the channel's magnitude is within a log tolerance of the magnitude of `d(angle)/dt` (both deg/s) | a sanity check that the two are even on the same scale |
| **coherence** | the two signals move *together* — a **centred Pearson** correlation when both signals have real variance, or a **mean match** when both are essentially constant (a steady rotation, where a correlation coefficient is undefined) | the primary criterion: it rejects an unrelated axis. A twist signal is uncorrelated with the rate of change of a tilt angle even when its magnitude happens to be similar |

The correlation is **centred** (the means are subtracted), so a channel that
shares a constant offset with the reference cannot score 1.0 by accident, and
a constant channel has zero variance and is rejected outright.

Both must pass. The winner also has to be unambiguous: a runner-up that scores
above 74 % of the winner *with the opposite sign* means two different axes
both look plausible, so **no channel is accepted** and the tilt path takes
over. A runner-up with the *same* sign is the same physical axis reported
twice, so the winner is kept. One channel can never drive both axes.

The scores are averaged over a 3 s window (and at least 48 motion events and
1.5 s of motion) so that a short-lived coincidence cannot lock in a wrong
mapping. The sign of the score sets the polarity, so the rate path and the
tilt path always agree on the direction.

The **twist axis is never a steering source**: it has no orientation-angle
counterpart (turning about the world vertical leaves the tilt angles
unchanged) and it is by far the noisiest axis in a one-handed grip — which is
exactly what made an earlier build feel twitchy.

The **校準 (calibrate)** button also clears the detection, so a new grip or a
new device is re-learned instead of keeping a stale mapping.

Fallback chain, in order:

| situation | what drives the camera |
|---|---|
| fresh rate on an identified channel | the rotation rate (the dead zone is applied to the *smoothed* rate, so a hand at rest gives a smooth zero) |
| rate stream stale (> 400 ms), or no channel identified | the tilt angle |
| no sensor data at all | touch pad and keyboard only |

The rate is used whenever it is *available*, not only while it is large. An
earlier build switched to the tilt path whenever the instantaneous rate
happened to be below the dead zone, so a phone that was turning slowly — or
crossing zero at the top of a flick — changed steering source mid-gesture.
Because the tilt path is **position** based (the angle away from the
calibrated pose), that switch made a phone held at 30 degrees produce a
full-scale command and kept the camera running after the user had stopped
rotating. That was the "6-axis too sensitive" behaviour.

A dead sensor stream is detected (no orientation for 1 s) and then produces no
gyro command at all, so the touch pad keeps full control.

Measured response (degrees per second of camera rotation):

| input | 低 | 中 | 高 |
|---|---|---|---|
| tilt 3 deg | 0 | 0 | 0 |
| tilt 15 deg | 1.5 | 2.6 | 3.9 |
| tilt 30 deg | 10.1 | 17.1 | ~25 |
| roll 20 deg | 7.4 | 12.3 | 18.8 |
| roll 40 deg | — | 40 (capped) | — |

### 4. Layout that gets out of the way
On any touch device — or any window narrower than 1100 px — the left telemetry
panel and the right site list are **drawers**: hidden by default, opened by
tapping the slim handle on that edge, closed by tapping the handle again, the
`X` inside the panel, or the map itself. The map stays unobstructed.

On a **phone held sideways** (short, wide windows) the button row moves to a
single-row strip in the top-left corner and the scale chip drops into the
empty middle of the bottom band, between the D-pad and the thumb cluster. The
strip is as wide as it needs to be, so **every button is on screen at once and
nothing is clipped or sideways-scrolled**, while the middle of the 3D view —
where the map actually is — stays completely clear. The site drawer is bounded
and scrollable, and its `✕` sits in a sticky header so it stays reachable no
matter how far you scroll the list.

Measured browser regression (`verify_landscape_layout.js`, 33 checks):
**33/33 pass** at 844×390, 740×360 and 900×500, with no portrait
(390×844) or desktop (1920×1080, 1000×1200) regression, exactly one `#btn_boost`
in the DOM at every size, and no console errors.

### 5. Metric-correct scale bar
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
| data/heightmap.png | 1280x2304 decoded DEM, 16-bit value packed in R/G (R = high byte, G = low byte) |
| data/heightmap_water.png | the same DEM with the final water carve |
| data/elev.json | min/max elevation, bbox, metres-per-pixel, tile provenance |
| data/sites.json | 16 biblical sites: Chinese / English / Hebrew names + coords |
| data/water_vector.json | vector water outlines with the two site holes (Capernaum, Tiberias) |
| data/water_meta.json | authoritative water levels and areas per basin |
| data/hk_overlay.png | RGBA 1024x742 Hong Kong raster (fill alpha 200, opaque white district borders) |
| data/hk_overlay_meta.json | image size, real-world size, tile world size, repeat and offset |
| data/geo.json | world frame: bbox, world size in metres, centre latitude, metres-per-pixel |
| data/tiles/ | the 45 source terrarium tiles (z=10, x 610–614 / y 410–418) used to build the heightmap |
| tools/israel3d_build.sh | **the** build chain — runs every stage below in order |
| tools/israel3d_write_heightmap.py | tiles → heightmap.png + elev.json (the DEM) |
| tools/israel3d_derive_geo.py | elev.json → geo.json + sites_pixel.json |
| tools/ | the rest of the reproducible build scripts (water vector, site holes, carve, shore, HK overlay, diagnostics) |

## Rebuild

Everything under `data/` that is not a source tile is generated. There is exactly
one build chain, and it starts from the committed DEM tiles in `data/tiles/`:

    bash tools/israel3d_build.sh

The stages run in this order, and each one reads the previous stage's output —
there is no second place where the grid size or the world size is written down:

| # | Stage | Tool | Produces |
|---|-------|------|----------|
| 1 | DEM | `tools/israel3d_write_heightmap.py` | `data/heightmap.png`, `data/elev.json` |
| 2 | Geo frame | `tools/israel3d_derive_geo.py` | `data/geo.json`, `data/sites_pixel.json` |
| 3 | Water | `tools/israel3d_water_v12.py` | `data/water.png`, `water_meta.json`, `rivers.json`, `coastline.json`, `water_vector.json` |
| 4 | Site pads | `tools/israel3d_site_holes.py` | pads punched into the DEM |
| 5 | Carve | `tools/israel3d_carve_water.py` | `data/heightmap_water.png` |
| 6 | Shore | `tools/israel3d_water_shore.py` | `data/water_shore.json` |
| 7 | Shore fix | `tools/israel3d_shore_local_fix.py` | `data/water_vector_local.json` |
| 8 | HK overlay | `tools/israel3d_hk_overlay.py` | `data/hk_overlay_meta.json` |
| 9 | Alignment | `tools/israel3d_align_check.py` | diagnostic report (geo↔pixel mapping) |
| 10 | Site audit | `tools/israel3d_site_audit.py` | diagnostic report (markers vs water) |

The DEM grid is defined **once**, by the tile window in `tools/israel3d_build.sh`:

    TILE_X0=610; TILE_X1=614; TILE_Y0=410; TILE_Y1=418   # 45 tiles → 1280×2304 px

Rows 410–418 are what give the map its northern extension: they carry Mount
Hermon (33.7243 °N edge), which the old 412–418 window cut off entirely. The
world size, the terrain mesh resolution, the water extent and the Hong Kong
overlay scale are all derived from `data/elev.json`, so they follow the grid
automatically.

Rebuilding is **deterministic** — the same tiles always produce a byte-identical
`data/heightmap.png`.

The water stage needs network access the first time (Natural Earth coastlines,
OSM rivers); afterwards it reuses `data/cache/`. To rebuild fully offline:

    ISRAEL3D_OFFLINE=1 bash tools/israel3d_build.sh

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
| 靈敏度 | cycle the gyroscope sensitivity (低 / 中 / 高) |
| 校準 | set the current phone pose as the neutral pose |

Altitude is clamped to terrain + 50 m, so you cannot fly through the ground.

## Honest caveats

* Vertical exaggeration defaults to 3x for legibility (true 1:1 relief is
  invisible from the air). Override with `?exag=1`. HUD altitude always reports
  true metres.
* The DEM is z=10 terrarium/SRTM, whose vertical range is lower than modern
  survey data: the grid peaks at 2808 m against Mount Hermon's published
  2814 m. The marker sits at the OSM peak node (`natural=peak`,
  node 4937091522, 33.41687 °N 35.85645 °E) and reads 2803 m from the DEM —
  a 10.8 m difference against the published figure, which is within the DEM's
  own resolution. The site list shows the published 2814 m.
* Water bodies are drawn at their authoritative modern levels (Dead Sea
  `-401 m`, Sea of Galilee `-209 m`, Mediterranean `0 m`); they are not a
  reconstruction of first-century shorelines.
* The Mediterranean is map-frame coastline only — no separate area figure is
  claimed for it.
