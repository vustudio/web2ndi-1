# webcg-ndi

A standalone Docker service that renders a **web page in headless Chromium** and
publishes it as a **native NDI source** — the same concept as the Sienna NDIPE
**CG Engine** node (`tv.sienna.cgeng`), but decoupled from NDIPE and built to run
GPU-accelerated on your own hardware.

```
Electron (Chromium, offscreen, GPU)  --BGRA frames-->  sender.py (cyndilib)  -->  NDI source on the LAN
```

## How it maps to the Sienna CG Engine node

| Sienna control | Here | Notes |
|---|---|---|
| `CONTENTURL` | `CG_URL` | page to render |
| `linecount` | `CG_HEIGHT` | 720 / 1080 / 2160 … |
| `framerate` | `CG_FPS` | up to 60 |
| fill+key (RGBA out) | `CG_ALPHA=1` | transparent page background is preserved (BGRA) |
| `HWACC/2DACC/WEBGL` | `CG_GL=egl` + `--gpus all` | real GPU here, not the Matrox software fallback |
| NDI `_OUT` | `NDI_NAME` | the NDI source name on the network |

## Requirements (GPU host)

- NVIDIA GPU + driver
- Docker + **NVIDIA Container Toolkit** (`nvidia-ctk`) so `--gpus all` works
- Run with an init (`--init` / compose `init: true`) — Chromium needs a real PID 1
  to reap its child processes, or it dies on startup. Already set in the compose file.

## Build & run

```bash
# with docker compose (recommended)
docker compose up --build -d
docker compose logs -f

# or plain docker  (--init is REQUIRED: Chromium needs a real PID 1 to reap children)
docker build -t webcg-ndi .
docker run --rm --init --gpus all --network host \
  -e CG_URL="https://rnd2.vu.studio/player?wallid=sienna" \
  -e CG_WIDTH=1920 -e CG_HEIGHT=1080 -e CG_FPS=60 \
  -e NDI_NAME="WebCG" -e CG_ALPHA=1 -e CG_GL=egl \
  -e NDI_DISCOVERY_SERVER="10.201.10.10" -e NDI_GROUP="public" \
  webcg-ndi
```

The NDI source `WebCG` then appears to any NDI receiver on the LAN.

### CPU-only host (no GPU)

Set `CG_GL=swiftshader` and drop the `--gpus` flag / the compose `deploy.resources`
block. Rendering falls back to software (like the Matrox box) — fine for testing.

## Web control panel

Open **`http://<host>:8099/`** (port set by `CTRL_PORT`). It gives you:

- **Live preview** of the current NDI output (auto-refreshing JPEG)
- **Set URL** — switch the rendered page instantly, no restart (like the CG node's dynamic `CONTENTURL`)
- **Reload** the current page
- **Output settings** — width / height / fps / NDI name / alpha; **Apply & restart** does a quick render+NDI restart (like the node's static controls)
- **Status** — resolution, target vs actual fps, NDI name, GL mode

REST API (same endpoints the panel uses):
```
GET  /status                       → JSON of current settings
GET  /preview.jpg                  → latest frame as JPEG
POST /url     {"url": "..."}       → switch page live
POST /reload                       → reload page
POST /config  {"width","height","fps","ndiName","alpha"}  → apply + restart
```
`CG_GL` (GPU vs software) is fixed for the process lifetime — change it via env + container restart, not the panel.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `CG_URL` | rnd2 player | page to render |
| `CG_WIDTH` / `CG_HEIGHT` | 1920 / 1080 | output resolution |
| `CG_FPS` | 30 | frame rate (try 60 on GPU) |
| `NDI_NAME` | WebCG | NDI source name |
| `CG_ALPHA` | 1 | 1 = BGRA fill+key, 0 = opaque BGRX |
| `CG_GL` | egl | `egl` = NVIDIA GPU, `swiftshader` = software |
| `CG_XVFB` | 1 | `0` = headless, no Xvfb — **required for GPU** (Xvfb forces software GLX). Keep `1` for software mode. |
| `CG_EXTRA_ARGS` | (unset) | extra Chromium CLI flags, e.g. `--use-angle=vulkan` |
| `NDI_DISCOVERY_SERVER` | (unset) | discovery server IP(s) — see below |
| `NDI_GROUP` | public | NDI send group (must match what receivers listen on) |
| `CTRL_PORT` | 8099 | web control panel port (`http://<host>:8099/`) |

## Networking / NDI discovery

`network_mode: host` puts the NDI source on the physical LAN. NDI normally finds
sources via **mDNS**, but mDNS is unreliable **inside containers** — especially on
a host that already runs other NDI apps, which hold the mDNS port. Tested result:
with plain mDNS the container's source was invisible to other NDI apps on the same
host, even with host networking.

**Fix — use an NDI Discovery Server** (unicast, port 5959). Set
`NDI_DISCOVERY_SERVER` to the server IP and every NDI app (senders + receivers)
that points at the same server sees each other, no mDNS needed. NDIPE already runs
one (`ndi-directory-service` on `:5959`). Example (verified working):

```yaml
environment:
  NDI_DISCOVERY_SERVER: "10.201.10.10"   # or 127.0.0.1 if on the same host
  NDI_GROUP: "public"
```

The entrypoint writes `~/.ndi/ndi-config.v1.json` from these vars at start.
Leave `NDI_DISCOVERY_SERVER` unset only if this container is the **only** NDI app
on its host (then mDNS works fine).

## Notes & limits (v1)

- **GPU WebGL:** with `CG_GL=egl` and a real GPU, WebGL/canvas/video run on the GPU
  via ANGLE and the composited frame is read back to CPU for NDI. Verify the GPU is
  actually in use with `nvidia-smi` (you should see the `electron`/`chrome` process).
  If WebGL falls back to SwiftShader, check the NVIDIA Container Toolkit install and
  that `NVIDIA_DRIVER_CAPABILITIES=all`.
- **Audio:** not sent yet (the Sienna CG node is video-only too). cyndilib supports
  audio frames — can be added.
- **Metadata-in (`ndimetadatareceived`):** not wired yet. A future version can expose
  the same JS hook by injecting a preload script and feeding it from NDI metadata or
  a small HTTP/WS control endpoint.
- **Frame pacing:** frames are pushed as Chromium paints; under load, frames are
  dropped (never queued) to stay realtime.

## Backlog

**Audio → NDI (transport done, capture blocked).**
The NDI side is finished and verified: the native addon queues planar float (FLTP)
alongside video on the same worker thread, and a receiver confirms audio frames
arriving at 23 blocks/sec (48000/2048). Enable with `CG_AUDIO=1` (default off —
a silent NDI audio track is worse than none).

What's blocked is tapping the *page's* audio. `createMediaElementSource` throws
`parameter 1 is not of type 'HTMLMediaElement'` even though the elements report
`instanceof HTMLMediaElement === true` and `ownerDocument === document`. The tell is
`Object.prototype.toString.call(el) === "[object EventTarget]"` — we hold cross-realm
wrapper objects and WebAudio's native brand check sees through them.

Ruled out (with evidence): `contextIsolation:false`, `sandbox:false`, and injecting
the tap as a real `<script>` element (it injects, still reports EventTarget).
`AudioContext` itself is native, not overridden by the page.

**Recommended next approach:** capture at the OS level, not the page level — a
PulseAudio null sink in the container, read via `parec`, into the addon's existing
`sendAudio()`. Page-, realm- and CORS-independent.

**Also open:**
- Shared-texture OSR (`offscreen: { useSharedTexture: true }`) — the GPU zero-copy
  readback path; the remaining structural step toward 4K60.
- A black bar has been seen on the right of ch1's render; it originates in Chromium's
  own paint (visible via `toJPEG`), so it is page layout rather than the NDI path.
