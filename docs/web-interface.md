# BFA web interface (under construction)

A local web app for building speech–text datasets with Bournemouth Forced Aligner: load a
recording, type (or transcribe) what is said, align it, then check and correct every phoneme by
hand over a spectrogram or waveform.

It runs on your own computer. Your audio and alignments stay in your browser; the local server
only does the computing.

## Start it

```bash
pip install "bournemouth-forced-aligner[web]"
balign --web
```

A browser tab opens at <http://localhost:7860>. Options: `--port 8000`, `--no-browser`,
`--device cpu|cuda`. Stop it with Ctrl+C.

The first alignment downloads the aligner model (~55 MB) and the G2P model (~1.2 GB), once. The
first transcription downloads the chosen Whisper model.

## Single mode

The page opens with a demo clip ("butterfly"). Press **Align** to run the real model on it.

1. **Audio…** picks a recording (WAV, FLAC, OGG or MP3).
2. Type what is said into the text box, **or** press **Transcribe (Whisper)**: the transcript
   arrives as a table of timed segments that you can correct before aligning.
3. **Align**. Aligning again replaces the alignment and discards your edits, so it asks first.
4. Correct the result (below), then **Download .vs.json** or **TextGrid**.

## Batch mode

Drop many audio files, plus the `.vs.json` files you downloaded from here earlier. Each
`.vs.json` is matched to its audio by the `audio_file` name stored in it. Work through the list,
tick **Done** on each, and **Download all (.zip)**. Audio without a `.vs.json` can be
transcribed and aligned the same way as in single mode.

## Editing

| To | Do |
|---|---|
| Move a boundary | Drag it, on the spectrogram or in the phoneme / word tier |
| Select a phoneme or word | Click it in its tier; ← → step through phonemes |
| Change a phoneme | Pick a replacement in the inspector. Only the model's own tokens are offered, sorted by the model's probability for that span |
| Set exact times | Type them into Start / End in the inspector |
| Change tone or word | Inspector dropdowns (stress and length are shown only: the model does not predict them) |
| Add a phoneme | **Split** one, or click a gap and **Insert phoneme here** |
| Delete a phoneme | **Delete** or the Del key; its time becomes a gap |
| Play | Space plays the selection (phoneme, word, segment or a dragged span); **W** plays the selected phoneme's word; Esc stops |
| Zoom / scroll | Ctrl + wheel / wheel; double-click zooms to an item; drag the strip under the editor |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z |

After every edit, confidence is recomputed from the model's per-frame probabilities, and
`words_ts` and the per-phoneme lists are rebuilt the same way BFA builds them. Edited phonemes
carry `"edited": true` and edited segments `"edited": true` in the downloaded `.vs.json`.

## Where your work is kept

Everything is saved in the browser (IndexedDB) as you work and reaches your disk only when you
download it. With **Keep audio** on, audio is stored too, so a reload loses nothing; it expires
after the number of days set beside it. Each save is read back to check it was kept. If the
browser runs out of space, a red banner says so: download your work, then turn off Keep audio
or clear the batch list.

## Files

```
server.py      Flask app: routes, started by `balign --web`
engine.py      model cache, job queue, align / analyze / transcribe jobs
static/        the page: index.html, app.css, js/ (no build step, no internet needed)
```

In the repository this directory sits at the top level; pip installs it as
`bournemouth_aligner.web_interface` (see `setup.py`).
