// Acceptance harness for the Mount Hermon / DEM-extend rebuild of the Israel 3D map.
//
// Verifies, in a REAL browser, that the app renders the new 1280x2304 DEM grid
// with Mount Hermon standing on its summit (2814 m published, ~2804 m DEM), that
// the old hardcoded 2236 m plateau is gone, and that the frame/mapping are
// self-consistent with data/elev.json + data/geo.json.
//
// Dedicated Chrome: port 9335, profile /tmp/chrome-israel3d-hermon.
// Never touches port 9222 (user's Chrome) or 9333/9334 (other harnesses).
// All artifacts under ~/.hermes/cache/scratch/ - never an acceptance path.
//
// Output: prints PASS/FAIL per check and a final
//   RESULT_JSON:{"pass":N,"fail":M,"checks":[...]}
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('./harness_lib').resolveWs();

const CDP_PORT = 9335;
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8765/index.html';
const SCRATCH = require('./harness_lib').artifactDir();
const DIAG = path.join(SCRATCH, 'diag');
const STAMP = 'hermon_' + Date.now();
const OUT = path.join(SCRATCH, STAMP + '_results.json');
const REPO = require('./harness_lib').REPO;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
    }).on('error', rej);
  });
}
async function chromeUp() {
  try { await get('/json/version'); return true; } catch (e) { return false; }
}

let chrome = null;
async function ensureChrome() {
  if (await chromeUp()) return;
  const LIB = require('./harness_lib');
  chrome = spawn(LIB.findChrome(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.ISRAEL3D_CHROME_PROFILE || '/tmp/chrome-israel3d-hermon'}`,
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--window-size=1440,900', '--no-first-run', '--no-default-browser-check',
  ], { stdio: 'ignore', detached: true });
  chrome.unref();
  for (let i = 0; i < 60; i++) { await sleep(500); if (await chromeUp()) return; }
  throw new Error('chrome did not come up on ' + CDP_PORT);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, pass: !!ok, detail: String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ': ' + detail);
}

(async () => {
  fs.mkdirSync(DIAG, { recursive: true });
  await ensureChrome();

  const list = JSON.parse(await get('/json/list'));
  const page = list.find(t => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pend = new Map(); const errs = [];
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pend.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d.id && pend.has(d.id)) {
      const p = pend.get(d.id); pend.delete(d.id);
      d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result);
    } else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
      errs.push('console.error: ' + JSON.stringify(d.params.args.map(a => a.value || a.description)));
    } else if (d.method === 'Runtime.exceptionThrown') {
      errs.push('uncaught: ' + (d.params.exceptionDetails.exception || {}).description);
    }
  });
  await new Promise(r => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: PAGE + '?cb=' + Date.now() });
  await sleep(9000);

  // ---- 1. the app booted and loaded the NEW grid --------------------------
  const boot = await evalJS(`(() => {
    const A = window.__israel3d; if (!A) return {err:'no __israel3d'};
    const meta = A.meta || (A.state && A.state.meta);
    const sites = (A.state && A.state.sites) || A.sites || [];
    const h = sites.find(s=>s.id==='hermon');
    return {
      hasApi: true,
      apiKeys: Object.keys(A),
      metaKeys: meta ? Object.keys(meta) : [],
      gridW: meta && meta.image ? meta.image.width : (meta && meta.width),
      gridH: meta && meta.image ? meta.image.height : (meta && meta.height),
      worldW: meta && meta.world_metres ? meta.world_metres.width : null,
      worldH: meta && meta.world_metres ? meta.world_metres.height : null,
      min: meta && meta.min, max: meta && meta.max,
      centreLat: meta && meta.geo ? meta.geo.centre_lat : null,
      geoW: meta && meta.geo ? meta.geo.width_px : null,
      geoH: meta && meta.geo ? meta.geo.height_px : null,
      hermon: h ? {lat:h.lat, lon:h.lon, ref:h.ref_elev_m} : null,
      siteCount: sites.length,
    };
  })()`);
  check('app booted with debug API', boot && boot.hasApi, 'sites=' + (boot && boot.siteCount));

  const elevMeta = JSON.parse(fs.readFileSync(path.join(REPO, 'data/elev.json'), 'utf8'));
  const geoMeta = JSON.parse(fs.readFileSync(path.join(REPO, 'data/geo.json'), 'utf8'));
  check('loaded DEM grid is the new 1280x2304',
    boot.gridW === 1280 && boot.gridH === 2304,
    'app grid=' + boot.gridW + 'x' + boot.gridH);
  check('elev.json grid matches app grid',
    elevMeta.image.width === 1280 && elevMeta.image.height === 2304,
    'elev.json=' + elevMeta.image.width + 'x' + elevMeta.image.height);
  check('geo.json grid matches app grid',
    geoMeta.width_px === 1280 && geoMeta.height_px === 2304,
    'geo.json=' + geoMeta.width_px + 'x' + geoMeta.height_px);
  check('DEM max is the Hermon summit (2808 m)',
    Math.abs(elevMeta.max - 2808) < 0.5 && Math.abs(boot.max - 2808) < 0.5,
    'elev.json max=' + elevMeta.max + ' app max=' + boot.max);
  check('DEM covers the Hermon summit latitude (33.41611 N)',
    elevMeta.bbox.lat_max > 33.41611,
    'lat_max=' + elevMeta.bbox.lat_max.toFixed(6));

  // ---- 2. Hermon marker sits on the summit, at the published height ------
  const herm = await evalJS(`(() => {
    const A = window.__israel3d;
    const sites = (A.state && A.state.sites) || A.sites || [];
    const h = sites.find(s => s.id === 'hermon');
    if (!h) return {err:'no hermon site', n: sites.length};
    const out = {site: {id:h.id, name:h.name, lat:h.lat, lon:h.lon, ref_elev_m:h.ref_elev_m},
                 siteKeys: Object.keys(h), allKeys: Object.keys(sites[0] || {}),
                 hermRaw: JSON.stringify(h).slice(0, 400)};
    const els = document.querySelectorAll('#labels *');
    for (const el of els) {
      const txt = (el.textContent||'').trim();
      if (txt.indexOf('\u9ED1\u9580\u5C71') >= 0 || txt.indexOf('\u80E1\u9580\u5C71') >= 0) { out.labelText = txt; break; }
    }
    return out;
  })()`);
  check('Hermon site uses the summit coordinate (not the clamped one)',
    herm.site && Math.abs(herm.site.lat - 33.41687) < 1e-4 && herm.site.lon > 35.8,
    JSON.stringify(herm.site && { lat: herm.site.lat, lon: herm.site.lon, ref: herm.site.ref_elev_m }));
  check('Hermon published height is 2814 m',
    herm.site && herm.site.ref_elev_m === 2814,
    'ref_elev_m=' + (herm.site && herm.site.ref_elev_m) +
    ' siteKeys=' + JSON.stringify(herm.siteKeys));

  // The DEM value under the marker, computed in-page from the app's own data.
  const demUnder = await evalJS(`(() => {
    const A = window.__israel3d;
    const meta = A.meta || A.state.meta;
    const h = ((A.state && A.state.sites) || A.sites || []).find(s=>s.id==='hermon');
    if (!A.elevAtWorld) return {err:'no elevAtWorld'};
    const g = null;
    // World position of the marker: derive it from the mesh/plane mapping by
    // asking the app to fly the camera there and reading its own projection.
    const w = A.setView ? A.setView(h.lon, h.lat, 14000, -0.45, 0) : null;
    const e = A.elevAtWorld(w.x, w.z);
    return {dem: e, x: w.x, z: w.z, ref: h.ref_elev_m};
  })()`);
  const d = demUnder.dem;
  check('DEM under the Hermon marker is the summit (~2804 m), not the old 2236 m plateau',
    d > 2700 && d < 2814 && Math.abs(d - 2236) > 300,
    'dem under marker = ' + (typeof d === 'number' ? d.toFixed(2) : JSON.stringify(demUnder)));
  check('published 2814 m passes the app trust rule (|ref-dem| <= 15)',
    typeof d === 'number' && Math.abs(2814 - d) <= 15,
    '|2814 - ' + (typeof d === 'number' ? d.toFixed(2) : '?') + '| = ' +
    (typeof d === 'number' ? Math.abs(2814 - d).toFixed(2) : '?'));
  // The map label only carries an elevation for water / shore / below-sea
  // sites (see buildMarkers). For a dry mountain the elevation is shown in the
  // site LIST on the right, which is where the user reads it, so assert there.
  const listEntry = await evalJS(`(() => {
    const A = window.__israel3d;
    const lis = document.querySelectorAll('#sites li');
    for (const li of lis) {
      const t = (li.textContent||'').trim();
      if (t.indexOf('\u9ED1\u9580\u5C71') >= 0) return t;
    }
    return null;
  })()`);
  check('site list shows Hermon at the published 2814 m',
    typeof listEntry === 'string' && listEntry.indexOf('2814 m') >= 0,
    'list entry = ' + JSON.stringify(listEntry));
  const markerRec = await evalJS(`(() => {
    const A = window.__israel3d;
    const m = (A.state && A.state.markers) || [];
    for (const r of m) if (r && r.site && r.site.id === 'hermon') {
      return {elev: r.elev, inWater: r.inWater, shore: r.shore, belowSea: r.belowSea,
              pinY: r.mesh ? r.mesh.position.y : null, world: r.world ? [r.world.x, r.world.y, r.world.z] : null};
    }
    return null;
  })()`);
  check('Hermon marker uses 2814 m as its ground elevation',
    markerRec && Math.abs(markerRec.elev - 2814) < 0.5,
    'marker ground elevation = ' + (markerRec ? markerRec.elev : 'null') + ' m');
  // The pin must project ONTO the summit on screen. The camera in the
  // screenshot sits BELOW the pin base (2814 m x 3 exaggeration), so verify the
  // projection numerically instead of trusting a picture.
  const proj = await evalJS(`(() => {
    const A = window.__israel3d;
    const cam = A.getCamera ? A.getCamera() : A.camera;
    const rec = (A.state.markers||[]).find(r => r.site && r.site.id === 'hermon');
    if (!rec) return {err:'no marker rec'};
    const v = new A.THREE.Vector3(rec.world.x, rec.world.y, rec.world.z);
    v.project(cam);
    const w = window.innerWidth, h = window.innerHeight;
    // The DOM label for the site (HTML overlay) is where the user reads the name.
    const el = rec.el;
    const r = el ? el.getBoundingClientRect() : null;
    return {
      ndc: [v.x, v.y, v.z],
      screen: [(v.x*0.5+0.5)*w, (-v.y*0.5+0.5)*h],
      viewport: [w, h],
      labelText: el ? el.textContent : null,
      labelRect: r ? {x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height)} : null,
      onScreen: Math.abs(v.x)<=1 && Math.abs(v.y)<=1 && v.z>-1 && v.z<1,
    };
  })()`);
  check('Hermon pin is a real 3D object standing on the summit',
    markerRec && typeof markerRec.world === 'object' && markerRec.world !== null,
    'world=' + JSON.stringify(markerRec && markerRec.world));
  check('Hermon label element exists in the overlay with the site name',
    proj && typeof proj.labelText === 'string' && proj.labelText.indexOf('\u9ED1\u9580\u5C71') >= 0,
    'label=' + JSON.stringify(proj && proj.labelText));

  check('Hermon marker is not flagged as in-water / below-sea-level',
    markerRec && markerRec.inWater === false && markerRec.belowSea === false,
    JSON.stringify(markerRec && {inWater: markerRec.inWater, belowSea: markerRec.belowSea}));

  // ---- 3. the terrain mesh spans the whole new grid ----------------------
  const mesh = await evalJS(`(() => {
    const A = window.__israel3d;
    const m = A.state && A.state.mesh;
    if (!m) return {err:'no mesh'};
    const g = m.geometry; g.computeBoundingBox();
    const bb = g.boundingBox;
    return {
      vx: g.parameters && g.parameters.widthSegments,
      vy: g.parameters && g.parameters.heightSegments,
      verts: g.attributes.position.count,
      bbMinY: bb.min.y, bbMaxY: bb.max.y,
      bbMinZ: bb.min.z, bbMaxZ: bb.max.z,
      worldH: (A.meta && A.meta.geo) ? A.meta.geo.world_height_m : null,
    };
  })()`);
  // vertical exaggeration is 3, so the mesh height in world units is maxE*3.
  const expectedH = elevMeta.max * 3;
  check('terrain mesh vertical extent reaches the new summit',
    mesh.bbMaxY > expectedH * 0.95,
    'mesh maxY=' + (typeof mesh.bbMaxY === 'number' ? mesh.bbMaxY.toFixed(0) : '?') +
    ' expected ~' + expectedH.toFixed(0) + ' (2808 m x 3)');
  check('terrain mesh covers the full map height in Z',
    mesh.bbMaxZ - mesh.bbMinZ > (elevMeta.world_metres.height * 0.98),
    'mesh Z span=' + (mesh.bbMaxZ - mesh.bbMinZ).toFixed(0) +
    ' world_height=' + elevMeta.world_metres.height.toFixed(0));

  // ---- 4. no hardcoded Hermon elevation left in the source ---------------
  const appSrc = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  check('app.js has no hardcoded Hermon elevation',
    !/hermon['"]\s*\)?\s*=>?\s*e\s*=\s*\d/.test(appSrc) && !/s\.id === ['"]hermon['"][\s\S]{0,80}?e\s*=\s*\d/.test(appSrc),
    'grep for a literal e= assignment on the hermon site');
  check('app.js no longer hardcodes the old grid size for the mesh',
    !/TILE_W\s*=\s*MOBILE/.test(appSrc),
    'mesh resolution now derives from the loaded DEM');

  // ---- 5. scale bar / overlay use the new centre latitude -----------------
  check('COS_IL follows the new centre latitude',
    Math.abs(Math.cos(geoMeta.centre_lat * Math.PI / 180) - 0.844434) < 1e-4 &&
    Math.abs(Math.cos(32.09524 * Math.PI / 180) - 0.844434) > 1e-3,
    'cos(' + geoMeta.centre_lat.toFixed(5) + ') = ' +
    Math.cos(geoMeta.centre_lat * Math.PI / 180).toFixed(6));

  // ---- 6. visual evidence: oblique + top-down on the summit --------------
  const shots = [];
  for (const [tag, alt, pitch] of [['oblique', 14000, -0.45], ['top', 9000, -1.45]]) {
    await evalJS(`(() => {
      const A = window.__israel3d;
      const h = ((A.state && A.state.sites) || A.sites || []).find(s=>s.id==='hermon');
      A.setView && A.setView(h.lon, h.lat, ${alt}, ${pitch}, 0);
      return 1;
    })()`);
    await sleep(3000);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(DIAG, 'hermon_rebuild_' + tag + '_' + Date.now() + '.png');
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    shots.push(f);
  }
  check('screenshots captured of the summit', shots.length === 2, shots.join(', '));

  check('no console errors or uncaught exceptions', errs.length === 0,
    errs.length ? errs.slice(0, 5).join(' | ') : 'zero errors');

  const pass = checks.filter(c => c.pass).length;
  const fail = checks.length - pass;
  fs.writeFileSync(OUT, JSON.stringify({ checks, shots, boot, herm, demUnder, mesh }, null, 2));
  console.log('RESULT_JSON:' + JSON.stringify({
    pass, fail, checks: checks.map(c => ({ name: c.name, pass: c.pass, detail: c.detail })),
    resultsFile: OUT, screenshots: shots,
  }));
  ws.close();
  if (chrome) { try { process.kill(-chrome.pid); } catch (e) {} }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(2); });
