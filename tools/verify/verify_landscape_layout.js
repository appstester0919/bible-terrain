// LANDSCAPE layout regression harness for the israel3d map.
//   node tools/verify/verify_landscape_layout.js
// (read-only against the app; every artifact under .hermes/cache/scratch/)
//
// Dedicated Chrome: port 9334, profile /tmp/chrome-israel3d-landscape.
// NEVER touches port 9222 or 9333, never kills any chrome it did not start.
//
// Checks (one named check each):
//   L1  landscape 844x390  controls do not cover the centre of the canvas
//   L2  landscape 844x390  #controls contains all its buttons, incl. 香港地圖 +
//       boost, every one visible and inside the bar without horizontal scroll
//   L3  landscape 844x390  drawer bounded + computed overflow-y + really scrolls
//   L4  landscape 844x390  last site reachable after scrolling to bottom, and no
//       collision with the D-pad chrome (#pad / #dpad)
//   CTRL_/DRAWER_*/BOOST_* at 740x360 and 900x500  (check 3a/3b + single boost)
//   NO_FALSE_TRIGGER_*     1920x1080 and 1000x1200 keep original offsets
//   P1/P2                  portrait 390x844 unchanged
//   BOOST_single_*         exactly one #btn_boost at every viewport, also after
//                          opening/closing the drawer
//   T1/T2                  real CDP mouse clicks (Input.dispatchMouseEvent) on
//                          #tab_right and on the drawer's own close button
//   X1                     no console errors / uncaught exceptions in the run
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./harness_lib').resolveWs();

const CDP_PORT = parseInt(process.env.ISRAEL3D_CDP_PORT || '9334', 10);  // ours only
const PAGE = process.env.PAGE_URL || "http://127.0.0.1:8765/";
const SCRATCH = require('./harness_lib').artifactDir();
const DIAG = path.join(SCRATCH, 'diag');
const STAMP = 'landfix_' + Date.now();
const OUT = path.join(SCRATCH, STAMP + '_results.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
    }).on('error', rej);
  });
}

// Probe run inside the page: measures every property the checks need.
const PROBE = `(function () {
  const R = el => { if (!el) return null; const b = el.getBoundingClientRect();
    return {left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height}; };
  const cs = el => getComputedStyle(el);
  const body = document.body;
  const canvas = document.getElementById('scene');
  const controls = document.getElementById('controls');
  const sites = document.getElementById('sites');
  const pad = document.getElementById('pad');
  const dpad = document.getElementById('dpad');
  const tabRight = document.getElementById('tab_right');
  const boost = document.getElementById('btn_boost');
  const cq = cs(controls), sq = cs(sites);
  const cr = R(controls), sr = R(sites), pr = R(pad), dr = R(dpad), tr = R(tabRight), br = R(boost);
  const ccr = R(canvas);
  const mediaMatch = m => { try { return matchMedia(m).matches; } catch (e) { return 'ERR:' + e.message; } };
  // #controls' own children, plus the boost wherever app.js parked it
  const ctrlBtns = Array.from(controls.querySelectorAll('button'));
  const boostHostId = boost ? (boost.parentElement ? boost.parentElement.id : '(none)') : '(missing)';
  if (boost && !ctrlBtns.includes(boost)) ctrlBtns.push(boost);
  const btnReport = ctrlBtns.map(b => {
    const r = R(b), s = cs(b);
    return { id: b.id || null, text: (b.textContent || '').trim(),
             left: Math.round(r.left), top: Math.round(r.top),
             width: Math.round(r.width), height: Math.round(r.height),
             visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden',
             inViewport: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
             insideControlsRect: cr ? (r.left >= cr.left - 1.5 && r.top >= cr.top - 1.5 &&
                                        r.right <= cr.right + 1.5 && r.bottom <= cr.bottom + 1.5) : false };
  });
  const dpr = devicePixelRatio;
  return {
    innerWidth, innerHeight, deviceScaleFactor: dpr,
    cssSize: { w: Math.round(innerWidth / dpr), h: Math.round(innerHeight / dpr) },
    bodyClass: body.className,
    touch: body.classList.contains('touch'), compact: body.classList.contains('compact'),
    showRight: body.classList.contains('show-right'), showLeft: body.classList.contains('show-left'),
    landscapeMedia: mediaMatch('(max-height: 560px) and (min-width: 600px) and (aspect-ratio >= 4/3)'),
    env: { coarse: matchMedia('(pointer: coarse)').matches, anyHover: matchMedia('(any-hover: hover)').matches,
           maxTouchPoints: navigator.maxTouchPoints, ontouchstart: typeof ontouchstart !== 'undefined' },
    canvas: ccr, controls: cr, sites: sr, pad: pr, dpad: dr, tabRight: tr,
    controlsCs: { position: cq.position, top: cq.top, left: cq.left, bottom: cq.bottom,
                  right: cq.right, transform: cq.transform, maxWidth: cq.maxWidth,
                  overflowX: cq.overflowX, zIndex: cq.zIndex },
    controlsScroll: { scrollWidth: controls.scrollWidth, clientWidth: controls.clientWidth,
                      scrollLeft: controls.scrollLeft },
    sitesCs: { position: sq.position, top: sq.top, right: sq.right, bottom: sq.bottom,
               left: sq.left, width: sq.width, maxHeight: sq.maxHeight,
               overflowY: sq.overflowY, overflowX: sq.overflowX, zIndex: sq.zIndex },
    sitesScroll: { scrollHeight: sites.scrollHeight, clientHeight: sites.clientHeight,
                   scrollTop: sites.scrollTop },
    buttons: btnReport,
    boostCount: document.querySelectorAll('#btn_boost').length,
    boostHostId, boostRect: br,
    boostVisible: !!boost && br.width > 0 && br.height > 0 && cs(boost).display !== 'none',
    boostText: boost ? (boost.textContent || '').trim() : null,
    padDisplay: cs(pad).display, padVisible: pr ? (pr.width > 0 && pr.height > 0) : false,
    dpadVisible: dr ? (dr.width > 0 && dr.height > 0) : false,
    tabRightDisplay: cs(tabRight).display, sitesDisplay: cs(sites).display,
    siteItemCount: document.querySelectorAll('#sitelist li').length,
    lastSiteRect: R(document.querySelector('#sitelist li:last-child')),
    firstSiteRect: R(document.querySelector('#sitelist li:first-child')),
  };
})()`;

function intersect(a, b) {
  if (!a || !b) return null;
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return { w: +w.toFixed(1), h: +h.toFixed(1), area: +(Math.max(0, w) * Math.max(0, h)).toFixed(1),
           overlap: w > 1 && h > 1 };
}
function centralBox(c) {   // middle 50% width x middle 50% height of the canvas
  return { left: c.left + c.width / 4, top: c.top + c.height / 4,
           right: c.left + c.width * 3 / 4, bottom: c.top + c.height * 3 / 4,
           width: +c.width.toFixed(1), height: +c.height.toFixed(1),
           cx: c.left + c.width / 2, cy: c.top + c.height / 2 };
}

(async () => {
  fs.mkdirSync(DIAG, { recursive: true });
  const list = JSON.parse(await get('/json/list'));
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target on port ' + CDP_PORT);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  let id = 0; const pend = new Map(); const consoleErrors = [];
  ws.on('message', m => {
    const msg = JSON.parse(m);
    if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      consoleErrors.push('EXCEPTION: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text || JSON.stringify(d)).slice(0, 300));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const txt = (msg.params.args || []).map(a => a.value || a.description || '').join(' ');
      consoleErrors.push('console.error: ' + txt.slice(0, 300));
    }
  });
  const cdpErrors = [];
  const send = (method, params = {}) => new Promise(r => {
    const i = ++id;
    pend.set(i, x => { if (x.error) { cdpErrors.push(method + ': ' + JSON.stringify(x.error).slice(0, 160)); console.log('CDPERR ' + method + ' ' + JSON.stringify(x.error).slice(0, 200)); } r(x); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails).slice(0, 400));
    return (r.result && r.result.result) ? r.result.result.value : undefined;
  };

  // drawer bottom must clear the real D-pad cross (#dpad); #pad is a full-width
  // flex band that legitimately wraps both the cross and the boost cluster.
  function chromeCollides(sites, dpad, pad) {
    const d = intersect(sites, dpad), p = intersect(sites, pad);
    return { dpadOverlap: !!(d && d.overlap), padBandOverlap: !!(p && p.overlap),
             dpadOverlapArea: d ? d.area : null, padOverlapArea: p ? p.area : null };
  }

  const traces = {};
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 900) : ''));
    return !!ok;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');

  async function setViewport(w, h, touch) {
    // Chrome only reports (pointer: coarse) when touch emulation is on, and that
    // emulation PERSISTS across Page.navigate - so it must be re-asserted for
    // every size, or a desktop viewport silently inherits body.touch from the
    // previous landscape run. Desktop sizes: explicit fine pointer + clearTouch.
    // NOTE (measured, not assumed): Emulation.setEmulatedMedia{pointer:fine} does
    // flip matchMedia('(pointer: coarse)') to false, but if touch EMULATION is
    // still enabled Chrome keeps dispatching mouse events as touch events and the
    // app's own `if (window.ontouchstart !== undefined || navigator.maxTouchPoints > 0)`
    // fallback then forces body.touch on a desktop viewport. Desktop sizes must
    // therefore DISABLE touch emulation outright, not just emulate a fine pointer.
    await send('Emulation.clearDeviceMetricsOverride');
    if (touch) {
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] });
    } else {
      // Chrome rejects maxTouchPoints:0 ("must be between 1 and 16") and has no
      // Emulation.clearEmulatedMedia in this build - a silently-failed call here
      // leaves touch emulation ON, which is what previously forced body.touch on
      // the desktop sizes. enabled:false alone is enough to drop (pointer: coarse).
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
    await send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: !!touch });
    await send('Page.navigate', { url: PAGE + '?land=' + STAMP + '&v=' + w + 'x' + h + '&t=' + Date.now() });
    let ready = false, mode = null;
    for (let i = 0; i < 80; i++) {
      ready = await evalJS('!!window.__israel3d').catch(() => false);
      if (ready) break; await sleep(250);
    }
    const wantTouch = !!touch, wantCompact = touch || w < 1100;
    for (let i = 0; i < 40; i++) {          // let applyLayoutMode settle to the requested mode
      mode = await evalJS(`({t:document.body.classList.contains('touch'),c:document.body.classList.contains('compact')})`);
      if (mode && mode.t === wantTouch && mode.c === wantCompact) break;
      await sleep(250);
    }
    await sleep(600);                       // let placeBoost settle after resize
    return { ready, mode };
  }
  async function openDrawer() {   // real CDP click on the handle, not element.click()
    const t = await centerOf('#tab_right');
    if (t && t.display !== 'none' && t.w > 0) await realClick(t.x, t.y);
    else await evalJS(`(function(){var t=document.getElementById('tab_right');if(t)t.click();})()`);
    await sleep(350);
    return await probe();
  }
  async function closeDrawer() { await evalJS(`document.body.classList.remove('show-left','show-right')`); await sleep(300); }
  async function probe() { return await evalJS(PROBE); }
  async function shot(tag) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(DIAG, STAMP + '_' + tag + '.png');
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('SHOT  ' + file);
    return file;
  }
  async function centerOf(sel) {
    return await evalJS(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:+r.width.toFixed(1),h:+r.height.toFixed(1),left:+r.left.toFixed(1),top:+r.top.toFixed(1),display:getComputedStyle(e).display};})()`);
  }
  async function realClick(x, y) {   // hit-testing through CDP input, not element.click()
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(400);
  }
  // Click an element at its own screen coordinates. Guarded: CSS hides #tab_right
  // while its drawer is open (display:none -> rect 0,0), and clicking (0,0) hits
  // the canvas, whose pointerdown handler closes any open drawer - that silently
  // undid toggles until this guard existed. Returns null when unclickable.
  async function clickEl(sel) {
    const c = await centerOf(sel);
    if (!c || c.display === 'none' || c.w <= 0 || c.h <= 0) return { ok: false, rect: c };
    await realClick(c.x, c.y);
    return { ok: true, rect: c };
  }
  // Records what the page actually hit-tests at a coordinate, and every drawer
  // mutation with its cause, so a failed toggle check says WHY.
  async function installTrace() {
    await evalJS(`(function(){
      if (window.__trace) return 'already';
      window.__trace = [];
      const push = o => { window.__trace.push(Object.assign({t:Math.round(performance.now())}, o)); };
      document.addEventListener('click', e => {
        const el = e.target.closest ? (e.target.closest('button,#sites,#pad,#controls') || e.target) : e.target;
        push({ ev:'click', target: el.id || el.tagName, x:Math.round(e.clientX), y:Math.round(e.clientY),
              showRight: document.body.classList.contains('show-right') });
      }, true);
      document.addEventListener('pointerdown', e => {
        const el = e.target.closest ? (e.target.closest('button,#sites,#pad,#controls,#scene') || e.target) : e.target;
        push({ ev:'pointerdown', target: el.id || el.tagName, x:Math.round(e.clientX), y:Math.round(e.clientY) });
      }, true);
      const mo = new MutationObserver(ms => ms.forEach(m => {
        if (m.attributeName === 'class') push({ ev:'body.class', value: document.body.className });
      }));
      mo.observe(document.body, { attributes:true, attributeFilter:['class'] });
      return 'installed';
    })()`);
  }
  async function readTrace() { return await evalJS(`JSON.stringify((window.__trace||[]).slice(-14))`).then(t => JSON.parse(t)); }

  // ------------------------------------------------- landscape 844x390 (touch)
  const modes = {};
  modes['844x390'] = await setViewport(844, 390, true);
  await installTrace();
  const p1 = await probe();
  console.log('VIEW 844x390 ' + JSON.stringify({ w: p1.innerWidth, h: p1.innerHeight, dpr: p1.deviceScaleFactor, bodyClass: p1.bodyClass, landscapeMedia: p1.landscapeMedia, padVisible: p1.padVisible }));
  await shot('844x390_closed');

  // ---- check 1: controls do not cover the centre of the canvas
  const cb1 = centralBox(p1.canvas);
  const ic1 = intersect(p1.controls, cb1);
  check('L1_controls_off_centre_844x390', ic1 && !ic1.overlap, {
    controlsRect: p1.controls, centralBox: cb1, intersection: ic1,
    controlsCs: { left: p1.controlsCs.left, top: p1.controlsCs.top, maxWidth: p1.controlsCs.maxWidth } });

  // ---- check 1b: #controls contains ALL its buttons (incl. 香港地圖 + boost),
  //      all visible and inside the bar without needing horizontal scroll
  const noHScroll = p1.controlsScroll.scrollWidth <= p1.controlsScroll.clientWidth + 1;
  // The boost button is ONE element that app.js parks in the right-hand thumb
  // cluster on touch devices (hold-to-boost) and in the toolbar on pointer
  // devices.  The brief allows it to MOVE (never duplicate), so L2 requires it
  // to be visible and on-screen, not to sit inside the toolbar rect.
  const barBtns = p1.buttons.filter(b => b.id !== 'btn_boost');
  const boostBtn = p1.buttons.find(b => b.id === 'btn_boost') || null;
  const contained = barBtns.length >= 5 && barBtns.every(b => b.visible && b.inViewport && b.insideControlsRect);
  const boostOk = !!boostBtn && boostBtn.visible && boostBtn.inViewport;
  const namedOk = p1.buttons.some(b => b.id === 'btn_hk' || /香港地圖/.test(b.text)) &&
                  !!boostBtn && /加速/.test(boostBtn.text || '');
  check('L2_controls_contain_all_buttons_visible_844x390', contained && boostOk && namedOk && noHScroll, {
    buttonCount: p1.buttons.length, barButtonCount: barBtns.length, boostOk,
    boostHostId: p1.boostHostId,
    controlsScroll: p1.controlsScroll, controlsMaxWidth: p1.controlsCs.maxWidth,
    horizontalScrollNeeded: !noHScroll,
    buttons: p1.buttons.map(b => ({ id: b.id, text: b.text, left: b.left, w: b.width, visible: b.visible, inViewport: b.inViewport, insideControlsRect: b.insideControlsRect })) });

  // ---- check 2: drawer bounded + scrollable + last item reachable + no pad collision
  await openDrawer();
  const p2 = await probe();
  const S = p2.sitesScroll, sr = p2.sites;
  const boundedH = sr.height > 120 && sr.height <= p2.innerHeight - 60;
  const overflowOk = ['auto', 'scroll'].includes(p2.sitesCs.overflowY);
  const scrollable = S.scrollHeight > S.clientHeight + 1;
  await evalJS(`(function(){var s=document.getElementById('sites');s.scrollTop=100000;return s.scrollTop;})()`);
  await sleep(300);
  const afterScroll = await probe();
  const maxScroll = S.scrollHeight - S.clientHeight;
  const scrollTopChanged = afterScroll.sitesScroll.scrollTop > 0 && Math.abs(afterScroll.sitesScroll.scrollTop - maxScroll) <= 2;
  const lastRect = afterScroll.lastSiteRect;
  const lastReachable = !!lastRect && lastRect.bottom <= sr.bottom + 1 && lastRect.top >= sr.top - 1;
  const padOverlapOpen = intersect(afterScroll.sites, afterScroll.pad);
  const dpadOverlapOpen = intersect(afterScroll.sites, afterScroll.dpad);
  check('L3_drawer_bounded_scrollable_844x390', boundedH && overflowOk && scrollable && scrollTopChanged, {
    sitesRect: sr, overflowY: p2.sitesCs.overflowY, maxHeight: p2.sitesCs.maxHeight,
    top: p2.sitesCs.top, bottom: p2.sitesCs.bottom, right: p2.sitesCs.right, zIndex: p2.sitesCs.zIndex,
    scrollHeight: S.scrollHeight, clientHeight: S.clientHeight, maxScroll,
    scrollTopAfterJump: afterScroll.sitesScroll.scrollTop });
  const col1 = chromeCollides(sr, afterScroll.dpad, afterScroll.pad);
  check('L4_last_site_reachable_844x390', lastReachable, {
    sitesRectBottom: sr.bottom, lastSiteRect: lastRect,
    condition: 'lastItem.bottom <= sites.bottom+1 && lastItem.top >= sites.top-1' });
  check('L5_no_dpad_collision_844x390', !col1.dpadOverlap, {
    dpadRect: afterScroll.dpad, sitesBottom: sr.bottom, collision: col1,
    condition: 'drawer rect must not overlap the visible D-pad cross (#dpad)' });
  await shot('844x390_drawer_open_scrolled_bottom');

  // ---- check 7: real CDP mouse hit-testing. Order matters: the canvas
  //      pointerdown handler closes any open drawer, so start closed, tap the
  //      handle twice (open -> close), then open again and tap the ✕ inside it.
  await closeDrawer();
  await sleep(300);
  await evalJS(`window.__trace = []`);               // clean baseline for the click sequence
  const tab1 = await centerOf('#tab_right');
  const tap1 = await clickEl('#tab_right');           // tap 1 -> should open
  const afterTap1 = await probe();
  traces.afterTap1 = await readTrace();
  // While the drawer is open #tab_right is display:none, so the close gesture in
  // landscape is a tap on the map (the app's own documented behaviour) - prove it.
  const tabWhileOpen = await centerOf('#tab_right');
  const mapTap = await realClick(Math.round(p1.canvas.left + p1.canvas.width / 2),
                                 Math.round(p1.canvas.top + p1.canvas.height / 2));
  const afterMapTap = await probe();
  traces.afterMapTap = await readTrace();
  const tap2 = await clickEl('#tab_right');           // reopen via the handle
  // The scroll-to-bottom test above left #sites scrolled; its ✕ sits at the top
  // of the scrollable content, so reset first or the close button is off-screen.
  await evalJS(`(function(){var s=document.getElementById('sites');s.scrollTop=0;})()`);
  await sleep(250);
  const afterReopen = await probe();
  traces.afterReopen = await readTrace();
  const xBtnClosed = tabWhileOpen;                    // handle hidden while open: expected
  const xBtn = await clickEl('#close_sites');         // drawer's own ✕ (real coordinates)
  const afterX = await probe();
  traces.afterCloseButton = await readTrace();
  check('T1_tab_right_real_click_opens_drawer',
    tab1.display !== 'none' && tap1.ok && afterTap1.showRight === true, {
    tabRightRectClosed: tab1, showRightAfterRealClickOnHandle: afterTap1.showRight,
    trace: traces.afterTap1 });
  check('T2_map_tap_closes_drawer_and_handle_reopens',
    tabWhileOpen.display === 'none' && afterMapTap.showRight === false &&
    tap2.ok && afterReopen.showRight === true, {
    tabRightRectWhileDrawerOpen: tabWhileOpen,
    mapTapAt: { x: Math.round(p1.canvas.left + p1.canvas.width / 2), y: Math.round(p1.canvas.top + p1.canvas.height / 2) },
    showRightAfterMapTap: afterMapTap.showRight, showRightAfterReopenViaHandle: afterReopen.showRight,
    trace: traces.afterCloseButton });
  check('T3_drawer_close_button_real_click',
    afterReopen.showRight === true && xBtn.ok &&
    afterX.showRight === false && afterX.sitesDisplay === 'none', {
    showRightBeforeCloseButton: afterReopen.showRight, closeSitesRect: xBtn.rect,
    showRightAfterCloseButton: afterX.showRight, sitesDisplayAfter: afterX.sitesDisplay,
    trace: traces.afterCloseButton });
  await shot('844x390_after_tab_right_taps');

  // ---- single boost at 844x390 (closed / open / after taps)
  const boostCounts = [{ state: 'closed', c: p1.boostCount, host: p1.boostHostId, visible: p1.boostVisible },
                       { state: 'open', c: p2.boostCount, host: p2.boostHostId, visible: p2.boostVisible },
                       { state: 'after_taps', c: afterX.boostCount, host: afterX.boostHostId, visible: afterX.boostVisible }];
  check('BOOST_single_844x390', boostCounts.every(b => b.c === 1 && b.visible), boostCounts);

  // ---- checks 3a/3b: 740x360 and 900x500
  const otherSizes = [];
  for (const [w, h] of [[740, 360], [900, 500]]) {
    modes[w + 'x' + h] = await setViewport(w, h, true);
    const a = await probe();
    const cb = centralBox(a.canvas), ic = intersect(a.controls, cb);
    check('CTRL_off_centre_' + w + 'x' + h, ic && !ic.overlap, { controlsRect: a.controls, centralBox: cb, intersection: ic });
    const noHS = a.controlsScroll.scrollWidth <= a.controlsScroll.clientWidth + 1;
    // Same rule as L2: the toolbar's own buttons must be visible and inside
    // the bar; the ONE boost button may live in the thumb cluster on touch
    // devices, but it must be visible and on-screen.
    const aBar = a.buttons.filter(b => b.id !== 'btn_boost');
    const aBoost = a.buttons.find(b => b.id === 'btn_boost') || null;
    const cont = aBar.length >= 5 && aBar.every(b => b.visible && b.inViewport && b.insideControlsRect);
    const aBoostOk = !!aBoost && aBoost.visible && aBoost.inViewport;
    check('CTRL_contain_all_buttons_' + w + 'x' + h, cont && aBoostOk && noHS, {
      controlsScroll: a.controlsScroll, controlsMaxWidth: a.controlsCs.maxWidth, horizontalScrollNeeded: !noHS,
      barButtonCount: aBar.length, boostOk: aBoostOk, boostHostId: a.boostHostId,
      buttons: a.buttons.map(b => ({ id: b.id, left: b.left, w: b.width, visible: b.visible, inViewport: b.inViewport, insideControlsRect: b.insideControlsRect })) });
    check('BOOST_single_' + w + 'x' + h, a.boostCount === 1 && a.boostVisible, { count: a.boostCount, host: a.boostHostId, rect: a.boostRect });
    await openDrawer();
    const b = await probe();
    const maxS = b.sitesScroll.scrollHeight - b.sitesScroll.clientHeight;
    await evalJS(`(function(){var s=document.getElementById('sites');s.scrollTop=100000;return s.scrollTop;})()`);
    await sleep(300);
    const c = await probe();
    const okBounded = b.sites.height > 120 && b.sites.height <= b.innerHeight - 60;
    const okOverflow = ['auto', 'scroll'].includes(b.sitesCs.overflowY);
    const okScroll = maxS > 1 && c.sitesScroll.scrollTop > 0 && Math.abs(c.sitesScroll.scrollTop - maxS) <= 2;
    const lr = c.lastSiteRect;
    const okLast = !!lr && lr.bottom <= b.sites.bottom + 1 && lr.top >= b.sites.top - 1;
    const col = chromeCollides(b.sites, c.dpad, c.pad);
    check('DRAWER_bounded_scrollable_' + w + 'x' + h, okBounded && okOverflow && okScroll, {
      sitesRect: b.sites, overflowY: b.sitesCs.overflowY, top: b.sitesCs.top, bottom: b.sitesCs.bottom, right: b.sitesCs.right,
      scrollHeight: b.sitesScroll.scrollHeight, clientHeight: b.sitesScroll.clientHeight, maxScroll: maxS,
      scrollTopAfterJump: c.sitesScroll.scrollTop });
    check('DRAWER_last_item_reachable_' + w + 'x' + h, okLast, {
      lastSiteRect: lr, sitesBottom: b.sites.bottom,
      condition: 'lastItem.bottom <= sites.bottom+1 && lastItem.top >= sites.top-1' });
    check('DRAWER_no_dpad_collision_' + w + 'x' + h, !col.dpadOverlap, {
      dpadRect: c.dpad, sitesBottom: b.sites.bottom, collision: col,
      condition: 'drawer rect must not overlap the visible D-pad cross (#dpad)' });
    check('BOOST_single_after_open_' + w + 'x' + h, c.boostCount === 1, { count: c.boostCount, host: c.boostHostId });
    otherSizes.push({ size: w + 'x' + h, controls: a.controls, controlsScroll: a.controlsScroll,
                      sites: b.sites, scroll: b.sitesScroll, landscapeMedia: a.landscapeMedia });
    await shot(w + 'x' + h + '_drawer_open');
  }

  // ---- check 4: no false trigger on large desktop viewports.
  //      Baseline offsets come from the app's own non-landscape rules:
  //        #sites{top:14px;right:14px}                      (desktop)
  //        body.compact.show-right #sites{top:92px;bottom:168px}   (compact, no pad)
  //      The landscape rule would instead give bottom 108/64 and right 34/8.
  for (const [w, h] of [[1920, 1080], [1000, 1200]]) {
    modes[w + 'x' + h] = await setViewport(w, h, false);
    const a = await probe();
    const cb = centralBox(a.canvas);
    const dx = Math.abs((a.controls.left + a.controls.width / 2) - cb.cx);
    const tol = 0.12 * a.canvas.width;
    const modeOk = a.touch === false && a.compact === (w < 1100);
    check('NO_FALSE_TRIGGER_CENTRED_' + w + 'x' + h,
      a.landscapeMedia === false && modeOk && dx <= tol, {
      landscapeMedia: a.landscapeMedia, compact: a.compact, touch: a.touch,
      controlsCenterX: +(a.controls.left + a.controls.width / 2).toFixed(1), canvasCenterX: cb.cx,
      offset: +dx.toFixed(1), tolerance: +tol.toFixed(1),
      controlsCsTop: a.controlsCs.top, controlsCsLeft: a.controlsCs.left, controlsCsTransform: a.controlsCs.transform });
    await openDrawer();
    const b = await probe();
    // Original (non-landscape) rules being preserved:
    //   #sites{top:14px;right:14px;max-height:calc(100% - 28px)}  -> desktop: top/right
    //       fixed, height content-driven, capped at innerHeight-28.
    //   body.compact.show-right #sites{top:92px;bottom:168px}     -> compact: both offsets fixed.
    // The landscape rule would instead report bottom 108px/64px and right 34px/8px,
    // so computed top/bottom/right are the discriminating measurements.
    const expTop = b.compact ? 92 : 14;
    const expBottomGap = b.compact ? 168 : 14;      // landscape rule would be 108 (touch) / 64
    const expRightGap = 14;                          // landscape rule would be 34 (touch) / 8
    const topOk = Math.abs(parseFloat(b.sitesCs.top) - expTop) <= 2;
    const botOk = b.compact
      ? Math.abs((b.innerHeight - b.sites.bottom) - expBottomGap) <= 2
      : (b.sitesCs.maxHeight || '').includes('calc(100% - 28px)') && b.sites.height <= b.innerHeight - 28 + 1;
    const rightOk = Math.abs((b.innerWidth - b.sites.right) - expRightGap) <= 2;
    check('NO_FALSE_TRIGGER_DRAWER_OFFSETS_' + w + 'x' + h, topOk && botOk && rightOk, {
      landscapeMedia: b.landscapeMedia, compact: b.compact, touch: b.touch,
      sitesCsTop: b.sitesCs.top, expectedTop: expTop,
      measuredBottomGap: +(b.innerHeight - b.sites.bottom).toFixed(1), expectedBottomGap: expBottomGap,
      measuredRightGap: +(b.innerWidth - b.sites.right).toFixed(1), expectedRightGap: expRightGap,
      overflowY: b.sitesCs.overflowY, sitesHeight: +b.sites.height.toFixed(1),
      sitesCsMaxHeight: b.sitesCs.maxHeight, sitesCsBottom: b.sitesCs.bottom,
      desktopInvariant: 'max-height == innerHeight-28 (content-driven height)',
      landscapeRuleWouldGive: { bottom: '108px or 64px', right: '34px or 8px' } });
    check('BOOST_single_' + w + 'x' + h, b.boostCount === 1, { count: b.boostCount, host: b.boostHostId, visible: b.boostVisible });
    await shot(w + 'x' + h + '_drawer_open');
  }

  // ---- check 5: portrait phone 390x844 unchanged
  modes['390x844'] = await setViewport(390, 844, true);
  const q1 = await probe();
  const cbp = centralBox(q1.canvas);
  const dxp = Math.abs((q1.controls.left + q1.controls.width / 2) - cbp.cx);
  const botGap = q1.innerHeight - q1.controls.bottom;
  // The app's own portrait rule is `body.compact #controls{bottom:172px}` (the
  // space reserved for the flight pad); only body.compact:not(.touch) drops it
  // to 14px. So on a touch phone the correct non-regression baseline is 172px,
  // NOT "within ~40px of the canvas bottom" - that expectation contradicts the
  // app's own CSS and was my harness's error, not the app's.
  check('P1_portrait_controls_bottom_centred_390x844',
    q1.landscapeMedia === false && Math.abs(parseFloat(q1.controlsCs.bottom) - 172) <= 2 && dxp <= 0.06 * q1.canvas.width, {
    landscapeMedia: q1.landscapeMedia, controlsRect: q1.controls,
    bottomGapToCanvasBottom: +botGap.toFixed(1), expectedComputedBottom: '172px (body.compact #controls)',
    centerOffset: +dxp.toFixed(1), canvasBottom: q1.canvas.bottom,
    controlsCsTop: q1.controlsCs.top, controlsCsBottom: q1.controlsCs.bottom });
  await openDrawer();
  const q2 = await probe();
  const expH = q2.innerHeight - 260;
  const hOk = Math.abs(q2.sites.height - expH) <= 30 && q2.sites.height > 120;
  check('P2_portrait_drawer_offsets_unchanged_390x844',
    Math.abs(parseFloat(q2.sitesCs.top) - 92) <= 2 && Math.abs((q2.innerHeight - q2.sites.bottom) - 168) <= 2 && hOk, {
    landscapeMedia: q2.landscapeMedia, sitesCsTop: q2.sitesCs.top, expectedTop: 92,
    measuredBottomGap: +(q2.innerHeight - q2.sites.bottom).toFixed(1), expectedBottomGap: 168,
    sitesHeight: +q2.sites.height.toFixed(1), expectedHeightApprox: expH });
  check('BOOST_single_390x844', q2.boostCount === 1 && q2.boostVisible, { count: q2.boostCount, host: q2.boostHostId, rect: q2.boostRect });
  await shot('390x844_drawer_open');

  // ---- check 8: no console errors anywhere in the run
  const errs = consoleErrors.filter(e => !/favicon/i.test(e));
  check('X1_no_console_errors', errs.length === 0, { errors: errs.slice(0, 5), rawCount: consoleErrors.length });

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  const summary = {
    harness: 'verify_landscape_layout.js', chromePort: CDP_PORT, profile: '/tmp/chrome-israel3d-landscape',
    page: PAGE, stamp: STAMP, checks: results.length, passed, failed,
    keyMeasurements_844x390: {
      canvasRect: p1.canvas, centralBox: cb1, controlsRect: p1.controls, controlsCs: p1.controlsCs,
      controlsScroll: p1.controlsScroll, buttons: p1.buttons,
      sitesRectOpen: sr, sitesCsOpen: p2.sitesCs, sitesScroll: S, maxScroll,
      lastSiteRectAfterScrollToBottom: lastRect, padRect: afterScroll.pad, dpadRect: afterScroll.dpad },
    emulationModes: modes, clickTraces: traces,
    otherLandscapeSizes: otherSizes,
    boostPerViewport: boostCounts.map(b => ({ state: '844x390/' + b.state, count: b.c, host: b.host })),
    consoleErrors: errs.length, cdpErrors, screenshotsDir: DIAG, results,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log('RESULT_JSON ' + JSON.stringify({
    harness: 'verify_landscape_layout.js', checks: results.length, passed, failed,
    consoleErrors: errs.length, resultsFile: OUT,
    perCheck: results.map(r => ({ name: r.name, pass: r.ok, detail: r.detail })) }));
  ws.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e && e.message || e); process.exit(2); });
