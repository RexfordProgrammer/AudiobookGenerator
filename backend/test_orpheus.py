"""Quick tester for Orpheus TTS.

Usage:
    # Set your HuggingFace token first:
    export HF_TOKEN=hf_...

    # Test all voices with a short sentence:
    python test_orpheus.py

    # Test a specific voice:
    python test_orpheus.py --voice tara

    # Custom text:
    python test_orpheus.py --text "Hello, this is a test." --voice leo

    # Output directory (default: ./orpheus_test_output):
    python test_orpheus.py --out ./my_output
"""

import argparse
import os
import sys
import time
from pathlib import Path

# Ensure backend package is on path when run directly
sys.path.insert(0, str(Path(__file__).parent))

# Load .env from project root before anything else
_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

DEFAULT_TEXT = (
    "Hello! This is a test of the Orpheus text-to-speech system. "
    "The quick brown fox jumps over the lazy dog."
)


def test_voice(voice: str, text: str, out_dir: Path) -> bool:
    from orpheus_tts import generate_preview_audio, SAMPLE_RATE
    import soundfile as sf

    print(f"\n--- Testing voice: {voice} ---")
    start = time.time()
    try:
        audio = generate_preview_audio(text, voice=voice)
        elapsed = time.time() - start
        if audio.size == 0:
            print(f"  FAIL: got empty audio array")
            return False

        duration = audio.size / SAMPLE_RATE
        out_path = out_dir / f"orpheus_{voice}.wav"
        sf.write(str(out_path), audio, SAMPLE_RATE)
        print(f"  OK  : {duration:.1f}s audio in {elapsed:.1f}s -> {out_path}")
        return True
    except Exception as e:
        elapsed = time.time() - start
        print(f"  FAIL ({elapsed:.1f}s): {e}")
        return False


def check_token() -> bool:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not token:
        print("ERROR: HF_TOKEN environment variable is not set.")
        print("  Set it with:  export HF_TOKEN=hf_...")
        print("  (Get your token at https://huggingface.co/settings/tokens)")
        return False
    masked = token[:8] + "..." + token[-4:] if len(token) > 12 else "***"
    print(f"HF_TOKEN found: {masked}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Test Orpheus TTS voices")
    parser.add_argument("--voice", help="Single voice to test (default: all voices)")
    parser.add_argument("--text", default=DEFAULT_TEXT, help="Text to synthesize")
    parser.add_argument("--out", default="./orpheus_test_output", help="Output directory")
    args = parser.parse_args()

    if not check_token():
        sys.exit(1)

    from orpheus_tts import ORPHEUS_VOICES

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Output directory: {out_dir.resolve()}")
    print(f"Text: {args.text[:80]}{'...' if len(args.text) > 80 else ''}")

    voices = [args.voice] if args.voice else ORPHEUS_VOICES
    if args.voice and args.voice not in ORPHEUS_VOICES:
        print(f"WARNING: '{args.voice}' is not a known voice. Known voices: {ORPHEUS_VOICES}")

    results = {}
    for voice in voices:
        results[voice] = test_voice(voice, args.text, out_dir)

    print("\n=== Summary ===")
    passed = sum(results.values())
    for voice, ok in results.items():
        status = "PASS" if ok else "FAIL"
        print(f"  {status}  {voice}")
    print(f"\n{passed}/{len(results)} voices passed.")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
