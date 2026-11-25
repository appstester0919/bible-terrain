// Shared plumbing for the israel3d verification harnesses.
//
// Why this file exists: the harnesses used to hardcode
//   an npx CACHE path - it changes whenever npm re-resolves, and it
// does not exist on a fresh clone.  A verification harness that cannot be run
// by the person who cloned the repo is not a regression test.
//
// This module resolves `ws` from, in order:
//   1. $WS_MODULE                       (explicit override)
//   2. a plain require('ws')            (a local node_modules, or a global)
//   3. any npm npx cache that has it    (glob ~/.npm/_npx/*/node_modules/ws)
//   4. a fresh `npm i ws` into .verify-deps/   (network, only if 1-3 fail)
//
// It also centralises the Chrome rules that this project has been burned by:
//   * every harness gets its OWN port and its OWN profile directory
//   * NEVER port 9222 (the user's own Chrome) and never 9333 (another agent's)
//   * only ever kill a Chrome process this harness started itself

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

// Ports this project owns.  9222 = the user's Chrome (FORBIDDEN).
// 9333 = another agent's instance (FORBIDDEN).
const RESERVED_PORTS = new Set([9222, 9333]);
const CHROME_BINARIES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  for (const b of CHROME_BINARIES) if (fs.existsSync(b)) return b;
  throw new Error('no Chrome binary found; set $CHROME_BIN');
}

// --- ws resolution ---------------------------------------------------------
function resolveWs() {
  const attempts = [];

  if (process.env.WS_MODULE) {
    attempts.push([process.env.WS_MODULE, 'env $WS_MODULE']);
  }
  attempts.push(['ws', "require('ws')"]);

  // npx caches: the pattern is <cache>/<hash>/node_modules/ws
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  if (fs.existsSync(npxRoot)) {
    for (const d of fs.readdirSync(npxRoot)) {
      const p = path.join(npxRoot, d, 'node_modules', 'ws');
      if (fs.existsSync(p)) attempts.push([p, 'npx cache']);
    }
  }

  // global npm root
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    const p = path.join(root, 'ws');
    if (fs.existsSync(p)) attempts.push([p, 'npm root -g']);
  } catch (_) { /* npm not on PATH: fine */ }

  for (const [spec, why] of attempts) {
    try {
      // eslint-disable-next-line import/no-dynamic-require
      const m = require(spec);
      if (m && (m.WebSocket || m.default)) return m.WebSocket || m.default;
    } catch (_) { /* try the next candidate */ }
  }

  // Last resort: install it next to the repo, into a gitignored folder.
  const deps = path.join(__dirname, '.verify-deps');
  try {
    fs.mkdirSync(deps, { recursive: true });
    execFileSync('npm', ['install', '--no-save', '--prefix', deps, 'ws'], { stdio: 'ignore' });
    const p = path.join(deps, 'node_modules', 'ws');
    if (fs.existsSync(p)) return require(p);
  } catch (_) { /* fall through to the error below */ }

  throw new Error(
    'cannot resolve the "ws" module.  Install it with:\n' +
    '    npm install --no-save --prefix tools/verify/.verify-deps ws\n' +
    'or point $WS_MODULE at an existing copy.'
  );
}

// --- paths -----------------------------------------------------------------
// The repo root is the parent of tools/verify/.
const REPO = path.resolve(__dirname, '..', '..');

// Artifacts (screenshots, JSON results) go somewhere disposable and OUTSIDE
// the repo by default, so a test run can never dirty a git checkout.
function artifactDir() {
  const d = process.env.ISRAEL3D_VERIFY_OUT ||
            path.join(os.tmpdir(), 'israel3d-verify');
  fs.mkdirSync(path.join(d, 'diag'), { recursive: true });
  return d;
}

// --- chrome lifecycle ------------------------------------------------------
function assertPortFree(port) {
  if (RESERVED_PORTS.has(port)) {
    throw new Error(
      `port ${port} is reserved (9222 = the user's Chrome, 9333 = another agent's). ` +
      'Pick a different CDP port for this harness.'
    );
  }
}

function portAlive(port) {
  return new Promise((res) => {
    const http = require('http');
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, (r) => {
      r.resume(); res(true);
    });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

/**
 * Start a dedicated headless Chrome.  Returns { proc, port, profile, stop() }.
 * stop() kills ONLY the process tree this function started.
 */
async function launchChrome({ port, profile, portLabel = '' }) {
  assertPortFree(port);
  if (await portAlive(port)) {
    throw new Error(`port ${port} is already in use${portLabel ? ' (' + portLabel + ')' : ''}`);
  }
  fs.mkdirSync(profile, { recursive: true });
  const bin = findChrome();
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--window-size=1440,900',
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: 'ignore', detached: true });
  proc.unref();

  // wait for the DevTools endpoint
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await portAlive(port)) {
      return {
        proc,
        port,
        profile,
        async stop() {
          try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {
            try { proc.kill('SIGTERM'); } catch (_) {}
          }
          await new Promise((r) => setTimeout(r, 800));
          try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { /* already gone */ }
        },
      };
    }
  }
  throw new Error(`Chrome did not come up on port ${port}`);
}

// A tiny static file server for the app, if one is not already running.
async function ensureServer(port, dir) {
  const http = require('http');
  const alive = () => new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (r) => {
      r.resume(); res(true);
    });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
  if (await alive()) return null;                      // someone else's server: leave it
  const p = spawn('python3', ['-m', 'http.server', String(port)], {
    cwd: dir, stdio: 'ignore', detached: true,
  });
  p.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await alive()) return p;
  }
  throw new Error(`static server did not start on port ${port}`);
}

// --- CDP client ------------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws = null;
  }
  async connect() {
    const WebSocket = resolveWs();
    this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message || 'CDP error'));
        else res(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    });
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
    }
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws && this.ws.close(); } catch (_) {} }
}

// Open a page target and connect to it.
async function openPage(port, url) {
  const http = require('http');
  const list = await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
  let target = list.find((t) => t.type === 'page');
  if (!target) {
    target = await new Promise((res, rej) => {
      http.get({ host: '127.0.0.1', port, path: '/json/new?about:blank' }, (r) => {
        let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(JSON.parse(d)));
      }).on('error', rej);
    });
  }
  const cdp = await new CDP(target.webSocketDebuggerUrl).connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (url) await cdp.send('Page.navigate', { url });
  return cdp;
}

module.exports = {
  REPO,
  RESERVED_PORTS,
  resolveWs,
  findChrome,
  artifactDir,
  launchChrome,
  ensureServer,
  portAlive,
  openPage,
  CDP,
};
