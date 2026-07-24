'use strict';
// Thin wrapper around the native in-process NDI sender (native/ndi_sender.cc,
// built to build/Release/ndi_sender.node against Electron's ABI).
//
// The addon replaces the old Electron -> pipe -> Python -> libndi path, which
// copied each frame ~4 times and capped throughput far below target. Everything
// here is a direct pass-through; it exists so the rest of the app imports a named
// module instead of reaching into build/Release by path.
const path = require('path');

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'ndi_sender.node'));

module.exports = {
  // createSender({ name, groups?, width, height, fps, fourcc }) -> numeric id
  createSender: opts => addon.createSender(opts),
  // sendFrame(id, bgraBuffer) -> bool (false if dropped/undersized)
  sendFrame: (id, buf) => addon.sendFrame(id, buf),
  // sendAudio(id, planarFloat32Buffer, channels, sampleRate, samplesPerChannel)
  sendAudio: (id, buf, ch, rate, samples) => addon.sendAudio(id, buf, ch, rate, samples),
  // getStats(id) -> { sent, audioSent, dropped, connections, onProgram, onPreview }
  getStats: id => addon.getStats(id),
  destroySender: id => addon.destroySender(id),
};
