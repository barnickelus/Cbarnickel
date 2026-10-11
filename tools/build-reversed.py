#!/usr/bin/env python3
"""Build and verify the pre-reversed soundtrack.

    pip install miniaudio lameenc numpy      (works through the session proxy; ffmpeg/sox are absent)
    python3 -I build-reversed.py <src.mp3> <out.mp3> [kbps=320]

Decodes the source at its native 48 kHz (miniaudio/dr_mp3), sample-reverses it, encodes CBR with
LAME (lameenc, quality 2), then decodes the result and compares it with the reversed source
(alignment by cross-correlation; LAME encoder+decoder delay is 1105 samples).
Measured on dark-ambient-music-354475.mp3 (256 kbps, 48 kHz, 127.32 s):
  320 kbps: 5,093,760 B, corr 0.999999, SNR 57.6 dB (a forward re-encode scores 57.64 dB)
  256 kbps: 4,075,008 B, corr 0.999997, SNR 53.0 dB
"""
import sys, time
import numpy as np, miniaudio, lameenc

src, out = sys.argv[1], sys.argv[2]
kbps = int(sys.argv[3]) if len(sys.argv) > 3 else 320
SR = 48000
dec = miniaudio.decode_file(src, output_format=miniaudio.SampleFormat.FLOAT32, nchannels=2, sample_rate=SR)
a = np.frombuffer(dec.samples, dtype=np.float32).reshape(-1, 2)
rev = np.ascontiguousarray(a[::-1])
pcm16 = np.clip(np.round(rev * 32767.0), -32768, 32767).astype('<i2').tobytes()
enc = lameenc.Encoder()
enc.set_bit_rate(kbps); enc.set_in_sample_rate(SR); enc.set_channels(2); enc.set_quality(2)
data = enc.encode(pcm16) + enc.flush()
open(out, 'wb').write(data)
print(f'wrote {out}: {len(data)} bytes, {kbps} kbps CBR, {len(rev)/SR:.3f} s')

# verify: decode the result, align to the reversed source, report correlation / SNR
d2 = miniaudio.decode_file(out, output_format=miniaudio.SampleFormat.FLOAT32, nchannels=2, sample_rate=SR)
b = np.frombuffer(d2.samples, dtype=np.float32).reshape(-1, 2)
s0, L = len(rev) // 2, SR * 4
ref = rev[s0:s0 + L, 0].astype(np.float64)
best = (0, -1.0)
for lag in range(0, 4000):
    c = b[s0 + lag:s0 + lag + L, 0].astype(np.float64)
    v = float(np.dot(ref, c) / (np.linalg.norm(ref) * np.linalg.norm(c) + 1e-12))
    if v > best[1]: best = (lag, v)
lag = best[0]
n = min(len(rev), len(b) - lag)
X = rev[:n].astype(np.float64); Y = b[lag:lag + n].astype(np.float64)
err = Y - X
print(f'lag {lag} samples, corr {np.corrcoef(X.ravel(), Y.ravel())[0, 1]:.6f}, '
      f'SNR {10 * np.log10(np.sum(X ** 2) / np.sum(err ** 2)):.2f} dB, max|err| {np.abs(err).max():.4f}')
