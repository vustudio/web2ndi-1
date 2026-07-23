'use strict';
// webcg-ndi: render a web page in headless Chromium (Electron, offscreen), stream
// each BGRA frame to sender.py (which publishes NDI), and expose an HTTP control
// panel to change the URL / resolution / fps / NDI name at runtime.
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CFG = {
  url:    process.env.CG_URL    || 'https://rnd2.vu.studio/player?wallid=sienna',
  width:  parseInt(process.env.CG_WIDTH  || '1920', 10),
  height: parseInt(process.env.CG_HEIGHT || '1080', 10),
  fps:    parseInt(process.env.CG_FPS    || '30', 10),
  name:   process.env.NDI_NAME  || 'WebCG',
  alpha: (process.env.CG_ALPHA || '1') === '1',
  gl:     process.env.CG_GL     || 'egl',              // fixed for process lifetime
  ctrlPort: parseInt(process.env.CTRL_PORT || '8099', 10),
};

// Persist cookies / localStorage / session across container restarts.
// Mount a volume at /data (or set CG_DATA_DIR) so the profile survives recreation.
try { app.setPath('userData', process.env.CG_DATA_DIR || '/data'); } catch (e) {}

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-dev-shm-usage');
if (CFG.gl === 'swiftshader') {
  app.disableHardwareAcceleration();
} else {
  // GPU (NVIDIA EGL). Headless ozone avoids the software GLX path taken under Xvfb.
  app.commandLine.appendSwitch('ozone-platform', 'headless');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'gl-egl');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}
// Experimental override, e.g. CG_CHROME_FLAGS="use-angle=vulkan enable-features=Vulkan"
for (const f of (process.env.CG_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)) {
  const i = f.indexOf('=');
  if (i > 0) app.commandLine.appendSwitch(f.slice(0, i).replace(/^--/, ''), f.slice(i + 1));
  else app.commandLine.appendSwitch(f.replace(/^--/, ''));
}

let sender = null, win = null, backed = false, headerSent = false, restarting = false;
let latestJpeg = null, paints = 0, fpsActual = 0;

// ---- NDI sender subprocess ------------------------------------------------
function startSender() {
  headerSent = false;
  backed = false;   // reset backpressure — a stale `true` from the old pipe would stall all frames
  sender = spawn('python3', [path.join(__dirname, 'sender.py')], {
    env: { ...process.env, CG_FPS: String(CFG.fps), NDI_NAME: CFG.name, CG_ALPHA: CFG.alpha ? '1' : '0' },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  sender.stdin.on('drain', () => { backed = false; });
  sender.stdin.on('error', () => {});
  sender.on('exit', (c) => { if (!restarting) { console.error(`[webcg] sender exited (${c})`); app.quit(); } });
  console.log(`[webcg] sender -> "${CFG.name}" ${CFG.width}x${CFG.height}@${CFG.fps} alpha=${CFG.alpha} gl=${CFG.gl}`);
}
function stopSender() { if (sender) { try { sender.kill('SIGKILL'); } catch (e) {} sender = null; } }

// ---- Offscreen render window ---------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: CFG.width, height: CFG.height, useContentSize: true,
    show: false, frame: false,
    transparent: CFG.alpha,
    backgroundColor: CFG.alpha ? '#00000000' : '#000000',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(CFG.fps);

  const tickMs = Math.max(1, Math.round(1000 / CFG.fps));
  const tick = setInterval(() => { if (win && !win.isDestroyed()) win.webContents.invalidate(); }, tickMs);
  win.on('closed', () => clearInterval(tick));

  let lastJpegAt = 0;
  win.webContents.on('paint', (_e, _dirty, image) => {
    paints++;
    // throttled preview JPEG for the control panel (~2/sec)
    const now = Date.now();
    if (now - lastJpegAt > 500) { lastJpegAt = now; try { latestJpeg = image.toJPEG(60); } catch (e) {} }

    if (backed || !sender || !sender.stdin.writable) return;
    const bmp = image.getBitmap();
    if (!bmp || bmp.length === 0) return;
    if (!headerSent) {
      const { width, height } = image.getSize();
      const hdr = Buffer.alloc(8);
      hdr.writeUInt32LE(width, 0); hdr.writeUInt32LE(height, 4);
      sender.stdin.write(hdr);
      headerSent = true;
      console.log(`[webcg] first frame ${width}x${height} (${bmp.length} bytes)`);
    }
    if (!sender.stdin.write(bmp)) backed = true;
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[webcg] render gone:', d.reason, '- reloading'); if (win) win.reload();
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[webcg] load failed ${code} ${desc}`); setTimeout(() => { if (win) win.loadURL(CFG.url); }, 2000);
  });
  console.log(`[webcg] loading ${CFG.url}`);
  win.loadURL(CFG.url);
}
function destroyWindow() { if (win) { try { win.destroy(); } catch (e) {} win = null; } }

// Full restart: needed for resolution / fps / name / alpha changes (the NDI frame
// is sized from the render's first frame, so both sides must restart together).
function fullRestart() {
  restarting = true;
  stopSender(); destroyWindow();
  setTimeout(() => { startSender(); createWindow(); restarting = false; }, 500);
}

// ---- HTTP control panel ---------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => d += c); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}
function startControlServer() {
  const htmlPath = path.join(__dirname, 'control.html');
  http.createServer(async (req, res) => {
    const u = req.url.split('?')[0];
    try {
      if (req.method === 'GET' && u === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(htmlPath)); return;
      }
      if (req.method === 'GET' && u === '/preview.jpg') {
        if (latestJpeg) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); res.end(latestJpeg); }
        else { res.writeHead(503); res.end(); }
        return;
      }
      if (req.method === 'GET' && u === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          url: CFG.url, width: CFG.width, height: CFG.height, fps: CFG.fps,
          ndiName: CFG.name, alpha: CFG.alpha, gl: CFG.gl,
          machineName: os.hostname().toUpperCase(),
          fpsActual, connected: !!(sender && win),
        }));
        return;
      }
      if (req.method === 'POST' && u === '/url') {
        const b = await readBody(req); if (b.url) { CFG.url = b.url; if (win) win.loadURL(b.url); }
        res.writeHead(200); res.end('ok'); return;
      }
      if (req.method === 'POST' && u === '/reload') {
        if (win) win.reload(); res.writeHead(200); res.end('ok'); return;
      }
      if (req.method === 'POST' && u === '/config') {
        const b = await readBody(req);
        if (Number.isFinite(b.width))  CFG.width  = Math.max(16, Math.min(7680, b.width|0));
        if (Number.isFinite(b.height)) CFG.height = Math.max(16, Math.min(4320, b.height|0));
        if (Number.isFinite(b.fps))    CFG.fps    = Math.max(1, Math.min(60, b.fps|0));
        if (typeof b.ndiName === 'string' && b.ndiName.trim()) CFG.name = b.ndiName.trim();
        if (typeof b.alpha === 'boolean') CFG.alpha = b.alpha;
        res.writeHead(200); res.end('ok');
        fullRestart();
        return;
      }
      res.writeHead(404); res.end('not found');
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  }).listen(CFG.ctrlPort, () => console.log(`[webcg] control panel on :${CFG.ctrlPort}`));
}

// actual-fps counter
setInterval(() => { fpsActual = paints; paints = 0; }, 1000);

app.whenReady().then(async () => {
  try {
    const gi = await app.getGPUInfo('complete');
    const a = gi.auxAttributes || {};
    console.log(`[gpu] renderer="${a.glRenderer || '?'}" vendor="${a.glVendor || '?'}" glVersion="${a.glVersion || '?'}"`);
  } catch (e) { console.log('[gpu] info unavailable:', e.message); }
  startSender(); setTimeout(createWindow, 300); startControlServer();
});
app.on('window-all-closed', () => { if (!restarting) app.quit(); });
process.on('SIGTERM', () => app.quit());
process.on('SIGINT',  () => app.quit());
