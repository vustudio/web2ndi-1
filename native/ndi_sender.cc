// In-process NDI sender for webcg-ndi.
//
// Replaces the previous Electron -> pipe -> Python -> libndi path. That design
// copied every frame ~4 times and pushed it through a 64KB pipe, which capped
// throughput well below the declared frame rate. This mirrors what OBS and
// Sienna do: call libndi directly, in the process that already owns the pixels,
// on a dedicated thread.
//
// Design notes:
//  * Zero-copy from JS: we keep a reference to the Electron frame Buffer and
//    hand libndi the raw pointer. Napi::References are only created/destroyed on
//    the JS thread; the worker just reads the memory.
//  * Latest-frame-wins queue (depth 1): if the worker is still busy, a newer
//    frame replaces the pending one rather than queueing latency.
//  * clock_video = true, so libndi paces the output to the declared rate. That is
//    the SDK's own pacing - no hand-rolled timer needed.
#include <napi.h>
#include <Processing.NDI.Lib.h>

#include <atomic>
#include <condition_variable>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <cstring>
#include <vector>

namespace {

using BufRef = Napi::Reference<Napi::Buffer<uint8_t>>;

// Audio arrives as planar float (WebAudio's native layout, and NDI's FLTP), and
// is tiny (48kHz stereo ~= 384 KB/s), so we copy it into the queue rather than
// juggling JS references. All libndi calls stay on the single worker thread.
struct AudioChunk {
  std::vector<float> data;   // planar: ch0 samples, then ch1 samples, ...
  int channels = 2, sampleRate = 48000, samples = 0;
};

struct Sender {
  NDIlib_send_instance_t inst = nullptr;
  int width = 0, height = 0, fpsN = 30, fpsD = 1, stride = 0;
  NDIlib_FourCC_video_type_e fourcc = NDIlib_FourCC_video_type_BGRX;
  std::vector<AudioChunk> audioQ;
  std::atomic<uint64_t> audioSent{0};

  std::thread worker;
  std::mutex m;
  std::condition_variable cv;
  bool stop = false;

  const uint8_t* pending = nullptr;   // raw pointer into the JS buffer
  BufRef pendingRef;                  // keeps that buffer alive
  bool hasPending = false;

  std::vector<BufRef> done;           // sent/dropped refs, freed on the JS thread
  std::atomic<uint64_t> sent{0};
  std::atomic<uint64_t> dropped{0};
};

std::map<int, Sender*> g_senders;
std::mutex g_mapMutex;
int g_nextId = 1;
bool g_ndiReady = false;

Sender* lookup(int id) {
  std::lock_guard<std::mutex> lk(g_mapMutex);
  auto it = g_senders.find(id);
  return it == g_senders.end() ? nullptr : it->second;
}

void workerLoop(Sender* s) {
  for (;;) {
    const uint8_t* data = nullptr;
    BufRef ref;
    std::vector<AudioChunk> audio;
    {
      std::unique_lock<std::mutex> lk(s->m);
      s->cv.wait(lk, [&] { return s->stop || s->hasPending || !s->audioQ.empty(); });
      if (s->stop) break;
      audio.swap(s->audioQ);
      if (s->hasPending) {
        data = s->pending;
        ref = std::move(s->pendingRef);
        s->hasPending = false;
      }
    }

    // Audio first: it is cheap and must not wait behind a paced video send.
    for (auto& a : audio) {
      NDIlib_audio_frame_v3_t af;
      af.sample_rate = a.sampleRate;
      af.no_channels = a.channels;
      af.no_samples = a.samples;
      af.timecode = NDIlib_send_timecode_synthesize;
      af.FourCC = NDIlib_FourCC_audio_type_FLTP;
      af.p_data = reinterpret_cast<uint8_t*>(a.data.data());
      af.channel_stride_in_bytes = a.samples * static_cast<int>(sizeof(float));
      af.p_metadata = nullptr;
      af.timestamp = 0;
      NDIlib_send_send_audio_v3(s->inst, &af);
      s->audioSent++;
    }

    if (!data) continue;

    NDIlib_video_frame_v2_t f;
    f.xres = s->width;
    f.yres = s->height;
    f.FourCC = s->fourcc;
    f.frame_rate_N = s->fpsN;
    f.frame_rate_D = s->fpsD;
    f.picture_aspect_ratio = 0.0f;
    f.frame_format_type = NDIlib_frame_format_type_progressive;
    f.timecode = NDIlib_send_timecode_synthesize;
    f.p_data = const_cast<uint8_t*>(data);
    f.line_stride_in_bytes = s->stride;
    f.p_metadata = nullptr;
    f.timestamp = 0;

    // Blocking send; with clock_video=true libndi paces this to fpsN/fpsD.
    NDIlib_send_send_video_v2(s->inst, &f);
    s->sent++;

    {
      std::lock_guard<std::mutex> lk(s->m);
      s->done.push_back(std::move(ref));   // moving a napi_ref makes no V8 calls
    }
  }
}

// Free references whose frames are finished. Must run on the JS thread.
void drainDone(Sender* s) {
  std::vector<BufRef> tmp;
  {
    std::lock_guard<std::mutex> lk(s->m);
    tmp.swap(s->done);
  }
  tmp.clear();   // destructors (and napi_delete_reference) run here
}

NDIlib_FourCC_video_type_e parseFourCC(const std::string& v, int* bytesPerPixel) {
  if (v == "BGRA") { *bytesPerPixel = 4; return NDIlib_FourCC_video_type_BGRA; }
  if (v == "RGBA") { *bytesPerPixel = 4; return NDIlib_FourCC_video_type_RGBA; }
  if (v == "RGBX") { *bytesPerPixel = 4; return NDIlib_FourCC_video_type_RGBX; }
  if (v == "UYVY") { *bytesPerPixel = 2; return NDIlib_FourCC_video_type_UYVY; }
  *bytesPerPixel = 4;
  return NDIlib_FourCC_video_type_BGRX;
}

Napi::Value CreateSender(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_ndiReady) {
    if (!NDIlib_initialize()) {
      Napi::Error::New(env, "NDIlib_initialize failed").ThrowAsJavaScriptException();
      return env.Null();
    }
    g_ndiReady = true;
  }
  Napi::Object o = info[0].As<Napi::Object>();
  std::string name = o.Get("name").As<Napi::String>().Utf8Value();
  std::string groups;
  if (o.Has("groups") && o.Get("groups").IsString()) groups = o.Get("groups").As<Napi::String>().Utf8Value();
  int w = o.Get("width").As<Napi::Number>().Int32Value();
  int h = o.Get("height").As<Napi::Number>().Int32Value();
  int fps = o.Get("fps").As<Napi::Number>().Int32Value();
  std::string fmt = "BGRX";
  if (o.Has("fourcc") && o.Get("fourcc").IsString()) fmt = o.Get("fourcc").As<Napi::String>().Utf8Value();

  int bpp = 4;
  auto* s = new Sender();
  s->fourcc = parseFourCC(fmt, &bpp);
  s->width = w; s->height = h; s->stride = w * bpp;
  s->fpsN = fps; s->fpsD = 1;

  NDIlib_send_create_t c;
  c.p_ndi_name = name.c_str();
  c.p_groups = groups.empty() ? nullptr : groups.c_str();
  c.clock_video = true;    // let the SDK pace the output
  c.clock_audio = false;
  s->inst = NDIlib_send_create(&c);
  if (!s->inst) {
    delete s;
    Napi::Error::New(env, "NDIlib_send_create failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  s->worker = std::thread(workerLoop, s);

  int id;
  {
    std::lock_guard<std::mutex> lk(g_mapMutex);
    id = g_nextId++;
    g_senders[id] = s;
  }
  return Napi::Number::New(env, id);
}

Napi::Value SendFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Sender* s = lookup(info[0].As<Napi::Number>().Int32Value());
  if (!s) return Napi::Boolean::New(env, false);

  drainDone(s);   // free finished refs on the JS thread

  Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
  size_t need = static_cast<size_t>(s->stride) * static_cast<size_t>(s->height);
  if (buf.Length() < need) return Napi::Boolean::New(env, false);

  {
    std::lock_guard<std::mutex> lk(s->m);
    if (s->hasPending) {                    // worker still busy: newest frame wins
      s->done.push_back(std::move(s->pendingRef));
      s->dropped++;
    }
    s->pendingRef = Napi::Persistent(buf);
    s->pending = buf.Data();
    s->hasPending = true;
  }
  s->cv.notify_one();
  return Napi::Boolean::New(env, true);
}

// sendAudio(id, float32Buffer, channels, sampleRate, samplesPerChannel)
// Buffer must be planar: all of ch0's samples, then ch1's, ...
Napi::Value SendAudio(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Sender* s = lookup(info[0].As<Napi::Number>().Int32Value());
  if (!s) return Napi::Boolean::New(env, false);
  Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
  int channels = info[2].As<Napi::Number>().Int32Value();
  int rate = info[3].As<Napi::Number>().Int32Value();
  int samples = info[4].As<Napi::Number>().Int32Value();
  if (channels <= 0 || samples <= 0) return Napi::Boolean::New(env, false);
  size_t need = static_cast<size_t>(channels) * samples * sizeof(float);
  if (buf.Length() < need) return Napi::Boolean::New(env, false);

  AudioChunk a;
  a.channels = channels; a.sampleRate = rate; a.samples = samples;
  a.data.resize(static_cast<size_t>(channels) * samples);
  std::memcpy(a.data.data(), buf.Data(), need);
  {
    std::lock_guard<std::mutex> lk(s->m);
    if (s->audioQ.size() > 32) s->audioQ.erase(s->audioQ.begin());  // bound the queue
    s->audioQ.push_back(std::move(a));
  }
  s->cv.notify_one();
  return Napi::Boolean::New(env, true);
}

Napi::Value GetStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Sender* s = lookup(info[0].As<Napi::Number>().Int32Value());
  Napi::Object out = Napi::Object::New(env);
  if (!s) return out;
  out.Set("sent", Napi::Number::New(env, static_cast<double>(s->sent.load())));
  out.Set("audioSent", Napi::Number::New(env, static_cast<double>(s->audioSent.load())));
  out.Set("dropped", Napi::Number::New(env, static_cast<double>(s->dropped.load())));
  out.Set("connections", Napi::Number::New(env, NDIlib_send_get_no_connections(s->inst, 0)));
  NDIlib_tally_t t;
  if (NDIlib_send_get_tally(s->inst, &t, 0)) {
    out.Set("onProgram", Napi::Boolean::New(env, t.on_program));
    out.Set("onPreview", Napi::Boolean::New(env, t.on_preview));
  }
  return out;
}

Napi::Value DestroySender(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int id = info[0].As<Napi::Number>().Int32Value();
  Sender* s = nullptr;
  {
    std::lock_guard<std::mutex> lk(g_mapMutex);
    auto it = g_senders.find(id);
    if (it != g_senders.end()) { s = it->second; g_senders.erase(it); }
  }
  if (!s) return Napi::Boolean::New(env, false);
  {
    std::lock_guard<std::mutex> lk(s->m);
    s->stop = true;
  }
  s->cv.notify_all();
  if (s->worker.joinable()) s->worker.join();
  drainDone(s);
  { std::lock_guard<std::mutex> lk(s->m); s->pendingRef.Reset(); s->hasPending = false; }
  NDIlib_send_destroy(s->inst);
  delete s;
  return Napi::Boolean::New(env, true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("createSender", Napi::Function::New(env, CreateSender));
  exports.Set("sendFrame", Napi::Function::New(env, SendFrame));
  exports.Set("sendAudio", Napi::Function::New(env, SendAudio));
  exports.Set("getStats", Napi::Function::New(env, GetStats));
  exports.Set("destroySender", Napi::Function::New(env, DestroySender));
  return exports;
}

}  // namespace

NODE_API_MODULE(ndi_sender, Init)
