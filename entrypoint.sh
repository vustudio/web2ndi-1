#!/usr/bin/env bash
set -euo pipefail

# NDI config (discovery server + machine name) is written by the app at startup
# from NDI_DISCOVERY_SERVER / NDI_GROUP / the persisted machine-name setting — see
# src/ndi-config.js. Keeping it in one place lets the control panel change it.

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
