{
  "targets": [
    {
      "target_name": "ndi_sender",
      "sources": [ "native/ndi_sender.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "/opt/ndi/include"
      ],
      "libraries": [ "-L/opt/ndi/lib", "-lndi", "-Wl,-rpath,/opt/ndi/lib" ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-std=c++17", "-O2" ],
      "defines": [ "NAPI_CPP_EXCEPTIONS" ]
    }
  ]
}
