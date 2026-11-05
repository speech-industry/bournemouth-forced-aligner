---
title: Home
hide:
  - navigation
  - toc
---

<div class="bfa-hero" markdown>

# Bournemouth Forced Aligner

**Find where every phoneme and word starts and ends in a recording, in 82 languages.**

BFA is a multilingual forced aligner. Given speech audio and its transcript, it returns start and
end times for every phoneme and word, exported as Praat TextGrids or JSON. Pronunciations come
from a neural grapheme-to-phoneme model, so no pronunciation dictionary and no training on your
data are needed.

[Get started](getting-started.md){ .md-button .md-button--primary }
[Language support](language-support.md){ .md-button }
[GitHub](https://github.com/speech-industry/bournemouth-forced-aligner){ .md-button }

</div>

```bash
pip install bournemouth-forced-aligner
balign recording.wav "the words spoken in the recording" --preset=en-us --textgrid=recording.TextGrid
```

Check and correct the result in the browser with `balign --web`: every phoneme over the
spectrogram, its boundaries draggable, and the model's alternatives ranked by probability.

![The web interface: an aligned sentence over the spectrogram, one phoneme selected, with the replacement tokens ranked by the model's probability](assets/screenshots/web-editor-light.webp#only-light)
![The web interface: an aligned sentence over the spectrogram, one phoneme selected, with the replacement tokens ranked by the model's probability](assets/screenshots/web-editor-dark.webp#only-dark)

[More about the web interface](web-interface.md){ .md-button }

## Documentation

<div class="grid cards" markdown>

-   :material-rocket-launch-outline:{ .lg .middle } **Getting started**

    ---

    Install, align one recording, a long interview, or many files at once, from the command
    line or from Python.

    [:octicons-arrow-right-24: Getting started](getting-started.md)

-   :material-translate:{ .lg .middle } **Language support**

    ---

    The 82 languages, the model each one uses, and what to know about tone, stress and word
    segmentation.

    [:octicons-arrow-right-24: Language support](language-support.md)

-   :material-cursor-default-click-outline:{ .lg .middle } **Web interface**

    ---

    `balign --web`: align, transcribe and hand-correct phoneme timestamps in the browser.

    [:octicons-arrow-right-24: Web interface](web-interface.md)

-   :material-alphabetical-variant:{ .lg .middle } **Phoneme guides**

    ---

    Every phoneme token of each language group, with example words and where its boundaries go.

    [:octicons-arrow-right-24: Phoneme guides](phoneme-guides/index.md)

-   :material-brain:{ .lg .middle } **About the models**

    ---

    How the acoustic models are built and trained, and how a boundary is read off them.

    [:octicons-arrow-right-24: About the models](about-models.md)

-   :material-chart-box-outline:{ .lg .middle } **Evaluation**

    ---

    Boundary accuracy and speed on TIMIT and Buckeye, against the Montreal Forced Aligner.

    [:octicons-arrow-right-24: Evaluation](evaluation.md)

-   :material-code-braces:{ .lg .middle } **Developer guide**

    ---

    The full API and command-line reference, the output format, and how to extend BFA.

    [:octicons-arrow-right-24: Developer guide](developer-guide.md)

-   :material-history:{ .lg .middle } **Changelog**

    ---

    What changed in each release, including the move from 1.x to 2.0.

    [:octicons-arrow-right-24: Changelog](../CHANGELOG.md)

</div>

## What's inside

| | |
|---|---|
| Speed | 6-20× faster than real time on a CPU, 100-500× with a GPU |
| Resolution | 5 ms frames, with each boundary placed between frames |
| Languages | 82 with the default phoneme set, including Mandarin, Cantonese, Japanese, Korean, Vietnamese, Thai, Arabic, Persian, Hindi and Greek; 80+ through espeak-ng (`ph66`) |
| Output | Praat TextGrid; JSON with phoneme, word and phoneme-group times, plus tone, stress and length; phoneme embeddings |
| Runs on | Linux, macOS, Windows |

## Accuracy

Phoneme-boundary F1 on two hand-labelled English corpora (TIMIT, 6,300 read sentences; Buckeye,
255 conversational recordings), against the Montreal Forced Aligner (MFA):

| | TIMIT, within 10 ms | TIMIT, within 25 ms | Buckeye, within 25 ms |
|---|---:|---:|---:|
| BFA `CUPE-3-en` (ph66, English) | **58.7** | 76.8 | 74.2 |
| BFA `mbfa-latin` (default, 36 languages) | 53.7 | 72.6 | 68.4 |
| MFA `english_us_arpa` (English model + dictionary) | 55.2 | **80.9** | **84.3** |

BFA's boundaries are more precise (better within 10 ms, lower median error), MFA has fewer large
misses, and one BFA model covers 36 languages with no dictionary. Speed, robustness to transcript
errors and the full analysis are on the [evaluation](evaluation.md) page.
