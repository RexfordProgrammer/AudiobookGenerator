import io
from typing import Callable

import numpy as np
import soundfile as sf
import torch
from kokoro import KPipeline
from pydub import AudioSegment

SAMPLE_RATE = 24000
_pipeline: KPipeline | None = None


def _get_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def get_pipeline() -> KPipeline:
    global _pipeline
    if _pipeline is None:
        device = _get_device()
        print(f"[tts] Using device: {device}")
        # lang_code='a' = American English; downloads model weights on first run
        _pipeline = KPipeline(lang_code="a", device=device)
    return _pipeline


def split_chunks(text: str, chunk_size: int = 2000) -> list[str]:
    """Split text into chunks at paragraph boundaries."""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for para in paragraphs:
        if current_len + len(para) > chunk_size and current:
            chunks.append("\n\n".join(current))
            current = [para]
            current_len = len(para)
        else:
            current.append(para)
            current_len += len(para)

    if current:
        chunks.append("\n\n".join(current))

    return chunks or [text]


def text_to_mp3(
    text: str,
    output_path: str,
    voice: str = "af_heart",
    speed: float = 1.0,
    progress_callback: Callable[[int], None] | None = None,
    engine: str = "kokoro",
) -> None:
    if engine == "orpheus":
        import orpheus_tts
        orpheus_tts.text_to_mp3(text, output_path, voice=voice, speed=speed, progress_callback=progress_callback)
        return

    pipeline = get_pipeline()
    chunks = split_chunks(text)
    total = len(chunks)
    audio_arrays: list[np.ndarray] = []

    for i, chunk in enumerate(chunks):
        if progress_callback:
            # Reserve 5–90% for TTS generation
            progress_callback(5 + int((i / total) * 85))

        for _, _, audio in pipeline(chunk, voice=voice, speed=speed):
            audio_arrays.append(audio)

    if not audio_arrays:
        raise RuntimeError("Kokoro produced no audio output")

    full_audio = np.concatenate(audio_arrays)

    if progress_callback:
        progress_callback(90)

    # Write to in-memory WAV buffer, then export as MP3 via pydub
    wav_buf = io.BytesIO()
    sf.write(wav_buf, full_audio, SAMPLE_RATE, format="WAV")
    wav_buf.seek(0)

    segment = AudioSegment.from_wav(wav_buf)
    segment.export(output_path, format="mp3", bitrate="128k")

    if progress_callback:
        progress_callback(100)
