"""
The Mason-Alberta Phonetic Segmenter (MAPS) as one more model of the sweep.

Kelley, Perry & Tucker (2024), Phonetica 81(5), https://github.com/MasonPhonLab/MAPS: a BiLSTM
over MFCCs (10 ms frames) that gives TIMIT-61 phone posteriors, a DTW forced alignment over
them, and a linear interpolation of the posteriors that places each boundary inside its frame.

Not run directly: `process_alignments.py` calls `run_maps` for every experiment whose model is a
`method: maps` entry of `evaluate.yaml`. The result has the same place and shape as an MFA run
(segment-relative times, ARPABET labels), so `compute_metrics.py` scores it the same way.

MAPS is reached only through its own `maps.py`, unmodified, in its own conda environment
(`maps.conda_env` in the yaml). It needs Python 3.11 and TensorFlow 2.12:

    conda create -n maps python=3.11
    conda run -n maps pip install tensorflow-cpu==2.12.1 numpy==1.23.5 scipy tqdm textgrid \\
        python_speech_features natsort soxr
    git clone https://github.com/MasonPhonLab/MAPS        # -> maps.repo_dir

How a run goes:
  1. Every segment becomes `<clip>__seg<N>.wav` + `.txt` (the MFA module's corpus builder),
     dealt round-robin into `maps.num_jobs` folders, one `maps.py` process each.
  2. MAPS stops the whole call on a word its dictionary lacks, so a dictionary is written for
     exactly the corpus's words: the model's `dictionary` (an MFA dictionary name or a CMU /
     MFA-format file; the most probable pronunciation first, since MAPS takes the first one),
     and every word it lacks from the MFA G2P model `g2p_model` (`null`: such segments are left
     out, and counted in the manifest).
  3. A `maps.py` call that crashes is restarted without the file it stopped on: MAPS works
     through a folder in sorted order and skips files that already have a TextGrid.
  4. The TextGrids' `phones` tier is read back into one `<clip>.json` per clip. MAPS's silence
     `H#` is written as `sil`, which the scorer drops like MFA's.

MAPS's English model was trained on TIMIT's training set and on most of Buckeye. Its model
entry says so (`trained_on`), and the sweep refuses it there unless the experiment has
`split: test`: TIMIT's test set and Buckeye speakers s27, s38, s39, s40, the clips its authors
held out for testing.
"""

import json
import os
import re
import shutil
import subprocess
import time
from collections import defaultdict

import soundfile as sf
from tqdm import tqdm

from evaluation.align_with_mfa import build_corpus, mfa_command, parse_textgrid
from evaluation.layout import MAPS_WORK_DIR, resolve_repo_path

# MAPS's own phone set (maps.py `phones`) and the foldings it applies to a dictionary
# (utils.py `_FOLDINGS`): a pronunciation is usable only if every phone ends up in the first.
MAPS_PHONES = set(
    "h# q eh dx iy r ey ix tcl sh ow z s hh aw m t er l w aa hv ae dcl y axr d kcl k ux ng gcl "
    "g ao epi ih p ay v n f jh ax en oy dh pcl ah bcl el zh uw pau b uh th ax-h em ch nx eng".split())
MAPS_FOLDINGS = {"AO": "AA", "AX": "AH", "AX-H": "AH", "AXR": "ER", "HV": "HH", "IX": "IH",
                 "EL": "L", "EM": "M", "EN": "N", "NX": "N", "ENG": "NG", "UX": "UW"}
SILENCE_LABELS = {"H#": "sil", "SIL": "sil"}
MAPS_SAMPLE_RATE = 16000
MAX_RESTARTS = 50           # per maps.py process: files skipped after a crash before giving up
# One maps.py process (TensorFlow + the model) peaks at about 1.5 GB, so the number run side by
# side is capped by the memory free when the run starts.
GB_PER_PROCESS = 1.8


def memory_cap():
    """How many maps.py processes fit in the available memory (Linux), or None if unknown."""
    try:
        with open("/proc/meminfo") as f:
            info = dict(line.split(":", 1) for line in f)
        available_gb = int(info["MemAvailable"].split()[0]) / 2**20
    except (OSError, KeyError, ValueError):
        return None
    return max(1, int(available_gb // GB_PER_PROCESS))


def _is_float(token):
    try:
        float(token)
        return True
    except ValueError:
        return False


def _usable(pron):
    """True when MAPS can align every phone of an ARPABET pronunciation."""
    for phone in pron:
        base = re.sub(r"\d", "", phone).upper()
        if MAPS_FOLDINGS.get(base, base).lower() not in MAPS_PHONES:
            return False
    return True


def resolve_dictionary(name):
    """A local dictionary file, or the path of an MFA pretrained dictionary of that name."""
    path = resolve_repo_path(name)
    if os.path.isfile(path):
        return path
    mfa_root = os.environ.get("MFA_ROOT_DIR", os.path.expanduser("~/Documents/MFA"))
    path = os.path.join(mfa_root, "pretrained_models", "dictionary", f"{name}.dict")
    if os.path.isfile(path):
        return path
    raise FileNotFoundError(f"MAPS dictionary {name!r}: neither a file nor an MFA pretrained "
                            f"dictionary in {os.path.dirname(path)} (`mfa model download "
                            f"dictionary {name}`)")


def load_pronunciations(path):
    """
    `{WORD: [pron, ...]}` from a CMU-format or MFA-format dictionary, most probable first.

    An MFA line is `word [prob [sil-after [sil-before-correction ...]]] phones...`: the numbers
    between the word and the phones are read as probabilities, and only the first orders the
    variants. A CMU line is `WORD(2)  PHONES`. Pronunciations MAPS cannot align are dropped.
    """
    scored = defaultdict(list)
    with open(path, encoding="utf-8") as f:
        for order, line in enumerate(f):
            items = line.split()
            if len(items) < 2 or line.startswith(";;;"):
                continue
            word = re.sub(r"\(\d+\)$", "", items[0]).upper()
            numbers = []
            rest = items[1:]
            while rest and _is_float(rest[0]) and len(numbers) < 4:
                numbers.append(float(rest.pop(0)))
            if rest and _usable(rest):
                prob = numbers[0] if numbers else 1.0
                scored[word].append((-prob, order, rest))
    return {word: [pron for _, _, pron in sorted(variants)] for word, variants in scored.items()}


def g2p_pronunciations(words, g2p_model, mfa_conda_env, work_dir, log):
    """The first pronunciation MFA's G2P model gives each word (its words are lowercase)."""
    if not words:
        return {}
    word_file = os.path.join(work_dir, "oov_words.txt")
    out_file = os.path.join(work_dir, "oov_g2p.txt")
    with open(word_file, "w", encoding="utf-8") as f:
        f.write("\n".join(sorted(w.lower() for w in words)) + "\n")
    command = mfa_command(mfa_conda_env) + ["g2p", word_file, g2p_model, out_file, "--clean"]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(out_file):
        log("STDERR: " + (result.stderr or "")[-2000:])
        raise RuntimeError(f"`mfa g2p ... {g2p_model}` failed ({result.returncode}); download "
                           f"the model with `mfa model download g2p {g2p_model}`")
    prons = {}
    with open(out_file, encoding="utf-8") as f:
        for line in f:
            word, _, pron = line.rstrip("\n").partition("\t")
            pron = pron.split()
            if word.upper() not in prons and pron and _usable(pron):
                prons[word.upper()] = [pron]
    return prons


def to_16k(wav_path):
    """Resample a wav to 16 kHz in place, as 16-bit PCM. Returns 1 if it was resampled."""
    audio, rate = sf.read(wav_path, dtype="float32")
    if rate == MAPS_SAMPLE_RATE:
        return 0
    from math import gcd
    from scipy.signal import resample_poly
    g = gcd(MAPS_SAMPLE_RATE, rate)
    audio = resample_poly(audio, MAPS_SAMPLE_RATE // g, rate // g, axis=0)
    sf.write(wav_path, audio.clip(-1, 1), MAPS_SAMPLE_RATE, subtype="PCM_16")
    return 1


def corpus_words(corpus_dir, names):
    """The words of each utterance as MAPS reads them: the .txt upper-cased, split on spaces."""
    words = {}
    for name in names:
        with open(os.path.join(corpus_dir, f"{name}.txt"), encoding="utf-8") as f:
            words[name] = f.read().upper().split()
    return words


def write_cmu_dictionary(lexicon, path):
    with open(path, "w", encoding="utf-8") as f:
        for word in sorted(lexicon):
            for n, pron in enumerate(lexicon[word]):
                tag = word if n == 0 else f"{word}({n + 1})"
                f.write(f"{tag}  {' '.join(pron)}\n")


def run_shard(maps_cmd, env, shard_dir, failed_dir, log_file, log):
    """
    Run one `maps.py` over one folder until every wav has a TextGrid. When it crashes, the
    first wav (in MAPS's sorted order) without a TextGrid is the one it stopped on: that one is
    moved to `failed_dir` and the call is repeated, which carries on where it stopped.
    """
    failed = []
    for _ in range(MAX_RESTARTS + 1):
        with open(log_file, "a") as out:
            code = subprocess.run(maps_cmd, stdout=out, stderr=subprocess.STDOUT,
                                  env=env).returncode
        pending = sorted(name for name in os.listdir(shard_dir) if name.endswith(".wav")
                         and not os.path.exists(os.path.join(shard_dir, name[:-4] + ".TextGrid")))
        if code == 0 or not pending:
            return failed
        culprit = pending[0][:-4]
        log(f"maps.py exited with {code} on {culprit} ({os.path.basename(shard_dir)}); "
            f"skipping it and continuing. See {log_file}")
        for ext in (".wav", ".txt"):
            os.replace(os.path.join(shard_dir, culprit + ext), os.path.join(failed_dir, culprit + ext))
        failed.append(culprit)
    raise RuntimeError(f"maps.py crashed more than {MAX_RESTARTS} times in {shard_dir}")


def run_maps(exp, jobs, maps_cfg, mfa_cfg, log):
    """
    Align every job's segments with MAPS and write one `<clip>.json` each.

    Args:
        exp: the experiment; `id`, `acoustic_model`, `dictionary`, `g2p_model`, `interpolate`
        jobs: `(audio_path, srt_path, out_path)` per clip. A clip whose `out_path` exists is
            left alone, which is what resuming an interrupted run means here.
        maps_cfg: the `maps:` section of evaluate.yaml
        mfa_cfg: the `mfa:` section; its conda env runs the G2P for missing words
        log: called with each line worth keeping
    Returns the run's statistics for the manifest.
    """
    repo_dir = resolve_repo_path(maps_cfg["repo_dir"])
    maps_py = os.path.join(repo_dir, "maps.py")
    model = resolve_repo_path(exp["acoustic_model"])
    for path in (maps_py, model):
        if not os.path.exists(path):
            raise FileNotFoundError(f"MAPS: {path} not found (maps.repo_dir / acoustic_model)")

    work_dir = os.path.join(MAPS_WORK_DIR, exp["id"])
    corpus_dir = os.path.join(work_dir, "corpus")
    failed_dir = os.path.join(work_dir, "failed")
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    for d in (corpus_dir, failed_dir):
        os.makedirs(d)

    utterances = build_corpus(jobs, corpus_dir)
    stats = {"total_segments": len(utterances), "failed_segments": 0, "failed_files": 0,
             "oov_words": 0, "oov_words_g2p": 0, "oov_segments_dropped": 0,
             "crashed_segments": 0, "maps_seconds": None}
    if not utterances:
        log("Nothing left to align.")
        return stats

    # ---- the dictionary: the corpus's words only
    words = corpus_words(corpus_dir, utterances)
    vocab = {w for ws in words.values() for w in ws}
    lexicon = load_pronunciations(resolve_dictionary(exp["dictionary"]))
    lexicon = {w: lexicon[w] for w in vocab if w in lexicon}
    oov = vocab - set(lexicon)
    stats["oov_words"] = len(oov)
    if oov and exp.get("g2p_model"):
        g2p = g2p_pronunciations(oov, exp["g2p_model"], mfa_cfg["conda_env"], work_dir, log)
        lexicon.update(g2p)
        stats["oov_words_g2p"] = len(g2p)
        oov -= set(g2p)
    log(f"{len(vocab)} distinct words, {stats['oov_words']} not in {exp['dictionary']}, "
        f"{stats['oov_words_g2p']} of them from G2P {exp.get('g2p_model')}")
    for name, ws in words.items():
        if not ws or any(w not in lexicon for w in ws):
            for ext in (".wav", ".txt"):
                os.remove(os.path.join(corpus_dir, name + ext))
            stats["oov_segments_dropped"] += 1
    if stats["oov_segments_dropped"]:
        log(f"{stats['oov_segments_dropped']} segment(s) left out: a word with no pronunciation")
    dict_path = os.path.join(work_dir, "dictionary.txt")
    write_cmu_dictionary(lexicon, dict_path)

    # ---- one folder per process, dealt round-robin so long and short clips mix
    names = sorted(n[:-4] for n in os.listdir(corpus_dir) if n.endswith(".wav"))
    n_shards = max(1, min(int(maps_cfg["num_jobs"]), len(names)))
    cap = memory_cap()
    if cap is not None and cap < n_shards:
        log(f"maps.num_jobs {maps_cfg['num_jobs']}: only {cap} maps.py process(es) fit in the "
            f"free memory (~{GB_PER_PROCESS} GB each), so {cap} are run")
        n_shards = cap
    shard_dirs = [os.path.join(work_dir, f"shard{k:02d}") for k in range(n_shards)]
    for d in shard_dirs:
        os.makedirs(d)
    resampled = 0
    for k, name in enumerate(names):
        for ext in (".wav", ".txt"):
            os.replace(os.path.join(corpus_dir, name + ext),
                       os.path.join(shard_dirs[k % n_shards], name + ext))
        # MAPS's model wants 16 kHz. Its own --resample writes to temporary folders it never
        # deletes, and would redo every file after each restart, so it is done here, once.
        resampled += to_16k(os.path.join(shard_dirs[k % n_shards], name + ".wav"))

    conda = mfa_command(maps_cfg["conda_env"])[:-1]          # `conda run ... -n <env>`
    threads = str(max(1, (os.cpu_count() or 1) // n_shards))
    env = {**os.environ, "TF_NUM_INTRAOP_THREADS": threads, "TF_NUM_INTEROP_THREADS": "1",
           "OMP_NUM_THREADS": threads, "TF_CPP_MIN_LOG_LEVEL": "2"}

    log(f"Running MAPS ({os.path.basename(model)}, interpolation "
        f"{'on' if exp['interpolate'] else 'off'}{f', {resampled} resampled to 16 kHz' if resampled else ''}) "
        f"on {len(names)} segments in {n_shards} process(es)...")
    t0 = time.time()
    from concurrent.futures import ThreadPoolExecutor
    commands = [conda + ["python", maps_py, "--audio", d, "--text", d, "--model", model,
                         "--dict", dict_path, "--interp", "true" if exp["interpolate"] else "false",
                         "--quiet"]
                for d in shard_dirs]
    with ThreadPoolExecutor(n_shards) as pool:
        futures = [pool.submit(run_shard, cmd, env, d, failed_dir, d + ".log", log)
                   for cmd, d in zip(commands, shard_dirs)]
        crashed = [name for fut in futures for name in fut.result()]
    stats["crashed_segments"] = len(crashed)
    stats["maps_seconds"] = time.time() - t0
    log(f"MAPS finished in {stats['maps_seconds']:.1f} s "
        f"({stats['maps_seconds'] / max(1, len(names)) * 1000:.0f} ms per segment)"
        + (f"; {len(crashed)} segment(s) crashed it and were skipped" if crashed else ""))

    # ---- read back
    where = {name: shard_dirs[k % n_shards] for k, name in enumerate(names)}
    by_clip = defaultdict(list)
    for name, info in utterances.items():
        by_clip[info["out_path"]].append((name, info))

    for out_path, clip_utterances in tqdm(by_clip.items(), desc="Parsing TextGrids"):
        segments = []
        for name, info in sorted(clip_utterances, key=lambda item: item[1]["seg_idx"]):
            textgrid_path = os.path.join(where.get(name, corpus_dir), f"{name}.TextGrid")
            phonemes = []
            if os.path.exists(textgrid_path):
                # `segments` is the tier MAPS writes for a clip too short to align, where it
                # divides the clip evenly between the phones.
                phonemes = parse_textgrid(textgrid_path, tier_names=("phones", "segments"))
            for p in phonemes:
                p["phone"] = SILENCE_LABELS.get(p["phone"].upper(), p["phone"])
            if not phonemes:
                stats["failed_segments"] += 1
                continue
            segments.append({"start": info["start"], "end": info["end"],
                             "text": info["text"], "phoneme_ts": phonemes})
        if not segments:
            stats["failed_files"] += 1
            continue
        with open(out_path, "w") as f:
            json.dump({"segments": segments}, f)

    if stats["failed_segments"]:
        log(f"{stats['failed_segments']} segment(s) have no alignment (left out, crashed, or "
            f"no TextGrid).")
    if not maps_cfg["keep_workdir"]:
        shutil.rmtree(work_dir)
    return stats
