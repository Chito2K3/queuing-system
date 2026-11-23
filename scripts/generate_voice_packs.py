"""
Generates compact, Smart-TV-ready embedded MP3 voice packs for ARMMC Pharmacy Queue
using Microsoft Neural Voices via edge-tts, trims leading/trailing silence safely on
MPEG Layer III frame boundaries (preserving main_data_begin == 0), and outputs
Apps Script HTML partials (AssetVoiceFil.html & AssetVoiceEn.html).
"""

import argparse
import asyncio
import base64
import json
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Tuple

import edge_tts

ROOT_DIR = Path(__file__).resolve().parent.parent

BITRATES_MPEG1_L3 = [
    0, 32000, 40000, 48000, 56000, 64000, 80000, 96000,
    112000, 128000, 160000, 192000, 224000, 256000, 320000, 0,
]
BITRATES_MPEG2_L3 = [
    0, 8000, 16000, 24000, 32000, 40000, 48000, 56000,
    64000, 80000, 96000, 112000, 128000, 144000, 160000, 0,
]
SAMPLE_RATES = {
    3: [44100, 48000, 32000],  # MPEG-1
    2: [22050, 24000, 16000],  # MPEG-2
    0: [11025, 12000, 8000],   # MPEG-2.5
}

NUMBER_WORDS_0_19 = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen",
]
TENS_WORDS = {
    20: "twenty",
    30: "thirty",
    40: "forty",
    50: "fifty",
    60: "sixty",
    70: "seventy",
    80: "eighty",
    90: "ninety",
}


class Mp3Frame(NamedTuple):
    start: int
    end: int
    start_ms: float
    end_ms: float
    main_data_begin: int


def build_number_clips() -> Dict[str, str]:
    """Builds shared number words for Taglish & PH-English packs."""
    clips: Dict[str, str] = {}
    for i, word in enumerate(NUMBER_WORDS_0_19):
        clips[f"n{i}"] = word
    for tens, word in TENS_WORDS.items():
        clips[f"n{tens}"] = word
    clips["n100"] = "one hundred"
    clips["hundred"] = "hundred"
    return clips


def build_common_clips() -> Dict[str, str]:
    """Builds shared counter and number words for natural Taglish & PH-English packs."""
    clips: Dict[str, str] = {
        "c1": "Counter one.",
        "c2": "Counter two.",
        "c3": "Counter three.",
        "c4": "Counter four.",
    }
    clips.update(build_number_clips())
    return clips


PACK_CONFIGS = [
    {
        "id": "fil_ph",
        "voice": "fil-PH-BlessicaNeural",
        "rate": "-5%",
        "name": "Blessica (Embedded Taglish AI Voice)",
        "lang": "fil-PH",
        "output": ROOT_DIR / "AssetVoiceFil.html",
        "phrases": {
            "prefix": "Numero",
            "bridge": "pumunta po sa",
            **build_common_clips(),
        },
    },
    {
        "id": "en_ph",
        "voice": "en-PH-RosaNeural",
        "rate": "-5%",
        "name": "Rosa (Embedded PH-English AI Voice)",
        "lang": "en-PH",
        "output": ROOT_DIR / "AssetVoiceEn.html",
        "phrases": {
            "prefix": "Number",
            "bridge": "please proceed to",
            **build_common_clips(),
        },
    },
    {
        "id": "fil_ph_male",
        "voice": "fil-PH-AngeloNeural",
        "rate": "-5%",
        "name": "Angelo — Embedded Taglish Male AI Voice (Smart TV Ready)",
        "lang": "fil-PH",
        "output": ROOT_DIR / "AssetVoiceFilMale.html",
        "phrases": {
            "prefix": "Numero",
            "end_c1": "pumunta po sa Counter one.",
            "end_c2": "pumunta po sa Counter two.",
            "end_c3": "pumunta po sa Counter three.",
            "end_c4": "pumunta po sa Counter four.",
            **build_number_clips(),
        },
    },
    {
        "id": "en_ph_male",
        "voice": "en-PH-JamesNeural",
        "rate": "-5%",
        "name": "James — Embedded PH-English Male AI Voice (Smart TV Ready)",
        "lang": "en-PH",
        "output": ROOT_DIR / "AssetVoiceEnMale.html",
        "phrases": {
            "prefix": "Number",
            "end_c1": "please proceed to Counter one.",
            "end_c2": "please proceed to Counter two.",
            "end_c3": "please proceed to Counter three.",
            "end_c4": "please proceed to Counter four.",
            **build_number_clips(),
        },
    },
]


def parse_mp3_frames(mp3_bytes: bytes) -> Optional[List[Mp3Frame]]:
    """Parses MPEG Layer III frames and byte/time ranges, skipping any ID3v2/ID3v1 tags."""
    data = mp3_bytes
    pos = 0
    end_limit = len(data)

    if len(data) >= 10 and data[:3] == b"ID3":
        s = data[6:10]
        tag_size = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]
        has_footer = (data[5] & 0x10) != 0
        pos = 10 + tag_size + (10 if has_footer else 0)

    if end_limit - pos >= 128 and data[end_limit - 128:end_limit - 125] == b"TAG":
        end_limit -= 128

    frames: List[Mp3Frame] = []
    elapsed_ms = 0.0

    while pos + 4 <= end_limit:
        b0, b1, b2 = data[pos], data[pos + 1], data[pos + 2]
        if b0 != 0xFF or (b1 & 0xE0) != 0xE0:
            return None

        version = (b1 >> 3) & 0x03
        layer = (b1 >> 1) & 0x03
        protection = b1 & 0x01
        bitrate_idx = (b2 >> 4) & 0x0F
        sr_idx = (b2 >> 2) & 0x03
        padding = (b2 >> 1) & 0x01

        if version == 1 or layer != 1 or sr_idx == 3:
            return None

        bitrate = BITRATES_MPEG1_L3[bitrate_idx] if version == 3 else BITRATES_MPEG2_L3[bitrate_idx]
        if bitrate == 0:
            return None

        sample_rate = SAMPLE_RATES[version][sr_idx]
        samples_per_frame = 1152 if version == 3 else 576
        frame_len = (samples_per_frame // 8) * bitrate // sample_rate + padding
        if frame_len < 6 or pos + frame_len > end_limit:
            return None

        crc_offset = 2 if protection == 0 else 0
        si_pos = pos + 4 + crc_offset
        if si_pos + (2 if version == 3 else 1) > pos + frame_len:
            return None

        if version == 3:
            main_data_begin = ((data[si_pos] << 1) | (data[si_pos + 1] >> 7)) & 0x1FF
        else:
            main_data_begin = data[si_pos]

        frame_ms = (samples_per_frame * 1000.0) / sample_rate
        frames.append(Mp3Frame(pos, pos + frame_len, elapsed_ms, elapsed_ms + frame_ms, main_data_begin))
        pos += frame_len
        elapsed_ms += frame_ms

    if pos != end_limit or not frames:
        return None
    return frames


def trim_mp3_frames(
    mp3_bytes: bytes,
    first_word_start_ms: Optional[float],
    last_word_end_ms: Optional[float],
) -> bytes:
    """Trims leading/trailing silence on frame boundaries with main_data_begin == 0."""
    frames = parse_mp3_frames(mp3_bytes)
    if not frames or first_word_start_ms is None or last_word_end_ms is None:
        return mp3_bytes

    target_start_ms = max(0.0, first_word_start_ms - 72.0)
    target_end_ms = last_word_end_ms + 96.0

    start_idx = 0
    for idx, frame in enumerate(frames):
        if frame.end_ms > target_start_ms:
            start_idx = idx
            break

    while start_idx > 0 and frames[start_idx].main_data_begin != 0:
        start_idx -= 1

    # Skip a VBR/Info metadata frame if it sits at frame 0.
    if start_idx == 0 and len(frames) > 5:
        first_chunk = mp3_bytes[frames[0].start:frames[0].end]
        if b"Xing" in first_chunk or b"Info" in first_chunk:
            if frames[1].main_data_begin == 0:
                start_idx = 1

    end_idx = len(frames)
    for idx in range(start_idx + 1, len(frames)):
        if frames[idx].start_ms >= target_end_ms:
            end_idx = idx
            break

    if end_idx - start_idx < 4:
        return mp3_bytes

    trimmed = b"".join(mp3_bytes[f.start:f.end] for f in frames[start_idx:end_idx])
    if len(trimmed) < 16 or trimmed[0] != 0xFF or (trimmed[1] & 0xE0) != 0xE0:
        return mp3_bytes
    return trimmed


async def synthesize_clip(text: str, voice: str, rate: str) -> bytes:
    """Synthesizes one spoken clip with retry and trims boundary silence."""
    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            communicate = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
            audio_parts: List[bytes] = []
            boundaries: List[Tuple[float, float]] = []

            async for chunk in communicate.stream():
                ctype = chunk.get("type")
                if ctype == "audio":
                    audio_parts.append(chunk["data"])
                elif ctype == "WordBoundary":
                    start_ms = float(chunk.get("offset", 0)) / 10000.0
                    dur_ms = float(chunk.get("duration", 0)) / 10000.0
                    boundaries.append((start_ms, start_ms + dur_ms))

            raw_mp3 = b"".join(audio_parts)
            if not raw_mp3:
                raise RuntimeError(f"Empty audio returned for {text!r}")

            first_ms = min(b[0] for b in boundaries) if boundaries else None
            last_ms = max(b[1] for b in boundaries) if boundaries else None
            return trim_mp3_frames(raw_mp3, first_ms, last_ms)
        except Exception as exc:
            last_err = exc
            await asyncio.sleep(1.0 * (attempt + 1))

    raise RuntimeError(f"Failed to synthesize {text!r} ({voice}): {last_err}")


async def generate_pack(cfg: dict) -> None:
    """Generates all clips for a single voice pack and writes its Apps Script HTML file."""
    phrases: Dict[str, str] = cfg["phrases"]
    clips_b64: Dict[str, str] = {}
    raw_bytes_total = 0

    for key, text in phrases.items():
        mp3_bytes = await synthesize_clip(text, cfg["voice"], cfg["rate"])
        raw_bytes_total += len(mp3_bytes)
        clips_b64[key] = base64.b64encode(mp3_bytes).decode("ascii")

    pack_payload = {
        "id": cfg["id"],
        "name": cfg["name"],
        "lang": cfg["lang"],
        "mime": "audio/mpeg",
        "clips": clips_b64,
    }
    html_content = (
        "<script>\n"
        "window.ARMMC_VOICE_PACKS = window.ARMMC_VOICE_PACKS || {};\n"
        f'window.ARMMC_VOICE_PACKS[{json.dumps(cfg["id"])}] = '
        f"{json.dumps(pack_payload, separators=(',', ':'))};\n"
        "</script>\n"
    )

    out_path: Path = cfg["output"]
    out_path.write_text(html_content, encoding="utf-8")
    html_kb = out_path.stat().st_size / 1024.0
    raw_kb = raw_bytes_total / 1024.0
    print(
        f"[{cfg['id']}] Generated {len(clips_b64)} clips "
        f"({raw_kb:.1f} KB raw MP3 -> {html_kb:.1f} KB {out_path.name})"
    )


async def main(only_ids: Optional[List[str]] = None) -> None:
    targets = PACK_CONFIGS
    if only_ids:
        wanted = set(only_ids)
        targets = [cfg for cfg in PACK_CONFIGS if cfg["id"] in wanted]
    for cfg in targets:
        await generate_pack(cfg)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate embedded MP3 voice packs via edge-tts.")
    parser.add_argument(
        "--only",
        nargs="+",
        choices=[cfg["id"] for cfg in PACK_CONFIGS],
        help="Generate only the specified voice pack IDs.",
    )
    args = parser.parse_args()
    asyncio.run(main(args.only))
