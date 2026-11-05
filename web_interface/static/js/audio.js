// Audio decoding and playback of any span of the clip (Web Audio API).

const FADE_S = 0.004;   // short fade in/out so a cut mid-waveform does not click

let ctx = null;
function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

export async function decode(blob) {
  const buf = await blob.arrayBuffer();
  return await audioCtx().decodeAudioData(buf);
}

/** Min/max per bucket of `bucket` samples, channel-averaged. For drawing long waveforms fast. */
export function peaks(buffer, bucket = 256) {
  const n = buffer.length;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const m = Math.ceil(n / bucket);
  const mins = new Float32Array(m), maxs = new Float32Array(m);
  for (let b = 0; b < m; b++) {
    let lo = Infinity, hi = -Infinity;
    const end = Math.min(n, (b + 1) * bucket);
    for (let i = b * bucket; i < end; i++) {
      let v = 0;
      for (const ch of chans) v += ch[i];
      v /= chans.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mins[b] = lo; maxs[b] = hi;
  }
  return { bucket, mins, maxs };
}

/**
 * Slow speech down without lowering its pitch: WSOLA (waveform-similarity overlap-add).
 * `x` mono samples, `stretch` > 1 makes it longer (2 = half speed). Each output frame is the
 * input frame, near its nominal place, that best continues the previous one, so pitch periods
 * line up and there is no phasing. The search is done on every 4th sample, then refined.
 */
export function timeStretch(x, sr, stretch) {
  const N = Math.max(64, Math.round(sr * 0.03)) & ~1;      // 30 ms frames
  const Hs = N / 2;                                          // output hop
  const Ha = Hs / stretch;                                   // input hop
  const tol = Math.round(sr * 0.008);                        // search +-8 ms
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const outLen = Math.ceil(x.length * stretch);
  const out = new Float32Array(outLen + N), norm = new Float32Array(outLen + N);
  const at = (i) => (i >= 0 && i < x.length ? x[i] : 0);
  const corr = (a, b, step) => {
    let s = 0;
    for (let i = 0; i < Hs; i += step) s += at(a + i) * at(b + i);
    return s;
  };
  let prev = 0;                                              // input position of the last frame
  for (let k = 0; k * Hs < outLen; k++) {
    const nominal = Math.round(k * Ha);
    let pos = nominal;
    if (k > 0) {
      const target = prev + Hs;                              // where the last frame would go on
      let best = -Infinity, bestD = 0;
      for (let d = -tol; d <= tol; d += 4) {
        const c = corr(target, nominal + d, 4);
        if (c > best) { best = c; bestD = d; }
      }
      for (let d = bestD - 3; d <= bestD + 3; d++) {
        const c = corr(target, nominal + d, 1);
        if (c > best) { best = c; bestD = d; }
      }
      pos = nominal + bestD;
    }
    const o = k * Hs;
    for (let i = 0; i < N; i++) { out[o + i] += at(pos + i) * win[i]; norm[o + i] += win[i]; }
    prev = pos;
  }
  const y = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) y[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return y;
}

/** The span [t0, t1) of a buffer as a new, slowed-down mono buffer. */
function slowedSpan(buffer, t0, t1, rate) {
  const sr = buffer.sampleRate;
  const i0 = Math.floor(t0 * sr), i1 = Math.min(buffer.length, Math.ceil(t1 * sr));
  const mono = new Float32Array(i1 - i0);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = i0; i < i1; i++) mono[i - i0] += ch[i] / buffer.numberOfChannels;
  }
  const y = timeStretch(mono, sr, 1 / rate);
  const out = audioCtx().createBuffer(1, y.length, sr);
  out.getChannelData(0).set(y);
  return out;
}

export class Player {
  constructor() {
    this.src = null;
    this.gain = null;
    this.startedAt = 0;      // ctx time when playback began
    this.t0 = 0;             // clip time (s) at that moment
    this.t1 = 0;
    this.loop = false;
    this.rate = 1;           // playback speed; below 1 the span is time-stretched, pitch kept
    this.playRate = 1;       // the rate of what is playing now
    this.onEnd = null;
    this._slow = null;       // {buffer, t0, t1, rate, out}: the last stretched span, reused
  }

  get playing() { return !!this.src; }

  /** Current play position in clip seconds, or null when stopped. */
  position() {
    if (!this.src) return null;
    const el = (audioCtx().currentTime - this.startedAt) * this.playRate;
    const dur = this.t1 - this.t0;
    return this.t0 + (this.loop ? el % dur : Math.min(el, dur));
  }

  play(buffer, t0, t1) {
    this.stop();
    const c = audioCtx();
    if (c.state === "suspended") c.resume();
    t0 = Math.max(0, t0);
    t1 = Math.min(buffer.duration, t1);
    if (t1 - t0 <= 0.001) return;
    this.playRate = 1;
    if (this.rate < 0.999) {
      // Play a stretched copy of just this span, from its start.
      const s = this._slow;
      if (!(s && s.buffer === buffer && s.t0 === t0 && s.t1 === t1 && s.rate === this.rate)) {
        this._slow = { buffer, t0, t1, rate: this.rate, out: slowedSpan(buffer, t0, t1, this.rate) };
      }
      this.playRate = this.rate;
      this._start(c, this._slow.out, 0, this._slow.out.duration, t0, t1);
      return;
    }
    this._start(c, buffer, t0, t1, t0, t1);
  }

  /** Play [b0, b1) of `buffer`; the clip span it stands for is [t0, t1). */
  _start(c, buffer, b0, b1, t0, t1) {
    const dur = b1 - b0;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const g = c.createGain();
    src.connect(g).connect(c.destination);
    const now = c.currentTime;
    if (this.loop) {
      src.loop = true;
      src.loopStart = b0;
      src.loopEnd = b1;
      g.gain.value = 1;
      src.start(now, b0);
    } else {
      const f = Math.min(FADE_S, dur / 4);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(1, now + f);
      g.gain.setValueAtTime(1, now + dur - f);
      g.gain.linearRampToValueAtTime(0, now + dur);
      src.start(now, b0, dur);
    }
    src.onended = () => {
      if (this.src === src) { this.src = null; if (this.onEnd) this.onEnd(); }
    };
    this.src = src; this.gain = g;
    this.startedAt = now; this.t0 = t0; this.t1 = t1;
  }

  stop() {
    if (this.src) {
      const s = this.src;
      this.src = null;
      try { s.stop(); } catch (_) { /* already stopped */ }
      if (this.onEnd) this.onEnd();
    }
  }
}
