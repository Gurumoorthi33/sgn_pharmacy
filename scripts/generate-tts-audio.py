#!/usr/bin/env python3
"""Generate Tamil announcement clips using gTTS, in MP3 or WAV.

Run once manually on a dev machine (not at request-time). Output clips are
committed to the repo as static assets under public/audio/ta/.

Usage:
    pip install gTTS pydub
    python scripts/generate-tts-audio.py            # MP3 (default)
    python scripts/generate-tts-audio.py --wav      # WAV (requires ffmpeg)

Generated files (whole-number natural pronunciation for tokens 0-99):
    public/audio/ta/token-num.{mp3|wav}        "Token எண்"
    public/audio/ta/please-proceed.{mp3|wav}   "தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்"
    public/audio/ta/num-{0..99}.{mp3|wav}      "0" ... "99"

WAV note: decodeAudioData() support for WAV/PCM is universal across Chromium
builds (including Silk on Fire TV), avoiding MP3 encoder/header-variant
compatibility issues at the cost of larger file sizes.
"""

import argparse
import shutil
import tempfile
from pathlib import Path

from gtts import gTTS
from pydub import AudioSegment

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "public" / "audio" / "ta"

PREFIX = "Token எண்"
SUFFIX = "தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்"

# 0 and 99 included, though max single-day count is realistically far lower.
MAX_NUM = 99


def generate(text: str, filename: str, as_wav: bool) -> Path:
    if not as_wav:
        path = OUTPUT_DIR / filename
        tts = gTTS(text=text, lang="ta")
        tts.save(str(path))
        print(f"wrote {path.relative_to(Path.cwd())}")
        return path

    # gTTS only emits MP3; convert to WAV (PCM 44100 Hz) as a post step.
    tts = gTTS(text=text, lang="ta")
    with tempfile.NamedTemporaryFile(suffix=".mp3") as tmp:
        tts.save(tmp.name)
        if shutil.which("ffmpeg") is None:
            raise RuntimeError(
                "ffmpeg not found on PATH. WAV conversion requires ffmpeg "
                "(pydub uses it as its backend). Install it, e.g. "
                "'apt-get install ffmpeg' or 'sudo apt-get install ffmpeg'."
            )
        seg = AudioSegment.from_mp3(tmp.name)
        seg = seg.set_frame_rate(44100).set_channels(1)
        path = OUTPUT_DIR / filename
        seg.export(str(path), format="wav")
    print(f"wrote {path.relative_to(Path.cwd())}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", action="store_true", help="emit WAV clips instead of MP3")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ext = "wav" if args.wav else "mp3"

    clips = [(PREFIX, "token-num"), (SUFFIX, "please-proceed")]
    clips += [(str(i), f"num-{i}") for i in range(MAX_NUM + 1)]

    for text, base in clips:
        generate(text, f"{base}.{ext}", args.wav)

    print(f"done — {len(clips)} {ext} clips written to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()