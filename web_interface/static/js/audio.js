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

export class Player {
  constructor() {
    this.src = null;
    this.gain = null;
    this.startedAt = 0;      // ctx time when playback began
    this.t0 = 0;             // clip time (s) at that moment
    this.t1 = 0;
    this.loop = false;
    this.onEnd = null;
  }

  get playing() { return !!this.src; }

  /** Current play position in clip seconds, or null when stopped. */
  position() {
    if (!this.src) return null;
    const el = audioCtx().currentTime - this.startedAt;
    const dur = this.t1 - this.t0;
    return this.t0 + (this.loop ? el % dur : Math.min(el, dur));
  }

  play(buffer, t0, t1) {
    this.stop();
    const c = audioCtx();
    if (c.state === "suspended") c.resume();
    t0 = Math.max(0, t0);
    t1 = Math.min(buffer.duration, t1);
    const dur = t1 - t0;
    if (dur <= 0.001) return;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const g = c.createGain();
    src.connect(g).connect(c.destination);
    const now = c.currentTime;
    if (this.loop) {
      src.loop = true;
      src.loopStart = t0;
      src.loopEnd = t1;
      g.gain.value = 1;
      src.start(now, t0);
    } else {
      const f = Math.min(FADE_S, dur / 4);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(1, now + f);
      g.gain.setValueAtTime(1, now + dur - f);
      g.gain.linearRampToValueAtTime(0, now + dur);
      src.start(now, t0, dur);
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
