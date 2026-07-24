'use strict';
// System telemetry for the control panel: container CPU/memory (from cgroup),
// host NIC throughput (from /proc/net/dev), and GPU utilisation (from nvidia-smi).
//
// Call start() once; read the latest snapshot with getSystemStats() any time. All
// sampling is on a fixed interval so the HTTP handler never blocks on I/O.
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');

// NDI SpeedHQ costs roughly this many bits per pixel on the wire; used to
// estimate per-stream bandwidth (measured ~0.75, not the ~1.1 often quoted).
const NDI_BPP = 0.75;
function ndiMbps(w, h, fps) { return Math.round(w * h * fps * NDI_BPP / 1e6); }

const sysStats = { cpuPercent: 0, cores: os.cpus().length, memMB: 0, gpus: [] };
let netStats = { rxMbps: 0, txMbps: 0, ifaces: [] };

// ---- CPU / memory (cgroup v2, with v1 fallbacks) --------------------------
function readCpuUsec() {
  try {
    const m = fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').match(/usage_usec\s+(\d+)/);
    if (m) return +m[1];
  } catch (e) { /* not cgroup v2 */ }
  try {
    return Math.round(+fs.readFileSync('/sys/fs/cgroup/cpuacct/cpuacct.usage', 'utf8').trim() / 1000);
  } catch (e) { /* not cgroup v1 either */ }
  return null;
}
function readMemMB() {
  for (const p of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try { return Math.round(+fs.readFileSync(p, 'utf8').trim() / 1048576); } catch (e) { /* try next */ }
  }
  return 0;
}

// ---- host NICs ------------------------------------------------------------
function readNetDev() {
  const out = {};
  try {
    for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const m = line.trim().match(/^([^:]+):\s*(.+)$/);
      if (!m) continue;
      const name = m[1].trim();
      // Physical NICs only. bond/bridge/veth are stacked layers carrying the SAME
      // packets, so counting them would multiply the real throughput.
      if (/^(lo|docker|veth|br|bond|shim|virbr|tun|tap)/.test(name)) continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      out[name] = { rx: f[0], tx: f[8] };
    }
  } catch (e) { /* no /proc/net/dev */ }
  return out;
}

// ---- GPU (nvidia-smi, self-rescheduling so a slow call can't overlap) -----
function pollGpu() {
  exec('nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
    { timeout: 4000 }, (err, out) => {
      if (!err && out) {
        sysStats.gpus = out.trim().split('\n').map((l) => {
          const [i, u, mu, mt] = l.split(',').map(x => x.trim());
          return { index: +i, util: +u, memUsed: +mu, memTotal: +mt };
        });
      }
      setTimeout(pollGpu, 3000);
    });
}

function start() {
  let lastCpu = { usec: readCpuUsec(), t: Date.now() };
  setInterval(() => {
    const usec = readCpuUsec();
    const t = Date.now();
    if (usec != null && lastCpu.usec != null) {
      const dtUsec = (t - lastCpu.t) * 1000;
      if (dtUsec > 0) sysStats.cpuPercent = Math.round((usec - lastCpu.usec) / dtUsec * 100);
    }
    lastCpu = { usec, t };
    sysStats.memMB = readMemMB();
  }, 2000);

  let lastNet = { v: readNetDev(), t: Date.now() };
  setInterval(() => {
    const v = readNetDev();
    const t = Date.now();
    const dt = (t - lastNet.t) / 1000;
    if (dt > 0) {
      const ifaces = [];
      let rxTotal = 0;
      let txTotal = 0;
      for (const k of Object.keys(v)) {
        const prev = lastNet.v[k];
        if (!prev) continue;
        const rx = (v[k].rx - prev.rx) * 8 / 1e6 / dt;
        const tx = (v[k].tx - prev.tx) * 8 / 1e6 / dt;
        if (rx > 0.05 || tx > 0.05) ifaces.push({ name: k, rxMbps: +rx.toFixed(1), txMbps: +tx.toFixed(1) });
        rxTotal += rx;
        txTotal += tx;
      }
      ifaces.sort((a, b) => b.txMbps - a.txMbps);
      netStats = { rxMbps: +rxTotal.toFixed(1), txMbps: +txTotal.toFixed(1), ifaces: ifaces.slice(0, 4) };
    }
    lastNet = { v, t };
  }, 2000);

  pollGpu();
}

// Snapshot for the /status response, including per-channel NDI totals.
function getSystemStats(channels) {
  const ndiTotalMbps = channels.reduce((a, c) => a + (c.ndiOutMbps || 0), 0);
  return { ...sysStats, net: netStats, ndiTotalMbps };
}

module.exports = { start, getSystemStats, ndiMbps };
