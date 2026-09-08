#!/usr/bin/env python3
"""Generate Tamil announcement clips as WAV using gTTS + pydub.

Run once manually on a dev machine (not at request-time). Output clips are
committed to the repo as static assets under public/audio/ta/.

gTTS only emits MP3 directly, so we pipe its output through pydub (which
shells out to ffmpeg) to convert to uncompressed PCM WAV at 44100 Hz.
WAV/PCM has near-universal decodeAudioData() support across all Chromium
builds — including Silk on Fire TV — removing the MP3 decoder compatibility
failure mode.

Rather than relying on a system ffmpeg on PATH, this script uses static
bundled binaries so it runs reproducibly on any machine without a system
ffmpeg install:
    - static-ffmpeg provides BOTH the ffmpeg and ffprobe executables on PATH
      (pydub cannot decode without ffprobe; imageio-ffmpeg only ships ffmpeg).
    - imageio-ffmpeg's binary is pinned explicitly as pydub's converter.

Requirements:
    pip install -r scripts/requirements.txt   # gTTS, pydub, imageio-ffmpeg, static-ffmpeg

Usage:
    python scripts/generate-tts-audio.py

Generated files (whole-number natural pronunciation for tokens 0-99):
    public/audio/ta/token-num.wav        "Token எண்"
    public/audio/ta/please-proceed.wav   "தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்"
    public/audio/ta/num-{0..99}.wav      "0" ... "99"
"""

import io
from pathlib import Path

import imageio_ffmpeg
import static_ffmpeg

# static-ffmpeg ships BOTH ffmpeg and ffprobe; pydub's decode path probes
# files with ffprobe, which imageio-ffmpeg does not bundle. Must run before
# pydub is imported (it resolves its prober/converter at class-definition
# time), so it also needs to remain above the pydub import below.
static_ffmpeg.add_paths()

from gtts import gTTS
from pydub import AudioSegment

# Pin the ffmpeg backend to the static binary bundled with imageio-ffmpeg
# instead of whatever (if anything) exists on the system PATH. Must be set
# before any AudioSegment usage.
AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "public" / "audio" / "ta"

PREFIX = "Token எண்"
SUFFIX = "தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்"

# 0 and 99 included, though max single-day count is realistically far lower.
MAX_NUM = 99


def save_as_wav(text: str, filename: str) -> None:
    mp3_buffer = io.BytesIO()
    gTTS(text=text, lang="ta").write_to_fp(mp3_buffer)
    mp3_buffer.seek(0)
    audio = AudioSegment.from_mp3(mp3_buffer)
    path = OUTPUT_DIR / f"{filename}.wav"
    audio.export(str(path), format="wav", parameters=["-ar", "44100"])
    print(f"wrote {path.relative_to(Path.cwd())}")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    clips = [(PREFIX, "token-num"), (SUFFIX, "please-proceed")]
    clips += [(str(i), f"num-{i}") for i in range(MAX_NUM + 1)]

    for text, base in clips:
        save_as_wav(text, base)

    print(f"done — {len(clips)} wav clips written to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()