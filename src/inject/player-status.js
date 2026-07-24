'use strict';
// Runs INSIDE each rendered page (via webContents.executeJavaScript) to read the
// Vū player's identity and state. Authored as a real async function and
// serialized with .toString(), so it lints and highlights as ordinary code —
// unlike an opaque template-string blob, and with no double-escaped regex.
//
// State model (the on-screen text is authoritative, IndexedDB is corroborating):
//   - The durable identity lives in IndexedDB (playerId / playerName) once paired.
//   - A genuinely licensed player has a NAME in IndexedDB. A bare playerId can be
//     stale/pending (e.g. mid-connect), so an id alone is NOT "licensed".
//   - "Unlicensed Player <id>" on screen overrides any leftover IndexedDB id.
async function collectPlayerStatus() {
  try {
    const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();

    const connected = /No User Connected/i.test(text) ? false
      : (/User Connected/i.test(text) ? true : null);

    const unlicensedScreen = /Unlicen[cs]ed Player/i.test(text);
    const onscreenIdMatch = text.match(/Unlicen[cs]ed Player[:\s]*([A-Za-z0-9]{4,12})/i);
    const onscreenId = onscreenIdMatch ? onscreenIdMatch[1] : null;

    let urlId = null;
    try { urlId = new URLSearchParams(location.search).get('id'); } catch (e) { /* no search */ }

    // Pull playerId / playerName out of whatever IndexedDB store holds them.
    const idb = {};
    try {
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      for (const info of dbs) {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open(info.name);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        for (const storeName of Array.from(db.objectStoreNames)) {
          try {
            await new Promise((res) => {
              const store = db.transaction(storeName, 'readonly').objectStore(storeName);
              const wanted = ['playerId', 'playerName'];
              let pending = wanted.length;
              wanted.forEach((key) => {
                const get = store.get(key);
                get.onsuccess = () => {
                  let v = get.result;
                  if (v && typeof v === 'object' && 'value' in v) v = v.value;
                  if (v !== undefined && idb[key] === undefined) idb[key] = v;
                  if (--pending === 0) res();
                };
                get.onerror = () => { if (--pending === 0) res(); };
              });
            });
          } catch (e) { /* store not keyed the way we expect */ }
        }
        db.close();
      }
    } catch (e) { /* IndexedDB unavailable */ }

    // A blocking error screen, e.g. the id claimed in another browser.
    let blocked = null;
    if (/Player Already Active/i.test(text)) {
      const at = text.search(/Player Already Active/i);
      const idMatch = text.match(/This player ID \(([A-Za-z0-9._-]{3,16})\)/i);
      blocked = { title: 'Player Already Active', id: idMatch ? idMatch[1] : null, msg: text.slice(at, at + 240).trim() };
    }

    let licensed = false;
    let playerId = null;
    let playerName = idb.playerName || null;
    if (blocked) { playerId = blocked.id || idb.playerId || null; playerName = null; }
    else if (unlicensedScreen) { playerId = onscreenId || null; playerName = null; }
    else if (playerName) { licensed = true; playerId = idb.playerId || urlId || null; }
    else { playerId = idb.playerId || urlId || null; } // connecting / pending

    const state = blocked ? 'blocked' : (unlicensedScreen ? 'unlicensed' : (licensed ? 'licensed' : 'connecting'));

    // A few visible button/link labels, so the panel can offer "click" actions.
    const actions = [];
    try {
      for (const el of document.querySelectorAll('button,a,[role=button]')) {
        const label = (el.innerText || '').trim();
        if (label && label.length < 40 && actions.length < 8) actions.push(label);
      }
    } catch (e) { /* no DOM */ }

    // Playback health from the <video> element plus the player's own diagnostics.
    let perf = null;
    try {
      const video = document.querySelector('video');
      let diag = null;
      const raw = localStorage.getItem('playerDiagnostics');
      if (raw) { try { const arr = JSON.parse(raw); diag = arr[arr.length - 1]; } catch (e) { /* not json */ } }
      if (video) {
        const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
        perf = {
          vw: video.videoWidth, vh: video.videoHeight,
          ct: +(video.currentTime || 0).toFixed(1),
          paused: video.paused, readyState: video.readyState,
          dropped: q.droppedVideoFrames || 0, total: q.totalVideoFrames || 0, diag,
        };
      } else {
        perf = { diag };
      }
    } catch (e) { /* no video / no localStorage */ }

    return { playerId, playerName, licensed, connected, state, origin: location.origin, blocked, actions, title: document.title, perf };
  } catch (e) {
    return { error: String(e) };
  }
}

// executeJavaScript evaluates an expression; wrap the function so it self-invokes
// and its Promise is what resolves back to the main process.
module.exports = `(${collectPlayerStatus.toString()})()`;
