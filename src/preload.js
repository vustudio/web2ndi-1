// Bridge to the main process. With contextIsolation disabled we share the page's
// world, so a plain window assignment works; contextBridge is kept as a fallback.
const { ipcRenderer, contextBridge } = require('electron');

const api = {
  audio (buf, channels, sampleRate, samples) {
    try {
      ipcRenderer.send('webcg:audio', {
        channels, sampleRate, samples,
        pcm: Buffer.from(buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer),
      });
    } catch (e) { /* main gone */ }
  },
  diag (d) { try { ipcRenderer.send('webcg:audiodiag', d); } catch (e) {} },
};

try { contextBridge.exposeInMainWorld('__webcg', api); }
catch (e) { window.__webcg = api; }        // contextIsolation:false path
