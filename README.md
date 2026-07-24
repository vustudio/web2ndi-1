# webcg-ndi

A standalone Docker service that renders a **web page in headless Chromium** and
publishes it as a **native NDI source** — the same concept as the Sienna NDIPE
**CG Engine** node (`tv.sienna.cgeng`), but decoupled from NDIPE and built to run
GPU-accelerated on your own hardware.

```
Electron (Chromium, offscreen, GPU) --BGRA--> native in-process NDI sender --> NDI source on the LAN
                     x N channels, each with its own session + NDI output
```

Multi-channel: one Electron process hosts N independent "channels", each with its own
URL, resolution, fps, NDI name and **persistent session partition** (so logins/cookies
are isolated and survive restarts). Channels live in `/data/channels.json`.

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
| `CG_ADAPTIVE` | 1 | `0` disables tally/receiver-driven frame-rate adaptation |
| `CG_AUDIO` | 0 | `1` enables the (currently silent) page audio tap — see Backlog |

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
- **Audio:** see Backlog — NDI transport works, page capture is blocked.
- **Metadata-in (`ndimetadatareceived`):** not wired. Control is HTTP instead.
- **Frame pacing:** a fixed timer transmits the newest frame, and libndi paces the
  output itself (`clock_video=true`). Chromium delivers paints in bursts, so gating
  on paint arrival collapses the rate — don't do that.
- **Adaptive rate** (`CG_ADAPTIVE`, default on): full rate only when on PGM/PVW,
  fps/3 when merely connected, 1 fps with no receivers. This is how you run many
  channels — spend frames only where they're seen.

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

**Shared-texture OSR — CLOSED, do not retry on Linux.**
`offscreen: { useSharedTexture: true }` cannot work on this stack. Measured on
Electron 33.4.11 + NVIDIA + headless container (`src/probe-sharedtexture.js`):
`event.texture` is always `null`, **and the flag disables the CPU readback** — the
`NativeImage` arrives `0x0 / 0 bytes` while the dirty rect still reports 1920x1080.
Paint events keep firing, so every counter looks healthy while the NDI output goes
black. Never enable it on a live channel.

Two independent structural causes:
1. `--ozone-platform=headless` uses a stub `TestPixmap` in Chromium
   (`ui/ozone/platform/headless/headless_surface_factory.cc`) whose
   `AreDmaBufFdsValid()` returns false and `GetDmaBufFd()` returns -1. Shared
   texture requires a real dma-buf; headless ozone structurally cannot supply one.
2. NVIDIA's proprietary driver cannot import cross-driver dma-bufs.
   electron#49247 reproduces this exact combination and was closed *"not planned"*.
   Electron's own CI skips the shared-texture spec unless macOS arm64.

Prior art agrees: OBS's `obs-browser` and upstream CEF gate `OnAcceleratedPaint` to
Windows (+ macOS arm64) and fall back to CPU `OnPaint` on Linux, and have for years.

**Consequence for 4K60:** with no shared texture there is no hook to convert
BGRA→UYVY *before* the GPU→CPU copy, so the readback bytes cannot be halved —
Chromium exposes no custom shader stage in the OSR pipeline. The remaining levers
are libyuv/SIMD for the post-readback conversion, NDI async send, splitting
channels across more Electron processes to parallelise readback, or abandoning OSR
for **NvFBC** (a real X head + framebuffer capture — the only zero-copy path with a
production track record on NVIDIA/Linux).

**Also open:**
- A black bar has been seen on the right of ch1's render; it originates in Chromium's
  own paint (visible via `toJPEG`), so it is page layout rather than the NDI path.
