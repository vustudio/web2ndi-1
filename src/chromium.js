'use strict';
// Chromium / Electron command-line configuration.
//
// These switches must be applied before app 'ready', so this runs at require
// time from main.js. The GL mode is the one thing that cannot change at runtime
// (disableHardwareAcceleration is a pre-ready, process-wide decision).
const GL = process.env.CG_GL || 'egl';

function apply(app) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  // Let page media start on its own — no "click to enable sound" gate.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  // Chromium crashes rendering heavy pages on Docker's default 64MB /dev/shm.
  app.commandLine.appendSwitch('disable-dev-shm-usage');

  if (GL === 'swiftshader') {
    // CPU-only host: fully disable the GPU process. Leaving it half-on breaks
    // WebGL offscreen rendering ("Buffer Handle is null" -> zero frames).
    app.disableHardwareAcceleration();
  } else {
    // GPU host: headless Ozone + ANGLE-over-EGL reaches the NVIDIA GPU. Note that
    // --ozone-platform=headless itself is set on the real command line by the
    // entrypoint; appendSwitch runs too late for that particular flag.
    app.commandLine.appendSwitch('ozone-platform', 'headless');
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'gl-egl');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
  }

  // Escape hatch: CG_CHROME_FLAGS="--foo=bar --baz" passes arbitrary switches.
  for (const f of (process.env.CG_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)) {
    const i = f.indexOf('=');
    if (i > 0) app.commandLine.appendSwitch(f.slice(0, i).replace(/^--/, ''), f.slice(i + 1));
    else app.commandLine.appendSwitch(f.replace(/^--/, ''));
  }
}

module.exports = { GL, apply };
