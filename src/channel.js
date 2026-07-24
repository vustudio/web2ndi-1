'use strict';
// A Channel owns one offscreen browser window and its NDI output, end to end:
// the render clock, frame pacing, adaptive frame rate, player scraping, the audio
// tap, and lifecycle. All the per-channel state that used to live in a shared
// `rt` object is encapsulated here, one instance per channel.
const path = require('path');
const { BrowserWindow, session } = require('electron');
const ndi = require('./ndi');

const PLAYER_STATUS_JS = require('./inject/player-status');
const AUDIO_TAP_JS = require('./inject/audio-tap');

// Render/send at full rate only when the source is on air; back off otherwise.
// Throttling setFrameRate() saves GPU render, readback, copy AND NDI encode at
// once — this is how one process drives many channels (see README, Vingester).
const ADAPTIVE = (process.env.CG_ADAPTIVE || '1') !== '0';
// Audio tap is opt-in: transport works, but page capture still yields silence,
// and a silent NDI audio track is worse than none (see README Backlog).
const AUDIO_ENABLED = (process.env.CG_AUDIO || '0') === '1';
const NDI_GROUP = process.env.NDI_GROUP || '';

const JPEG_INTERVAL_MS = 500; // preview refresh cadence
const SCRAPE_INTERVAL_MS = 3000;
const ADAPT_INTERVAL_MS = 2000;

class Channel {
  constructor(cfg) {
    this.cfg = cfg;               // { id, url, width, height, fps, name, alpha }
    this.win = null;
    this.wcId = null;             // webContents id, for routing IPC audio
    this.ndiId = null;            // created lazily on the first painted frame
    this.lastImage = null;
    this.latestJpeg = null;
    this.lastJpegAt = 0;
    this.page = null;             // latest scraped player status
    this.audioDiag = null;
    this.audioChunks = 0;

    // Rolling per-second counters.
    this.paints = 0;
    this.fpsActual = 0;
    this.sent = 0;
    this.fpsSent = 0;
    this.targetFps = cfg.fps;

    this.timers = {};             // named intervals, cleared together on stop()
  }

  get id() { return this.cfg.id; }

  // ---- lifecycle ----------------------------------------------------------
  start() {
    const ch = this.cfg;
    console.log(`[${ch.id}] channel -> "${ch.name}" ${ch.width}x${ch.height}@${ch.fps} alpha=${ch.alpha}`);

    // Auto-grant media permissions so players start without a human gesture.
    try {
      const ses = session.fromPartition('persist:' + ch.id);
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
      ses.setPermissionCheckHandler(() => true);
    } catch (e) {
      console.error(`[${ch.id}] permission handler: ${e.message}`);
    }

    const win = new BrowserWindow({
      width: ch.width, height: ch.height, useContentSize: true, show: false, frame: false,
      transparent: ch.alpha, backgroundColor: ch.alpha ? '#00000000' : '#000000',
      webPreferences: {
        offscreen: true, backgroundThrottling: false, partition: 'persist:' + ch.id,
        preload: path.join(__dirname, 'preload.js'), // taps page audio -> NDI
      },
    });
    this.win = win;
    this.wcId = win.webContents.id;
    win.webContents.setAudioMuted(false);
    win.webContents.setFrameRate(ch.fps);

    this._startRenderClock(ch.fps);
    this.timers.fps = setInterval(() => {
      this.fpsActual = this.paints; this.paints = 0;
      this.fpsSent = this.sent; this.sent = 0;
    }, 1000);

    // Frame pacing: the paint handler only records the newest frame; a fixed
    // timer transmits it. Chromium delivers paints in bursts (several within a
    // millisecond, then a gap), so sending on paint arrival collapses the rate.
    win.webContents.on('paint', (_e, _dirty, image) => {
      this.paints++;
      this.lastImage = image;
      const now = Date.now();
      if (now - this.lastJpegAt > JPEG_INTERVAL_MS) {
        this.lastJpegAt = now;
        try { this.latestJpeg = image.toJPEG(60); } catch (e) { /* transient */ }
      }
    });
    this._startSendClock(ch.fps);

    this.timers.adapt = setInterval(() => this._reevaluateRate(), ADAPT_INTERVAL_MS);
    this.timers.scrape = setInterval(() => this._scrape(), SCRAPE_INTERVAL_MS);

    win.webContents.on('dom-ready', () => this._installAudioTap());
    win.webContents.on('render-process-gone', (_e, d) => {
      console.error(`[${ch.id}] render gone: ${d.reason}`);
      if (this.win && !this.win.isDestroyed()) this.win.reload();
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error(`[${ch.id}] load failed ${code} ${desc}`);
      setTimeout(() => { if (this.win && !this.win.isDestroyed()) this.win.loadURL(ch.url); }, 2000);
    });
    win.loadURL(ch.url);
  }

  stop() {
    for (const t of Object.values(this.timers)) clearInterval(t);
    this.timers = {};
    this.lastImage = null;
    if (this.ndiId) { try { ndi.destroySender(this.ndiId); } catch (e) { /* already gone */ } this.ndiId = null; }
    if (this.win) { try { this.win.destroy(); } catch (e) { /* already gone */ } this.win = null; }
  }

  // ---- render + send clocks ----------------------------------------------
  _startRenderClock(fps) {
    if (this.timers.render) clearInterval(this.timers.render);
    this.timers.render = setInterval(() => {
      // OSR paint is damage-driven, so a static page would paint once then go
      // silent; invalidate() forces a continuous frame clock.
      if (this.win && !this.win.isDestroyed()) this.win.webContents.invalidate();
    }, Math.max(1, Math.round(1000 / fps)));
  }

  _startSendClock(fps) {
    if (this.timers.send) clearInterval(this.timers.send);
    this.timers.send = setInterval(() => this._sendFrame(), Math.max(1, Math.round(1000 / fps)));
  }

  _sendFrame() {
    if (!this.lastImage) return;
    let bmp;
    try { bmp = this.lastImage.getBitmap(); } catch (e) { return; }
    if (!bmp || bmp.length === 0) return;

    if (!this.ndiId) {
      // Size the sender to what Chromium actually paints (OSR paints 1px smaller
      // than the window and pads line stride), not to what we requested.
      const s = this.lastImage.getSize();
      try {
        this.ndiId = ndi.createSender({
          name: this.cfg.name, groups: NDI_GROUP || undefined,
          width: s.width, height: s.height, fps: this.cfg.fps,
          fourcc: this.cfg.alpha ? 'BGRA' : 'BGRX',
        });
      } catch (e) {
        console.error(`[${this.cfg.id}] NDI create failed: ${e.message}`);
        return;
      }
      console.log(`[${this.cfg.id}] NDI "${this.cfg.name}" ${s.width}x${s.height}@${this.cfg.fps} ${this.cfg.alpha ? 'BGRA' : 'BGRX'}`);
    }
    if (ndi.sendFrame(this.ndiId, bmp)) this.sent++;
  }

  // Adaptive frame rate: full rate only when tallied on PGM/PVW, fps/3 when merely
  // connected, 1fps when nobody is watching.
  _adaptiveTarget() {
    if (!ADAPTIVE || !this.ndiId) return this.cfg.fps;
    let st;
    try { st = ndi.getStats(this.ndiId); } catch (e) { return this.cfg.fps; }
    if (!st || !st.connections) return 1;
    if (st.onProgram || st.onPreview) return this.cfg.fps;
    return Math.max(5, Math.trunc(this.cfg.fps / 3));
  }

  _reevaluateRate() {
    const target = this._adaptiveTarget();
    if (target === this.targetFps) return;
    this.targetFps = target;
    try {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.setFrameRate(Math.max(1, Math.min(240, target)));
      }
    } catch (e) { /* window gone */ }
    this._startRenderClock(target);
    this._startSendClock(target);
    console.log(`[${this.cfg.id}] adaptive rate -> ${target} fps (of ${this.cfg.fps})`);
  }

  // ---- page interaction ---------------------------------------------------
  _scrape() {
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isLoading()) return;
    this.win.webContents.executeJavaScript(PLAYER_STATUS_JS, true)
      .then(r => { this.page = r; })
      .catch(() => { /* page navigating */ });
  }

  _installAudioTap() {
    if (!AUDIO_ENABLED || !this.win || this.win.isDestroyed()) return;
    // Inject as a real <script> so the tap runs in the page's main world, where
    // media elements are genuine (the isolated world hands us EventTarget wrappers
    // that WebAudio rejects).
    const inject = `(() => { try {
      const s = document.createElement('script');
      s.textContent = ${JSON.stringify(AUDIO_TAP_JS)};
      (document.head || document.documentElement).appendChild(s);
      s.remove(); return 'injected';
    } catch (e) { return 'inject-failed: ' + e.message } })()`;
    this.win.webContents.executeJavaScript(inject, true)
      .then(r => console.log(`[${this.cfg.id}] audio tap ${r}`))
      .catch(() => {});
  }

  loadURL(url) {
    if (this.win && !this.win.isDestroyed()) this.win.loadURL(url);
  }

  reload() {
    if (this.win && !this.win.isDestroyed()) this.win.reload();
  }

  // Real OS-level input injection. Unlike a synthetic DOM .click(), this works on
  // canvas/WebGL UIs and satisfies "user gesture" requirements.
  injectInput({ type, key, x, y }) {
    if (!this.win || this.win.isDestroyed()) throw new Error('no window');
    const wc = this.win.webContents;
    if (type === 'key') {
      const k = String(key || 'Enter');
      wc.sendInputEvent({ type: 'keyDown', keyCode: k });
      wc.sendInputEvent({ type: 'char', keyCode: k });
      wc.sendInputEvent({ type: 'keyUp', keyCode: k });
    } else {
      const px = Number.isFinite(+x) ? +x : Math.round(this.cfg.width / 2);
      const py = Number.isFinite(+y) ? +y : Math.round(this.cfg.height / 2);
      wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
      wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    }
  }

  // Click a page element by (case-insensitive) label substring. Resolves to
  // whether a matching element was found and clicked.
  async clickLabel(label) {
    if (!this.win || this.win.isDestroyed() || !label) return false;
    const needle = JSON.stringify(String(label).toLowerCase());
    const js = `(() => { const els=[...document.querySelectorAll('button,a,[role=button]')];`
      + ` const el=els.find(e=>((e.innerText||'').trim().toLowerCase()).includes(${needle}));`
      + ` if(el){el.click(); return true;} return false; })()`;
    try { return await this.win.webContents.executeJavaScript(js, true); } catch (e) { return false; }
  }

  // ---- audio in from the preload bridge -----------------------------------
  handleAudio(msg) {
    if (!this.ndiId || !msg || !msg.pcm) return;
    const buf = Buffer.isBuffer(msg.pcm) ? msg.pcm : Buffer.from(msg.pcm);
    ndi.sendAudio(this.ndiId, buf, msg.channels | 0, msg.sampleRate | 0, msg.samples | 0);
    this.audioChunks++;
  }

  osProcessId() {
    try {
      return this.win && !this.win.isDestroyed() ? this.win.webContents.getOSProcessId() : 0;
    } catch (e) { return 0; }
  }

  // NDI tally / connection counts, or null if the sender isn't up yet.
  ndiStats() {
    if (!this.ndiId) return null;
    try {
      const st = ndi.getStats(this.ndiId);
      return { conn: st.connections, audioSent: st.audioSent || 0, tally: { program: !!st.onProgram, preview: !!st.onPreview } };
    } catch (e) { return null; }
  }
}

module.exports = { Channel };
