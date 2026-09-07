#!/usr/bin/env python3
"""Generate Tamil announcement MP3 clips using gTTS.

Run once manually on a dev machine (not at request-time). Output MP3s are
committed to the repo as static assets under public/audio/ta/.

Usage:
    pip install gTTS
    python scripts/generate-tts-audio.py

Generated files (whole-number natural pronunciation for tokens 0-99):
    public/audio/ta/token-num.mp3        "Token எண்"
    public/audio/ta/please-proceed.mp3   "தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்"
    public/audio/ta/num-{0..99}.mp3      "0" ... "99"
"""

from pathlib import Path

from gtts import gTTS

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "public" / "audio" / "ta"

PREFIX = "Token எண்"
SUFFIX = "தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்"

# 0 and 99 included, though max single-day count is realistically far lower.
MAX_NUM = 99


def save(text: str, filename: str) -> Path:
    path = OUTPUT_DIR / filename
    tts = gTTS(text=text, lang="ta")
    tts.save(str(path))
    print(f"wrote {path.relative_to(Path.cwd())}")
    return path


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    save(PREFIX, "token-num.mp3")
    save(SUFFIX, "please-proceed.mp3")

    for i in range(MAX_NUM + 1):
        save(str(i), f"num-{i}.mp3")

    print(f"done — {MAX_NUM + 3} clips written to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()