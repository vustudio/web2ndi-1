#!/usr/bin/env bash
set -euo pipefail

# NDI discovery: mDNS is unreliable inside containers, especially on a host that
# already runs other NDI apps (they hold the mDNS port). If NDI_DISCOVERY_SERVER
# is set, write an NDI config so libndi registers with that discovery server
# (unicast, port 5959) instead of relying on mDNS. Receivers must use the same
# server. Leave it unset to use plain mDNS (fine when this is the only NDI app).
if [ -n "${NDI_DISCOVERY_SERVER:-}" ]; then
  mkdir -p /root/.ndi
  cat > /root/.ndi/ndi-config.v1.json <<EOF
{
  "ndi": {
    "networks": { "discovery": "${NDI_DISCOVERY_SERVER}" },
    "groups": { "send": "\"${NDI_GROUP:-public}\"" }
  }
}
EOF
  echo "[entrypoint] NDI discovery server: ${NDI_DISCOVERY_SERVER}  group: ${NDI_GROUP:-public}"
else
  echo "[entrypoint] NDI discovery: mDNS (set NDI_DISCOVERY_SERVER to use a discovery server)"
fi

# CG_XVFB=0 runs Electron with no X server (for headless GPU/EGL mode, where a
# software X server would otherwise pull GL onto the software GLX path). Default
# keeps Xvfb, which software (SwiftShader) mode needs.
# CG_EXTRA_ARGS lets us pass Chromium flags on the real command line (needed for
# early-init switches like --ozone-platform that app.commandLine can't set).
EXTRA="${CG_EXTRA_ARGS:-}"
if [ "${CG_XVFB:-1}" = "0" ]; then
  echo "[entrypoint] no Xvfb (headless GPU mode) extra: $EXTRA"
  exec node_modules/.bin/electron . --no-sandbox --ozone-platform=headless $EXTRA
else
  exec xvfb-run -a --server-args="-screen 0 ${CG_WIDTH:-1920}x${CG_HEIGHT:-1080}x24 -ac -nolisten tcp" \
       node_modules/.bin/electron . --no-sandbox $EXTRA
fi
