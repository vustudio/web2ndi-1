// Probe: is shared-texture OSR actually honoured on this platform?
//
// Electron will silently fall back to CPU readback when it cannot export a GPU
// texture, so setting `offscreen.useSharedTexture` proves nothing on its own.
// The only reliable tell is what the `paint` event delivers: a `texture` object
// (shared texture active) or a `NativeImage` (CPU readback, i.e. fallback).
//
// Run standalone; it renders a moving page, reports what it got, and exits.
//   electron src/probe-sharedtexture.js --no-sandbox --ozone-platform=headless
const { app, BrowserWindow } = require('electron');

const WIDTH  = +(process.env.PROBE_W || 1920);
const HEIGHT = +(process.env.PROBE_H || 1080);
const FPS    = +(process.env.PROBE_FPS || 60);
const SECS   = +(process.env.PROBE_SECS || 6);

app.commandLine.appendSwitch('use-gl', process.env.CG_GL || 'egl');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-dev-shm-usage');

// Animated so Chromium has a real reason to paint every frame.
const PAGE = 'data:text/html,' + encodeURIComponent(`
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}
b{position:absolute;width:20vw;height:20vw;border-radius:50%;background:#0af;
  animation:m 1.4s linear infinite alternate}
@keyframes m{from{transform:translate(0,0)}to{transform:translate(340%,320%)}}</style>
<b></b><b style="animation-delay:-.5s;background:#fa0"></b>`);

function summarise (o) {
  if (!o || typeof o !== 'object') return String(o);
  const own = Object.keys(o);
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(o) || {})
    .filter(k => k !== 'constructor');
  return `${o.constructor && o.constructor.name} own=[${own}] proto=[${proto.slice(0, 12)}]`;
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, useContentSize: true, show: false, frame: false,
    webPreferences: {
      // The flag under test. Object form is required — `offscreen: true` is the
      // legacy CPU path and ignores the option entirely.
      offscreen: { useSharedTexture: true },
      backgroundThrottling: false,
    },
  });

  let paints = 0, textureFrames = 0, bitmapFrames = 0;
  let firstTexture = null, firstImage = null, sawErr = null;

  win.webContents.setFrameRate(FPS);

  win.webContents.on('paint', function (e, dirty, image) {
    paints++;
    // The texture's location in the callback has moved between Electron versions,
    // so on the first paint dump every argument rather than guessing at one shape.
    if (paints === 1) {
      console.log(`ARGC         : ${arguments.length}`);
      for (let i = 0; i < arguments.length; i++) {
        const a = arguments[i];
        console.log(`ARG[${i}]       : type=${typeof a} ${summarise(a)}`);
        if (a && typeof a === 'object') {
          for (const k of Object.keys(a)) {
            const v = a[k];
            console.log(`   .${k} = ${typeof v === 'object' && v ? summarise(v) : JSON.stringify(v)}`);
          }
        }
      }
    }
    // Electron >=32 passes the shared texture as `event.texture`; older shapes
    // put it in the third arg. Check both so a version skew can't fool us.
    const tex = (e && e.texture) || (image && image.textureInfo ? image : null);
    if (tex) {
      textureFrames++;
      if (!firstTexture) {
        firstTexture = tex;
        try {
          console.log('TEXTURE_OBJ  :', summarise(tex));
          if (tex.textureInfo) console.log('TEXTURE_INFO :', JSON.stringify(tex.textureInfo, null, 2).slice(0, 1200));
        } catch (err) { sawErr = err.message; }
      }
      try { tex.release && tex.release(); } catch (err) {}
    } else if (image) {
      bitmapFrames++;
      if (!firstImage) {
        firstImage = true;
        try {
          const s = image.getSize();
          console.log(`BITMAP       : NativeImage ${s.width}x${s.height} bytes=${image.getBitmap().length}`);
        } catch (err) { sawErr = err.message; }
      }
    }
  });

  win.loadURL(PAGE);
  const t0 = Date.now();
  const tick = setInterval(() => { if (!win.isDestroyed()) win.webContents.invalidate(); }, 1000 / FPS);

  setTimeout(() => {
    clearInterval(tick);
    const secs = (Date.now() - t0) / 1000;
    const active = textureFrames > 0;
    console.log('\n================ SHARED TEXTURE PROBE ================');
    console.log(`electron       : ${process.versions.electron}  chrome ${process.versions.chrome}`);
    console.log(`gl backend     : ${process.env.CG_GL || 'egl'}   ozone=${process.argv.includes('--ozone-platform=headless') ? 'headless' : 'default'}`);
    console.log(`requested      : ${WIDTH}x${HEIGHT} @ ${FPS}fps for ${secs.toFixed(1)}s`);
    console.log(`paints         : ${paints}  (${(paints / secs).toFixed(1)} fps)`);
    console.log(`texture frames : ${textureFrames}`);
    console.log(`bitmap frames  : ${bitmapFrames}`);
    if (sawErr) console.log(`note           : ${sawErr}`);
    console.log(`VERDICT        : ${active ? 'SHARED TEXTURE ACTIVE' : 'FELL BACK TO CPU READBACK'}`);
    console.log('======================================================');
    app.exit(active ? 0 : 3);
  }, SECS * 1000);
});
