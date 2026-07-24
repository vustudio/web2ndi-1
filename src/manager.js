'use strict';
// Owns the set of channels: their persisted config, their running Channel
// instances, add/remove/patch operations, and the assembled /status payload.
// The control server and IPC handlers talk to the manager, never to channels
// directly, so there is one place that keeps config and runtime in step.
const config = require('./config');
const metrics = require('./metrics');
const { Channel } = require('./channel');

const RESTART_DELAY_MS = 400;

class ChannelManager {
  constructor() {
    this.channels = [];        // persisted config records
    this.instances = new Map(); // id -> Channel
  }

  // Load persisted channels (or the env seed) and start them all.
  startAll() {
    this.channels = config.load();
    config.save(this.channels);
    for (const ch of this.channels) this._spawn(ch);
    console.log(`[webcg] ${this.channels.length} channel(s) running`);
  }

  stopAll() {
    for (const inst of this.instances.values()) inst.stop();
    this.instances.clear();
  }

  _spawn(cfg) {
    const inst = new Channel(cfg);
    this.instances.set(cfg.id, inst);
    inst.start();
    return inst;
  }

  has(id) { return this.channels.some(c => c.id === id); }

  add(patch) {
    const cfg = config.withDefaults(config.nextId(this.channels), config.sanitize(patch));
    this.channels.push(cfg);
    config.save(this.channels);
    this._spawn(cfg);
    return cfg;
  }

  remove(id) {
    const inst = this.instances.get(id);
    if (inst) { inst.stop(); this.instances.delete(id); }
    this.channels = this.channels.filter(c => c.id !== id);
    config.save(this.channels);
  }

  // A URL-only change swaps the page live; anything else needs a render+NDI
  // restart (resolution/fps/name/alpha all change the sender or the window).
  patch(id, patch) {
    const cfg = this.channels.find(c => c.id === id);
    if (!cfg) return null;
    const changes = config.sanitize(patch);
    const urlOnly = Object.keys(changes).length === 1 && 'url' in changes;
    Object.assign(cfg, changes);
    config.save(this.channels);

    if (urlOnly) {
      const inst = this.instances.get(id);
      if (inst) inst.loadURL(cfg.url);
    } else {
      const inst = this.instances.get(id);
      if (inst) { inst.stop(); this.instances.delete(id); }
      setTimeout(() => this._spawn(cfg), RESTART_DELAY_MS);
    }
    return cfg;
  }

  get(id) { return this.instances.get(id); }

  // Route page audio (by webContents id) to the owning channel's NDI sender.
  routeAudio(wcId, msg) {
    for (const inst of this.instances.values()) {
      if (inst.wcId === wcId) { inst.handleAudio(msg); return; }
    }
  }

  routeAudioDiag(wcId, diag) {
    for (const inst of this.instances.values()) {
      if (inst.wcId === wcId) { inst.audioDiag = diag; return; }
    }
  }

  // The full /status payload: per-channel runtime merged with config, plus system.
  status(appMetrics, glMode, machineName) {
    const byPid = {};
    try { for (const m of appMetrics) byPid[m.pid] = m; } catch (e) { /* metrics unavailable */ }

    const channels = this.channels.map((cfg) => {
      const inst = this.instances.get(cfg.id);
      const perStream = metrics.ndiMbps(cfg.width, cfg.height, cfg.fps);

      let cpu = null;
      let memMB = null;
      if (inst) {
        const m = byPid[inst.osProcessId()];
        if (m) { cpu = Math.round(m.cpu.percentCPUUsage); memMB = Math.round((m.memory.workingSetSize || 0) / 1024); }
      }

      const nd = inst ? inst.ndiStats() : null;
      const conn = nd ? nd.conn : null;
      return {
        ...cfg,
        fpsActual: inst ? inst.fpsActual : 0,
        fpsSent: inst ? inst.fpsSent : 0,
        targetFps: inst ? inst.targetFps : cfg.fps,
        connected: !!(inst && inst.ndiId && inst.win),
        tally: nd ? nd.tally : null,
        audioSent: nd ? nd.audioSent : 0,
        audioDiag: inst ? inst.audioDiag : null,
        page: inst ? inst.page : null,
        cpu, memMB, conn,
        ndiPerStreamMbps: perStream,
        ndiOutMbps: (conn && conn > 0) ? perStream * conn : 0,
      };
    });

    return {
      gl: glMode,
      machineName,
      system: metrics.getSystemStats(channels),
      channels,
    };
  }
}

module.exports = { ChannelManager };
