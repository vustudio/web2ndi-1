'use strict';
// webcg-ndi (multi-channel): one Electron process hosts N offscreen "channels".
// Each channel = its own browser (own persistent session partition), rendered to
// its own NDI output via a dedicated sender.py. Channels are configured/persisted
// in /data/channels.json and managed from one HTTP control panel.
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
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

// ---- per-channel sender + offscreen window --------------------------------
function startChannel(ch) {
  const rt = RT[ch.id] = { win: null, sender: null, backed: false, headerSent: false,
    latestJpeg: null, paints: 0, fpsActual: 0, lastJpegAt: 0, tick: null, fpsTick: null, stopping: false };

  const sender = spawn('python3', [path.join(__dirname, 'sender.py')], {
    env: { ...process.env, CG_FPS: String(ch.fps), NDI_NAME: ch.name, CG_ALPHA: ch.alpha ? '1' : '0' },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  rt.sender = sender;
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
  rt.fpsTick = setInterval(() => { rt.fpsActual = rt.paints; rt.paints = 0; }, 1000);

  win.webContents.on('paint', (_e, _d, image) => {
    rt.paints++;
    const now = Date.now();
    if (now - rt.lastJpegAt > 500) { rt.lastJpegAt = now; try { rt.latestJpeg = image.toJPEG(60); } catch (e) {} }
    if (rt.backed || !rt.sender || !rt.sender.stdin.writable) return;
    const bmp = image.getBitmap();
    if (!bmp || bmp.length === 0) return;
    if (!rt.headerSent) {
      const s = image.getSize();
      const h = Buffer.alloc(8); h.writeUInt32LE(s.width, 0); h.writeUInt32LE(s.height, 4);
      rt.sender.stdin.write(h); rt.headerSent = true;
      console.log(`[${ch.id}] first frame ${s.width}x${s.height}`);
    }
    if (!rt.sender.stdin.write(bmp)) rt.backed = true;
  });
  win.webContents.on('render-process-gone', (_e, d) => { console.error(`[${ch.id}] render gone: ${d.reason}`); if (win && !win.isDestroyed()) win.reload(); });
  win.webContents.on('did-fail-load', (_e, code, desc) => { console.error(`[${ch.id}] load failed ${code} ${desc}`); setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(ch.url); }, 2000); });
  win.loadURL(ch.url);
}
function stopChannel(id) {
  const rt = RT[id]; if (!rt) return; rt.stopping = true;
  if (rt.tick) clearInterval(rt.tick);
  if (rt.fpsTick) clearInterval(rt.fpsTick);
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          gl: GL, machineName: os.hostname().toUpperCase(),
          channels: channels.map(c => { const rt = RT[c.id] || {}; return { ...c, fpsActual: rt.fpsActual || 0, connected: !!(rt.sender && rt.win) }; }),
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
