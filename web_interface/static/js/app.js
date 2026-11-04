// UI wiring: config bar, single and batch modes, the inspector, keyboard, saving.

import { getJSON, getInventory, runJob, unpackAnalysis } from "./api.js";
import * as store from "./store.js";
import * as M from "./model.js";
import { decode, Player } from "./audio.js";
import { Editor } from "./view.js";
import { makeZip } from "./zip.js";

const $ = (id) => document.getElementById(id);
const UNDO_LIMIT = 200;

// ---------------------------------------------------------------------------------------------
// Settings (per browser, small: localStorage)
// ---------------------------------------------------------------------------------------------

const SETTINGS_KEY = "bfa-web-settings";
const settings = Object.assign({
  lang: "en-us", whisper: null, pad: 0, keepAudio: true, expiryDays: 7, loop: false,
  view: "mel", mode: "single", batchCurrent: null,
}, (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) { return {}; } })());

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* private mode */ }
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

let info = null;
const clips = new Map();          // id -> clip
let clip = null;                  // the one in the editor
let busy = false;
const player = new Player();

function newClip(id, mode, name = "") {
  return {
    id, mode, name, lang: settings.lang, segMode: "text", text: "", segInput: [],
    vs: null, done: false,
    audioBlob: null, audioBuffer: null, analysis: null, inventory: null,
    undo: [], redo: [], cursor: 0,
  };
}

function clipRecord(c) {
  return { id: c.id, mode: c.mode, name: c.name, lang: c.lang, segMode: c.segMode, text: c.text,
    segInput: c.segInput, vs: c.vs, done: c.done };
}

// ---------------------------------------------------------------------------------------------
// Saving, with the storage-full check
// ---------------------------------------------------------------------------------------------

function showBanner(msg) {
  const b = $("banner");
  if (!msg) { b.hidden = true; return; }
  b.textContent = msg;
  b.hidden = false;
}

function storageFailed(e) {
  console.error(e);
  showBanner("Browser storage is full: your latest changes are NOT saved in this browser. " +
    "Download your .vs.json files now, then free space (turn off \"Keep audio\" or clear the batch list).");
}

const saveTimers = new Map();
function scheduleSave(c = clip) {
  if (!c) return;
  clearTimeout(saveTimers.get(c.id));
  saveTimers.set(c.id, setTimeout(() => saveNow(c), 400));
}

async function saveNow(c) {
  saveTimers.delete(c.id);
  try {
    await store.saveClip(clipRecord(c));
    refreshUsage();
  } catch (e) {
    if (e instanceof store.StorageFullError) storageFailed(e);
    else console.error(e);
  }
}

async function saveAudioFor(c) {
  if (!settings.keepAudio || !c.audioBlob) return;
  try { await store.saveAudio(c.id, c.audioBlob, c.name, settings.expiryDays); }
  catch (e) { if (e instanceof store.StorageFullError) storageFailed(e); else console.error(e); }
}

async function saveAnalysisFor(c) {
  if (!settings.keepAudio || !c.analysis) return;
  try { await store.saveAnalysis(c.id, c.analysis, settings.expiryDays); }
  catch (e) { if (e instanceof store.StorageFullError) storageFailed(e); else console.error(e); }
}

let usageTimer = 0;
function refreshUsage() {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(async () => {
    const u = await store.usage();
    $("storage-info").textContent = u ? `${(u.usage / 1e6).toFixed(1)} MB used` : "";
  }, 500);
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

const editor = new Editor($("view"), $("overview"), {
  onSelect: () => renderInspector(),
  onEditStart: () => pushUndo(),
  onEdit: (si, edge, t) => {
    M.moveEdge(clip, si, edge, t);
    editor.draw();
    renderInspector(true);
  },
  onEditEnd: () => { scheduleSave(); renderInspector(); renderBatchList(); },
  onSeek: (t) => { if (clip) clip.cursor = t; },
});

function pushUndo() {
  if (!clip || !clip.vs) return;
  clip.undo.push(structuredClone(clip.vs.segments));
  if (clip.undo.length > UNDO_LIMIT) clip.undo.shift();
  clip.redo = [];
  updateUndoButtons();
}

function undoRedo(from, to) {
  if (!clip || !clip.vs || !from.length) return;
  to.push(structuredClone(clip.vs.segments));
  clip.vs.segments = from.pop();
  const s = editor.sel;
  if (s && (!clip.vs.segments[s.si] || (s.type === "phoneme" && !clip.vs.segments[s.si].phoneme_ts[s.j]))) {
    editor.sel = null;
  }
  editor.draw();
  renderInspector();
  updateUndoButtons();
  scheduleSave();
  renderBatchList();
}

function updateUndoButtons() {
  $("btn-undo").disabled = !clip || !clip.undo.length;
  $("btn-redo").disabled = !clip || !clip.redo.length;
}

/** Run one edit with an undo step, then redraw and save. */
function edit(fn) {
  if (!clip || !clip.vs) return;
  pushUndo();
  const r = fn();
  editor.draw();
  scheduleSave();
  renderBatchList();
  return r;
}

// ---------------------------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------------------------

function play(t0, t1, padded = false) {
  if (!clip || !clip.audioBuffer) return;
  const pad = padded ? (settings.pad || 0) / 1000 : 0;
  player.loop = $("cfg-loop").checked;
  player.play(clip.audioBuffer, t0 - pad, t1 + pad);
  animatePlayhead();
}

function animatePlayhead() {
  const step = () => {
    const p = player.position();
    editor.setPlayhead(p);
    if (p !== null) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
player.onEnd = () => editor.setPlayhead(null);

function playSelection() {
  if (!clip || !clip.audioBuffer) return;
  const span = editor.selSpan();
  if (span) {
    const t = editor.sel.type;
    play(span[0], span[1], t === "phoneme" || t === "word" || t === "gap");
  } else {
    const from = Math.max(editor.view[0], Math.min(clip.cursor || 0, editor.view[1]));
    play(from, editor.view[1]);
  }
}

function playWordOfSelection() {
  const s = editor.sel;
  if (!s || s.type !== "phoneme") return;
  const seg = clip.vs.segments[s.si];
  const ph = M.wordPhones(seg, seg.phoneme_ts[s.j]._w);
  if (ph.length) play(ph[0].start_ms / 1000, ph[ph.length - 1].end_ms / 1000, true);
}

// ---------------------------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------------------------

const fmtMs = (ms) => `${ms.toFixed(1)} ms`;

function renderInspector(timesOnly = false) {
  const s = editor.sel;
  const has = !!(s && clip);
  $("insp-empty").hidden = has;
  $("insp-body").hidden = !has;
  if (!has) return;
  const span = editor.selSpan();
  if (!span) { $("insp-empty").hidden = false; $("insp-body").hidden = true; return; }
  $("insp-times").textContent = `${(span[0] * 1000).toFixed(1)} – ${(span[1] * 1000).toFixed(1)} ms ` +
    `(${((span[1] - span[0]) * 1000).toFixed(1)} ms)`;

  const isPh = s.type === "phoneme";
  $("insp-phoneme").hidden = !isPh;
  $("insp-gap").hidden = s.type !== "gap";
  $("insp-tokens-wrap").hidden = !isPh;
  $("insp-play-word").hidden = !isPh;

  const segs = clip.vs ? clip.vs.segments : [];
  if (s.type === "range") $("insp-title").textContent = "Selection";
  if (s.type === "segment") $("insp-title").textContent = `Segment ${s.si + 1}: ${segs[s.si].text}`;
  if (s.type === "gap") $("insp-title").textContent = "Gap (no phoneme)";
  if (s.type === "word") $("insp-title").textContent = `Word: ${segs[s.si].words[s.w] ?? "?"}`;
  if (!isPh) return;

  const seg = segs[s.si];
  const p = seg.phoneme_ts[s.j];
  $("insp-title").textContent = `/${p.phoneme_label}/  in “${seg.words[p._w] ?? "?"}”` +
    (p.edited ? "  · edited" : "");
  if (document.activeElement !== $("insp-start")) $("insp-start").value = p.start_ms.toFixed(1);
  if (document.activeElement !== $("insp-end")) $("insp-end").value = p.end_ms.toFixed(1);
  $("insp-conf").textContent = (p.confidence ?? 0).toFixed(3);
  if (timesOnly) return;

  $("insp-stress").textContent = ["none", "primary", "secondary"][p.stress] ?? p.stress;
  $("insp-length").textContent = ["short", "long", "half-long"][p.length] ?? p.length;

  const wsel = $("insp-word");
  wsel.innerHTML = "";
  seg.words.forEach((w, i) => wsel.add(new Option(`${i + 1}. ${w}`, i)));
  wsel.value = p._w;

  // tone, ranked by the tone head when present
  const tsel = $("insp-tone");
  tsel.innerHTML = "";
  const tp = M.spanToneProbs(clip, s.si, p.start_ms, p.end_ms);
  const tones = info.tone_vocab.map((t, i) => ({ i, t, pr: tp ? tp[i] : null }));
  if (tp) tones.sort((a, b) => b.pr - a.pr);
  for (const t of tones) {
    const label = (t.t || "none") + (t.pr !== null ? `  (${(t.pr * 100).toFixed(1)}%)` : "");
    tsel.add(new Option(label, t.i));
  }
  tsel.value = p.tone ?? 0;

  renderTokens();
}

function renderTokens() {
  const s = editor.sel;
  if (!s || s.type !== "phoneme" || !clip.inventory) return;
  const seg = clip.vs.segments[s.si];
  const p = seg.phoneme_ts[s.j];
  const inv = clip.inventory;
  const probs = M.spanPhonemeProbs(clip, s.si, p.start_ms, p.end_ms);
  $("insp-token-note").textContent = probs ? `${inv.tokens.length - 1} tokens of ${inv.model}, ` +
    "sorted by model probability in this span" : `${inv.tokens.length - 1} tokens of ${inv.model}`;
  const q = $("insp-filter").value.trim();
  let items = inv.tokens.map((t, id) => ({ id, t, pr: probs ? probs[id] : 0 }))
    .filter((x) => x.id !== inv.pad_id && (!q || x.t.includes(q)));
  if (probs) items.sort((a, b) => b.pr - a.pr);
  const box = $("insp-tokens");
  box.innerHTML = "";
  for (const x of items) {
    const b = document.createElement("button");
    b.className = "token" + (x.id === p.phoneme_id ? " current" : "");
    b.textContent = x.t;
    if (probs) {
      const sm = document.createElement("small");
      sm.textContent = x.pr >= 0.001 ? (x.pr * 100).toFixed(1) : "0";
      b.append(sm);
    }
    b.title = `id ${x.id}`;
    b.onclick = () => {
      edit(() => M.relabel(clip, s.si, s.j, x.id));
      renderInspector();
    };
    box.append(b);
  }
  box.dataset.first = items.length ? items[0].id : "";
}

$("insp-filter").addEventListener("input", renderTokens);
$("insp-filter").addEventListener("keydown", (e) => {
  const s = editor.sel;
  if (e.key === "Enter" && s && s.type === "phoneme" && $("insp-tokens").dataset.first !== "") {
    edit(() => M.relabel(clip, s.si, s.j, Number($("insp-tokens").dataset.first)));
    $("insp-filter").value = "";
    renderInspector();
  }
});

function onTimeInput() {
  const s = editor.sel;
  if (!s || s.type !== "phoneme") return;
  const a = Number($("insp-start").value), b = Number($("insp-end").value);
  if (!isFinite(a) || !isFinite(b)) return;
  pushUndo();
  if (!M.setTimes(clip, s.si, s.j, a, b)) clip.undo.pop();
  editor.draw(); scheduleSave(); renderInspector();
}
$("insp-start").addEventListener("change", onTimeInput);
$("insp-end").addEventListener("change", onTimeInput);
$("insp-word").addEventListener("change", (e) => {
  const s = editor.sel;
  edit(() => M.setWord(clip, s.si, s.j, Number(e.target.value)));
  renderInspector();
});
$("insp-tone").addEventListener("change", (e) => {
  const s = editor.sel;
  edit(() => M.setTone(clip, s.si, s.j, Number(e.target.value)));
  renderInspector();
});
$("insp-split").onclick = () => {
  const s = editor.sel;
  const j = edit(() => M.split(clip, s.si, s.j));
  if (j < 0) { clip.undo.pop(); updateUndoButtons(); return; }
  editor.setSelection({ type: "phoneme", si: s.si, j });
};
function deleteSelected() {
  const s = editor.sel;
  if (!s || s.type !== "phoneme") return;
  const p = clip.vs.segments[s.si].phoneme_ts[s.j];
  const mid = (p.start_ms + p.end_ms) / 2;
  edit(() => M.deletePhone(clip, s.si, s.j));
  // Select the gap it leaves, so "Insert phoneme here" is one click away.
  const gap = M.gapAt(clip.vs.segments[s.si], mid);
  editor.setSelection(gap ? { type: "gap", si: s.si, gap } : null);
}
$("insp-delete").onclick = deleteSelected;
$("insp-fill").onclick = () => {
  const s = editor.sel;
  const j = edit(() => M.fillGap(clip, s.si, s.gap));
  editor.setSelection({ type: "phoneme", si: s.si, j });
  $("insp-filter").focus();
};
$("insp-play").onclick = playSelection;
$("insp-play-word").onclick = playWordOfSelection;

// ---------------------------------------------------------------------------------------------
// Input card: audio, text / segments, transcribe, align, download
// ---------------------------------------------------------------------------------------------

function setStatus(msg) { $("job-status").textContent = msg || ""; }

function setBusy(b) {
  busy = b;
  $("btn-align").disabled = b;
  $("btn-transcribe").disabled = b;
}

function audioDuration(c) { return c.audioBuffer ? c.audioBuffer.duration : (c.vs && c.vs.duration) || 0; }

function renderInputs() {
  const c = clip;
  const has = !!c;
  $("audio-name").textContent = !has ? "No audio" :
    (c.name ? c.name + (c.audioBlob ? `  ·  ${audioDuration(c).toFixed(2)} s` : "  ·  audio not loaded — choose the file again") : "No audio");
  $("text-input").value = has ? c.text : "";
  document.querySelector(`input[name=segmode][value=${has ? c.segMode : "text"}]`).checked = true;
  $("text-input").hidden = has && c.segMode === "table";
  $("seg-table-wrap").hidden = !(has && c.segMode === "table");
  renderSegTable();
  const aligned = !!(c && c.vs);
  $("btn-download").disabled = !aligned;
  $("btn-textgrid").disabled = !aligned;
  $("done-wrap").hidden = !(c && c.mode === "batch");
  $("clip-done").checked = !!(c && c.done);
  $("view-empty").hidden = !!(c && (c.audioBuffer || c.vs));
  updateUndoButtons();
}

function validateSegments(segs, duration) {
  const bad = new Set();
  let prevEnd = -Infinity;
  segs.forEach((s, i) => {
    if (!(s.end > s.start) || s.start < 0 || (duration && s.end > duration + 0.01) || s.start < prevEnd - 1e-6) bad.add(i);
    prevEnd = Math.max(prevEnd, s.end);
  });
  return bad;
}

function renderSegTable() {
  const tb = $("seg-table");
  tb.innerHTML = "";
  if (!clip) return;
  const bad = validateSegments(clip.segInput, audioDuration(clip));
  clip.segInput.forEach((s, i) => {
    const tr = document.createElement("tr");
    if (bad.has(i)) tr.className = "invalid";
    const num = (k) => {
      const inp = document.createElement("input");
      inp.type = "number"; inp.step = "0.01"; inp.min = "0"; inp.value = s[k];
      inp.onchange = () => { s[k] = Number(inp.value); scheduleSave(); renderSegTable(); };
      return inp;
    };
    const txt = document.createElement("input");
    txt.type = "text"; txt.value = s.text;
    txt.oninput = () => { s.text = txt.value; scheduleSave(); };
    const del = document.createElement("button");
    del.className = "btn small danger"; del.textContent = "✕"; del.title = "Remove this segment";
    del.onclick = () => { clip.segInput.splice(i, 1); scheduleSave(); renderSegTable(); };
    const play = document.createElement("button");
    play.className = "btn small"; play.textContent = "▶"; play.title = "Play this segment";
    play.onclick = () => play_(s.start, s.end);
    const cells = [document.createTextNode(String(i + 1)), num("start"), num("end"), txt];
    for (const n of cells) { const td = document.createElement("td"); td.append(n); tr.append(td); }
    const td = document.createElement("td"); td.append(play, del); tr.append(td);
    tb.append(tr);
  });
}
function play_(a, b) { play(a, b); }

$("seg-add").onclick = () => {
  if (!clip) return;
  const last = clip.segInput[clip.segInput.length - 1];
  const d = audioDuration(clip);
  const start = last ? last.end : 0;
  clip.segInput.push({ start, end: Math.min(d || start + 1, start + 5), text: "" });
  scheduleSave(); renderSegTable();
};

for (const r of document.querySelectorAll("input[name=segmode]")) {
  r.addEventListener("change", () => {
    if (!clip) return;
    clip.segMode = r.value;
    if (r.value === "table" && !clip.segInput.length && clip.text.trim()) {
      clip.segInput = [{ start: 0, end: +audioDuration(clip).toFixed(3), text: clip.text.trim() }];
    }
    if (r.value === "text" && !clip.text.trim() && clip.segInput.length) {
      clip.text = clip.segInput.map((s) => s.text).join(" ");
    }
    scheduleSave(); renderInputs();
  });
}
$("text-input").addEventListener("input", () => { if (clip) { clip.text = $("text-input").value; scheduleSave(); } });

async function setAudio(c, blob, name) {
  c.audioBlob = blob;
  c.name = name;
  try {
    c.audioBuffer = await decode(blob);
  } catch (e) {
    c.audioBuffer = null;
    alert(`This browser cannot decode "${name}": ${e.message || e}`);
  }
  saveAudioFor(c);
}

$("audio-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !clip) return;
  if (clip.vs && clip.vs.audio_file && clip.vs.audio_file !== f.name &&
      !confirm(`This alignment belongs to "${clip.vs.audio_file}". Load "${f.name}" anyway and clear the alignment?`)) return;
  if (clip.vs && (!clip.vs.audio_file || clip.vs.audio_file !== f.name)) {
    if (M.isEdited(clip.vs) && !confirm("Loading new audio clears the current alignment and its edits. Continue?")) return;
    clip.vs = null; clip.analysis = null; clip.undo = []; clip.redo = [];
  }
  await setAudio(clip, f, f.name);
  scheduleSave();
  await openClip(clip);
});

function currentSegments() {
  const d = audioDuration(clip);
  if (clip.segMode === "text") {
    const t = clip.text.trim();
    return t ? [{ start: 0, end: d, text: t }] : [];
  }
  return clip.segInput.filter((s) => s.text.trim());
}

$("btn-transcribe").onclick = async () => {
  if (!clip || !clip.audioBlob) return alert("Choose an audio file first.");
  const hasText = clip.segMode === "text" ? clip.text.trim() : clip.segInput.length;
  if (hasText && !confirm("Replace the current text with Whisper's transcript?")) return;
  setBusy(true);
  const c = clip;
  try {
    setStatus("Transcribing…");
    const r = await runJob("transcribe", c.audioBlob,
      { whisper_model: settings.whisper, lang: settings.lang, audio_name: c.name }, (s) => setStatus(s + "…"));
    c.segInput = r.segments;
    c.text = r.segments.map((s) => s.text).join(" ");
    c.segMode = "table";
    setStatus(`Whisper found ${r.segments.length} segment(s). Check the text, then Align.`);
    scheduleSave(c);
    if (c === clip) renderInputs();
  } catch (e) {
    setStatus("");
    alert(`Transcription failed: ${e.message}`);
  } finally { setBusy(false); }
};

$("btn-align").onclick = async () => {
  if (!clip || !clip.audioBlob) return alert("Choose an audio file first.");
  const segs = currentSegments();
  if (!segs.length) return alert("Enter the text spoken in the recording first.");
  if (clip.segMode === "table" && validateSegments(segs, audioDuration(clip)).size) {
    return alert("Some segments have invalid times (marked red): each must end after it starts, " +
      "stay inside the audio, and not overlap the previous one.");
  }
  if (clip.vs && M.isEdited(clip.vs) &&
      !confirm("Aligning again replaces the current alignment, and ALL your edits to it will be lost. Continue?")) return;
  await align(clip, segs);
};

async function align(c, segs) {
  setBusy(true);
  try {
    setStatus("Aligning…");
    const r = await runJob("align", c.audioBlob, { lang: settings.lang, segments: segs, audio_name: c.name },
      (s) => setStatus(s + "…"));
    c.lang = settings.lang;
    c.vs = M.prepareVs(r.vs);
    c.analysis = unpackAnalysis(r.analysis);
    c.inventory = await getInventory(c.lang);
    c.undo = []; c.redo = [];
    const n = c.vs.segments.reduce((s, x) => s + x.phoneme_ts.length, 0);
    setStatus(`Aligned ${n} phonemes in ${c.vs.segments.length} segment(s).`);
    scheduleSave(c);
    saveAnalysisFor(c);
    if (c === clip) { editor.setClip(c); renderInputs(); renderInspector(); }
    renderBatchList();
  } catch (e) {
    setStatus("");
    alert(`Alignment failed: ${e.message}`);
  } finally { setBusy(false); }
}

function baseName(name) { return (name || "audio").replace(/\.[^.]+$/, ""); }

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

$("btn-download").onclick = () => {
  if (!clip || !clip.vs) return;
  downloadBlob(new Blob([M.exportJSON(clip.vs)], { type: "application/json" }), baseName(clip.name) + ".vs.json");
};
$("btn-textgrid").onclick = () => {
  if (!clip || !clip.vs) return;
  downloadBlob(new Blob([M.toTextGrid(clip.vs, audioDuration(clip))], { type: "text/plain" }),
    baseName(clip.name) + ".TextGrid");
};
$("clip-done").addEventListener("change", (e) => {
  if (!clip) return;
  clip.done = e.target.checked;
  scheduleSave(); renderBatchList();
});

// ---------------------------------------------------------------------------------------------
// Opening a clip: decode audio, fetch inventory, get posteriors for a loaded .vs.json
// ---------------------------------------------------------------------------------------------

async function openClip(c) {
  clip = c;
  player.stop();
  if (c.audioBlob && !c.audioBuffer) {
    try { c.audioBuffer = await decode(c.audioBlob); } catch (e) { console.error(e); }
  }
  if (c.vs && !c.inventory) {
    try { c.inventory = await getInventory(c.vs.lang || c.lang); }
    catch (e) { alert(`Cannot edit this file: ${e.message}`); }
  }
  editor.setClip(c);
  renderInputs();
  renderInspector();
  renderBatchList();
  if (c.vs && !c.analysis) {
    const saved = await store.get("analysis", c.id).catch(() => null);
    if (saved && saved.data) c.analysis = saved.data;
    else if (c.audioBlob) await analyze(c);
    if (c === clip) editor.setClip(c, true);
  }
}

/** Spectrogram + posteriors for an alignment that came from a file. Edits are untouched. */
async function analyze(c) {
  if (busy) return;
  setBusy(true);
  try {
    setStatus("Computing spectrogram and model probabilities…");
    const r = await runJob("analyze", c.audioBlob,
      { lang: c.vs.lang || c.lang, segments: c.vs.segments.map((s) => ({ start: s.start, end: s.end })), audio_name: c.name },
      (s) => setStatus(s + "…"));
    c.analysis = unpackAnalysis(r.analysis);
    saveAnalysisFor(c);
    setStatus("");
  } catch (e) {
    setStatus(`Could not compute the spectrogram: ${e.message}`);
  } finally { setBusy(false); }
}

// ---------------------------------------------------------------------------------------------
// Batch mode
// ---------------------------------------------------------------------------------------------

function batchClips() {
  return [...clips.values()].filter((c) => c.mode === "batch").sort((a, b) => a.name.localeCompare(b.name));
}

function renderBatchList() {
  if (settings.mode !== "batch") return;
  const ul = $("batch-list");
  ul.innerHTML = "";
  const list = batchClips();
  for (const c of list) {
    const li = document.createElement("li");
    if (c === clip) li.className = "active";
    const name = document.createElement("span");
    name.className = "name"; name.textContent = c.name; name.title = c.name;
    li.append(name);
    const badge = (text, cls = "") => {
      const b = document.createElement("span"); b.className = "badge " + cls; b.textContent = text; li.append(b);
    };
    if (!c.audioBlob) badge("no audio", "warn");
    if (!c.vs) badge("not aligned");
    else if (M.isEdited(c.vs)) badge("edited");
    if (c.done) badge("done", "ok");
    li.onclick = () => { settings.batchCurrent = c.id; saveSettings(); openClip(c); };
    ul.append(li);
  }
  const done = list.filter((c) => c.done).length;
  $("batch-count").textContent = list.length ? `${list.length} file(s), ${done} done` : "No files yet";
}

function isJson(f) { return /\.json$/i.test(f.name); }

async function addBatchFiles(files) {
  files = [...files];
  const audios = files.filter((f) => !isJson(f));
  const jsons = files.filter(isJson);
  const problems = [];
  for (const f of audios) {
    const id = "batch:" + f.name;
    const c = clips.get(id) || newClip(id, "batch", f.name);
    clips.set(id, c);
    await setAudio(c, f, f.name);
    scheduleSave(c);
  }
  for (const f of jsons) {
    let vs;
    try { vs = JSON.parse(await f.text()); } catch (e) { problems.push(`${f.name}: not valid JSON`); continue; }
    if (!vs || !Array.isArray(vs.segments)) { problems.push(`${f.name}: not a .vs.json (no segments)`); continue; }
    if (vs.phoneme_set && !String(vs.phoneme_set).startsWith("std")) {
      problems.push(`${f.name}: phoneme set "${vs.phoneme_set}" is not supported (std only)`); continue;
    }
    let audioName = vs.audio_file;
    if (!audioName) {
      // Older files have no audio_file: match "x.vs.json" with an audio file named "x.*".
      const stem = f.name.replace(/\.vs\.json$/i, "").replace(/\.json$/i, "");
      const match = batchClips().find((c) => baseName(c.name) === stem);
      audioName = match ? match.name : stem + ".wav";
    }
    const id = "batch:" + audioName;
    const c = clips.get(id) || newClip(id, "batch", audioName);
    clips.set(id, c);
    if (c.vs && M.isEdited(c.vs) && !confirm(`"${audioName}" already has edits in this browser. Replace them with ${f.name}?`)) continue;
    c.vs = M.prepareVs(vs);
    c.lang = vs.lang || c.lang;
    c.inventory = null; c.analysis = null; c.undo = []; c.redo = [];
    c.segInput = vs.segments.map((s) => ({ start: s.start, end: s.end, text: s.text || "" }));
    c.segMode = c.segInput.length > 1 ? "table" : "text";
    c.text = c.segInput.map((s) => s.text).join(" ");
    await store.del("analysis", id).catch(() => {});
    scheduleSave(c);
  }
  if (problems.length) alert("Some files were skipped:\n" + problems.join("\n"));
  renderBatchList();
  const first = batchClips().find((c) => !c.done);
  if (first && (!clip || clip.mode !== "batch")) openClip(first);
}

$("batch-files").addEventListener("change", (e) => { addBatchFiles(e.target.files); e.target.value = ""; });
const dz = $("dropzone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); addBatchFiles(e.dataTransfer.files); });

$("batch-download").onclick = () => {
  const files = batchClips().filter((c) => c.vs).map((c) => ({ name: baseName(c.name) + ".vs.json", text: M.exportJSON(c.vs) }));
  if (!files.length) return alert("Nothing aligned yet.");
  downloadBlob(makeZip(files), "bfa-alignments.zip");
};

$("batch-clear").onclick = async () => {
  const list = batchClips();
  if (!list.length) return;
  if (!confirm(`Remove all ${list.length} file(s) from this browser? Download anything you need first.`)) return;
  for (const c of list) {
    clips.delete(c.id);
    for (const s of ["clips", "audio", "analysis"]) await store.del(s, c.id).catch(() => {});
  }
  if (clip && clip.mode === "batch") { clip = null; editor.setClip(null); renderInputs(); renderInspector(); }
  renderBatchList(); refreshUsage();
};

// ---------------------------------------------------------------------------------------------
// Modes and config bar
// ---------------------------------------------------------------------------------------------

async function setMode(mode) {
  settings.mode = mode; saveSettings();
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.mode === mode);
  $("batch-panel").hidden = mode !== "batch";
  $("audio-pick-label").hidden = false;
  if (mode === "single") {
    await openClip(clips.get("single"));
  } else {
    const c = clips.get(settings.batchCurrent) || batchClips()[0];
    if (c) await openClip(c);
    else { clip = null; editor.setClip(null); renderInputs(); renderInspector(); }
    renderBatchList();
  }
}
for (const t of document.querySelectorAll(".tab")) t.onclick = () => setMode(t.dataset.mode);

function initConfig() {
  const ls = $("cfg-lang");
  for (const [group, codes] of Object.entries(info.languages)) {
    const og = document.createElement("optgroup");
    og.label = group;
    for (const code of codes) og.append(new Option(code, code));
    ls.append(og);
  }
  if (![...ls.options].some((o) => o.value === settings.lang)) {
    ls.add(new Option(settings.lang, settings.lang), 0);
  }
  ls.value = settings.lang;
  ls.onchange = () => { settings.lang = ls.value; saveSettings(); };

  const ws = $("cfg-whisper");
  for (const m of info.whisper_models) ws.add(new Option(m.label, m.id));
  ws.value = settings.whisper || info.default_whisper;
  settings.whisper = ws.value;
  ws.onchange = () => { settings.whisper = ws.value; saveSettings(); };

  $("cfg-pad").value = settings.pad;
  $("cfg-pad").onchange = () => { settings.pad = Math.max(0, Number($("cfg-pad").value) || 0); saveSettings(); };
  $("cfg-loop").checked = settings.loop;
  $("cfg-loop").onchange = () => { settings.loop = $("cfg-loop").checked; saveSettings(); };
  $("cfg-expiry").value = settings.expiryDays;
  $("cfg-expiry").onchange = () => {
    settings.expiryDays = Math.max(1, Number($("cfg-expiry").value) || 7); saveSettings();
    for (const c of clips.values()) { saveAudioFor(c); saveAnalysisFor(c); }
  };
  $("cfg-keep-audio").checked = settings.keepAudio;
  $("cfg-keep-audio").onchange = async (e) => {
    if (!e.target.checked) {
      if (!confirm("Stop keeping audio in this browser, and delete the audio stored so far? " +
        "Your alignments stay; you will need to choose the audio files again after a reload.")) {
        e.target.checked = true; return;
      }
      settings.keepAudio = false; saveSettings();
      await store.clearStore("audio"); await store.clearStore("analysis");
    } else {
      settings.keepAudio = true; saveSettings();
      for (const c of clips.values()) { await saveAudioFor(c); await saveAnalysisFor(c); }
    }
    refreshUsage();
  };

  for (const r of document.querySelectorAll("input[name=viewmode]")) {
    r.checked = r.value === settings.view;
    r.onchange = () => { settings.view = r.value; saveSettings(); editor.setMode(r.value); };
  }
  editor.setMode(settings.view);
}

// toolbar
$("btn-play").onclick = playSelection;
$("btn-play-all").onclick = () => clip && clip.audioBuffer && play(0, clip.audioBuffer.duration);
$("btn-stop").onclick = () => player.stop();
$("btn-undo").onclick = () => clip && undoRedo(clip.undo, clip.redo);
$("btn-redo").onclick = () => clip && undoRedo(clip.redo, clip.undo);
$("btn-zoom-in").onclick = () => editor.zoom(0.5);
$("btn-zoom-out").onclick = () => editor.zoom(2);
$("btn-zoom-fit").onclick = () => editor.fit();

// keyboard
function selectNeighbour(dir) {
  const s = editor.sel;
  if (!clip || !clip.vs || !s || s.type !== "phoneme") return;
  let { si, j } = s;
  j += dir;
  const segs = clip.vs.segments;
  while (si >= 0 && si < segs.length && (j < 0 || j >= segs[si].phoneme_ts.length)) {
    si += dir;
    if (si < 0 || si >= segs.length) return;
    j = dir > 0 ? 0 : segs[si].phoneme_ts.length - 1;
  }
  editor.setSelection({ type: "phoneme", si, j });
}

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "textarea" || tag === "select" ||
    (tag === "input" && !["radio", "checkbox", "button"].includes(e.target.type));
  if (typing) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === " ") { e.preventDefault(); player.playing ? player.stop() : playSelection(); }
  else if (e.key === "Escape") { player.stop(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && !ctrl) { e.preventDefault(); deleteSelected(); }
  else if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); clip && undoRedo(clip.undo, clip.redo); }
  else if (ctrl && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
    e.preventDefault(); clip && undoRedo(clip.redo, clip.undo);
  }
  else if (e.key === "ArrowRight") { e.preventDefault(); selectNeighbour(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); selectNeighbour(-1); }
  else if (e.key.toLowerCase() === "w") playWordOfSelection();
});

window.addEventListener("beforeunload", () => {
  for (const [id, t] of saveTimers) { clearTimeout(t); const c = clips.get(id); if (c) saveNow(c); }
});

// ---------------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------------

async function restoreClips() {
  let records = [];
  try { records = await store.getAll("clips"); }
  catch (e) { showBanner(`Browser storage is not available (${e.message || e}); nothing will be kept after a reload.`); }
  for (const r of records) {
    const c = Object.assign(newClip(r.id, r.mode, r.name), r);
    if (c.vs) M.prepareVs(c.vs);
    const a = await store.get("audio", r.id).catch(() => null);
    if (a && a.blob) c.audioBlob = a.blob;
    clips.set(c.id, c);
  }
}

async function loadDemo(c) {
  const d = info.demo;
  const blob = await (await fetch(d.audio)).blob();
  await setAudio(c, blob, d.name);
  c.text = d.text;
  c.segMode = "text";
  scheduleSave(c);
}

async function main() {
  try { info = await getJSON("/api/info"); }
  catch (e) { showBanner(`Cannot reach the BFA server: ${e.message}. Is \`balign --web\` running?`); return; }
  initConfig();
  store.requestPersistence();
  await store.purgeExpired().catch(() => 0);
  await restoreClips();
  if (!clips.has("single")) {
    const c = newClip("single", "single");
    clips.set("single", c);
    await loadDemo(c).catch((e) => console.error(e));
  }
  await setMode(settings.mode === "batch" ? "batch" : "single");
  refreshUsage();
}

main();
