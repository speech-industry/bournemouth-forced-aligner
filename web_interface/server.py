"""
Local web interface for Bournemouth Forced Aligner. Start it with `balign --web`.

The browser holds all user data (audio, alignments, edits). This server only computes: it
aligns, transcribes and analyses audio that the browser uploads with each request, and it
never reads or lists files on this machine, apart from its own static files and demo clip.
"""

import json
import os
import threading
import webbrowser

from . import engine

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
MAX_UPLOAD_MB = 1024


def create_app(device="auto"):
    try:
        from flask import Flask, jsonify, request, send_from_directory
    except ImportError as ex:
        raise SystemExit(
            "The web interface needs Flask:  pip install \"bournemouth-forced-aligner[web]\""
        ) from ex

    from bournemouth_aligner import __version__, presets
    from bournemouth_aligner.phonemizers.std import std_inventory
    from bournemouth_aligner.standard_g2p.gold_g2p import TONE_VOCAB
    from bournemouth_aligner.utils import detect_device_automatically

    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
    models = engine.Models(device=device)
    jobs = engine.JobQueue(models)

    def error(msg, code=400):
        return jsonify({"error": msg}), code

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/static/<path:path>")
    def static_files(path):
        return send_from_directory(STATIC_DIR, path)

    @app.get("/api/info")
    def info():
        return jsonify({
            "version": __version__,
            "device": detect_device_automatically() if device == "auto" else device,
            "languages": presets.std_languages(),
            "default_lang": "en-us",
            "whisper_models": [{"id": i, "label": l} for i, l in engine.WHISPER_MODELS],
            "default_whisper": engine.DEFAULT_WHISPER,
            "tone_vocab": TONE_VOCAB,
            "demo": {"audio": "/static/demo/butterfly.wav", "name": "butterfly.wav",
                     "text": "butterfly", "lang": "en-us"},
        })

    @app.get("/api/inventory")
    def inventory():
        lang = request.args.get("lang", "en-us")
        try:
            model_name, code, group = engine.Models.resolve(lang)
        except Exception as ex:
            return error(str(ex))
        inv = std_inventory(group)
        return jsonify({
            "name": inv.name, "lang": code, "lang_group": group, "model": model_name,
            "tokens": inv.tokens, "sil_id": inv.sil_id, "pad_id": inv.pad_id,
            "group_of": [inv.phoneme_id_to_group_id[i] for i in range(inv.n_classes)],
            "group_labels": [inv.group_id_to_label[i] for i in range(inv.n_groups)],
            "phonemes_key": inv.phonemes_key, "groups_key": inv.groups_key,
        })

    @app.post("/api/jobs")
    def submit():
        kind = request.form.get("kind", "")
        try:
            params = json.loads(request.form.get("params") or "{}")
        except ValueError:
            return error("params is not valid JSON")
        upload = request.files.get("audio")
        if upload is None:
            return error("No audio uploaded")
        try:
            job_id = jobs.submit(kind, upload.read(), params)
        except ValueError as ex:
            return error(str(ex))
        return jsonify({"job_id": job_id})

    @app.get("/api/jobs/<job_id>")
    def job(job_id):
        j = jobs.get(job_id)
        if j is None:
            return error("No such job (the server may have restarted)", 404)
        return jsonify(j)

    return app


def run(host="127.0.0.1", port=7860, open_browser=True, device="auto"):
    app = create_app(device=device)
    url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}/"
    print(f"BFA web interface: {url}  (Ctrl+C to stop)")
    if host not in ("127.0.0.1", "localhost"):
        print("Warning: listening beyond this machine. Anyone who can reach it can run jobs.")
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=host, port=port, debug=False, threaded=True, use_reloader=False)
