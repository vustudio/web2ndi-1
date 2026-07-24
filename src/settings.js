'use strict';
// App-level settings (as opposed to per-channel config): things that apply to
// the whole process. Persisted to /data/settings.json so they survive restarts.
//
// Currently just the NDI machine name — the "MACHINE" half of an NDI source's
// "MACHINE (source)" identity. libndi normally derives it from the hostname; an
// override here lets it be set independently (useful when the container has its
// own network identity, e.g. on an ipvlan/macvlan address). Empty = use hostname.
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

const FILE = path.join(config.DATA_DIR, 'settings.json');

function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { /* first run */ }
  if (typeof s.machineName !== 'string') s.machineName = process.env.CG_MACHINE_NAME || '';
  return s;
}

function save(s) {
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error('[settings] save failed:', e.message);
  }
}

// NDI machine names are shown in every receiver's source list, so keep them to
// plain, safe characters and a sane length.
function sanitizeMachineName(v) {
  return String(v || '').replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 32);
}

// The machine name libndi will actually advertise: the override if set, else the
// container/host name (upper-cased, as NDI conventionally shows it).
function effectiveMachineName(s) {
  return s.machineName || os.hostname().toUpperCase();
}

module.exports = { load, save, sanitizeMachineName, effectiveMachineName, FILE };
