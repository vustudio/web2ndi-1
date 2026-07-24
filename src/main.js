'use strict';
// webcg-ndi (multi-channel): one Electron process hosts N offscreen "channels".
// Each channel = its own browser (own persistent session partition), rendered to
// its own NDI output via a dedicated sender.py. Channels are configured/persisted
// in /data/channels.json and managed from one HTTP control panel.
const { app, BrowserWindow } = require('electron');
const { spawn, exec } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.CG_DATA_DIR || '/data';
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const GL = process.env.CG_GL || 'egl';
const CTRL_PORT = parseInt(process.env.CTRL_PORT || '8099', 10);

// Persistent profile root (each channel's persist: partition lives under here).
try { app.setPath('userData', DATA_DIR); } catch (e) {}

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-dev-shm-usage');
if (GL === 'swiftshader') {
  app.disableHardwareAcceleration();
} else {
  app.commandLine.appendSwitch('ozone-platform', 'headless');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'gl-egl');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}
for (const f of (process.env.CG_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)) {
  const i = f.indexOf('=');
  if (i > 0) app.commandLine.appendSwitch(f.slice(0, i).replace(/^--/, ''), f.slice(i + 1));
  else app.commandLine.appendSwitch(f.replace(/^--/, ''));
}

// ---- channel config (persisted to /data/channels.json) --------------------
function seedFromEnv() {
  return [{
    id: 'ch1',
    url: process.env.CG_URL || 'https://rnd2.vu.studio/player?wallid=sienna',
    width: parseInt(process.env.CG_WIDTH || '1920', 10),
    height: parseInt(process.env.CG_HEIGHT || '1080', 10),
    fps: parseInt(process.env.CG_FPS || '30', 10),
    name: process.env.NDI_NAME || 'WebCG',
    alpha: (process.env.CG_ALPHA || '1') === '1',
  }];
}
function loadChannels() {
  try { const j = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')); if (Array.isArray(j) && j.length) return j; } catch (e) {}
  return seedFromEnv();
}
function saveChannels() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2)); }
  catch (e) { console.error('[cfg] save failed:', e.message); }
}
function newId() { let n = 1; while (channels.find(c => c.id === 'ch' + n)) n++; return 'ch' + n; }
function sanitize(patch) {
  const o = {};
  if (typeof patch.url === 'string' && patch.url.trim()) o.url = patch.url.trim();
  if (Number.isFinite(+patch.width))  o.width  = Math.max(16, Math.min(7680, +patch.width | 0));
  if (Number.isFinite(+patch.height)) o.height = Math.max(16, Math.min(4320, +patch.height | 0));
  if (Number.isFinite(+patch.fps))    o.fps    = Math.max(1, Math.min(60, +patch.fps | 0));
  if (typeof patch.name === 'string' && patch.name.trim()) o.name = patch.name.trim();
  if (typeof patch.alpha === 'boolean') o.alpha = patch.alpha;
  return o;
}

let channels = [];
const RT = {}; // runtime state keyed by channel id

// JS run in each page to read player identity. The durable id lives in IndexedDB
// (playerId/playerName) once paired, and appears as ?id= in the URL; before pairing
// the unlicensed id is shown on-screen. Returns a Promise (executeJavaScript awaits it).
const SCRAPE_JS = `(async () => {
  try {
    const t = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim();
    const connected = /No User Connected/i.test(t) ? false : (/User Connected/i.test(t) ? true : null);
    let onscreenId = null;
    const u = t.match(/Unlicen[cs]ed Player[:\\s]*([A-Za-z0-9]{4,12})/i);
    if (u) onscreenId = u[1];
    let urlId = null;
    try { urlId = new URLSearchParams(location.search).get('id'); } catch (e) {}
    const idb = {};
    try {
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      for (const info of dbs) {
        const db = await new Promise((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for (const sn of Array.from(db.objectStoreNames)) {
          try {
            await new Promise((res) => {
              const store = db.transaction(sn, 'readonly').objectStore(sn);
              const want = ['playerId', 'playerName']; let pend = want.length;
              want.forEach(k => { const g = store.get(k); g.onsuccess = () => { let v = g.result; if (v && typeof v === 'object' && 'value' in v) v = v.value; if (v !== undefined && idb[k] === undefined) idb[k] = v; if (--pend === 0) res(); }; g.onerror = () => { if (--pend === 0) res(); }; });
            });
          } catch (e) {}
        }
        db.close();
      }
    } catch (e) {}
    // The on-screen "Unlicensed Player" text is authoritative — a leftover playerId
    // in IndexedDB does NOT mean the player is currently licensed.
    const unlicensedScreen = /Unlicen[cs]ed Player/i.test(t);
    // Blocking error screen, e.g. "Player Already Active" (id claimed in another browser)
    let blocked = null;
    if (/Player Already Active/i.test(t)) {
      const bi = t.search(/Player Already Active/i);
      const im = t.match(/This player ID \\(([A-Za-z0-9._-]{3,16})\\)/i);
      blocked = { title: 'Player Already Active', id: im ? im[1] : null, msg: t.slice(bi, bi + 240).trim() };
    }
    // A genuinely paired player has a NAME in IndexedDB. An id on its own can be a
    // pending/stale value (e.g. while the splash screen is still connecting), so it
    // must NOT be treated as licensed.
    let licensed = false, playerId = null, playerName = idb.playerName || null;
    if (blocked)                 { playerId = blocked.id || idb.playerId || null; playerName = null; }
    else if (unlicensedScreen)   { playerId = onscreenId || null; playerName = null; }
    else if (playerName)         { licensed = true; playerId = idb.playerId || urlId || null; }
    else                         { playerId = idb.playerId || urlId || null; }  // connecting / pending
    const actions = [];
    try { for (const e of document.querySelectorAll('button,a,[role=button]')) { const x = (e.innerText || '').trim(); if (x && x.length < 40 && actions.length < 8) actions.push(x); } } catch (e) {}
    const state = blocked ? 'blocked' : (unlicensedScreen ? 'unlicensed' : (licensed ? 'licensed' : 'connecting'));
    const origin = location.origin;
    let perf = null;
    try {
      const v = document.querySelector('video');
      let diag = null;
      const dr = localStorage.getItem('playerDiagnostics');
      if (dr) { try { const a = JSON.parse(dr); diag = a[a.length - 1]; } catch (e) {} }
      if (v) {
        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
        perf = { vw: v.videoWidth, vh: v.videoHeight, ct: +(v.currentTime || 0).toFixed(1), paused: v.paused, readyState: v.readyState, dropped: q.droppedVideoFrames || 0, total: q.totalVideoFrames || 0, diag };
      } else { perf = { diag }; }
    } catch (e) {}
    return { playerId, playerName, licensed, connected, state, origin, blocked, actions, title: document.title, perf };
  } catch (e) { return { error: String(e) }; }
})()`;

// ---- container CPU / mem (cgroup) + GPU (nvidia-smi) sampling -------------
let sysStats = { cpuPercent: 0, cores: os.cpus().length, memMB: 0, gpus: [] };
function readCpuUsec() {
  try { const m = fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').match(/usage_usec\s+(\d+)/); if (m) return +m[1]; } catch (e) {}
  try { return Math.round(+fs.readFileSync('/sys/fs/cgroup/cpuacct/cpuacct.usage', 'utf8').trim() / 1000); } catch (e) {}
  return null;
}
function readMemMB() {
  for (const p of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try { return Math.round(+fs.readFileSync(p, 'utf8').trim() / 1048576); } catch (e) {}
  }
  return 0;
}
let _lastCpu = { usec: readCpuUsec(), t: Date.now() };
setInterval(() => {
  const usec = readCpuUsec(), t = Date.now();
  if (usec != null && _lastCpu.usec != null) {
    const dt = (t - _lastCpu.t) * 1000; // -> usec
    if (dt > 0) sysStats.cpuPercent = Math.round((usec - _lastCpu.usec) / dt * 100);
  }
  _lastCpu = { usec, t };
  sysStats.memMB = readMemMB();
}, 2000);
// ---- host NIC throughput (container is on host networking, so these are Unraid's) ----
// NDI SpeedHQ is roughly ~1.1 bits per pixel; used to estimate per-stream cost.
const NDI_BPP = 0.75;
function ndiMbps(w, h, fps) { return Math.round(w * h * fps * NDI_BPP / 1e6); }
let netStats = { rxMbps: 0, txMbps: 0, ifaces: [] };
function readNetDev() {
  const out = {};
  try {
    for (const l of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const m = l.trim().match(/^([^:]+):\s*(.+)$/); if (!m) continue;
      const name = m[1].trim();
      // physical NICs only — bond/br/shim are stacked layers carrying the SAME
      // packets, so counting them would multiply the real throughput.
      if (/^(lo|docker|veth|br|bond|shim|virbr|tun|tap)/.test(name)) continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      out[name] = { rx: f[0], tx: f[8] };
    }
  } catch (e) {}
  return out;
}
let _lastNet = { v: readNetDev(), t: Date.now() };
setInterval(() => {
  const v = readNetDev(), t = Date.now();
  const dt = (t - _lastNet.t) / 1000;
  if (dt > 0) {
    const ifaces = []; let rxT = 0, txT = 0;
    for (const k of Object.keys(v)) {
      const p = _lastNet.v[k]; if (!p) continue;
      const rx = (v[k].rx - p.rx) * 8 / 1e6 / dt, tx = (v[k].tx - p.tx) * 8 / 1e6 / dt;
      if (rx > 0.05 || tx > 0.05) ifaces.push({ name: k, rxMbps: +rx.toFixed(1), txMbps: +tx.toFixed(1) });
      rxT += rx; txT += tx;
    }
    ifaces.sort((a, b) => b.txMbps - a.txMbps);
    netStats = { rxMbps: +rxT.toFixed(1), txMbps: +txT.toFixed(1), ifaces: ifaces.slice(0, 4) };
  }
  _lastNet = { v, t };
}, 2000);

function pollGpu() {
  exec('nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
    { timeout: 4000 }, (err, out) => {
      if (!err && out) sysStats.gpus = out.trim().split('\n').map(l => {
        const [i, u, mu, mt] = l.split(',').map(x => x.trim());
        return { index: +i, util: +u, memUsed: +mu, memTotal: +mt };
      });
      setTimeout(pollGpu, 3000);
    });
}
pollGpu();

// ---- per-channel sender + offscreen window --------------------------------
function startChannel(ch) {
  const rt = RT[ch.id] = { win: null, sender: null, backed: false, headerSent: false,
    latestJpeg: null, paints: 0, fpsActual: 0, sent: 0, fpsSent: 0, nextDue: 0,
    lastJpegAt: 0, tick: null, fpsTick: null, stopping: false };

  const sender = spawn('python3', [path.join(__dirname, 'sender.py')], {
    env: { ...process.env, CG_FPS: String(ch.fps), NDI_NAME: ch.name, CG_ALPHA: ch.alpha ? '1' : '0' },
    stdio: ['pipe', 'inherit', 'pipe'],
  });
  rt.sender = sender;
  let errbuf = '';
  sender.stderr.on('data', (d) => {          // parse "#STATS {...}" lines, pass the rest through
    errbuf += d.toString();
    let i;
    while ((i = errbuf.indexOf('\n')) >= 0) {
      const line = errbuf.slice(0, i); errbuf = errbuf.slice(i + 1);
      if (line.startsWith('#STATS')) { try { rt.conn = JSON.parse(line.slice(6).trim()).conn; } catch (e) {} }
      else if (line.trim()) console.error(`[${ch.id}] ${line}`);
    }
  });
  sender.stdin.on('drain', () => { rt.backed = false; });
  sender.stdin.on('error', () => {});
  sender.on('exit', (c) => { if (RT[ch.id] === rt && !rt.stopping) console.error(`[${ch.id}] sender exited (${c})`); });
  console.log(`[${ch.id}] sender -> "${ch.name}" ${ch.width}x${ch.height}@${ch.fps} alpha=${ch.alpha}`);

  const win = new BrowserWindow({
    width: ch.width, height: ch.height, useContentSize: true, show: false, frame: false,
    transparent: ch.alpha, backgroundColor: ch.alpha ? '#00000000' : '#000000',
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'persist:' + ch.id },
  });
  rt.win = win;
  win.webContents.setFrameRate(ch.fps);
  rt.tick = setInterval(() => { if (win && !win.isDestroyed()) win.webContents.invalidate(); }, Math.max(1, Math.round(1000 / ch.fps)));
  rt.fpsTick = setInterval(() => { rt.fpsActual = rt.paints; rt.paints = 0; rt.fpsSent = rt.sent; rt.sent = 0; }, 1000);

  // Frame pacing. Chromium delivers paints in bursts (several within a millisecond,
  // then a gap), so gating *on paint arrival* transmits one frame per burst and the
  // rate collapses well below target. Instead: the paint handler only records the
  // newest frame, and a fixed timer transmits it. That yields exactly the declared
  // rate, evenly spaced, always sending the freshest available frame.
  const frameMs = 1000 / ch.fps;
  win.webContents.on('paint', (_e, _d, image) => {
    rt.paints++;
    rt.lastImage = image;
    const now = Date.now();
    if (now - rt.lastJpegAt > 500) { rt.lastJpegAt = now; try { rt.latestJpeg = image.toJPEG(60); } catch (e) {} }
  });
  rt.sendTick = setInterval(() => {
    if (!rt.lastImage || rt.backed || !rt.sender || !rt.sender.stdin.writable) return;
    let bmp; try { bmp = rt.lastImage.getBitmap(); } catch (e) { return; }
    if (!bmp || bmp.length === 0) return;
    if (!rt.headerSent) {
      const s = rt.lastImage.getSize();
      const h = Buffer.alloc(8); h.writeUInt32LE(s.width, 0); h.writeUInt32LE(s.height, 4);
      rt.sender.stdin.write(h); rt.headerSent = true;
      console.log(`[${ch.id}] first frame ${s.width}x${s.height}`);
    }
    if (!rt.sender.stdin.write(bmp)) rt.backed = true;
    rt.sent++;
  }, Math.max(1, Math.round(frameMs)));
  // Periodically scrape player status (id / licensed / connected) from the DOM.
  rt.scrapeTick = setInterval(() => {
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
    win.webContents.executeJavaScript(SCRAPE_JS, true).then(r => { rt.page = r; }).catch(() => {});
  }, 3000);

  win.webContents.on('render-process-gone', (_e, d) => { console.error(`[${ch.id}] render gone: ${d.reason}`); if (win && !win.isDestroyed()) win.reload(); });
  win.webContents.on('did-fail-load', (_e, code, desc) => { console.error(`[${ch.id}] load failed ${code} ${desc}`); setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(ch.url); }, 2000); });
  win.loadURL(ch.url);
}
function stopChannel(id) {
  const rt = RT[id]; if (!rt) return; rt.stopping = true;
  if (rt.tick) clearInterval(rt.tick);
  if (rt.fpsTick) clearInterval(rt.fpsTick);
  if (rt.sendTick) clearInterval(rt.sendTick);
  if (rt.scrapeTick) clearInterval(rt.scrapeTick);
  if (rt.sender) { try { rt.sender.kill('SIGKILL'); } catch (e) {} }
  if (rt.win) { try { rt.win.destroy(); } catch (e) {} }
  delete RT[id];
}

// ---- channel operations ---------------------------------------------------
function addChannel(cfg) {
  const s = sanitize(cfg);
  const ch = { id: newId(), url: s.url || 'https://example.com', width: s.width || 1920, height: s.height || 1080,
    fps: s.fps || 30, name: s.name || ('WebCG-' + Date.now()), alpha: s.alpha !== undefined ? s.alpha : true };
  channels.push(ch); saveChannels(); startChannel(ch); return ch;
}
function removeChannel(id) {
  stopChannel(id); channels = channels.filter(c => c.id !== id); saveChannels();
}
function patchChannel(id, patch) {
  const ch = channels.find(c => c.id === id); if (!ch) return null;
  const s = sanitize(patch);
  const onlyUrl = Object.keys(s).length === 1 && 'url' in s;
  Object.assign(ch, s); saveChannels();
  if (onlyUrl) { const rt = RT[id]; if (rt && rt.win && !rt.win.isDestroyed()) rt.win.loadURL(ch.url); }  // live
  else { stopChannel(id); setTimeout(() => startChannel(ch), 400); }                                        // restart
  return ch;
}

// ---- HTTP control panel ---------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } }); });
}
function startControlServer() {
  const htmlPath = path.join(__dirname, 'control.html');
  http.createServer(async (req, res) => {
    const [pathname, qs] = req.url.split('?');
    const parts = pathname.split('/').filter(Boolean); // e.g. ['channels','ch2','url']
    const query = new URLSearchParams(qs || '');
    try {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(htmlPath)); return;
      }
      if (req.method === 'GET' && pathname === '/preview.jpg') {
        const rt = RT[query.get('id')];
        if (rt && rt.latestJpeg) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); res.end(rt.latestJpeg); }
        else { res.writeHead(503); res.end(); }
        return;
      }
      if (req.method === 'GET' && pathname === '/status') {
        const metrics = {}; try { for (const m of app.getAppMetrics()) metrics[m.pid] = m; } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const chans = channels.map(c => {
          const rt = RT[c.id] || {};
          let cpu = null, memMB = null;
          try { const pid = rt.win && !rt.win.isDestroyed() ? rt.win.webContents.getOSProcessId() : 0; const m = metrics[pid]; if (m) { cpu = Math.round(m.cpu.percentCPUUsage); memMB = Math.round((m.memory.workingSetSize || 0) / 1024); } } catch (e) {}
          const per = ndiMbps(c.width, c.height, c.fps);
          const conn = (rt.conn === undefined || rt.conn === null) ? null : rt.conn;
          return { ...c, fpsActual: rt.fpsActual || 0, fpsSent: rt.fpsSent || 0, connected: !!(rt.sender && rt.win), page: rt.page || null, cpu, memMB,
                   conn, ndiPerStreamMbps: per, ndiOutMbps: (conn && conn > 0) ? per * conn : 0 };
        });
        res.end(JSON.stringify({
          gl: GL, machineName: os.hostname().toUpperCase(),
          system: { ...sysStats, net: netStats, ndiTotalMbps: chans.reduce((a, c) => a + (c.ndiOutMbps || 0), 0) },
          channels: chans,
        }));
        return;
      }
      if (req.method === 'POST' && pathname === '/channels') {          // add
        const b = await readBody(req); const ch = addChannel(b);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ch)); return;
      }
      if (req.method === 'POST' && parts[0] === 'channels' && parts[1]) { // /channels/:id[/action]
        const id = parts[1], action = parts[2];
        if (!channels.find(c => c.id === id)) { res.writeHead(404); res.end('no channel'); return; }
        if (action === 'delete') { removeChannel(id); res.writeHead(200); res.end('ok'); return; }
        if (action === 'reload') { const rt = RT[id]; if (rt && rt.win && !rt.win.isDestroyed()) rt.win.reload(); res.writeHead(200); res.end('ok'); return; }
        if (action === 'url') { const b = await readBody(req); patchChannel(id, { url: b.url }); res.writeHead(200); res.end('ok'); return; }
        if (action === 'click') {   // click a button on the page by its label (e.g. "Retry Connection")
          const b = await readBody(req);
          const label = String(b.label || '').toLowerCase();
          const rt = RT[id];
          let ok = false;
          if (rt && rt.win && !rt.win.isDestroyed() && label) {
            const js = `(() => { const els=[...document.querySelectorAll('button,a,[role=button]')];`
              + ` const el=els.find(e=>((e.innerText||'').trim().toLowerCase()).includes(${JSON.stringify(label)}));`
              + ` if(el){el.click(); return true;} return false; })()`;
            try { ok = await rt.win.webContents.executeJavaScript(js, true); } catch (e) {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ clicked: !!ok })); return;
        }
        // default: config patch
        const b = await readBody(req); patchChannel(id, b); res.writeHead(200); res.end('ok'); return;
      }
      res.writeHead(404); res.end('not found');
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  }).listen(CTRL_PORT, () => console.log(`[webcg] control panel on :${CTRL_PORT} (${channels.length} channel(s))`));
}

app.whenReady().then(() => {
  channels = loadChannels(); saveChannels();
  for (const ch of channels) startChannel(ch);
  startControlServer();
});
app.on('window-all-closed', () => { /* keep running with no channels so the panel can add one */ });
process.on('SIGTERM', () => { for (const id of Object.keys(RT)) stopChannel(id); app.quit(); });
process.on('SIGINT',  () => { for (const id of Object.keys(RT)) stopChannel(id); app.quit(); });
