// Talking to the local server. Every job uploads the audio with it; the server keeps nothing.

export async function getJSON(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  return body;
}

const inventoryCache = new Map();
export async function getInventory(lang) {
  if (!inventoryCache.has(lang)) {
    inventoryCache.set(lang, getJSON(`/api/inventory?lang=${encodeURIComponent(lang)}`)
      .catch((e) => { inventoryCache.delete(lang); throw e; }));
  }
  return inventoryCache.get(lang);
}

/**
 * Submit a job and poll it until it finishes.
 * @param {string} kind  "align" | "analyze" | "transcribe"
 * @param {Blob} audio
 * @param {object} params
 * @param {(stage: string) => void} onStage
 */
export async function runJob(kind, audio, params, onStage = () => {}) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("params", JSON.stringify(params));
  form.append("audio", audio, params.audio_name || "audio");
  const r = await fetch("/api/jobs", { method: "POST", body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  const id = body.job_id;
  let delay = 300;
  for (;;) {
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(1500, delay * 1.3);
    const j = await getJSON(`/api/jobs/${id}`);
    if (j.state === "done") return j.result;
    if (j.state === "error") throw new Error(j.error || "The job failed");
    onStage(j.stage || j.state);
  }
}

// ---- decoding the server's packed arrays ----

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** {shape, dtype, data(base64)} -> {shape, dtype, data: Uint8Array}. Idempotent. */
export function unpack(packed) {
  if (!packed || packed.data instanceof Uint8Array) return packed;
  return { ...packed, data: b64ToBytes(packed.data) };
}

export function unpackAnalysis(a) {
  if (!a) return a;
  return {
    mel: unpack(a.mel),
    segments: a.segments.map((s) => ({ ...s, phoneme: unpack(s.phoneme), tone: unpack(s.tone) })),
  };
}

// uint8-sqrt -> probability lookup table
const SQRT_LUT = new Float32Array(256);
for (let q = 0; q < 256; q++) SQRT_LUT[q] = (q / 255) ** 2;

/** Probability of class c at frame t from a packed uint8-sqrt [T, C] array. */
export function prob(packed, t, c) {
  return SQRT_LUT[packed.data[t * packed.shape[1] + c]];
}

/** Peak probability of every class over frames [t0, t1). Returns Float32Array(C). */
export function peakProbs(packed, t0, t1) {
  const [T, C] = packed.shape;
  const out = new Float32Array(C);
  t0 = Math.max(0, Math.min(t0, T - 1));
  t1 = Math.max(t0 + 1, Math.min(t1, T));
  const d = packed.data;
  for (let t = t0; t < t1; t++) {
    const row = t * C;
    for (let c = 0; c < C; c++) {
      const v = SQRT_LUT[d[row + c]];
      if (v > out[c]) out[c] = v;
    }
  }
  return out;
}
