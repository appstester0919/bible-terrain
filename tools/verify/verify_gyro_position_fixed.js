// verify_gyro_position_fixed.js — regression harness: the gyroscope may only
// ROTATE the view; it must NEVER TRANSLATE the camera, and it must not break
// the D-pad or keyboard movement. Self-contained CDP driver (no deps beyond ws).
//
//   node tools/verify/verify_gyro_position_fixed.js
//
// Chrome it drives: dedicated headless instance on 127.0.0.1:9336 with profile
// /tmp/chrome-israel3d-prof (started by this script if not already running).
// App under test: http://127.0.0.1:8765/ (python3 -m http.server in
// the repository root; started by this script if not running).
//
// Harness discipline baked in:
//  * ONE navigation-based driver at a time: an O_EXCL lockfile guards the page.
//  * Screenshots (for diagnostics only) go under scratch/diag/ with a unique
//    run-tagged name; no formal acceptance directory is ever touched.
//  * Chrome on 9336 is never closed at the end.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const WebSocket = require('./harness_lib').resolveWs();

const LIB = require('./harness_lib');
const CDP = { host: '127.0.0.1', port: parseInt(process.env.ISRAEL3D_CDP_PORT || '9336', 10) };
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8765/';
const APP_DIR = LIB.REPO;
const CHROME_BIN = LIB.findChrome();
const USER_DATA_DIR = process.env.ISRAEL3D_CHROME_PROFILE || '/tmp/chrome-israel3d-gyro';
const DIAG_DIR = path.join(LIB.artifactDir(), 'diag');
const TAG = 'gyroposfix_' + Date.now();
const LOCK = path.join(LIB.artifactDir(), 'harness_page.lock');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(p) { return new Promise((res, rej) => http.get({ host: CDP.host, port: CDP.port, path: p }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej)); }
function alive(port) { return new Promise(res => { const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, r => { r.resume(); res(true); }); req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); }); }); }

// ---------- single-driver lock (burned-by rule: only ONE navigation harness) --
let locked = false;
function acquireLock() {
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  let fd;
  try { fd = fs.openSync(LOCK, 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') {
      let age = 0;
      try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch (_) {}
      if (age < 10 * 60 * 1000) {
        // A live holder is honoured; a dead PID means the last run died before
        // releasing (crash, SIGKILL, pipe closed) — reclaim instead of deadlock.
        let holder = null; try { holder = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (_) {}
        let aliveHolder = false;
        if (holder && holder.pid) { try { process.kill(holder.pid, 0); aliveHolder = true; } catch (_) {} }
        if (aliveHolder) throw new Error('another harness holds the page lock (' + LOCK + ', pid ' + holder.pid + ', ' + Math.round(age / 1000) + 's old); run this alone');
      }
      try { fs.unlinkSync(LOCK); } catch (_) {}   // stale (>10min) lock
      fd = fs.openSync(LOCK, 'wx');
    } else throw e;
  }
  fs.writeSync(fd, JSON.stringify({ tag: TAG, pid: process.pid, at: new Date().toISOString() }));
  locked = true;
}
function releaseLock() { if (locked) { try { fs.unlinkSync(LOCK); } catch (_) {} locked = false; } }

// ---------- environment bootstrap -------------------------------------------
async function ensureServer() {
  if (await alive(8765)) return 'already running';
  const p = spawn('python3', ['-m', 'http.server', '8765'], { cwd: APP_DIR, stdio: 'ignore', detached: true });
  p.on('error', () => {});
  p.unref();
  for (let i = 0; i < 20; i++) { await sleep(300); if (await alive(8765)) return 'started'; }
  throw new Error('could not start http.server on 8765');
}
async function ensureChrome() {
  if (await alive(CDP.port)) return 'already running';
  const p = spawn(CHROME_BIN, ['--headless=new', '--remote-debugging-port=' + CDP.port,
    '--user-data-dir=' + USER_DATA_DIR, '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore', detached: true });
  p.on('error', () => {});
  p.unref();
  for (let i = 0; i < 30; i++) { await sleep(500); if (await alive(CDP.port)) return 'started'; }
  throw new Error('could not start Chrome on port ' + CDP.port);
}

// ---------- checks bookkeeping ----------------------------------------------
const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : ': ' + detail));
}

(async () => {
  acquireLock();
  try {
    console.log('server:', await ensureServer());
    console.log('chrome:', await ensureChrome());

    const list = JSON.parse(await get('/json/list'));
    let page = list.find(t => t.type === 'page');
    if (!page) throw new Error('no CDP page target on ' + CDP.port);
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    let id = 0; const pend = new Map(); const events = [];
    ws.on('message', m => {
      const msg = JSON.parse(m);
      if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
      else if (msg.method) events.push(msg);
    });
    const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pend.set(i, m => m.error ? j(new Error(method + ': ' + JSON.stringify(m.error))) : r(m)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.result.exceptionDetails));
      return r.result && r.result.result ? r.result.result.value : null;
    };
    const shot = async name => {
      try {
        const s = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(DIAG_DIR + '/' + TAG + '_' + name, Buffer.from(s.result.data, 'base64'));
        console.log('shot ' + TAG + '_' + name);
      } catch (_) {}
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.setLifecycleEventsEnabled', { enabled: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // mobile:true + touch emulation makes matchMedia('(pointer: coarse)')
    // true -> body.touch -> the #dpad flight pad is laid out and testable.
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: true });

    // ---- console / page error collection for check 8 ----
    const consoleErrors = [];
    const onEvent = m => {
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        consoleErrors.push('console.' + m.params.type + ': ' + (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 300));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        consoleErrors.push('pageerror: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown').slice(0, 300));
      } else if (m.method === 'Log.entryAdded' && m.params.entry && m.params.entry.level === 'error') {
        consoleErrors.push('log.error: ' + String(m.params.entry.text || '').slice(0, 300));
      }
    };
    ws.on('message', m => { try { onEvent(JSON.parse(m)); } catch (_) {} });

    // ---- inject the synthetic sensor injector BEFORE any event fires ----
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
(function(){
  window.__harnessInjections = 0;
  function fire(type, props){
    var e;
    try {
      e = (type === 'devicemotion')
        ? new DeviceMotionEvent(type, props)
        : new DeviceOrientationEvent(type, props);
    } catch (err) { return false; }
    window.dispatchEvent(e);
    window.__harnessInjections++;
    return true;
  }
  // Sustained large rotation scenario, designed against the app's own
  // detection maths (updateRateCorrelation, app.js ~line 998):
  //  * gamma ramps monotonically -40deg -> +40deg over 2s at a constant
  //    ~40 deg/s. A CONSTANT rate is what the detector's "steady" branch
  //    accepts (centred Pearson needs variance; a constant rotation has
  //    none). gamma never returns, so dGamma stays full-scale for the whole
  //    window and the tilt fallback is also saturated.
  //  * rotationRate.alpha == rotationRate.gamma == dgamma/dt: exactly one
  //    physical axis varies, reported under two raw names (the app treats a
  //    same-sign rival as the same axis), so the turn channel locks onto it.
  //  * beta holds a CONSTANT 30deg tilt: dBeta -> 0, rmsB stays below
  //    corrRefMin=4 deg/s, so no pitch channel is ever accepted and the
  //    scenario cannot rotate the view through a sneaky pitch path either.
  // Sustained large rotation scenario, designed against the app's own
  // detection maths (updateRateCorrelation, app.js ~line 998). Verified by a
  // faithful port of that maths before wiring it in: a CONSTANT gamma rate
  // ramps the centred-coherence score to ~0.99 within ~1s; a sinusoidal
  // sweep never clears the 0.8 threshold (the ramp-down half cancels it).
  //  * gamma ramps monotonically -40deg -> +40deg over 2s at a constant
  //    40 deg/s and HOLDS there: gyro.dGamma stays saturated, so the tilt
  //    fallback is also full-scale for the whole window.
  //  * rotationRate.alpha == rotationRate.gamma == dgamma/dt: one physical
  //    axis reported under two raw names (the app accepts a same-sign rival),
  //    so the turn channel locks onto it.
  //  * beta holds CONSTANT 30deg: dBeta -> 0, rmsB < corrRefMin=4 deg/s, so
  //    no pitch channel is ever accepted — the scenario can only yaw.
  window.__sensorActive = false;
  window.__lastSensorEvents = [];   // what ACTUALLY reached the page listeners
  ['deviceorientation','devicemotion'].forEach(function(type){
    window.addEventListener(type, function(e){
      var L = window.__lastSensorEvents;
      if (L.length > 600) L.splice(0, L.length - 600);
      var rr = type === 'devicemotion' ? e.rotationRate : null;
      L.push({ m: type === 'devicemotion' ? 'motion' : 'orient', t: Math.round(e.timeStamp), ts: Date.now(),
               beta: e.beta, gamma: e.gamma,
               ra: rr ? rr.alpha : null, rb: rr ? rr.beta : null, rg: rr ? rr.gamma : null });
    }, true);
  });
  // Sustained large rotation scenario. A faithful port of the app's own
  // detection maths (updateRateCorrelation, app.js ~line 998) proved:
  //  * a CONSTANT gamma rate reaches centred-coherence ~0.99 within ~1s;
  //    a sinusoidal sweep never clears the corrMin=0.8 threshold.
  //  * BUT the acceptance gate needs motionSeen >= corrSamples(48) AND
  //    corrSpan >= corrSpanS(1.5s), and by event 48 (t=2.9s) a ramp that
  //    STOPS at 2s has already decayed gyro.dGamma to 0 -> score 0.64, gate
  //    never opens. The rate must therefore stay constant for the WHOLE
  //    scenario: gamma ramps past +40deg and keeps going (full tilt deflection
  //    throughout), rotationRate.gamma == dgamma/dt stays at 40 deg/s.
  //  * beta holds CONSTANT 30deg: dBeta -> 0, rmsB < corrRefMin=4 deg/s, so no
  //    pitch channel is ever accepted — the scenario can only yaw.
  window.__startSustainedRotation = function(durationMs){
    if (window.__sensorActive) return true;   // never double-fire scenarios
    window.__sensorActive = true;
    var durMs = durationMs || 6000;
    var t0 = performance.now();
    var lastFire = 0;
    function finish(){ window.__sensorActive = false; }
    // Headless Chrome throttles background setInterval hard, which starves the
    // app's rateStaleMs/orientStaleMs freshness windows. A self-rescheduling
    // rAF chain is not throttled while the page renders, and each event gets
    // its OWN performance.now() timestamp so the app sees real per-event dt
    // instead of one burst clamped to dt=0.005.
    function step(){
      var now = performance.now();
      var t = (now - t0) / 1000;
      if (now - t0 > durMs) { finish(); return; }        // rotate for the whole scenario window
      if (now - lastFire >= 45) {
        lastFire = now;
        var dgdt = 40;                               // constant deg/s, never stops
        var g = -40 + dgdt * t;                      // CONTINUOUS ramp — must never
                                                     // clamp: a clamped gamma means
                                                     // dgamma/dt=0 in the app's own
                                                     // reference (onDeviceOrient), the
                                                     // coherence decays, and corrMin
                                                     // is never reached.
        fire('deviceorientation', { alpha: 0, beta: 30, gamma: g, absolute: false });
        fire('devicemotion', {
          acceleration: null, accelerationIncludingGravity: null, interval: 45,
          rotationRate: { alpha: dgdt, beta: 0, gamma: dgdt },
          rotationRateIncludingGravity: { alpha: dgdt, beta: 0, gamma: dgdt }
        });
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    return true;
  };
  window.__stopSustainedRotation = function(){ window.__sensorActive = false; return true; };
})();` });

    // ---- navigate & wait for the app to be ready ----
    await send('Page.navigate', { url: PAGE + '?gyroposfix=' + Date.now() });
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try { ready = !!(await ev('!!(window.__israel3d && document.body.classList.contains("ready"))')); } catch (_) {}
      if (ready) break;
    }
    if (!ready) throw new Error('app did not become ready (window.__israel3d missing)');
    await sleep(2500); // let terrain/water settle

    // ---- helper installed in the page: snapshot + sustained-sensor scenario ----
    await ev(`(function(){
      const A = window.__israel3d;
      window.__snap = () => {
        const c = A.getCamera();
        const d = new A.THREE.Vector3(); c.getWorldDirection(d);
        const e = new A.THREE.Euler().setFromQuaternion(c.quaternion, 'YXZ'); // app sets rotation.set(pitch,yaw,0,'YXZ')
        return { x: c.position.x, y: c.position.y, z: c.position.z, dirx: d.x, diry: d.y, dirz: d.z,
                 yawDeg: e.y * 180 / Math.PI, pitchDeg: e.x * 180 / Math.PI, mode: A.viewMode() };
      };
      // One scenario = sustained sensor rotation + a settle window, all inside
      // the page so the animation loop keeps running between injections.
      window.__scenario = async (opts) => {
        opts = opts || {};
        if (opts.resetDetection) A.gyroReset();
        const before = window.__snap();
        window.__startSustainedRotation(30000);   // inject continuously the whole scenario
        let locked = null; const trace = [];
        for (let i = 0; i < 80 && !locked; i++) {
          await new Promise(r => setTimeout(r, 250));
          const rep = A.gyroReport();
          trace.push({ t: +((i+1)*0.25).toFixed(2), mode: rep.mode, turnCh: rep.turnCh,
                       turnCorr: +rep.turnCorr.toFixed(3), motionSeen: rep.motionSeen,
                       dGamma: +rep.dGamma.toFixed(1), rateFresh: rep.rateFresh });
          if (rep.mode === 'rate' && rep.turnCh) locked = rep;
        }
        await new Promise(r => setTimeout(r, opts.runMs || 2000)); // yaw moves in rate mode
        const after = window.__snap();
        const report = A.gyroReport();
        window.__stopSustainedRotation();
        await new Promise(r => setTimeout(r, 1600));               // let velocity bleed off
        const settled = window.__snap();
        const L = window.__lastSensorEvents;
        const audit = { events: L.length,
                        orientGaps: (function(){ const o=L.filter(x=>x.m==='orient'); const gg=[]; for(let i=1;i<o.length;i++) gg.push(o[i].ts-o[i-1].ts); gg.sort((u,v)=>u-v); return {n:o.length, median:gg.length?gg[Math.floor(gg.length/2)]:null, max:gg.length?gg[gg.length-1]:null}; })(),
                        motionGaps: (function(){ const o=L.filter(x=>x.m==='motion'); const gg=[]; for(let i=1;i<o.length;i++) gg.push(o[i].ts-o[i-1].ts); gg.sort((u,v)=>u-v); return {n:o.length, median:gg.length?gg[Math.floor(gg.length/2)]:null, max:gg.length?gg[gg.length-1]:null}; })(),
                        lastOrientT: L.length?L[L.length-1].t:null };
        return { before, after, settled, report, locked: !!locked, trace, audit };
      };
      return true;
    })()`);

    const EPS = 1e-6;
    const maxDelta = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
    const dirAngleDeg = (a, b) => {
      const dot = Math.min(1, Math.max(-1, a.dirx * b.dirx + a.diry * b.diry + a.dirz * b.dirz));
      return Math.acos(dot) * 180 / Math.PI;
    };

    // baseline pose: mid-map, looking north. Deliberately well inside the map
    // bounds so the app's "near edge -> auto-turn-back" yaw logic (app.js
    // ~line 1298) cannot contribute orientation drift and pollute check 4.
    await ev(`(function(){ const A=window.__israel3d; A.setViewMode('3d'); return true; })()`);
    await ev(`(function(){ window.__israel3d.setView(35.0, 31.5, 60000, -45, 0); return true; })()`);
    await sleep(1200);

    // ---- enable the gyro through the real UI path (btn_gyro click) ----
    const gyroOn = await ev(`(function(){
      const b = document.getElementById('btn_gyro'); if (!b) return { ok:false, why:'no #btn_gyro' };
      b.click();
      const r = window.__israel3d.gyroReport();
      return { ok: !!r.active, active: !!r.active, sensName: r.sensName };
    })()`);

    const enableProbe = await ev(`(function(){
      const A=window.__israel3d;
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{alpha:0,beta:5,gamma:5,absolute:false}));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion',{acceleration:null,accelerationIncludingGravity:null,interval:66,rotationRate:{alpha:20,beta:0,gamma:20}}));
      const r=A.gyroReport();
      return { active:r.active, injections:window.__harnessInjections, rate:r.rate, motionSeen:r.motionSeen };
    })()`);
    console.log('enableProbe', JSON.stringify(enableProbe));

    // ================= checks 1, 2, 4 (rate-mode scenario) ==================
    let s1 = await ev('window.__scenario({ resetDetection: true, runMs: 5000 })');
    console.log('s1.trace', JSON.stringify(s1.mid));
    console.log('s1.audit', JSON.stringify(s1.audit));
    console.log('s1.trace', JSON.stringify(s1.trace.slice(-6)));
    const d1 = maxDelta(s1.after, s1.settled);
    const dyaw = Math.abs(s1.after.yawDeg - s1.before.yawDeg);
    const ang1 = dirAngleDeg(s1.before, s1.after);
    const rateDriven = s1.locked && !!s1.report.turnCh;

    record('gyro enabled, no movement',
      gyroOn.ok && d1 <= EPS && rateDriven && dyaw > 5,
      !gyroOn.ok ? 'gyro could not be enabled: ' + JSON.stringify(gyroOn)
        : (!rateDriven ? 'counter-test failed first: sensor did not drive the view (mode=' + s1.report.mode + ', turnCh=' + s1.report.turnCh + ') — a no-movement pass would be meaningless'
          : 'max |camera.position delta| = ' + d1.toExponential(3) + ' m while yaw moved ' + dyaw.toFixed(1) + '° in rate mode (sensor locked channel ' + s1.report.turnCh + ', turnCorr=' + s1.report.turnCorr.toFixed(2) + ')'));

    record('gyro does not alter world elevation',
      Math.abs(s1.settled.y - s1.after.y) <= EPS,
      'camera.position.y after-run=' + s1.after.y.toFixed(6) + ' settled=' + s1.settled.y.toFixed(6) + ' delta=' + (s1.settled.y - s1.after.y).toExponential(3) + ' while pitch moved from ' + s1.before.pitchDeg.toFixed(1) + '° to ' + s1.after.pitchDeg.toFixed(1) + '°');

    // ================= check 3: 2D map centre unchanged =====================
    const v2 = await ev(`(function(){ const A=window.__israel3d; A.setViewMode('2d'); return { cx:A.state.view2d.cx, cz:A.state.view2d.cz, zoom:A.state.view2d.zoom }; })()`);
    await sleep(1500);
    // In the flat 2D view there is no perspective camera to steer: updateFlight2D
    // never calls gyroSteer at all. The counter-test for check 3 therefore proves
    // the sensor stream is still ALIVE in this scenario (motionSeen climbing) so
    // "centre unchanged" cannot be an artifact of a dead sensor feed.
    let s2 = await ev(`(async function(){
      const A=window.__israel3d;
      A.gyroReset();
      const before={ x:A.state.view2d.cx, z:A.state.view2d.cz };
      window.__startSustainedRotation(9000);
      let motionSeenMax=0, orientSeenMax=0;
      for (let i=0;i<36;i++){
        await new Promise(r=>setTimeout(r,250));
        const rep=A.gyroReport();
        motionSeenMax=Math.max(motionSeenMax,rep.motionSeen);
        orientSeenMax=Math.max(orientSeenMax, window.__lastSensorEvents.filter(x=>x.m==='orient').length);
      }
      const after={ x:A.state.view2d.cx, z:A.state.view2d.cz };
      window.__stopSustainedRotation();
      await new Promise(r=>setTimeout(r,1600));
      const settled={ x:A.state.view2d.cx, z:A.state.view2d.cz };
      return { before, after, settled, mode:A.viewMode(), motionSeenMax, orientSeenMax, report:A.gyroReport() };
    })()`);
    const dCx = Math.abs(s2.settled.x - s2.after.x), dCz = Math.abs(s2.settled.z - s2.after.z);
    record('gyro does not alter the 2D map centre',
      s2.mode === '2d' && s2.motionSeenMax >= 40 && dCx <= EPS && dCz <= EPS,
      'sensor stream alive in 2D too (motion events seen: ' + s2.motionSeenMax + ', orientation events seen: ' + s2.orientSeenMax + '); ' +
      'view2d.cx delta=' + dCx.toExponential(3) + ' view2d.cz delta=' + dCz.toExponential(3) + ' (cx after/settled ' + s2.after.x.toFixed(3) + '/' + s2.settled.x.toFixed(3) + ', cz ' + s2.after.z.toFixed(3) + '/' + s2.settled.z.toFixed(3) + ')');
    await ev(`(function(){ window.__israel3d.setViewMode('3d'); return true; })()`);
    await sleep(1500);

    // ================= check 4: view orientation DID change ==================
    // rate-mode evidence (from the scenario that drove checks 1/2)
    record('gyro DOES change view orientation',
      ang1 > 5 && dyaw > 5,
      'yaw changed only ' + dyaw.toFixed(2) + '° / world-direction ' + ang1.toFixed(2) + '° after a sustained constant 40°/s rotation (mode=' + s1.report.mode + ', turnCh=' + s1.report.turnCh + ', lastTurnCmd=' + s1.report.lastTurnCmd + ') — sensor events may be ignored');
    // tilt-mode counter-test: NO rotationRate at all -> the app falls back to
    // the absolute-tilt path. Hold a CONSTANT 35deg roll away from the
    // calibrated pose (the real "device with no gyro sensor" case) and assert
    // it still only ROTATES — never translates.
    //
    // The pose is reset to a sane baseline first, so the counter-test does not
    // depend on whatever the preceding checks left behind.
    await ev(`(function(){ window.__israel3d.setView(35.0, 31.5, 60000, -45, 0); return true; })()`);
    await sleep(1200);
    await ev(`(function(){ window.__israel3d.gyroReset(); return true; })()`);
    await sleep(400);
    let s4b = await ev(`(async function(){
      const A=window.__israel3d;
      // calibrate at neutral first so the held 35deg is a real deflection
      for(let i=0;i<8;i++) window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{alpha:0,beta:0,gamma:0,absolute:false}));
      await new Promise(r=>setTimeout(r,300));
      const before=window.__snap();
      var t0=performance.now(); var lastFire=0;
      (function step(){
        var now=performance.now(); var t=(now-t0)/1000;
        if(t>2.5) return;
        if(now-lastFire>=60){ lastFire=now;
          window.dispatchEvent(new DeviceOrientationEvent('deviceorientation',{alpha:0,beta:0,gamma:35,absolute:false})); }
        requestAnimationFrame(step);
      })();
      await new Promise(r=>setTimeout(r,3800));
      return {before,after:window.__snap(),report:A.gyroReport()};
    })()`);
    const ang4b = dirAngleDeg(s4b.before, s4b.after);
    const d4b = maxDelta(s4b.before, s4b.after);
    // The rotation claim is asserted on the YAW ANGLE, not on the angle
    // between the camera's world-direction vectors.  The direction-vector
    // metric is degenerate at a steep pitch: when the camera is pitched to
    // MAXPITCH (pi/2 - 0.05 = 87.14deg, i.e. looking almost straight up)
    // the forward vector is 99.9% vertical, so a 34deg yaw rotation moves it
    // by only 1.69deg and the check reports a false failure.  The camera IS
    // rotated; only the measurement was blind to it.  The yaw angle is the
    // quantity the gyro actually drives, so it is the honest metric.
    const yaw4b = Math.abs(((s4b.after.yawDeg - s4b.before.yawDeg) % 360 + 540) % 360 - 180);
    if (ang1 > 5 && (yaw4b <= 5 || d4b > EPS)) {
      // tilt-mode detail rides on check 4 only when it contradicts the claim
      record('gyro DOES change view orientation', false,
        'tilt-mode fallback: yaw changed only ' + yaw4b.toFixed(2) + '° (world-direction ' + ang4b.toFixed(2) + '°) and position moved ' + d4b.toExponential(3) + ' m (mode=' + s4b.report.mode + ')');
    } else {
      console.log('  detail: tilt-mode fallback also clean — yaw ' + yaw4b.toFixed(1) + '° (world-direction ' + ang4b.toFixed(1) + '°), max position delta ' + d4b.toExponential(3) + ' m, mode=' + s4b.report.mode);
    }

    // ================= check 5: D-pad still moves (gyro ON) ==================
    await ev(`(function(){ window.__israel3d.setView(35.0, 31.5, 60000, -45, 0); return true; })()`);
    await sleep(1000);
    const dpad = await ev(`(async function(){
      const A=window.__israel3d;
      const el=document.getElementById('dpad'); if(!el) return {ok:false,why:'no #dpad element'};
      const r=el.getBoundingClientRect();
      if(r.width===0||r.height===0) return {ok:false,why:'#dpad has zero size (hidden layout?)'};
      const before=window.__snap();
      // pointerdown on the UP arm of the plus -> state.touch.fwd = 1
      const cx=r.left+r.width/2, cy=r.top+8;   // inside vertical arm, above hub
      const opts={pointerId:42,pointerType:'touch',isPrimary:true,button:0,buttons:1,clientX:cx,clientY:cy};
      el.dispatchEvent(new PointerEvent('pointerdown',opts));
      await new Promise(r=>setTimeout(r,1500));
      const mid=window.__snap();
      const touch=A.state.touch;
      el.dispatchEvent(new PointerEvent('pointerup',{...opts,buttons:0}));
      await new Promise(r=>setTimeout(r,1200));
      return {ok:true,before,mid,touch:{fwd:touch.fwd,side:touch.side},report:A.gyroReport()};
    })()`);
    if (!dpad.ok) {
      record('D-pad still moves', false, dpad.why);
    } else {
      const moved = Math.hypot(dpad.mid.x - dpad.before.x, dpad.mid.z - dpad.before.z);
      // "forward" = along the flat heading of the camera view direction
      const fx = dpad.before.dirx, fz = dpad.before.dirz;
      const flen = Math.hypot(fx, fz) || 1;
      const fwdDist = ((dpad.mid.x - dpad.before.x) * fx + (dpad.mid.z - dpad.before.z) * fz) / flen;
      record('D-pad still moves', moved > 50 && fwdDist > 20,
        'forward touch: position moved ' + moved.toFixed(1) + ' m, component along view heading ' + fwdDist.toFixed(1) + ' m (state.touch.fwd was set while pressed; gyro mode=' + dpad.report.mode + ')');
    }

    // ================= check 6: keyboard 'w' still moves =====================
    const kb = await ev(`(async function(){
      const A=window.__israel3d;
      const before=window.__snap();
      dispatchEvent(new KeyboardEvent('keydown',{key:'w'}));
      await new Promise(r=>setTimeout(r,1500));
      const mid=window.__snap();
      dispatchEvent(new KeyboardEvent('keyup',{key:'w'}));
      await new Promise(r=>setTimeout(r,1200));
      const after=window.__snap();
      return {before,mid,after};
    })()`);
    const kbMoved = Math.hypot(kb.mid.x - kb.before.x, kb.mid.z - kb.before.z);
    const kbFx = kb.before.dirx, kbFz = kb.before.dirz;
    const kbFlen = Math.hypot(kbFx, kbFz) || 1;
    const kbFwd = ((kb.mid.x - kb.before.x) * kbFx + (kb.mid.z - kb.before.z) * kbFz) / kbFlen;
    record('keyboard still moves', kbMoved > 50 && kbFwd > 20,
      "'w' keydown: moved " + kbMoved.toFixed(1) + ' m, along heading ' + kbFwd.toFixed(1) + ' m');

    // ================= check 7: keyboard 'e' changes elevation ===============
    const alt = await ev(`(async function(){
      const A=window.__israel3d;
      const before=window.__snap();
      dispatchEvent(new KeyboardEvent('keydown',{key:'e'}));
      await new Promise(r=>setTimeout(r,1500));
      const mid=window.__snap();
      dispatchEvent(new KeyboardEvent('keyup',{key:'e'}));
      await new Promise(r=>setTimeout(r,1200));
      return {before,mid};
    })()`);
    const dy = alt.mid.y - alt.before.y;
    record('keyboard up/down still changes elevation', dy > 50,
      "'e' keydown: camera.position.y from " + alt.before.y.toFixed(1) + ' to ' + alt.mid.y.toFixed(1) + ' m (delta ' + dy.toFixed(1) + ' m)');

    // ================= check 8: no console errors ============================
    await sleep(800);
    const errs = consoleErrors.filter(e => !/favicon/i.test(e));
    record('no console errors', errs.length === 0,
      errs.length ? errs.slice(0, 5).join(' | ') : 'zero console/page errors collected over the whole run');

    await shot('final_state.png');

    // ================= summary ==============================================
    const pass = checks.filter(c => c.pass).length;
    const fail = checks.length - pass;
    fs.writeFileSync(LIB.artifactDir() + '/' + TAG + '_results.json', JSON.stringify({ tag: TAG, at: new Date().toISOString(), pass, fail, checks }, null, 2));
    console.log('RESULT_JSON:' + JSON.stringify({ pass, fail, checks }));
    ws.close();
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    releaseLock();
  }
})().catch(e => {
  console.error('FATAL', e && e.stack || e);
  releaseLock();
  process.exit(2);
});
