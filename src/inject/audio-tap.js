'use strict';
// Runs INSIDE each rendered page's MAIN world to tap page audio and push raw
// planar Float32 to the preload bridge (window.__webcg.audio), which forwards it
// to the channel's NDI sender.
//
// Why the main world: executeJavaScript runs in an ISOLATED world where DOM nodes
// are cross-realm wrappers (Object.prototype.toString reports "[object
// EventTarget]") and WebAudio's native brand-check rejects them. main.js injects
// this as a real <script> element so it runs where the media elements are genuine.
//
// STATUS: transport works end-to-end; page capture is still blocked (see the
// Backlog in README). Gated behind CG_AUDIO=1 — a silent NDI audio track is worse
// than none. Authored as a real function, serialized with .toString().
function installAudioTap() {
  if (window.__webcgAudioInstalled || !window.__webcg) return 'skip';
  window.__webcgAudioInstalled = true;

  const RATE = 48000;
  const FRAMES = 2048;
  const CH = 2;
  let ctx = null;
  let proc = null;
  const tappedEls = new WeakSet();
  const tappedStreams = new Set();
  const diag = { mode: null, tracks: 0, ctxState: 'none', elements: 0, error: null };

  function ensureContext() {
    if (ctx) return;
    ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'playback' });
    proc = ctx.createScriptProcessor(FRAMES, CH, CH);
    proc.onaudioprocess = (e) => {
      const inp = e.inputBuffer;
      const n = inp.length;
      const avail = inp.numberOfChannels;
      const out = new Float32Array(CH * n);
      for (let c = 0; c < CH; c++) out.set(inp.getChannelData(Math.min(c, avail - 1)), c * n);
      window.__webcg.audio(out.buffer, CH, Math.round(inp.sampleRate) || RATE, n);
    };
    const gain = ctx.createGain();
    gain.gain.value = 0; // tap without local playback
    proc.connect(gain);
    gain.connect(ctx.destination);
  }

  function attach(el) {
    try {
      ensureContext();
      const stream = el.srcObject;
      if (stream && typeof stream.getAudioTracks === 'function') {
        const tracks = stream.getAudioTracks();
        diag.tracks = tracks.length;
        if (!tracks.length) { diag.mode = 'stream-no-audio'; return; }
        if (tappedStreams.has(stream.id)) return;
        ctx.createMediaStreamSource(stream).connect(proc);
        tappedStreams.add(stream.id);
        diag.mode = 'mediastream';
      } else {
        if (tappedEls.has(el)) return;
        diag.acNative = (typeof AudioContext === 'function') && /\[native code\]/.test(AudioContext.toString());
        diag.acName = (typeof AudioContext === 'function') && AudioContext.name;
        diag.elProto = Object.prototype.toString.call(el);
        const src = ctx.createMediaElementSource(el);
        src.connect(proc);
        src.connect(ctx.destination);
        tappedEls.add(el);
        diag.mode = 'element';
      }
      try { if (el.muted) { el.muted = false; el.volume = 1.0; } } catch (e) { /* readonly */ }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (e) {
      diag.error = String((e && e.message) || e);
    }
  }

  function scan() {
    try {
      const els = document.querySelectorAll('video,audio');
      diag.elements = els.length;
      diag.els = Array.prototype.map.call(els, (e) => ({
        tag: e.tagName,
        ctor: e.constructor && e.constructor.name,
        isMedia: (typeof HTMLMediaElement !== 'undefined') && (e instanceof HTMLMediaElement),
        sameDoc: e.ownerDocument === document,
        hasSrcObject: !!e.srcObject,
        srcKind: e.srcObject ? (e.srcObject.constructor && e.srcObject.constructor.name) : (e.currentSrc ? 'src' : 'none'),
        muted: e.muted, paused: e.paused,
      }));
      els.forEach(attach);
    } catch (e) {
      diag.error = 'scan:' + String((e && e.message) || e);
    }
    if (ctx) { diag.ctxState = ctx.state; if (ctx.state === 'suspended') ctx.resume().catch(() => {}); }
    try { window.__webcg.diag(diag); } catch (e) { /* bridge gone */ }
  }

  scan();
  setInterval(scan, 2000);
  document.addEventListener('play', (e) => attach(e.target), true);
  return 'installed';
}

// Injected as the body of a <script> element (runs in the page's main world).
module.exports = `(${installAudioTap.toString()})()`;
