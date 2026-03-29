"""Orpheus TTS backend (canopylabs/orpheus-3b-0.1-ft).

Lazy-loads the model on first use (~7 GB download). Requires:
    pip install snac transformers torch
"""

import io
import re
from typing import Callable

import numpy as np
import soundfile as sf
import torch
from pydub import AudioSegment
from snac import SNAC
from transformers import AutoModelForCausalLM, AutoTokenizer

SAMPLE_RATE = 24000
ORPHEUS_VOICES = ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"]
MODEL_NAME = "canopylabs/orpheus-3b-0.1-ft"

_snac_model = None
_model = None
_tokenizer = None


def _get_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def get_models():
    global _snac_model, _model, _tokenizer
    if _model is None:
        device = _get_device()
        print(f"[orpheus] Loading SNAC model…")
        _snac_model = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to(device)

        print(f"[orpheus] Loading Orpheus-3B model to {device} (first run downloads ~7 GB)…")
        _model = AutoModelForCausalLM.from_pretrained(MODEL_NAME, torch_dtype=torch.bfloat16).to(device)
        _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
        print("[orpheus] Models ready.")
    return _snac_model, _model, _tokenizer


def _process_prompt(text: str, voice: str, tokenizer, device: str):
    prompt = f"{voice}: {text}"
    input_ids = tokenizer(prompt, return_tensors="pt").input_ids
    start_token = torch.tensor([[128259]], dtype=torch.int64)
    end_tokens = torch.tensor([[128009, 128260]], dtype=torch.int64)
    modified = torch.cat([start_token, input_ids, end_tokens], dim=1)
    attention_mask = torch.ones_like(modified)
    return modified.to(device), attention_mask.to(device)


def _parse_output(generated_ids) -> list[int]:
    token_to_find = 128257
    token_to_remove = 128258

    indices = (generated_ids == token_to_find).nonzero(as_tuple=True)
    if len(indices[1]) > 0:
        last_idx = indices[1][-1].item()
        cropped = generated_ids[:, last_idx + 1:]
    else:
        cropped = generated_ids

    row = cropped[0]
    row = row[row != token_to_remove]
    new_len = (row.size(0) // 7) * 7
    row = row[:new_len]
    return [t - 128266 for t in row.tolist()]


def _redistribute_codes(code_list: list[int], snac_model) -> np.ndarray:
    device = next(snac_model.parameters()).device
    layer_1, layer_2, layer_3 = [], [], []
    for i in range(len(code_list) // 7):
        layer_1.append(code_list[7 * i])
        layer_2.append(code_list[7 * i + 1] - 4096)
        layer_3.append(code_list[7 * i + 2] - 2 * 4096)
        layer_3.append(code_list[7 * i + 3] - 3 * 4096)
        layer_2.append(code_list[7 * i + 4] - 4 * 4096)
        layer_3.append(code_list[7 * i + 5] - 5 * 4096)
        layer_3.append(code_list[7 * i + 6] - 6 * 4096)

    codes = [
        torch.tensor(layer_1, device=device).unsqueeze(0),
        torch.tensor(layer_2, device=device).unsqueeze(0),
        torch.tensor(layer_3, device=device).unsqueeze(0),
    ]
    audio = snac_model.decode(codes)
    return audio.detach().squeeze().cpu().numpy()


def _split_chunks(text: str, chunk_size: int = 800) -> list[str]:
    """Split at sentence boundaries — Orpheus works best with moderate-length inputs."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for sent in sentences:
        if current_len + len(sent) > chunk_size and current:
            chunks.append(" ".join(current))
            current = [sent]
            current_len = len(sent)
        else:
            current.append(sent)
            current_len += len(sent)
    if current:
        chunks.append(" ".join(current))
    return chunks or [text]


def _generate_audio(text: str, voice: str, max_new_tokens: int = 4096) -> np.ndarray:
    snac_model, model, tokenizer = get_models()
    device = _get_device()

    input_ids, attention_mask = _process_prompt(text, voice, tokenizer, device)
    with torch.no_grad():
        generated_ids = model.generate(
            input_ids=input_ids,
            attention_mask=attention_mask,
            max_new_tokens=max_new_tokens,
            do_sample=True,
            temperature=0.6,
            top_p=0.95,
            repetition_penalty=1.1,
            num_return_sequences=1,
            eos_token_id=128258,
        )

    code_list = _parse_output(generated_ids)
    if not code_list:
        return np.array([], dtype=np.float32)
    return _redistribute_codes(code_list, snac_model)


def text_to_mp3(
    text: str,
    output_path: str,
    voice: str = "tara",
    speed: float = 1.0,
    progress_callback: Callable[[int], None] | None = None,
) -> None:
    if voice not in ORPHEUS_VOICES:
        voice = "tara"

    chunks = _split_chunks(text)
    total = len(chunks)
    audio_arrays: list[np.ndarray] = []

    for i, chunk in enumerate(chunks):
        if progress_callback:
            progress_callback(5 + int((i / total) * 85))
        audio = _generate_audio(chunk, voice)
        if audio.size > 0:
            audio_arrays.append(audio)

    if not audio_arrays:
        raise RuntimeError("Orpheus produced no audio output")

    full_audio = np.concatenate(audio_arrays)

    if progress_callback:
        progress_callback(90)

    wav_buf = io.BytesIO()
    sf.write(wav_buf, full_audio, SAMPLE_RATE, format="WAV")
    wav_buf.seek(0)
    AudioSegment.from_wav(wav_buf).export(output_path, format="mp3", bitrate="128k")

    if progress_callback:
        progress_callback(100)


def generate_preview_audio(text: str, voice: str = "tara") -> np.ndarray:
    if voice not in ORPHEUS_VOICES:
        voice = "tara"
    return _generate_audio(text[:300], voice, max_new_tokens=1200)
