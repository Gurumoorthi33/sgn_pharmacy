#!/usr/bin/env python3
"""Generate pre-rendered Tamil token announcements as single MP3 files.

Run once manually on a dev machine (not at request-time). Output clips are
committed to the repo as static assets under public/audio/ta/.

Each token number gets ONE continuous file containing the full sentence:
    "Token எண் {N}, தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்"
e.g. announcement-5.mp3 = "Token எண் 5, தயவுசெய்து ...". The display board
plays a single element per announcement — no multi-clip chaining needed.

gTTS emits MP3 directly, which we normalize through pydub to a fixed moderate
bitrate suited for spoken word. MP3 is confirmed supported by Amazon Silk's
official documentation (same as WAV), and the much smaller file size reduces
load time on slower TV hardware, shrinking the window in which audio race
conditions can occur.

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

Generated files (tokens 0-99 dispatch + entry counters 1-4, tokens 1-300):
    public/audio/ta/announcement-{0..99}.mp3
    public/audio/ta/entry/counter-{1..4}-token-{1..300}.mp3
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

# Full sentence, pre-rendered per token number as one continuous clip.
ANNOUNCEMENT_TEMPLATE = (
    "Token எண் {token_number}, "
    "தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்"
)

# Entry-counter full sentence, per (counter, token) as one continuous clip.
# One file per combination — never chained/segmented clips, matching the
# Dispatch approach that proved reliable on TV browsers.
ENTRY_ANNOUNCEMENT_TEMPLATE = (
    "Token எண் {token_number}, "
    "நுழைவு கவுண்டர் {counter_number}-க்கு வரவும்"
)

# 0 and 99 included, though max single-day count is realistically far lower.
MAX_NUM = 99

# Entry counters 1-4, tokens 1-300.
ENTRY_COUNTERS = range(1, 5)
ENTRY_MAX_TOKEN = 300


def generate_announcement(token_number: int) -> None:
    text = ANNOUNCEMENT_TEMPLATE.format(token_number=token_number)
    mp3_buffer = io.BytesIO()
    gTTS(text=text, lang="ta").write_to_fp(mp3_buffer)
    mp3_buffer.seek(0)
    audio = AudioSegment.from_mp3(mp3_buffer)
    path = OUTPUT_DIR / f"announcement-{token_number}.mp3"
    audio.export(str(path), format="mp3", bitrate="96k")
    print(f"wrote {path.relative_to(Path.cwd())}")


def generate_entry_announcement(counter_number: int, token_number: int) -> None:
    text = ENTRY_ANNOUNCEMENT_TEMPLATE.format(
        counter_number=counter_number, token_number=token_number
    )
    mp3_buffer = io.BytesIO()
    gTTS(text=text, lang="ta").write_to_fp(mp3_buffer)
    mp3_buffer.seek(0)
    audio = AudioSegment.from_mp3(mp3_buffer)
    entry_dir = OUTPUT_DIR / "entry"
    entry_dir.mkdir(parents=True, exist_ok=True)
    path = entry_dir / f"counter-{counter_number}-token-{token_number}.mp3"
    audio.export(str(path), format="mp3", bitrate="96k", parameters=["-ar", "44100"])
    print(f"wrote {path.relative_to(Path.cwd())}")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for i in range(MAX_NUM + 1):
        generate_announcement(i)

    for counter in ENTRY_COUNTERS:
        for token in range(1, ENTRY_MAX_TOKEN + 1):
            generate_entry_announcement(counter, token)

    print(
        f"done — {MAX_NUM + 1} dispatch + {len(list(ENTRY_COUNTERS)) * ENTRY_MAX_TOKEN} entry mp3 files written to {OUTPUT_DIR}"
    )


if __name__ == "__main__":
    main()