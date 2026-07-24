'use strict';
// Channel configuration: environment defaults, validation, and persistence.
//
// A "channel" is one rendered web page and its NDI output. The set of channels
// lives in /data/channels.json so it survives restarts; on first run (no file)
// a single channel is seeded from the CG_* environment variables.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CG_DATA_DIR || '/data';
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');

// Bounds for user-supplied channel fields. Kept here so validation is one source
// of truth shared by the seed, the REST API, and the defaults below.
const LIMITS = {
  width: { min: 16, max: 7680 },
  height: { min: 16, max: 4320 },
  fps: { min: 1, max: 60 },
};
const DEFAULTS = { url: 'https://example.com', width: 1920, height: 1080, fps: 30, alpha: true };

function clamp(n, { min, max }) { return Math.max(min, Math.min(max, n | 0)); }

// The single channel created when no channels.json exists yet.
function seedFromEnv() {
  return [{
    id: 'ch1',
    url: process.env.CG_URL || 'https://rnd2.vu.studio/player?wallid=sienna',
    width: parseInt(process.env.CG_WIDTH || '1920', 10),
    height: parseInt(process.env.CG_HEIGHT || '1080', 10),
    fps: parseInt(process.env.CG_FPS || '30', 10),
    name: process.env.NDI_NAME || 'WebCG',
    alpha: (process.env.CG_ALPHA || '1') === '1',
  }];
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    if (Array.isArray(j) && j.length) return j;
  } catch (e) { /* missing or corrupt -> seed */ }
  return seedFromEnv();
}

function save(channels) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2));
  } catch (e) {
    console.error('[cfg] save failed:', e.message);
  }
}

// First free "chN" id given the channels already in use.
function nextId(channels) {
  let n = 1;
  while (channels.find(c => c.id === 'ch' + n)) n++;
  return 'ch' + n;
}

// Keep only the recognised fields, coerced and clamped to safe ranges. Returns a
// partial object containing just the fields the caller actually supplied, so it
// doubles as a patch for existing channels and a template for new ones.
function sanitize(patch) {
  const o = {};
  if (typeof patch.url === 'string' && patch.url.trim()) o.url = patch.url.trim();
  if (Number.isFinite(+patch.width)) o.width = clamp(+patch.width, LIMITS.width);
  if (Number.isFinite(+patch.height)) o.height = clamp(+patch.height, LIMITS.height);
  if (Number.isFinite(+patch.fps)) o.fps = clamp(+patch.fps, LIMITS.fps);
  if (typeof patch.name === 'string' && patch.name.trim()) o.name = patch.name.trim();
  if (typeof patch.alpha === 'boolean') o.alpha = patch.alpha;
  return o;
}

// Fill a sanitized patch out to a complete channel record (used when adding).
function withDefaults(id, sanitized) {
  return {
    id,
    url: sanitized.url || DEFAULTS.url,
    width: sanitized.width || DEFAULTS.width,
    height: sanitized.height || DEFAULTS.height,
    fps: sanitized.fps || DEFAULTS.fps,
    name: sanitized.name || ('WebCG-' + id),
    alpha: sanitized.alpha !== undefined ? sanitized.alpha : DEFAULTS.alpha,
  };
}

module.exports = { DATA_DIR, load, save, nextId, sanitize, withDefaults };
