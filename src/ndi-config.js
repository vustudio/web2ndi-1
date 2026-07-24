'use strict';
// Writes libndi's runtime config, ~/.ndi/ndi-config.v1.json.
//
// libndi reads this once, at NDIlib_initialize() — which the native addon calls
// lazily when the first sender is created. We therefore write it at app startup,
// before any channel starts, so both settings below take effect:
//
//   * discovery server — mDNS is unreliable in containers (especially on a host
//     already running NDI apps that hold the mDNS port), so we register with a
//     unicast discovery server (:5959) instead. Receivers must use the same one.
//   * machine name — overrides the "MACHINE" half of every source's identity.
//     Empty leaves it to the hostname.
//
// This used to live in entrypoint.sh; owning it here makes it a single source of
// truth and lets the control panel change the machine name (applied on restart).
const fs = require('fs');
const path = require('path');
const os = require('os');

function write({ discoveryServer, group, machineName }) {
  const ndi = {};
  if (machineName) ndi.machinename = machineName;
  if (discoveryServer) ndi.networks = { discovery: discoveryServer };
  // libndi expects the group list as a quoted, comma-separated string.
  ndi.groups = { send: '"' + (group || 'public') + '"' };

  const dir = path.join(os.homedir(), '.ndi');
  const file = path.join(dir, 'ndi-config.v1.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ndi }, null, 2));
    console.log(`[ndi] config: machine=${machineName || '(hostname)'} discovery=${discoveryServer || 'mDNS'} group=${group || 'public'}`);
  } catch (e) {
    console.error('[ndi] config write failed:', e.message);
  }
  return file;
}

module.exports = { write };
