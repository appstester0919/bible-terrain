// Israel 3D - real DEM terrain + free-flight camera + biblical site markers.
// No build step, no CDN: three.js is vendored under vendor/.
import * as THREE from './vendor/three.module.js';
import earcut from './vendor/earcut.module.js';

const ELEV_URL = 'data/elev.json';
// Terrain DEM. heightmap_water.png is the same DEM with the water bodies
// carved below their surface level, so the flat water plane meets the vector
// shoreline instead of intersecting a stepped DEM (which produced a staircase
// edge and stray blocks). Fall back to the raw DEM if it is missing.
const HMAP_URL = 'data/heightmap_water.png';
const HMAP_RAW_URL = 'data/heightmap.png';
const SITES_URL = 'data/sites.json';
const GEO_URL = 'data/geo.json';
const WATER_URL = 'data/water.png';
const WATER_META_URL = 'data/water_meta.json';
const RIVERS_URL = 'data/rivers.json';
const COAST_URL = 'data/coastline.json';
const HK_META_URL = 'data/hk_overlay_meta.json';
const HK_OVERLAY_URL = 'data/hk_overlay.png';
// The map frame is a Web-Mercator strip: a true ground distance d is drawn as
// d/cos(latitude) world-metres, i.e. everything on screen is stretched by
// 1/cos(lat). The Hong Kong overlay is placed with the SAME factor (divide by
// COS_IL) so that "one Hong Kong" on screen equals the real Hong Kong placed
// against the real distance between two biblical sites - and the scale bar is
// corrected by the same factor, so the two always agree.
const COS_IL = Math.cos(32.09524 * Math.PI / 180);
// water_vector.json holds the Natural Earth outlines. Their AREA is the
// published figure (Dead Sea ~850 km2 at -401 m, which includes the southern
// basin that SRTM fills at -398 m, so a DEM contour cannot draw it and comes
// out -15.6% small). The DEM-derived water_shore.json is kept for reference
// but is NOT used for the surface.
const WVEC_URL = 'data/water_vector.json';

// Terrain exaggeration. Real 1:1 over a 274 km strip makes relief invisible from
// the air, so heights are amplified for legibility while keeping metres honest.
const VERT_EXAG = Number(new URLSearchParams(location.search).get('exag') ?? 3);
const CLEARANCE = 50;          // never fly below terrain + 50 m
// Mobile GPUs cannot afford the full 640x896 terrain (574k vertices) plus a
// flat-shaded material, so the mesh is reduced on touch devices.
const MOBILE = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || innerWidth < 820;
const TILE_W = MOBILE ? 384 : 640, TILE_H = MOBILE ? 538 : 896;   // from 1280x1792

const state = {
  meta: null, sites: [], elev: null,
  mesh: null, sea: null, markers: [], labels: [], labelLayer: null,
  terrainMin: -Infinity,
  flyingTo: null,
  hkOverlay: null, hkMeta: null,
  view2d: { cx: 0, cz: 0, zoom: 1 },
  touch: { fwd: 0, side: 0, up: 0, boost: false },
};

// ---------------------------------------------------------------- elevation IO
async function loadElevJson() {
  const meta = await (await fetch(ELEV_URL)).json();
  // geo.json is the authoritative pixel<->world mapping (Mercator-correct).
  // If it is missing, fall back to the legacy linear-latitude mapping so the
  // app still runs (slightly misaligned) instead of failing to boot.
  try {
    meta.geo = await (await fetch(GEO_URL)).json();
  } catch (err) {
    console.error('geo.json missing, falling back to legacy mapping:', err);
    const b = meta.bbox;
    const mpp = meta.meters_per_pixel_x;
    meta.geo = {
      lon_min: b.lon_min, lon_max: b.lon_max,
      merc_y_top: Math.log(Math.tan(b.lat_max*Math.PI/180) + 1/Math.cos(b.lat_max*Math.PI/180)),
      merc_y_bot: Math.log(Math.tan(b.lat_min*Math.PI/180) + 1/Math.cos(b.lat_min*Math.PI/180)),
      world_width_m: meta.world_metres.width, world_height_m: meta.world_metres.height,
      fallback: true,
    };
  }
  const cv = document.createElement('canvas');
  cv.width = meta.image.width; cv.height = meta.image.height;
  let bmp;
  try {
    bmp = await createImageBitmap(await (await fetch(HMAP_URL)).blob());
  } catch (err) {
    console.error('carved heightmap missing, using raw DEM:', err);
    bmp = await createImageBitmap(await (await fetch(HMAP_RAW_URL)).blob());
  }
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const W = cv.width, H = cv.height;
  const elev = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const v = (d[p] * 256 + d[p + 1]) / 65535;          // 16-bit normalised value
    elev[i] = meta.min + v * (meta.max - meta.min);      // metres
  }
  return { meta, elev, W, H };
}

// ------------------------------------------------------------- geo <-> world
// World units are metres. X = east, Z = south (so -Z is north), Y = up.
//
// IMPORTANT: the DEM grid is a Web-Mercator tile grid. Longitude is linear in
// pixel column, but latitude is NOT linear in pixel row (Mercator stretches
// toward the poles). Mapping latitude linearly onto Z (the old behaviour)
// shifted every site pin and the whole water body away from the terrain -
// visible as the Jordan Valley drifting sideways.
//
// geo.json carries the authoritative grid: lon_min/lon_max (pixel column
// edges) and lat_top/lat_bottom (pixel row edges) plus the mercator values
// used for the row mapping.
function mercY(latDeg) {
  const lr = latDeg * Math.PI / 180;
  return Math.log(Math.tan(lr) + 1 / Math.cos(lr));
}

function geoToWorld(meta, lat, lon) {
  const g = meta.geo;
  const x = ((lon - g.lon_min) / (g.lon_max - g.lon_min) - 0.5) * g.world_width_m;
  const my = mercY(lat);
  const f = (g.merc_y_top - my) / (g.merc_y_top - g.merc_y_bot);
  const z = (f - 0.5) * g.world_height_m;
  return { x, z };
}
function worldToGeo(meta, x, z) {
  const g = meta.geo;
  const lon = g.lon_min + (x / g.world_width_m + 0.5) * (g.lon_max - g.lon_min);
  const my = g.merc_y_top - (z / g.world_height_m + 0.5) * (g.merc_y_top - g.merc_y_bot);
  const lat = Math.atan(Math.sinh(my)) * 180 / Math.PI;
  return { lat, lon };
}
// bilinear sample of the full-resolution elevation grid at a world position
function elevAt(meta, elev, W, H, x, z) {
  const g = meta.geo;
  const fx = (x / g.world_width_m + 0.5) * (W - 1);
  const fz = (z / g.world_height_m + 0.5) * (H - 1);
  const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx)));
  const z0 = Math.max(0, Math.min(H - 2, Math.floor(fz)));
  const tx = fx - x0, tz = fz - z0;
  const a = elev[z0 * W + x0], b2 = elev[z0 * W + x0 + 1];
  const c = elev[(z0 + 1) * W + x0], d = elev[(z0 + 1) * W + x0 + 1];
  return (a * (1 - tx) + b2 * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

// hypsometric ramp: deep green lowland -> tan -> brown -> white above 1200 m
const RAMP = [
  [-450, [0.10, 0.26, 0.18]],
  [   0, [0.20, 0.45, 0.24]],
  [ 200, [0.45, 0.55, 0.26]],
  [ 450, [0.72, 0.63, 0.38]],
  [ 800, [0.55, 0.40, 0.24]],
  [1200, [0.44, 0.29, 0.19]],
  [1700, [0.72, 0.70, 0.68]],
  [2300, [0.98, 0.99, 1.00]],
];
function hypso(e) {
  if (e <= RAMP[0][0]) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) {
    if (e <= RAMP[i][0]) {
      const [e0, c0] = RAMP[i - 1], [e1, c1] = RAMP[i];
      const t = (e - e0) / (e1 - e0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

// ---------------------------------------------------------------- water bodies
// Water is NOT derived from the DEM alone: the Dead Sea's true surface is
// -401 m and the Sea of Galilee -209 m, and a DEM flood fill cannot know that
// (the basin floor ramps up to ~0 m at the shore, so a naive "highest pixel
// in the region" rule collapses both lakes to sea level and floods the whole
// Jordan Rift Valley).
// Instead we load a pre-computed water-surface raster:
//   R,G = 16-bit normalised surface elevation, A = 255 where there is water.
// data/water_meta.json records the authoritative levels per basin.
async function loadWaterRaster() {
  const meta = await (await fetch(WATER_META_URL)).json();
  const bmp = await createImageBitmap(await (await fetch(WATER_URL)).blob());
  const cv = document.createElement('canvas');
  cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const W = cv.width, H = cv.height;
  const level = new Float32Array(W * H);
  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    if (d[p + 3] < 128) continue;                    // not water
    const v = (d[p] * 256 + d[p + 1]) / 65535;
    level[i] = meta.min + v * (meta.max - meta.min); // metres
    mask[i] = 1;
  }
  return { level, mask, W, H, meta };
}

// Build the water SURFACE from the vector outlines (data/water_vector.json),
// triangulated with earcut. Building it from the raster instead gives a
// staircase shoreline at 153 m/px and stray inland cells; the vector outline
// is the real boundary and gives a clean edge at any zoom.
//
// Each body sits at its own authoritative level (Dead Sea -401 m, Sea of
// Galilee -209 m, Mediterranean 0 m), scaled by the same vertical exaggeration
// as the terrain so the shore meets the ground.
async function buildWaterVectorMesh(meta) {
  let doc;
  try {
    doc = await (await fetch(WVEC_URL)).json();
  } catch (err) {
    console.error('water_vector.json missing, keeping raster surface:', err);
    return null;
  }
  const bodies = doc.bodies || [];
  if (!bodies.length) return null;

  const group = new THREE.Group();
  group.name = 'waterVector';
  const report = [];

  for (const body of bodies) {
    const level = body.level_m;
    const y = level * VERT_EXAG;
    const positions = [];
    for (const part of body.parts) {
      // earcut works in 2D. Project lon/lat to world x/z and triangulate there.
      const ring = part.ring.map(p => {
        const w = geoToWorld(meta, p[1], p[0]);
        return [w.x, w.z];
      });
      const holeRings = (part.holes || []).map(h => h.map(p => {
        const w = geoToWorld(meta, p[1], p[0]);
        return [w.x, w.z];
      }));
      const flat = [];
      const holeIdx = [];
      for (const p of ring) { flat.push(p[0], p[1]); }
      for (const hr of holeRings) {
        holeIdx.push(flat.length / 2);
        for (const p of hr) { flat.push(p[0], p[1]); }
      }
      const tris = earcut(flat, holeIdx, 2);
      for (let i = 0; i < tris.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const idx = tris[i + k];
          positions.push(flat[idx * 2], y, flat[idx * 2 + 1]);
        }
      }
      report.push({ body: body.name, part: part.name, ringPts: ring.length, tris: tris.length / 3 });
    }
    if (!positions.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1c5f9e, transparent: true, opacity: 0.80, roughness: 0.15,
      metalness: 0.25, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'water:' + body.name;
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  scene.add(group);
  state.waterVector = group;
  state.waterVectorReport = report;
  return group;
}

// Build one mesh holding every water body, each at its own surface level.
function buildWaterMesh(water, meta) {
  const { level, mask, W, H } = water;
  const TW = Math.floor(W / 2), TH = Math.floor(H / 2);
  const vlev = new Float32Array(TW * TH).fill(NaN);
  const put = (gx, gy, lvl) => {
    if (gx < 0 || gy < 0 || gx >= TW || gy >= TH) return;
    const k = gy * TW + gx;
    if (Number.isNaN(vlev[k]) || lvl > vlev[k]) vlev[k] = lvl;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const lvl = level[y * W + x];
      const gx = x >> 1, gy = y >> 1;
      // NOTE: no 4-neighbour dilation here. Dilating the mask painted water one
      // cell beyond the true shoreline, which is what produced the stray blue
      // rectangles floating inland of the Dead Sea shore. The vector outline
      // (water_vector.json) now defines the surface; this raster is only a
      // per-pixel LEVEL lookup.
      put(gx, gy, lvl);
    }
  }

  const positions = [];
  const wx = meta.geo.world_width_m, wz = meta.geo.world_height_m;
  const px2x = (gx) => ((gx / (TW - 1)) - 0.5) * wx;
  const px2z = (gy) => ((gy / (TH - 1)) - 0.5) * wz;

  for (let gy = 0; gy < TH - 1; gy++) {
    for (let gx = 0; gx < TW - 1; gx++) {
      const a = vlev[gy * TW + gx], b = vlev[gy * TW + gx + 1];
      const c = vlev[(gy + 1) * TW + gx], d = vlev[(gy + 1) * TW + gx + 1];
      let lvl = -Infinity;
      for (const v of [a, b, c, d]) if (Number.isFinite(v) && v > lvl) lvl = v;
      if (!Number.isFinite(lvl)) continue;   // no water in this cell
      const y = lvl * VERT_EXAG;
      const x0 = px2x(gx), x1 = px2x(gx + 1);
      const z0 = px2z(gy), z1 = px2z(gy + 1);
      positions.push(x0, y, z0, x1, y, z0, x1, y, z1);
      positions.push(x0, y, z0, x1, y, z1, x0, y, z1);
    }
  }
  if (!positions.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1c5f9e, transparent: true, opacity: 0.72, roughness: 0.2, metalness: 0.15,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  scene.add(mesh);
  state.water = mesh;
  return mesh;
}

// water surface level (m) at a world position, or null if that spot is land
function waterLevelAt(water, meta, x, z) {
  if (!water) return null;
  const { level, mask, W, H } = water;
  const g = meta.geo;
  const fx = Math.round((x / g.world_width_m + 0.5) * (W - 1));
  const fz = Math.round((z / g.world_height_m + 0.5) * (H - 1));
  if (fx < 0 || fz < 0 || fx >= W || fz >= H) return null;
  const i = fz * W + fx;
  return mask[i] ? level[i] : null;
}

// ------------------------------------------------------------- vector rivers
// A DEM raster CANNOT draw the Jordan River: one pixel is 153 m and the river
// is ~30 m wide (0.2 px). Even a perfect raster flood renders it as an
// invisible smear. Real map renderers draw rivers as VECTOR centre lines, so
// that is what we do: data/rivers.json holds OSM waterway=river centrelines,
// and we drape them on the terrain as screen-facing ribbons.
//
// The ribbon width is in WORLD metres but grows with the camera distance so a
// 30 m river stays visible from 40 km up without becoming a 30 km ribbon when
// you fly down to it. RIVER_MIN_PX is the on-screen floor.
const RIVER_MIN_PX = 2.2;

function buildRiverMesh(rivers, meta) {
  if (!rivers || !rivers.length) return null;
  const centers = [];      // centreline world position per vertex
  const offsets = [];      // perpendicular offset vector per vertex (XZ)
  const positions = [];
  const g = meta.geo;
  // project a lon/lat pair to world
  const proj = (lon, lat) => {
    const x = ((lon - g.lon_min) / (g.lon_max - g.lon_min) - 0.5) * g.world_width_m;
    const my = mercY(lat);
    const f = (g.merc_y_top - my) / (g.merc_y_top - g.merc_y_bot);
    const z = (f - 0.5) * g.world_height_m;
    return { x, z };
  };
  // resample a polyline to a fixed spacing (in source degrees) so the ribbon
  // has enough vertices to follow the terrain
  const RESAMPLE_DEG = 0.004;    // ~400 m
  let used = 0;
  for (const r of rivers) {
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    // resample
    const dense = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i+1];
      const dx = b[0]-a[0], dy = b[1]-a[1];
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(dist / RESAMPLE_DEG));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        dense.push([a[0] + dx*t, a[1] + dy*t]);
      }
    }
    dense.push(pts[pts.length-1]);
    if (dense.length < 2) continue;

    // Build the ribbon as two vertices per centreline point: the centreline
    // point plus a PERPENDICULAR offset of half the river's real width.
    // The offset is stored in a separate attribute so that widening (see
    // updateRiverScale) happens in the shader around the river's OWN
    // centreline. Scaling the mesh instead would push every river radially
    // away from the middle of the map and detach it from its valley.
    const half = Math.max(r.real_width_m || 20, 30) / 2;
    const yOf = (pt) => {
      const e = elevAt(meta, elev_full, elevW, elevH, pt.x, pt.z);
      const w = waterLevelAt(state.waterAnalysis, meta, pt.x, pt.z);
      const base = (w === null ? e : Math.max(e, w)) * VERT_EXAG;
      return base + 14;               // 14 m above the surface, avoid z-fight
    };
    // perpendicular unit vector in XZ for each centreline point
    const nrm = [];
    for (let i = 0; i < dense.length; i++) {
      const p = proj(dense[i][0], dense[i][1]);
      const a = proj(dense[Math.max(0, i-1)][0], dense[Math.max(0, i-1)][1]);
      const b = proj(dense[Math.min(dense.length-1, i+1)][0], dense[Math.min(dense.length-1, i+1)][1]);
      let dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      nrm.push({ p, nx: -dz, nz: dx });
    }
    // strip of quads between consecutive centreline points
    for (let i = 0; i < nrm.length - 1; i++) {
      const A = nrm[i], B = nrm[i+1];
      const yA = yOf(A.p), yB = yOf(B.p);
      const quad = [
        { c: A.p, o: [ A.nx*half,  A.nz*half], y: yA },
        { c: A.p, o: [-A.nx*half, -A.nz*half], y: yA },
        { c: B.p, o: [-B.nx*half, -B.nz*half], y: yB },
        { c: A.p, o: [ A.nx*half,  A.nz*half], y: yA },
        { c: B.p, o: [-B.nx*half, -B.nz*half], y: yB },
        { c: B.p, o: [ B.nx*half,  B.nz*half], y: yB },
      ];
      for (const v of quad) {
        centers.push(v.c.x, v.y, v.c.z);
        offsets.push(v.o[0], 0, v.o[1]);
        positions.push(v.c.x + v.o[0], v.y, v.c.z + v.o[1]);
      }
      used++;
    }
  }
  if (!positions.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3));
  geo.setAttribute('aOffset', new THREE.Float32BufferAttribute(offsets, 3));
  geo.computeVertexNormals();

  // Shader: the ribbon is widened around its own centreline by uScale, so
  // the river keeps its true position while gaining on-screen thickness.
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uScale: { value: 1 }, uColor: { value: new THREE.Color(0x2f8fd8) } },
    ]),
    vertexShader: `
      attribute vec3 aCenter;
      attribute vec3 aOffset;
      uniform float uScale;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec3 p = aCenter + aOffset * uScale;
        vWorld = p;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      void main() {
        // cheap directional shading so the ribbon reads as lying on the ground
        float lit = 0.78 + 0.22 * clamp(normalize(vWorld - vec3(0.0, 1.0, 0.0)).y, 0.0, 1.0);
        gl_FragColor = vec4(uColor * lit, 1.0);
        #include <fog_fragment>
      }`,
    fog: true,
    side: THREE.DoubleSide,
    transparent: false,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 4;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

// Keep the river ribbon at least RIVER_MIN_PX wide on screen whatever the
// altitude. The world is ~195 km across; at 40 km altitude one pixel covers
// ~50 m, so a 15 m river would be 0.3 px and vanish.
function updateRiverScale() {
  const mesh = state.riverMesh;
  if (!mesh || !mesh.material || !mesh.material.uniforms) return;
  let mPerPx;
  if (viewMode === '2d') {
    mPerPx = (orthoCam.right - orthoCam.left) / window.innerWidth;
  } else {
    const dist = Math.max(50, camera.position.y / VERT_EXAG);   // altitude in metres
    mPerPx = (2 * Math.tan(camera.fov * Math.PI / 360) * dist) / window.innerHeight;
  }
  const scale = Math.max(1, (RIVER_MIN_PX * mPerPx) / 30);
  mesh.material.uniforms.uScale.value = scale;
  mesh.userData.scale = scale;
  mesh.userData.mPerPx = mPerPx;
}

// ------------------------------------------------------------- shoreline
// data/coastline.json: sea_runs (vector coastline polylines) + lakes
// (boundary segments with their surface level).
function buildShoreline(coast, meta) {
  if (!coast) return null;
  const g = meta.geo;
  const pos = [], col = [];
  const push = (lon, lat, y, c) => {
    const x = ((lon - g.lon_min) / (g.lon_max - g.lon_min) - 0.5) * g.world_width_m;
    const my = mercY(lat);
    const f = (g.merc_y_top - my) / (g.merc_y_top - g.merc_y_bot);
    const z = (f - 0.5) * g.world_height_m;
    pos.push(x, y, z);
    col.push(((c >> 16) & 255)/255, ((c >> 8) & 255)/255, (c & 255)/255);
  };
  // sea coastline: draw at sea level, slightly raised
  for (const run of (coast.sea_runs || [])) {
    for (let i = 0; i < run.length - 1; i++) {
      const y = 6;
      push(run[i][0], run[i][1], y, 0x0d3b63);
      push(run[i+1][0], run[i+1][1], y, 0x0d3b63);
    }
  }
  // lake shorelines: at each lake's own surface level
  for (const lk of (coast.lakes || [])) {
    const y = (lk.level_m || 0) * VERT_EXAG + 6;
    for (const sg of (lk.segments || [])) {
      push(sg[0][0], sg[0][1], y, 0x0d3b63);
      push(sg[1][0], sg[1][1], y, 0x0d3b63);
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 });
  const line = new THREE.LineSegments(geo, mat);
  line.renderOrder = 3;
  scene.add(line);
  return line;
}

// ---------------------------------------------------------------- three setup
let renderer, scene, camera, perspCam, orthoCam, yaw, pitch, keys = {};
let viewMode = '3d';
const MAXPITCH = Math.PI / 2 - 0.05;

function initThree() {
  const canvas = document.getElementById('scene');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE });
  renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb6c9);
  scene.fog = new THREE.Fog(0x9fb6c9, 60000, 240000);

  perspCam = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 1, 900000);
  camera = perspCam;
  // Orthographic camera for the straight-down 2D map view.
  orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 900000);
  orthoCam.up.set(0, 0, -1);            // north (-Z) is up on screen
  // Tilted aerial view over central Israel, looking DOWN ~57 deg.
  // SIGN NOTE: with rotation.order 'YXZ' the camera looks along -Z, so a POSITIVE
  // rotation.x tilts it UP. A downward look therefore needs a NEGATIVE pitch.
  pitch = -THREE.MathUtils.degToRad(57);
  yaw = 0;
  camera.rotation.order = 'YXZ';

  const sun = new THREE.DirectionalLight(0xfff3e0, 2.1);
  sun.position.set(-0.6, 1.0, -0.8);           // light from the NW, Israel-ish sun
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xa9c4dd, 0.85));
  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x2b3a24, 0.7));

  addEventListener('resize', () => {
    perspCam.aspect = innerWidth / innerHeight;
    perspCam.updateProjectionMatrix();
    if (viewMode === '2d') setViewMode('2d');
    renderer.setSize(innerWidth, innerHeight);
  });
}

function buildTerrain(meta, elev, W, H) {
  const g = meta.geo;
  const geo = new THREE.PlaneGeometry(g.world_width_m, g.world_height_m, TILE_W - 1, TILE_H - 1);
  geo.rotateX(-Math.PI / 2);                    // XY plane -> XZ ground plane

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  let minE = Infinity, maxE = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const e = elevAt(meta, elev, W, H, pos.getX(i), pos.getZ(i));
    if (e < minE) minE = e; if (e > maxE) maxE = e;
    pos.setY(i, Math.max(e, -500) * VERT_EXAG);
    const c = hypso(e);
    colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0.0, flatShading: true,
  });
  state.mesh = new THREE.Mesh(geo, mat);
  scene.add(state.mesh);
  state.terrainMin = minE;
}

// ------------------------------------------------------------ Hong Kong overlay
// One transparent PNG tile holds the whole Hong Kong 18-district map at true
// ground scale: the raster is aspect-correct (1024 x 742) and one pixel is
// square in ground metres, so the silhouette is NOT stretched.
//
// The tile is repeated across the ENTIRE map plane, so a listener can read
// the real size of Hong Kong against the real distance between two biblical
// sites. The tile's world size and the repeat counts come from
// data/hk_overlay_meta.json (computed from the GeoJSON bbox, never
// hard-coded), and the plane is a Web-Mercator strip, so a true ground
// distance is drawn as d/cos(lat) world-metres: the tile is placed with the
// SAME factor, which is what makes it directly comparable with the scale bar.
function buildHKOverlay() {
  const hm = state.hkMeta;
  const tex = new THREE.TextureLoader().load(HK_OVERLAY_URL);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (hm) {
    tex.repeat.set(hm.repeat_x, hm.repeat_y);
    tex.offset.set(hm.offset_x, hm.offset_y);
  }
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.78, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  // The SAME geometry as the terrain: the overlay lies exactly on the map
  // plane, so its horizontal scale is identical to the map's.
  const mesh = new THREE.Mesh(state.mesh.geometry, mat);
  mesh.renderOrder = 3;
  mesh.visible = false;
  scene.add(mesh);
  state.hkOverlay = mesh;
  return mesh;
}
// Aerial perspective is a 3D-only effect: the flat map is viewed from far
// above, so with the 3D fog range every pixel would be washed out to the
// background colour.
function updateFog() {
  if (!scene.fog) return;
  if (viewMode === '2d') { scene.fog.near = 900000; scene.fog.far = 1200000; }
  else { scene.fog.near = 60000; scene.fog.far = 240000; }
}
async function loadHKMeta() {
  try {
    state.hkMeta = await (await fetch(HK_META_URL)).json();
  } catch (err) {
    console.error('hk_overlay_meta.json missing:', err);
    state.hkMeta = null;
  }
}
function toggleHKOverlay(on) {
  const mesh = state.hkOverlay;
  if (!mesh) return false;
  const next = (on === undefined) ? !mesh.visible : !!on;
  mesh.visible = next;
  const btn = document.getElementById('btn_hk');
  if (btn) btn.textContent = next ? '香港地圖：開' : '香港地圖：關';
  return next;
}

// Water is loaded separately (authoritative raster), see loadWaterRaster().

// --------------------------------------------------------------- site markers
function buildMarkers(meta, sites) {
  state.labelLayer = document.getElementById('labels');
  const pinGeo = new THREE.ConeGeometry(1, 2.6, 6);   // unit cone, scaled per marker
  sites.forEach((s) => {
    const { x, z } = geoToWorld(meta, s.lat, s.lon);
    let e = elevAt(meta, elev_full, elevW, elevH, x, z);
    if (s.id === 'hermon') e = 2236;                  // summit lies outside the DEM bbox
    // Authoritative elevation from the source (data/sites.json ref_elev_m).
    // Only trusted when it agrees with the rendered terrain: a 153 m DEM pixel
    // cannot resolve a lakeshore village, so Capernaum's pixel averages the
    // town with the harbour water (-207 m vs -212 m).
    const refE = (s.ref_elev_m !== undefined && s.ref_elev_m !== null) ? s.ref_elev_m : null;
    const groundE = (refE !== null && Math.abs(refE - e) <= 15) ? refE : e;
    // Ground elevation vs. the local water surface. A site inside the Dead Sea
    // (-401 m) or the Sea of Galilee (-209 m) must sit on THAT water surface,
    // not on a generic 0 m plane and not on the lake floor.
    const groundY = groundE * VERT_EXAG;
    const wLvl = waterLevelAt(state.waterAnalysis, meta, x, z);
    const surfaceY = wLvl === null ? groundY : wLvl * VERT_EXAG;
    // "In water" must be decided by the site's OWN ground vs the water level,
    // never by polygon membership: the rendered lake outline over-covers the
    // shallow shore (153 m DEM pixels), so lakeside towns fall inside the
    // water polygon while their ground is clearly above the surface.
    const inWater = wLvl !== null && groundE < wLvl;
    const shore = wLvl !== null && !inWater;          // lakeside but on dry ground
    const belowSea = groundE < 0;
    // Pin base = the surface it stands on (water surface if it is a water site,
    // otherwise the real ground).
    const pinBaseY = inWater ? surfaceY : groundY;
    // Cone head always clears the surface it stands on.
    const headY = pinBaseY + 1900 * 1.3;
    const colour = inWater ? 0x7fe3ff : 0xffd23f;

    const m = new THREE.Mesh(pinGeo, new THREE.MeshBasicMaterial({
      color: colour, depthTest: false,
    }));
    m.scale.setScalar(1900);
    m.position.set(x, headY, z);
    m.renderOrder = 5;
    scene.add(m);

    const stem = new THREE.Mesh(new THREE.CylinderGeometry(120, 120, 3800, 5),
      new THREE.MeshBasicMaterial({ color: colour, depthTest: false }));
    stem.position.set(x, pinBaseY + 1900, z);
    stem.renderOrder = 5;
    scene.add(stem);

    const el = document.createElement('div');
    el.className = 'label';
    el.innerHTML = `<b>${s.name}</b><span>${s.en} · ${s.he}</span>` +
      (inWater ? `<em>水面 ${Math.round(wLvl)} m</em>`
        : (shore ? `<em>湖岸 · 地面 ${Math.round(groundE)} m</em>`
          : (belowSea ? '<em>低於海平面</em>' : '')));
    state.labelLayer.appendChild(el);

    const rec = { site: s, mesh: m, stem, el, elev: groundE, belowSea, inWater, shore, waterLevel: wLvl,
      world: new THREE.Vector3(x, headY + 1900 * 1.3, z) };
    state.markers.push(rec);
    m.userData.rec = rec;
    m.userData.clickable = true;

    const li = document.createElement('li');
    li.innerHTML = `<b>${s.name}</b><span>${s.en}</span><em>${Math.round(groundE)} m</em>` +
      (inWater ? `<i>水面 ${Math.round(wLvl)} m</i>`
        : (shore ? `<i>湖岸 · 地面 ${Math.round(groundE)} m</i>` : ''));
    li.addEventListener('click', () => flyTo(rec));
    document.getElementById('sitelist').appendChild(li);
  });
}


// ------------------------------------------------- mobile / 6-axis gyro flight
// DeviceOrientation gives the absolute attitude (beta = front/back tilt,
// gamma = left/right roll); DeviceMotion adds the rotation rate and the
// acceleration vector, i.e. all six axes. Gyro mode flies like an arcade
// flight game: the craft always moves forward and the player steers by
// tilting the device. Devices without a usable sensor fall back to the
// on-screen pad and the keyboard.
const gyro = { active: false, beta: 0, gamma: 0, rotZ: 0, accel: 0, base: null };

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 2600);
}
function gyroCalibrate() {
  gyro.base = { beta: gyro.beta, gamma: gyro.gamma };
  toast('已校準：以目前姿勢為水平');
}
function enableGyro() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) { toast('此瀏覽器不支援感應器，請用下方按鈕操縱'); return; }
  const start = () => {
    gyro.active = true;
    addEventListener('deviceorientation', onDeviceOrient, true);
    addEventListener('devicemotion', onDeviceMotion, true);
    document.body.classList.add('gyro-on');
    const b = document.getElementById('btn_gyro');
    if (b) b.textContent = '感應器：開';
    if (!gyro.base) gyroCalibrate();
    toast('感應器已開啟：傾斜裝置即可飛行');
  };
  if (typeof DOE.requestPermission === 'function') {
    DOE.requestPermission().then((r) => {
      if (r === 'granted') start(); else toast('感應器權限被拒絕，已改用按鈕操縱');
    }).catch(() => toast('感應器權限被拒絕，已改用按鈕操縱'));
  } else start();
}
function onDeviceOrient(e) {
  if (e.beta === null || e.gamma === null) return;
  gyro.beta = e.beta; gyro.gamma = e.gamma;
  if (!gyro.base) gyroCalibrate();
}
function onDeviceMotion(e) {
  if (e.rotationRate && typeof e.rotationRate.z === 'number') gyro.rotZ = e.rotationRate.z;
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (a) gyro.accel = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
}

// ------------------------------------------------------------- flight controls
const vel = new THREE.Vector3();
function flyTo(rec) {
  const p = rec.mesh.position;
  if (viewMode === '2d') {
    state.view2d.cx = p.x; state.view2d.cz = p.z;
    state.view2d.zoom = Math.max(state.view2d.zoom, 3);
    applyOrtho();
    return;
  }
  state.flyingTo = { x: p.x, z: p.z, dist: 26000 };
}
function updateFlight(dt) {
  if (viewMode === '2d') { updateFlight2D(dt); return; }

  const boost = ((keys['shiftleft'] || keys['shiftright']) ? 3 : 1) *
                (state.touch.boost ? 3 : 1);
  const speed = 9000 * boost;

  let fwd = 0, side = 0, up = 0;
  if (keys['w'] || keys['arrowup']) fwd += 1;
  if (keys['s'] || keys['arrowdown']) fwd -= 1;
  if (keys['a'] || keys['arrowleft']) side -= 1;
  if (keys['d'] || keys['arrowright']) side += 1;
  if (keys['e'] || keys['r']) up += 1;
  if (keys['q'] || keys['f']) up -= 1;
  fwd += state.touch.fwd; side += state.touch.side; up += state.touch.up;

  // Gyro steering: roll to turn, tilt forward/back to pitch. Prefer the real
  // gyro rate (rotationRate.z); fall back to the roll angle when the device
  // does not report a rotation rate.
  if (gyro.active) {
    const b = gyro.base || { beta: 0, gamma: 0 };
    const dGamma = gyro.gamma - b.gamma;
    const dBeta = gyro.beta - b.beta;
    const yawRate = gyro.rotZ ? (-gyro.rotZ * 0.35) : (dGamma * 0.030);
    yaw += yawRate * dt;
    pitch = THREE.MathUtils.clamp(pitch - dBeta * 0.022 * dt, -MAXPITCH, MAXPITCH);
    if (fwd === 0) fwd = 1;                    // arcade flight: always moving
    if (gyro.accel > 12) fwd = 1 + Math.min(0.6, (gyro.accel - 12) * 0.05);
  }

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
  const right = new THREE.Vector3().crossVectors(flat, new THREE.Vector3(0, 1, 0)).normalize();

  const target = new THREE.Vector3()
    .addScaledVector(flat, fwd * speed)
    .addScaledVector(right, side * speed)
    .addScaledVector(new THREE.Vector3(0, 1, 0), up * speed * 0.8);

  if (state.flyingTo) {
    const f = state.flyingTo;
    const cur = camera.position;
    const dx = f.x - cur.x, dz = f.z - cur.z;
    const d = Math.hypot(dx, dz);
    if (d < 1500) state.flyingTo = null;
    else {
      target.set(dx / d * speed, 0, dz / d * speed);
      const wantPitch = -Math.atan2(cur.y - (f.dist * 0.35), d);
      pitch += (THREE.MathUtils.clamp(wantPitch, -1.2, -0.18) - pitch) * Math.min(1, dt * 2.2);
    }
  }

  // damping: exponential approach to the target velocity
  const k = 1 - Math.exp(-dt * 4.5);
  vel.lerp(target, k);
  camera.position.addScaledVector(vel, dt);

  // Reaching the edge of the map: turn back towards the centre automatically
  // so a phone player never gets stuck against an invisible wall.
  const m = state.meta;
  const hw = m.world_metres.width / 2, hh = m.world_metres.height / 2;
  const nearEdge = Math.abs(camera.position.x) > hw * 0.93 || Math.abs(camera.position.z) > hh * 0.93;
  const headingOut = (camera.position.x * vel.x + camera.position.z * vel.z) > 0;
  if (nearEdge && headingOut) {
    // The camera looks along -Z rotated by yaw, so the yaw that points at the
    // map centre is atan2(x, z).
    const want = Math.atan2(camera.position.x, camera.position.z);
    let diff = ((want - yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    yaw += diff * Math.min(1, dt * 1.8);
  }
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -hw, hw);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -hh, hh);

  // altitude clamp: stay above the local surface (terrain OR water) + clearance
  const ground = elevAt(m, elev_full, elevW, elevH, camera.position.x, camera.position.z) * VERT_EXAG;
  const wLvl = waterLevelAt(state.waterAnalysis, m, camera.position.x, camera.position.z);
  const surf = wLvl === null ? ground : wLvl * VERT_EXAG;
  const floorY = Math.max(ground, surf) + CLEARANCE;
  if (camera.position.y < floorY) { camera.position.y = floorY; vel.y = Math.max(vel.y, 0); }
  camera.position.y = Math.min(camera.position.y, 120000);

  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}


// ------------------------------------------------------------ 2D top-down view
// The 2D view REUSES the same scene and the same data (one terrain, one
// water set), and only swaps the camera for an orthographic one looking
// straight down, north up. Low-end phones therefore keep the same vertex
// count as the 3D view.
function applyOrtho() {
  const g = state.meta.geo;
  const aspect = innerWidth / innerHeight;
  const fitH = Math.max(g.world_height_m, g.world_width_m / aspect);
  const halfH = (fitH / 2) / state.view2d.zoom;
  const halfW = halfH * aspect;
  orthoCam.left = -halfW; orthoCam.right = halfW;
  orthoCam.top = halfH; orthoCam.bottom = -halfH;
  orthoCam.near = 1; orthoCam.far = 900000;
  orthoCam.up.set(0, 0, -1);              // north (-Z) is up on screen
  orthoCam.position.set(state.view2d.cx, 400000, state.view2d.cz);
  orthoCam.lookAt(state.view2d.cx, 0, state.view2d.cz);
  orthoCam.updateProjectionMatrix();
}
function setViewMode(mode) {
  viewMode = mode;
  const btn = document.getElementById('btn_view');
  if (mode === '2d') {
    // Centre the flat map on where the 3D camera is, so switching views does
    // not teleport the listener to the middle of the country.
    state.view2d.cx = perspCam.position.x;
    state.view2d.cz = perspCam.position.z;
    camera = orthoCam;
    applyOrtho();
    updateFog();
    if (btn) btn.textContent = '3D 視角';
  } else {
    camera = perspCam;
    camera.rotation.order = 'YXZ';
    updateFog();
    if (btn) btn.textContent = '2D 俯視';
  }
  document.body.classList.toggle('view2d', mode === '2d');
}
function updateFlight2D(dt) {
  const g = state.meta.geo;
  const aspect = innerWidth / innerHeight;
  const fitH = Math.max(g.world_height_m, g.world_width_m / aspect);
  const halfH = (fitH / 2) / state.view2d.zoom;
  const speed = halfH * 1.6 * dt;
  let dx = 0, dz = 0;
  if (keys['w'] || keys['arrowup']) dz -= 1;
  if (keys['s'] || keys['arrowdown']) dz += 1;
  if (keys['a'] || keys['arrowleft']) dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;
  dx += state.touch.side; dz -= state.touch.fwd;
  state.view2d.cx = THREE.MathUtils.clamp(state.view2d.cx + dx * speed,
    -g.world_width_m / 2, g.world_width_m / 2);
  state.view2d.cz = THREE.MathUtils.clamp(state.view2d.cz + dz * speed,
    -g.world_height_m / 2, g.world_height_m / 2);
  applyOrtho();
}

// mouse-drag look
let dragging = false, lastX = 0, lastY = 0;
function initLook(canvas) {
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (viewMode === '2d') {
      // Pan the map: dragging right moves the view west, dragging down moves
      // the view south (the map does not rotate in 2D mode).
      const g = state.meta.geo;
      const wpp = (orthoCam.right - orthoCam.left) / innerWidth;
      state.view2d.cx = THREE.MathUtils.clamp(state.view2d.cx - dx * wpp,
        -g.world_width_m / 2, g.world_width_m / 2);
      state.view2d.cz = THREE.MathUtils.clamp(state.view2d.cz - dy * wpp,
        -g.world_height_m / 2, g.world_height_m / 2);
      applyOrtho();
      return;
    }
    yaw -= dx * 0.0035;
    // negative pitch = looking DOWN, so dragging the mouse DOWN must make the
    // pitch more negative (look further down at the ground).
    pitch = THREE.MathUtils.clamp(pitch - dy * 0.0030, -MAXPITCH, MAXPITCH);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (viewMode === '2d') {
      state.view2d.zoom = THREE.MathUtils.clamp(
        state.view2d.zoom * (e.deltaY < 0 ? 1.15 : 0.87), 0.4, 16);
      applyOrtho();
      return;
    }
    camera.position.y = Math.max(camera.position.y - e.deltaY * 12, 200);
  }, { passive: false });
}

// click a marker -> fly there
const ray = new THREE.Raycaster();
function initClick(canvas) {
  canvas.addEventListener('click', (e) => {
    if (Math.abs(e.clientX - (window.__downX ?? e.clientX)) > 6) return;
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(state.markers.map((m) => m.mesh), false)[0];
    if (hit && hit.object.userData.rec) flyTo(hit.object.userData.rec);
  });
}

// ------------------------------------------------------------------- HUD/labels
const hud = {};
function initHud() {
  ['alt', 'gps', 'speed', 'fps'].forEach((k) => hud[k] = document.getElementById(k));
}
let ndc = new THREE.Vector3();
function updateLabels() {
  const Wm = innerWidth, Hm = innerHeight;
  for (const rec of state.markers) {
    ndc.copy(rec.world).project(camera);
    const behind = ndc.z > 1;
    if (behind || Math.abs(ndc.x) > 1.25 || Math.abs(ndc.y) > 1.25) { rec.el.style.display = 'none'; continue; }
    const x = (ndc.x * 0.5 + 0.5) * Wm, y = (-ndc.y * 0.5 + 0.5) * Hm;
    const d = viewMode === '2d'
      ? Math.hypot(rec.world.x - state.view2d.cx, rec.world.z - state.view2d.cz)
      : camera.position.distanceTo(rec.world);
    rec.el.style.display = 'block';
    rec.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -130%)`;
    rec.el.style.opacity = String(Math.max(0.25, Math.min(1, 90000 / d)));
    rec.el.style.zIndex = String(1000 - Math.round(d / 100));
  }
}

let cursorGeo = { lat: NaN, lon: NaN };
function updateHud(dt) {
  const p = camera.position;
  if (viewMode === '2d') {
    const g = worldToGeo(state.meta, state.view2d.cx, state.view2d.cz);
    hud.alt.textContent = '2D 俯視';
    hud.gps.textContent = g.lat.toFixed(4) + ', ' + g.lon.toFixed(4);
    hud.speed.textContent = '-';
    hud.fps.textContent = (1 / dt).toFixed(0);
    return;
  }
  const ground = elevAt(state.meta, elev_full, elevW, elevH, p.x, p.z);
  hud.alt.textContent = Math.round(p.y / VERT_EXAG) + ' m';
  hud.gps.textContent = isFinite(cursorGeo.lat)
    ? cursorGeo.lat.toFixed(4) + ', ' + cursorGeo.lon.toFixed(4)
    : worldToGeo(state.meta, p.x, p.z).lat.toFixed(4) + ', ' + worldToGeo(state.meta, p.x, p.z).lon.toFixed(4);
  // horizontal speed in true ground metres (the world frame is stretched)
  const g2 = worldToGeo(state.meta, p.x, p.z);
  const vTrue = Math.hypot(vel.x, vel.z) * Math.cos(g2.lat * Math.PI / 180);
  hud.speed.textContent = Math.round(vTrue) + ' m/s';
  hud.fps.textContent = (1 / dt).toFixed(0);
}

// cursor -> ground lat/lon via ray against the terrain mesh
function initCursorReadout(canvas) {
  canvas.addEventListener('pointermove', (e) => {
    const n = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(n, camera);
    const hit = ray.intersectObject(state.mesh, false)[0];
    if (hit) cursorGeo = worldToGeo(state.meta, hit.point.x, hit.point.z);
  });
}

// ------------------------------------------------------------------- scale bar
// The bar must report TRUE ground metres, because the Hong Kong overlay is
// drawn at true ground scale and the two have to agree.
//
// Two traps are avoided here:
//  1. The map frame is a Web-Mercator strip: world metres are NOT ground
//     metres (they are stretched by 1/cos(lat)), so a world-metre scale bar
//     would overstate every distance by ~18%.
//  2. The vertical axis is exaggerated VERT_EXAG times, and the ground under
//     the view centre is not at sea level, so "altitude / tan(pitch)" is
//     wrong as well.
//
// So the bar is measured, not derived: the view ray is marched against the
// terrain to find the ground point under the screen centre, two ground
// points either side of it are projected to screen pixels, and the TRUE
// geodesic distance between them (haversine on their lat/lon) is divided by
// their pixel distance. That is correct at any pitch, altitude, zoom or
// vertical exaggeration, and it is exactly the number a listener reads off
// the map.
function haversineM(a, b) {
  const R = 6371008.8, toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function terrainSurfaceY(x, z) {
  const e = elevAt(state.meta, elev_full, elevW, elevH, x, z);
  return Math.max(e, -500) * VERT_EXAG;
}
// the ground point hit by the camera's central ray
function groundPointUnderCentre(cam) {
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  if (dir.y > -0.02) return null;                 // looking up / at the horizon
  const o = cam.position;
  let tPrev = 0, t = 200;
  for (let i = 0; i < 600; i++) {
    const x = o.x + dir.x * t, y = o.y + dir.y * t, z = o.z + dir.z * t;
    if (y <= terrainSurfaceY(x, z)) {
      let lo = tPrev, hi = t;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        const mx = o.x + dir.x * mid, my = o.y + dir.y * mid, mz = o.z + dir.z * mid;
        if (my <= terrainSurfaceY(mx, mz)) hi = mid; else lo = mid;
      }
      const ft = (lo + hi) / 2;
      return new THREE.Vector3(o.x + dir.x * ft, o.y + dir.y * ft, o.z + dir.z * ft);
    }
    tPrev = t;
    t += Math.max(150, t * 0.02);
    if (t > 600000) break;
  }
  return null;
}
// true ground metres covered by one screen pixel at the centre of the view
function groundMetresPerPixel() {
  const cam = camera;
  let hit;
  if (cam.isOrthographicCamera) {
    // The flat map has no central ray to march: the ground point under the
    // middle of the screen is the map centre itself.
    hit = new THREE.Vector3(state.view2d.cx, 0, state.view2d.cz);
  } else {
    hit = groundPointUnderCentre(cam);
  }
  if (!hit) return null;
  // horizontal screen-right direction in world space
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  right.y = 0;
  if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
  right.normalize();
  const step = 1000;                               // world metres
  const mk = (sgn) => {
    const x = hit.x + right.x * step * sgn, z = hit.z + right.z * step * sgn;
    return new THREE.Vector3(x, terrainSurfaceY(x, z), z);
  };
  const a = mk(-1), b = mk(1);
  const pa = a.clone().project(cam), pb = b.clone().project(cam);
  const px = Math.hypot((pb.x - pa.x) * innerWidth / 2, (pb.y - pa.y) * innerHeight / 2);
  if (!(px > 0.05)) return null;
  const trueM = haversineM(worldToGeo(state.meta, a.x, a.z), worldToGeo(state.meta, b.x, b.z));
  if (!(trueM > 0)) return null;
  return trueM / px;
}
function updateScaleBar() {
  const mPerPx = groundMetresPerPixel();
  if (!mPerPx || !isFinite(mPerPx) || mPerPx <= 0) return;
  const want = mPerPx * innerWidth * 0.18;
  const nice = [1, 2, 5, 10, 20, 50, 100];
  let km = 1; for (const n of nice) { if (n * 1000 <= want) km = n; }
  document.getElementById('scalebar').style.width = (km * 1000 / mPerPx).toFixed(0) + 'px';
  document.getElementById('scaletext').textContent = km + ' km';
}


// ------------------------------------------------------------------------ main
let elev_full, elevW, elevH;
async function main() {
  const { meta, elev, W, H } = await loadElevJson();
  state.meta = meta; elev_full = elev; elevW = W; elevH = H;

  initThree();
  buildTerrain(meta, elev, W, H);

  // Water bodies: authoritative per-pixel surface raster (Dead Sea -401 m,
  // Sea of Galilee -209 m, Mediterranean 0 m). Missing file must not kill the app.
  try {
    const water = await loadWaterRaster();
    state.waterAnalysis = water;          // set BEFORE building meshes: rivers need it
    // The raster surface is only a fallback. The vector outline
    // (water_vector.json, triangulated with earcut) gives a clean shoreline;
    // building the surface from the raster gives a 153 m staircase and stray
    // inland cells, so the vector mesh replaces it whenever it is available.
    const vecMesh = await buildWaterVectorMesh(meta);
    if (!vecMesh) buildWaterMesh(water, meta);
  } catch (err) {
    console.error('water raster failed:', err);
    state.waterAnalysis = null;
    const f = document.getElementById('fatal');
    if (f) { f.textContent = 'WARNING: water raster unavailable (' + err.message + ')'; f.style.display = 'block'; }
  }

  // Vector coastline + vector rivers. These are SEPARATE from the water raster:
  // a coastline is a vector fact, and a river is far narrower than one DEM pixel.
  try {
    const coast = await (await fetch(COAST_URL)).json();
    state.shoreline = buildShoreline(coast, meta);
    state.coastInfo = { sea_runs: (coast.sea_runs || []).length,
                        lakes: (coast.lakes || []).map(l => ({ name: l.name, level_m: l.level_m,
                                                               segments: (l.segments || []).length })) };
  } catch (err) {
    console.error('coastline failed:', err);
    state.shoreline = null; state.coastInfo = null;
  }
  try {
    const riv = await (await fetch(RIVERS_URL)).json();
    state.rivers = riv.rivers || [];
    state.riverMesh = buildRiverMesh(state.rivers, meta);
    state.riverInfo = { source: riv.source, count: state.rivers.length,
                        total_km: Math.round(state.rivers.reduce((a, r) => a + r.length_m, 0) / 1000),
                        vertices: state.riverMesh ? state.riverMesh.geometry.attributes.position.count : 0 };
  } catch (err) {
    console.error('rivers failed:', err);
    state.riverMesh = null; state.rivers = []; state.riverInfo = null;
  }

  state.sites = (await (await fetch(SITES_URL)).json()).sites;
  buildMarkers(meta, state.sites);

  // Hong Kong comparison overlay (optional, toggled from the HUD).
  await loadHKMeta();
  buildHKOverlay();

  // start: tilted aerial view over central Israel (near Jerusalem/Samaria)
  const start = geoToWorld(meta, 32.05, 35.15);
  camera.position.set(start.x, 26000, start.z + 42000);
  pitch = -THREE.MathUtils.degToRad(57); yaw = 0;
  camera.rotation.set(pitch, yaw, 0, 'YXZ');

  initLook(document.getElementById('scene'));
  initClick(document.getElementById('scene'));
  initCursorReadout(document.getElementById('scene'));
  initHud();

  // HUD buttons: HK overlay / 2D-3D switch / gyroscope / calibrate / boost.
  const btnHK = document.getElementById('btn_hk');
  if (btnHK) btnHK.addEventListener('click', () => toggleHKOverlay());
  const btnView = document.getElementById('btn_view');
  if (btnView) btnView.addEventListener('click', () =>
    setViewMode(viewMode === '2d' ? '3d' : '2d'));
  const btnGyro = document.getElementById('btn_gyro');
  if (btnGyro) btnGyro.addEventListener('click', () => {
    if (gyro.active) {
      gyro.active = false;
      document.body.classList.remove('gyro-on');
      btnGyro.textContent = '感應器：關';
      toast('感應器已關閉');
    } else enableGyro();
  });
  const btnCal = document.getElementById('btn_cal');
  if (btnCal) btnCal.addEventListener('click', () => gyroCalibrate());
  const btnBoost = document.getElementById('btn_boost');
  if (btnBoost) btnBoost.addEventListener('click', () => {
    state.touch.boost = !state.touch.boost;
    btnBoost.classList.toggle('on', state.touch.boost);
    toast(state.touch.boost ? '加速：開' : '加速：關');
  });

  // Touch control pad (mobile): sets the same axes as the keyboard.
  document.querySelectorAll('[data-touch]').forEach((el) => {
    const axis = el.dataset.touch;      // fwd/back/left/right/up/down/boost
    const set = (v) => {
      if (axis === 'boost') state.touch.boost = !!v;
      else if (axis === 'fwd') state.touch.fwd = v;
      else if (axis === 'back') state.touch.fwd = -v;
      else if (axis === 'left') state.touch.side = -v;
      else if (axis === 'right') state.touch.side = v;
      else if (axis === 'up') state.touch.up = v;
      else if (axis === 'down') state.touch.up = -v;
      el.classList.toggle('pressed', !!v);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); set(1);
    });
    el.addEventListener('pointerup', () => set(0));
    el.addEventListener('pointercancel', () => set(0));
    el.addEventListener('pointerleave', () => set(0));
  });

  addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
    if (['arrowup','arrowdown','arrowleft','arrowright',' '].includes(e.key.toLowerCase())) e.preventDefault();
    if (e.key.toLowerCase() === 'h') document.body.classList.toggle('nohelp');
    if (e.key.toLowerCase() === 'm') toggleHKOverlay();
    if (e.key.toLowerCase() === 'v') setViewMode(viewMode === '2d' ? '3d' : '2d');
  });
  addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

  document.getElementById('legend').innerHTML = RAMP.map(([e, c]) =>
    `<li><i style="background:rgb(${c.map(v => Math.round(v * 255)).join(',')})"></i>${e} m</li>`).join('');
  document.getElementById('exag').textContent = VERT_EXAG + 'x';

  const clock = new THREE.Clock();
  let acc = 0, frames = 0;
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);
    updateFlight(dt);
    updateRiverScale();          // keep rivers >= RIVER_MIN_PX wide on screen
    renderer.render(scene, camera);
    updateLabels();
    updateScaleBar();
    acc += dt; frames++;
    if (acc > 0.25) { updateHud(acc / frames); acc = 0; frames = 0; }
  }
  loop();

  // expose a handle for automated verification
  window.__israel3d = { THREE, scene, camera, renderer, state, elevAt: () => elevAt(state.meta, elev_full, elevW, elevH, camera.position.x, camera.position.z),
    // Move the camera to a lon/lat at a given altitude and look direction.
    // The app owns pitch/yaw as module state and rewrites camera.rotation
    // every frame, so setting camera.rotation directly is silently undone.
    setView: (lon, lat, alt, pitchDeg, yawDeg) => {
      const w = geoToWorld(state.meta, lat, lon);
      state.flyingTo = null;
      if (viewMode === '2d') {
        // In the flat view there is no camera to fly: move the map centre.
        state.view2d.cx = w.x; state.view2d.cz = w.z;
        applyOrtho();
        return { x: Math.round(w.x), y: alt, z: Math.round(w.z) };
      }
      camera.position.set(w.x, alt, w.z);
      pitch = THREE.MathUtils.clamp(THREE.MathUtils.degToRad(pitchDeg), -MAXPITCH, -0.05);
      yaw = THREE.MathUtils.degToRad(yawDeg);
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      return { x: Math.round(w.x), y: alt, z: Math.round(w.z) };
    },
    setViewMode: (m) => setViewMode(m),
    // The active camera changes when the view switches between 3D and 2D, so
    // expose it through a getter instead of a snapshot taken at startup.
    getCamera: () => camera,
    // Terrain elevation (real metres, not exaggerated) at a world position.
    elevAtWorld: (x, z) => elevAt(state.meta, elev_full, elevW, elevH, x, z),
    toggleHK: (on) => toggleHKOverlay(on),
    viewMode: () => viewMode,
    gyroReport: () => ({
      active: gyro.active, beta: gyro.beta, gamma: gyro.gamma,
      rotZ: gyro.rotZ, accel: gyro.accel, base: gyro.base,
    }),
    hkReport: () => ({
      visible: !!(state.hkOverlay && state.hkOverlay.visible),
      meta: state.hkMeta,
      repeat: state.hkOverlay
        ? [state.hkOverlay.material.map.repeat.x, state.hkOverlay.material.map.repeat.y] : null,
      offset: state.hkOverlay
        ? [state.hkOverlay.material.map.offset.x, state.hkOverlay.material.map.offset.y] : null,
      scaleText: document.getElementById('scaletext').textContent,
      scalePx: document.getElementById('scalebar').style.width,
      metresPerPixel: groundMetresPerPixel(),
    }),
    waterVectorReport: () => state.waterVectorReport || null,
    waterReport: () => state.waterAnalysis ? (state.waterAnalysis.meta.bodies || null) : null,
    riverReport: () => state.riverInfo || null,
    coastReport: () => state.coastInfo || null,
    sceneCounts: () => {
      let meshes = 0, lines = 0, verts = 0;
      scene.children.forEach(o => {
        if (o.isMesh) { meshes++; if (o.geometry && o.geometry.attributes.position) verts += o.geometry.attributes.position.count; }
        if (o.isLineSegments || o.isLine) { lines++; if (o.geometry && o.geometry.attributes.position) verts += o.geometry.attributes.position.count; }
      });
      return { meshes, lines, verts };
    } };
  document.body.classList.add('ready');
}
main().catch((err) => {
  document.getElementById('fatal').textContent = 'FATAL: ' + (err && err.stack ? err.stack : err);
  document.getElementById('fatal').style.display = 'block';
  console.error(err);
});
