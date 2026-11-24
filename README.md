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

The button row is a single horizontally scrollable strip above the flight pad;
the scale bar and compass sit in the top corners. Measured overlap check
across 412x915, 360x740, 820x1180 and 1440x900: **zero overlapping or
offscreen panels**.

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
| 靈敏度 | cycle the gyroscope sensitivity (低 / 中 / 高) |
| 校準 | set the current phone pose as the neutral pose |

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
