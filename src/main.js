'use strict';
// webcg-ndi — render headless web pages and publish each as a native NDI source.
//
// One Electron process hosts N independent channels; each channel is its own
// offscreen browser (with its own persistent session) rendered to its own NDI
// output via the in-process native sender. Everything is driven and observed
// through one HTTP control panel.
//
// This file only wires the pieces together. The substance lives in:
//   chromium.js        pre-ready command-line switches (incl. the GL mode)
//   config.js          channel config: env defaults + /data/channels.json
//   channel.js         Channel — one browser window's whole lifecycle
//   manager.js         ChannelManager — the collection, persistence, /status
//   metrics.js         CPU / memory / NIC / GPU sampling
//   control-server.js  the HTTP control panel + REST API
//   ndi.js             wrapper around the native NDI sender addon
const os = require('os');
const { app, ipcMain } = require('electron');

const chromium = require('./chromium');
const config = require('./config');
const metrics = require('./metrics');
const controlServer = require('./control-server');
const { ChannelManager } = require('./manager');

const CTRL_PORT = parseInt(process.env.CTRL_PORT || '8099', 10);

// Command-line switches must be set before 'ready'.
chromium.apply(app);
// Persist each channel's session partition under the data dir.
try { app.setPath('userData', config.DATA_DIR); } catch (e) { /* best effort */ }

const manager = new ChannelManager();

// Page audio (from preload.js) -> the owning channel's NDI sender.
ipcMain.on('webcg:audio', (event, msg) => {
  try { manager.routeAudio(event.sender.id, msg); } catch (e) { /* malformed frame */ }
});
ipcMain.on('webcg:audiodiag', (event, diag) => manager.routeAudioDiag(event.sender.id, diag));

app.whenReady().then(() => {
  metrics.start();
  manager.startAll();
  controlServer.start({
    app,
    manager,
    glMode: chromium.GL,
    machineName: os.hostname().toUpperCase(),
    port: CTRL_PORT,
  });
});

// Keep running with no channels so the panel can still add one.
app.on('window-all-closed', () => { /* no-op */ });

function shutdown() { manager.stopAll(); app.quit(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
