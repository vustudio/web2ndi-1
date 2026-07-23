#!/usr/bin/env python3
"""Read raw BGRA frames from stdin and publish them as an NDI source (cyndilib).

Wire protocol on stdin: an 8-byte header (uint32 LE width, uint32 LE height)
followed by an endless stream of width*height*4 BGRA frames.
"""
import os, sys, struct
from fractions import Fraction
from cyndilib import Sender, VideoSendFrame, FourCC

FPS   = int(os.environ.get('CG_FPS', '30'))
NAME  = os.environ.get('NDI_NAME', 'WebCG')
ALPHA = os.environ.get('CG_ALPHA', '1') == '1'

stdin = sys.stdin.buffer

def read_exactly(n):
    buf = bytearray(n)
    mv = memoryview(buf)
    got = 0
    while got < n:
        r = stdin.readinto(mv[got:])
        if not r:
            return None
        got += r
    return buf

# First read the dimension header from Electron (its real paint size).
hdr = read_exactly(8)
if hdr is None:
    sys.exit(0)
W, H = struct.unpack('<II', hdr)

sender = Sender(NAME)
vf = VideoSendFrame()
vf.set_resolution(W, H)
vf.set_frame_rate(Fraction(FPS, 1))
vf.set_fourcc(FourCC.BGRA if ALPHA else FourCC.BGRX)
sender.set_video_frame(vf)

frame_size = vf.get_data_size()            # W*H*4 for BGRA/BGRX
mv = memoryview(bytearray(frame_size))
sys.stderr.write(f"[sender] NDI '{NAME}' {W}x{H}@{FPS} {'BGRA' if ALPHA else 'BGRX'} {frame_size}B\n")
sys.stderr.flush()

with sender:
    while True:
        got = 0
        while got < frame_size:            # read exactly one full frame
            r = stdin.readinto(mv[got:])
            if not r:
                sys.exit(0)                # stdin closed -> Electron gone
            got += r
        sender.write_video_async(mv)
