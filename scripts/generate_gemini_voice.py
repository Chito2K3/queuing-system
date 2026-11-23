"""
Generates a natural, Smart-TV-ready 2-half Taglish voice pack (104 clips: Numero 1..100
+ pumunta po sa Counter 1..4) using Google AI Studio Gemini TTS in just 5 free API calls.
Caches raw WAV batches in audio_cache/fil_ph/ so re-runs never waste free daily quota.
"""

import argparse
from array import array
import base64
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Dict, List, Optional, Sequence, Tuple
import wave

ROOT_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT_DIR / "audio_cache"
FIL_CACHE_DIR = CACHE_DIR / "fil_ph"
OUTPUT_HTML_PATH = ROOT_DIR / "AssetVoiceFil.html"
PREVIEW_MP3_PATH = CACHE_DIR / "preview_numero_24_counter_2.mp3"
TEST_WAV_PATH = CACHE_DIR / "test_sample.wav"

ONES_WORDS = [
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

MIN_SILENCE_SWEEP_MS = [1000, 900, 800, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250]
REL_THRESH_SWEEP = [0.025, 0.035, 0.05, 0.07, 0.018, 0.09]
MIN_SPEECH_MS = 240.0
MIN_CLIP_SEC = 0.28
MAX_CLIP_SEC = 4.0


def number_to_english_words(n: int) -> str:
    """Converts integer 1..100 into natural spoken English number words."""
    if n < 0 or n > 100:
        raise ValueError(f"Number out of supported 0..100 range: {n}")
    if n < 20:
        return ONES_WORDS[n]
    if n == 100:
        return "one hundred"
    tens = (n // 10) * 10
    ones = n % 10
    if ones == 0:
        return TENS_WORDS[tens]
    return f"{TENS_WORDS[tens]}-{ONES_WORDS[ones]}"


def build_batches() -> List[List[Tuple[str, str]]]:
    """Builds 5 compact batches covering Numero 1..100 and Counter 1..4."""
    batches: List[List[Tuple[str, str]]] = []
    for start in range(1, 101, 25):
        items = [
            (f"h1_{n}", f"Numero {number_to_english_words(n)},")
            for n in range(start, start + 25)
        ]
        batches.append(items)
    batches.append([
        (f"end_c{c}", f"pumunta po sa Counter {number_to_english_words(c)}.")
        for c in range(1, 5)
    ])
    return batches


BATCHES = build_batches()


def build_batch_prompt(lines: Sequence[str], gender: str = "female") -> str:
    """Builds a natural Manila Taglish voice-direction prompt for Gemini TTS."""
    joined = "\n\n".join(lines)
    persona = "Filipino" if gender == "male" else "Filipina"
    return (
        f"Speak as a warm, calm, friendly {persona} hospital pharmacy announcer in Manila speaking natural Taglish. "
        "Pronounce 'Numero' and 'pumunta po sa' in natural Filipino, and pronounce the English numbers and 'Counter' "
        "in clear, natural Philippine English. Keep a steady, polite, welcoming pace. "
        "Read ONLY the lines below in exact order. Leave a clear 1.5-second silent pause between every line. "
        "Do not add introductions, commentary, or extra words.\n\n"
        f"{joined}"
    )


def parse_sample_rate(mime_type: Optional[str], default_rate: int = 24000) -> int:
    """Extracts PCM sample rate from mime_type (e.g. 'audio/L16;rate=24000')."""
    if not mime_type:
        return default_rate
    match = re.search(r"rate=(\d+)", mime_type)
    return int(match.group(1)) if match else default_rate


def write_wav_bytes(out_path: Path, raw_bytes: bytes, mime_type: Optional[str]) -> None:
    """Writes API audio bytes as a valid 16-bit mono WAV file."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if raw_bytes[:4] == b"RIFF":
        out_path.write_bytes(raw_bytes)
        return

    sample_rate = parse_sample_rate(mime_type, 24000)
    with wave.open(str(out_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(raw_bytes)


def is_transient_api_error(exc: Exception) -> bool:
    """Returns True for rate-limit (429) or temporary server/network errors."""
    msg = str(exc).lower()
    return any(tok in msg for tok in ("429", "quota", "rate", "resource_exhausted", "500", "502", "503", "504", "timeout"))


def is_model_not_found_error(exc: Exception) -> bool:
    """Returns True when an API model name is unsupported or not found."""
    msg = str(exc).lower()
    return any(tok in msg for tok in ("404", "not found", "unsupported", "invalid argument"))


def extract_audio_part(response) -> Tuple[bytes, Optional[str]]:
    """Extracts inline audio bytes and mime_type from a Gemini response."""
    candidates = getattr(response, "candidates", None) or []
    for cand in candidates:
        content = getattr(cand, "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            inline = getattr(part, "inline_data", None)
            if inline and getattr(inline, "data", None):
                data = inline.data
                if isinstance(data, str):
                    data = base64.b64decode(data)
                return bytes(data), getattr(inline, "mime_type", None)
    raise RuntimeError("Gemini TTS response did not contain inline audio data.")


def fetch_gemini_wav(
    client,
    model_candidates: Sequence[str],
    voice_name: str,
    prompt: str,
    out_wav_path: Path,
) -> None:
    """Calls Gemini TTS with model fallback and rate-limit retries, saving a WAV file."""
    from google.genai import types

    last_err: Optional[Exception] = None
    for model_id in model_candidates:
        for attempt, backoff_sec in enumerate((30, 60, 0)):
            try:
                response = client.models.generate_content(
                    model=model_id,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_modalities=["AUDIO"],
                        speech_config=types.SpeechConfig(
                            voice_config=types.VoiceConfig(
                                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                                    voice_name=voice_name
                                )
                            )
                        ),
                    ),
                )
                audio_bytes, mime_type = extract_audio_part(response)
                write_wav_bytes(out_wav_path, audio_bytes, mime_type)
                return
            except Exception as exc:
                last_err = exc
                if is_model_not_found_error(exc):
                    print(f"  Model {model_id} unavailable ({exc}); trying next fallback...", file=sys.stderr)
                    break
                if is_transient_api_error(exc) and backoff_sec > 0:
                    print(
                        f"  API rate-limited/transient error on {model_id} (attempt {attempt + 1}); "
                        f"waiting {backoff_sec}s...",
                        file=sys.stderr,
                    )
                    time.sleep(backoff_sec)
                    continue
                raise

    raise RuntimeError(f"All Gemini TTS models failed: {last_err}")


def read_mono_pcm16(wav_path: Path) -> Tuple[array, int]:
    """Reads a WAV file and returns mono 16-bit signed PCM samples plus sample rate."""
    with wave.open(str(wav_path), "rb") as wf:
        nchannels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())

    if sampwidth != 2:
        raise ValueError(f"{wav_path.name}: expected 16-bit PCM WAV, got sampwidth={sampwidth}")

    samples = array("h")
    samples.frombytes(raw)
    if sys.byteorder == "big":
        samples.byteswap()

    if nchannels == 1:
        return samples, sample_rate

    mono = array("h")
    for idx in range(0, len(samples) - nchannels + 1, nchannels):
        avg = sum(samples[idx:idx + nchannels]) // nchannels
        mono.append(max(-32768, min(32767, avg)))
    return mono, sample_rate


def compute_frame_rms(samples: array, frame_len: int) -> List[float]:
    """Computes normalized 0..1 RMS energy per fixed-size audio frame."""
    rms_vals: List[float] = []
    total = len(samples)
    for start in range(0, total, frame_len):
        end = min(total, start + frame_len)
        count = end - start
        if count <= 0:
            break
        sq_sum = 0.0
        for s in samples[start:end]:
            sq_sum += s * s
        rms_vals.append(math.sqrt(sq_sum / count) / 32768.0)
    return rms_vals


def detect_speech_segments(
    rms_vals: List[float],
    thresh: float,
    min_silence_frames: int,
    min_speech_frames: int,
) -> List[Tuple[int, int]]:
    """Groups active frames, bridges short intra-word gaps, and filters tiny clicks."""
    raw_runs: List[Tuple[int, int]] = []
    run_start: Optional[int] = None
    for idx, val in enumerate(rms_vals):
        if val >= thresh:
            if run_start is None:
                run_start = idx
        elif run_start is not None:
            raw_runs.append((run_start, idx))
            run_start = None
    if run_start is not None:
        raw_runs.append((run_start, len(rms_vals)))

    if not raw_runs:
        return []

    merged: List[Tuple[int, int]] = [raw_runs[0]]
    for s, e in raw_runs[1:]:
        prev_s, prev_e = merged[-1]
        if (s - prev_e) < min_silence_frames:
            merged[-1] = (prev_s, e)
        else:
            merged.append((s, e))

    return [(s, e) for (s, e) in merged if (e - s) >= min_speech_frames]


def slice_wav_into_clips(wav_path: Path, expected_count: int) -> Tuple[List[array], int]:
    """Adaptively splits a batch WAV into exact expected_count spoken phrases."""
    samples, sample_rate = read_mono_pcm16(wav_path)
    frame_len = max(1, int(round(sample_rate * 0.010)))  # 10ms frames
    rms_vals = compute_frame_rms(samples, frame_len)
    non_zero = sorted(r for r in rms_vals if r > 1e-6)
    if not non_zero:
        raise RuntimeError(f"{wav_path.name} appears completely silent.")

    ref_level = non_zero[int(0.95 * (len(non_zero) - 1))]
    min_speech_frames = max(1, int(round(MIN_SPEECH_MS / 10.0)))

    chosen: Optional[List[Tuple[int, int]]] = None
    best_attempt: Optional[Tuple[int, List[Tuple[int, int]], int, float]] = None

    for min_sil_ms in MIN_SILENCE_SWEEP_MS:
        min_sil_frames = max(1, int(round(min_sil_ms / 10.0)))
        for rel_thr in REL_THRESH_SWEEP:
            segs = detect_speech_segments(rms_vals, ref_level * rel_thr, min_sil_frames, min_speech_frames)
            durs = [((e - s) * frame_len) / sample_rate for s, e in segs]
            valid_durs = all(MIN_CLIP_SEC <= d <= MAX_CLIP_SEC for d in durs) if durs else False

            if len(segs) == expected_count and valid_durs:
                chosen = segs
                break

            diff = abs(len(segs) - expected_count)
            if best_attempt is None or diff < best_attempt[0]:
                best_attempt = (diff, segs, min_sil_ms, rel_thr)
        if chosen is not None:
            break

    if chosen is None:
        closest_segs = best_attempt[1] if best_attempt else []
        durs = [round(((e - s) * frame_len) / sample_rate, 2) for s, e in closest_segs]
        min_d = min(durs) if durs else 0.0
        max_d = max(durs) if durs else 0.0
        raise RuntimeError(
            f"Auto-slicer mismatch on {wav_path.name}: expected {expected_count} phrases, "
            f"closest match found {len(closest_segs)} (min={min_d}s, max={max_d}s, "
            f"min_sil={best_attempt[2] if best_attempt else '?'}ms, rel={best_attempt[3] if best_attempt else '?'})."
        )

    lead_pad = int(round(sample_rate * 0.025))
    tail_pad = int(round(sample_rate * 0.065))
    fade_samples = max(1, int(round(sample_rate * 0.010)))
    total_samples = len(samples)

    clips: List[array] = []
    for idx, (sf, ef) in enumerate(chosen):
        prev_limit = 0 if idx == 0 else ((chosen[idx - 1][1] + sf) * frame_len) // 2
        next_limit = total_samples if idx == len(chosen) - 1 else ((ef + chosen[idx + 1][0]) * frame_len) // 2
        s_idx = max(prev_limit, sf * frame_len - lead_pad)
        e_idx = min(next_limit, ef * frame_len + tail_pad)

        clip = array("h", samples[s_idx:e_idx])
        n_clip = len(clip)
        f_len = min(fade_samples, n_clip // 4)
        for i in range(f_len):
            gain_in = i / float(f_len)
            clip[i] = int(round(clip[i] * gain_in))
            gain_out = i / float(f_len)
            clip[n_clip - 1 - i] = int(round(clip[n_clip - 1 - i] * gain_out))
        clips.append(clip)

    return clips, sample_rate


def normalize_pcm(samples: array, target_rms: float = 0.14, peak_cap: float = 0.90) -> array:
    """RMS-normalizes a 16-bit PCM clip while enforcing a safe peak ceiling."""
    n = len(samples)
    if n == 0:
        return samples

    sq_sum = 0.0
    peak = 0
    for s in samples:
        sq_sum += s * s
        ab = -s if s < 0 else s
        if ab > peak:
            peak = ab

    rms = math.sqrt(sq_sum / n) / 32768.0
    if rms < 1e-6 or peak == 0:
        return array("h", samples)

    gain = target_rms / rms
    max_gain = (peak_cap * 32767.0) / float(peak)
    gain = min(gain, max_gain)

    out = array("h")
    for s in samples:
        scaled = int(round(s * gain))
        if scaled > 32767:
            scaled = 32767
        elif scaled < -32768:
            scaled = -32768
        out.append(scaled)
    return out


def encode_pcm_to_mp3(samples: array, sample_rate: int, bitrate: str = "24k") -> bytes:
    """Encodes mono 16-bit PCM samples to compact MP3 via imageio-ffmpeg."""
    import imageio_ffmpeg

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    pcm_data = array("h", samples)
    if sys.byteorder == "big":
        pcm_data.byteswap()

    cmd = [
        ffmpeg_exe,
        "-y",
        "-f", "s16le",
        "-ar", str(sample_rate),
        "-ac", "1",
        "-i", "pipe:0",
        "-c:a", "libmp3lame",
        "-b:a", bitrate,
        "-ac", "1",
        "-ar", "24000",
        "-f", "mp3",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, input=pcm_data.tobytes(), capture_output=True, check=True)
    if not proc.stdout:
        raise RuntimeError("FFmpeg produced empty MP3 output.")
    return proc.stdout


def load_api_key(cli_key: Optional[str]) -> Optional[str]:
    """Reads GEMINI_API_KEY from CLI flag, environment, or local .env file."""
    if cli_key:
        return cli_key.strip()
    env_key = os.environ.get("GEMINI_API_KEY")
    if env_key:
        return env_key.strip()
    env_file = ROOT_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("GEMINI_API_KEY="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    return val
    return None


def make_genai_client(api_key: str):
    """Creates a google-genai Client routed to v1beta where speechConfig is supported."""
    from google import genai
    from google.genai import types

    return genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(api_version="v1beta"),
    )


def write_voice_pack_html(
    out_path: Path,
    voice_name: str,
    clips_b64: Dict[str, str],
    pack_id: str = "fil_ph",
    gender: str = "female",
) -> None:
    """Writes AssetVoiceFil*.html with the 104-clip 2-half Gemini Taglish pack."""
    gender_label = "Male" if gender == "male" else "Female"
    payload = {
        "id": pack_id,
        "name": f"Gemini AI ({voice_name}) — Natural Taglish {gender_label} Voice (Smart TV Ready)",
        "lang": "fil-PH",
        "mime": "audio/mpeg",
        "mode": "two_half",
        "clips": clips_b64,
    }
    html = (
        "<script>\n"
        "window.ARMMC_VOICE_PACKS = window.ARMMC_VOICE_PACKS || {};\n"
        f'window.ARMMC_VOICE_PACKS[{json.dumps(pack_id)}] = '
        f"{json.dumps(payload, separators=(',', ':'))};\n"
        "</script>\n"
    )
    out_path.write_text(html, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate natural Taglish Gemini TTS voice pack in 5 free API calls."
    )
    parser.add_argument("--api-key", help="Gemini API key (or set GEMINI_API_KEY)")
    parser.add_argument("--gender", choices=["female", "male"], default="female", help="Voice pack gender (default: female)")
    parser.add_argument("--voice", default=None, help="Gemini prebuilt voice name (default: Aoede for female, Charon for male)")
    parser.add_argument("--model", default="gemini-2.5-flash-preview-tts", help="Primary Gemini TTS model ID")
    parser.add_argument("--bitrate", default="24k", help="Output MP3 bitrate (default: 24k)")
    parser.add_argument("--delay", type=float, default=22.0, help="Seconds to wait between API calls (default: 22)")
    parser.add_argument("--test-only", action="store_true", help="Generate 1 quick sample WAV to audition the voice")
    parser.add_argument("--only-batch", type=int, choices=[1, 2, 3, 4, 5], help="Re-fetch only batch N (1..5)")
    parser.add_argument("--from-cache", action="store_true", help="Re-slice and pack cached WAV batches without API calls")
    parser.add_argument("--force", action="store_true", help="Re-fetch cached batch WAV files from Gemini API")
    args = parser.parse_args()

    if args.voice is None:
        args.voice = "Charon" if args.gender == "male" else "Aoede"

    pack_id = "fil_ph_male" if args.gender == "male" else "fil_ph"
    cache_dir = CACHE_DIR / pack_id
    out_html_path = ROOT_DIR / ("AssetVoiceFilMale.html" if args.gender == "male" else "AssetVoiceFil.html")
    preview_mp3_path = CACHE_DIR / (
        "preview_male_numero_24_counter_2.mp3" if args.gender == "male" else "preview_numero_24_counter_2.mp3"
    )

    model_candidates = []
    for cand in (args.model, "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts"):
        if cand and cand not in model_candidates:
            model_candidates.append(cand)

    if args.test_only:
        api_key = load_api_key(args.api_key)
        if not api_key:
            print("ERROR: Missing GEMINI_API_KEY. Pass --api-key or set GEMINI_API_KEY.", file=sys.stderr)
            return 1
        client = make_genai_client(api_key)
        prompt = build_batch_prompt(["Numero twenty-four, pumunta po sa Counter two."], gender=args.gender)
        test_path = CACHE_DIR / ("test_sample_male.wav" if args.gender == "male" else "test_sample.wav")
        print(f"Generating single test sample with voice={args.voice} ({args.gender})...")
        fetch_gemini_wav(client, model_candidates, args.voice, prompt, test_path)
        print(f"Saved test sample: {test_path}")
        return 0

    batch_indices = [args.only_batch] if args.only_batch else [1, 2, 3, 4, 5]
    client = None
    made_api_call = False

    if not args.from_cache:
        need_api = any(
            args.force or not (cache_dir / f"batch_{idx}.wav").exists()
            for idx in batch_indices
        )
        if need_api:
            api_key = load_api_key(args.api_key)
            if not api_key:
                print(
                    "ERROR: Missing GEMINI_API_KEY. Set $env:GEMINI_API_KEY='...' or pass --api-key (or use --from-cache).",
                    file=sys.stderr,
                )
                return 1
            client = make_genai_client(api_key)

        for idx in batch_indices:
            wav_path = cache_dir / f"batch_{idx}.wav"
            if wav_path.exists() and not args.force:
                print(f"[Batch {idx}/5] Using cached {wav_path.name}")
                continue
            if made_api_call and args.delay > 0:
                print(f"  Waiting {args.delay:.0f}s to respect 3 RPM free-tier limit...")
                time.sleep(args.delay)
            items = BATCHES[idx - 1]
            prompt = build_batch_prompt([text for _, text in items], gender=args.gender)
            print(f"[Batch {idx}/5] Calling Gemini TTS ({args.voice}, {args.gender}, {len(items)} phrases)...")
            fetch_gemini_wav(client, model_candidates, args.voice, prompt, wav_path)
            made_api_call = True
            print(f"  Saved {wav_path}")

    # Verify all 5 batch WAVs exist before slicing
    missing = [idx for idx in range(1, 6) if not (cache_dir / f"batch_{idx}.wav").exists()]
    if missing:
        print(f"Missing cached WAV files for batches {missing}; run without --only-batch to complete.", file=sys.stderr)
        return 1

    clips_b64: Dict[str, str] = {}
    pcm_by_key: Dict[str, Tuple[array, int]] = {}
    raw_mp3_bytes = 0

    for idx in range(1, 6):
        wav_path = cache_dir / f"batch_{idx}.wav"
        items = BATCHES[idx - 1]
        try:
            sliced_clips, sr = slice_wav_into_clips(wav_path, len(items))
        except Exception as exc:
            print(f"\nERROR: {exc}", file=sys.stderr)
            print(
                f"Tip: Re-generate only batch {idx} with:\n"
                f"  python scripts/generate_gemini_voice.py --gender {args.gender} --only-batch {idx} --force",
                file=sys.stderr,
            )
            return 1

        for (key, _), pcm in zip(items, sliced_clips):
            norm = normalize_pcm(pcm)
            pcm_by_key[key] = (norm, sr)
            mp3 = encode_pcm_to_mp3(norm, sr, bitrate=args.bitrate)
            raw_mp3_bytes += len(mp3)
            clips_b64[key] = base64.b64encode(mp3).decode("ascii")
        print(f"[Batch {idx}/5] Sliced and encoded {len(items)} clips cleanly.")

    write_voice_pack_html(out_html_path, args.voice, clips_b64, pack_id=pack_id, gender=args.gender)
    html_kb = out_html_path.stat().st_size / 1024.0
    print(f"\nWrote {len(clips_b64)} clips ({raw_mp3_bytes / 1024.0:.1f} KB MP3 -> {html_kb:.1f} KB {out_html_path.name})")

    # Build stitched audible preview: Numero 24, (140ms pause) pumunta po sa Counter 2.
    pcm_h1, sr1 = pcm_by_key["h1_24"]
    pcm_end, sr2 = pcm_by_key["end_c2"]
    if sr1 == sr2:
        silence = array("h", [0] * int(round(sr1 * 0.14)))
        stitched = array("h", pcm_h1)
        stitched.extend(silence)
        stitched.extend(pcm_end)
        preview_mp3 = encode_pcm_to_mp3(stitched, sr1, bitrate=args.bitrate)
        preview_mp3_path.parent.mkdir(parents=True, exist_ok=True)
        preview_mp3_path.write_bytes(preview_mp3)
        print(f"Saved audible preview: {preview_mp3_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
