"""
The compute side of the web interface: models, and the jobs the browser asks for.

The server keeps no user data. Every job gets the audio bytes and parameters from the browser,
and returns everything the browser needs (alignment, spectrogram, posteriors). Jobs run one at
a time on a single worker thread, because the models are large and not meant to be shared
between threads, and a local tool has one user.
"""

import base64
import io
import queue
import threading
import time
import traceback
import uuid

import numpy as np

SAMPLE_RATE = 16000

# Spectrogram on the model's own frame grid: hop 80 samples = 5 ms, so spectrogram column t
# lines up with posterior frame t of a segment that starts at a multiple of 5 ms.
MEL_N_FFT = 512
MEL_WIN = 400           # 25 ms
MEL_HOP = 80            # 5 ms
MEL_BINS = 80
MEL_FMAX = 8000
MEL_DB_RANGE = 80.0

WHISPER_MODELS = [
    ("openai/whisper-tiny", "tiny (~150 MB, fastest)"),
    ("openai/whisper-base", "base (~290 MB)"),
    ("openai/whisper-small", "small (~970 MB)"),
    ("openai/whisper-medium", "medium (~3 GB)"),
    ("openai/whisper-large-v3-turbo", "large-v3-turbo (~1.6 GB, best)"),
]
DEFAULT_WHISPER = "openai/whisper-base"


# ------------------------------------------------------------------------------------------
# Encoding helpers
# ------------------------------------------------------------------------------------------

def _b64(arr):
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")


def encode_probs(probs):
    """
    [T, C] probabilities -> uint8, sqrt-scaled: q = round(255 * sqrt(p)), p = (q / 255)^2.
    The sqrt keeps the low end precise (0.01 is stored to within ~0.001), which matters
    because std-model confidences of well-placed phones are often well below 0.1.
    """
    p = np.clip(np.asarray(probs, dtype=np.float32), 0.0, 1.0)
    q = np.rint(np.sqrt(p) * 255.0).astype(np.uint8)
    return {"shape": list(q.shape), "dtype": "uint8-sqrt", "data": _b64(q)}


def read_audio_bytes(data):
    """Audio file bytes -> mono float32 tensor [1, samples] at 16 kHz."""
    import soundfile as sf
    import torch
    try:
        x, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as ex:
        raise ValueError(f"Could not read the audio file ({ex}). WAV, FLAC, OGG and MP3 "
                         f"are supported.") from ex
    x = x.mean(axis=1)
    if x.size == 0:
        raise ValueError("The audio file is empty.")
    if sr != SAMPLE_RATE:
        import librosa
        x = librosa.resample(x, orig_sr=sr, target_sr=SAMPLE_RATE)
    return torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32)).unsqueeze(0)


def mel_spectrogram(wav):
    """[1, samples] at 16 kHz -> uint8 [T, MEL_BINS] in dB, top MEL_DB_RANGE dB kept."""
    import torch
    import torchaudio
    mel = torchaudio.transforms.MelSpectrogram(
        sample_rate=SAMPLE_RATE, n_fft=MEL_N_FFT, win_length=MEL_WIN, hop_length=MEL_HOP,
        n_mels=MEL_BINS, f_min=0.0, f_max=MEL_FMAX, power=2.0, center=True)(wav[0])
    db = 10.0 * torch.log10(mel.clamp_min(1e-10))
    top = float(db.max())
    db = db.clamp(min=top - MEL_DB_RANGE)
    q = ((db - (top - MEL_DB_RANGE)) * (255.0 / MEL_DB_RANGE)).round().to(torch.uint8)
    q = q.T.contiguous().numpy()          # [T, bins], bin 0 = lowest frequency
    return {"shape": list(q.shape), "dtype": "uint8", "data": _b64(q),
            "hop_ms": 1000.0 * MEL_HOP / SAMPLE_RATE, "fmax": MEL_FMAX,
            "db_range": MEL_DB_RANGE}


# ------------------------------------------------------------------------------------------
# Models
# ------------------------------------------------------------------------------------------

class Models:
    """Loaded models, kept between jobs. One aligner per language group, one Whisper."""

    def __init__(self, device="auto", max_aligners=2):
        self.device = device
        self.max_aligners = max_aligners
        self._aligners = {}               # model_name -> BFA, oldest first
        self._whisper = None              # (model_id, pipeline)

    @staticmethod
    def resolve(lang):
        """BCP 47 code -> (model_name, canonical_lang, lang_group). Raises if unsupported."""
        from bournemouth_aligner import presets
        model_name, code, group, _note = presets.get_std_preset(lang)
        return model_name, code, group

    def aligner(self, lang, report):
        from bournemouth_aligner import BFA
        model_name, code, _group = self.resolve(lang)
        bfa = self._aligners.pop(model_name, None)
        if bfa is None:
            report(f"Loading aligner {model_name} (the first run downloads the model and "
                   f"the ~1.2 GB G2P model)")
            while len(self._aligners) >= self.max_aligners:
                old = self._aligners.pop(next(iter(self._aligners)))
                old.close()
            bfa = BFA(preset=code, lang=code, phoneme_set="std", device=self.device,
                      warn_level=1)
        elif bfa.lang != code:
            bfa._set_phonemizer("std", code)
        self._aligners[model_name] = bfa      # most recently used last
        return bfa

    def whisper(self, model_id, report):
        if self._whisper is not None and self._whisper[0] == model_id:
            return self._whisper[1]
        report(f"Loading Whisper {model_id} (downloaded on first use)")
        self._whisper = None
        from transformers import pipeline
        from bournemouth_aligner.utils import detect_device_automatically
        device = detect_device_automatically() if self.device == "auto" else self.device
        pipe = pipeline("automatic-speech-recognition", model=model_id, device=device)
        self._whisper = (model_id, pipe)
        return pipe


# ------------------------------------------------------------------------------------------
# Jobs
# ------------------------------------------------------------------------------------------

def _clean_segments(segments, duration):
    out = []
    for i, s in enumerate(segments or []):
        text = str(s.get("text", "")).strip()
        start = max(0.0, float(s.get("start", 0.0)))
        end = min(duration, float(s.get("end", duration)))
        if not text:
            continue
        if end - start < 0.05:
            raise ValueError(f"Segment {i + 1} is shorter than 50 ms ({start:.2f}-{end:.2f} s).")
        out.append({"start": start, "end": end, "text": text})
    if not out:
        raise ValueError("There is no text to align.")
    return out


def analysis(bfa, wav, segments, report):
    """Spectrogram of the whole clip + posteriors for every segment."""
    report("Computing spectrogram and model posteriors")
    segs = []
    for s in segments:
        p = bfa.frame_posteriors(wav, s["start"], s["end"])
        segs.append({
            "start_sec": p["start_sec"],
            "ms_per_frame": p["ms_per_frame"],
            "phoneme": encode_probs(p["phoneme"].numpy()),
            "tone": encode_probs(p["tone"].numpy()) if p["tone"] is not None else None,
        })
    return {"mel": mel_spectrogram(wav), "segments": segs}


def run_align(models, audio, params, report):
    wav = read_audio_bytes(audio)
    duration = wav.shape[1] / SAMPLE_RATE
    segments = _clean_segments(params.get("segments"), duration)
    bfa = models.aligner(params.get("lang") or "en-us", report)
    report(f"Aligning {len(segments)} segment(s)")
    result = bfa.process_segments([{"segments": segments}], [wav])[0]
    bfa._set_audio_file(result, params.get("audio_name") or "audio.wav")
    result["duration"] = duration
    return {"vs": result, "analysis": analysis(bfa, wav, result["segments"], report)}


def run_analyze(models, audio, params, report):
    """For a `.vs.json` loaded from disk: posteriors + spectrogram, alignment untouched."""
    wav = read_audio_bytes(audio)
    bfa = models.aligner(params.get("lang") or "en-us", report)
    segments = [{"start": float(s["start"]), "end": float(s["end"])}
                for s in params.get("segments") or []]
    return {"analysis": analysis(bfa, wav, segments, report),
            "duration": wav.shape[1] / SAMPLE_RATE}


def run_transcribe(models, audio, params, report):
    wav = read_audio_bytes(audio)
    model_id = params.get("whisper_model") or DEFAULT_WHISPER
    if model_id not in dict(WHISPER_MODELS):
        raise ValueError(f"Unknown Whisper model {model_id!r}")
    pipe = models.whisper(model_id, report)
    lang = (params.get("lang") or "").split("-")[0].lower()
    kwargs = {"task": "transcribe"}
    if lang and params.get("whisper_lang_hint", True):
        kwargs["language"] = lang
    report("Transcribing")
    x = wav[0].numpy()
    try:
        out = pipe({"raw": x, "sampling_rate": SAMPLE_RATE}, return_timestamps=True,
                   generate_kwargs=kwargs)
    except ValueError:
        # Whisper does not know this language code: let it detect the language itself.
        kwargs.pop("language", None)
        out = pipe({"raw": x, "sampling_rate": SAMPLE_RATE}, return_timestamps=True,
                   generate_kwargs=kwargs)
    duration = wav.shape[1] / SAMPLE_RATE
    segments = []
    for c in out.get("chunks") or []:
        start, end = c.get("timestamp") or (None, None)
        text = (c.get("text") or "").strip()
        if not text:
            continue
        start = 0.0 if start is None else float(start)
        end = duration if end is None else min(float(end), duration)
        segments.append({"start": round(start, 3), "end": round(max(end, start), 3),
                         "text": text})
    if not segments and (out.get("text") or "").strip():
        segments = [{"start": 0.0, "end": duration, "text": out["text"].strip()}]
    return {"segments": segments, "duration": duration, "model": model_id}


RUNNERS = {"align": run_align, "analyze": run_analyze, "transcribe": run_transcribe}


class JobQueue:
    """One worker thread; jobs are polled by id. Finished jobs are forgotten after an hour."""

    KEEP_SECONDS = 3600

    def __init__(self, models):
        self.models = models
        self.jobs = {}
        self.lock = threading.Lock()
        self.queue = queue.Queue()
        threading.Thread(target=self._worker, daemon=True, name="bfa-web-worker").start()

    def submit(self, kind, audio, params):
        if kind not in RUNNERS:
            raise ValueError(f"Unknown job kind {kind!r}")
        job_id = uuid.uuid4().hex
        with self.lock:
            self._expire()
            self.jobs[job_id] = {"id": job_id, "kind": kind, "state": "queued",
                                 "stage": "Waiting for the previous job", "created": time.time()}
        self.queue.put((job_id, kind, audio, params))
        return job_id

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def _expire(self):
        now = time.time()
        for k in [k for k, j in self.jobs.items()
                  if j["state"] in ("done", "error") and now - j.get("finished", now)
                  > self.KEEP_SECONDS]:
            del self.jobs[k]

    def _set(self, job_id, **kw):
        with self.lock:
            if job_id in self.jobs:
                self.jobs[job_id].update(kw)

    def _worker(self):
        while True:
            job_id, kind, audio, params = self.queue.get()
            self._set(job_id, state="running", stage="Starting", started=time.time())

            def report(stage, _id=job_id):
                self._set(_id, stage=stage)

            try:
                result = RUNNERS[kind](self.models, audio, params, report)
                self._set(job_id, state="done", stage="Done", result=result,
                          finished=time.time())
            except Exception as ex:
                traceback.print_exc()
                self._set(job_id, state="error", stage="Failed",
                          error=str(ex) or ex.__class__.__name__, finished=time.time())
