import asyncio
import io
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware # type: ignore
from fastapi.responses import FileResponse, StreamingResponse
from pydub import AudioSegment
from pydantic import BaseModel

from llm import get_phonetics_batched
from parser import extract_text
from scanner import (
    apply_phonetics,
    find_proper_nouns,
    merge_into_lexicon,
    save_job_phonetics,
)
from tts import SAMPLE_RATE, get_pipeline, text_to_mp3


def log(job_id: str, msg: str) -> None:
    print(f"[{job_id[:8]}] {msg}", flush=True)


app = FastAPI(title="Ebook to Audiobook")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("uploads")
OUTPUT_DIR = Path("outputs")
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {".epub", ".txt"}

# In-memory job store: job_id -> dict
# Keys: status, progress, error, filename, words, phonetics, text, output_path
jobs: dict[str, dict] = {}


# ── Background: direct convert (no scan) ────────────────────────────────────

def _direct_convert(job_id: str, file_path: str) -> None:
    job = jobs[job_id]
    t_start = time.monotonic()
    try:
        job["status"] = "parsing"
        job["progress"] = 2
        log(job_id, "Parsing file…")

        text = extract_text(file_path)
        if not text.strip():
            raise ValueError("No readable text found in the uploaded file.")

        log(job_id, f"Parsed {len(text):,} chars. Starting TTS…")
        job["status"] = "converting"
        output_path = OUTPUT_DIR / f"{job_id}.mp3"
        last_pct = [0]

        def on_progress(pct: int) -> None:
            job["progress"] = pct
            if pct - last_pct[0] >= 10:
                log(job_id, f"TTS {pct}% ({time.monotonic() - t_start:.0f}s)")
                last_pct[0] = pct

        text_to_mp3(text, str(output_path), voice=job["voice"], engine=job.get("engine", "kokoro"), progress_callback=on_progress)

        job["status"] = "done"
        job["progress"] = 100
        job["output_path"] = str(output_path)
        log(job_id, f"Done in {time.monotonic() - t_start:.1f}s")

    except Exception as exc:
        log(job_id, f"ERROR: {exc}")
        job["status"] = "error"
        job["error"] = str(exc)
    finally:
        try:
            os.remove(file_path)
        except OSError:
            pass


# ── Background: scan (parse → detect words → LLM phonetics) ─────────────────

def _scan(job_id: str, file_path: str) -> None:
    job = jobs[job_id]
    try:
        job["status"] = "scanning"
        job["progress"] = 5
        log(job_id, "Parsing file…")

        text = extract_text(file_path)
        if not text.strip():
            raise ValueError("No readable text found in the uploaded file.")

        log(job_id, f"Parsed {len(text):,} chars. Finding proper nouns…")
        job["progress"] = 20

        words_with_counts = find_proper_nouns(text)
        word_list = [w for w, _ in words_with_counts]
        log(job_id, f"Found {len(word_list)} candidate proper nouns. Calling LLM…")
        job["progress"] = 40

        # Prime the TTS pipeline now — it will be needed immediately for preview
        # requests once the user reaches the review screen. Loading (~300 MB) in
        # a daemon thread lets it overlap with the LLM call below.
        threading.Thread(target=get_pipeline, daemon=True).start()

        phonetics: dict[str, str] = {}
        if word_list:
            try:
                phonetics = asyncio.run(get_phonetics_batched(word_list))
                log(job_id, f"LLM returned {len(phonetics)} phonetic mappings")
            except Exception as e:
                log(job_id, f"LLM call failed (continuing without phonetics): {e}")

        save_job_phonetics(job_id, word_list, phonetics)

        job["text"] = text          # held in memory until conversion starts
        job["words"] = [{"word": w, "count": n} for w, n in words_with_counts]
        job["phonetics"] = phonetics
        job["status"] = "awaiting_review"
        job["progress"] = 100
        log(job_id, "Scan complete — awaiting user review")

    except Exception as exc:
        log(job_id, f"ERROR during scan: {exc}")
        job["status"] = "error"
        job["error"] = str(exc)
    finally:
        try:
            os.remove(file_path)
        except OSError:
            pass


# ── Background: TTS conversion ───────────────────────────────────────────────

def _convert(job_id: str) -> None:
    job = jobs[job_id]
    t_start = time.monotonic()
    try:
        text: str = job.pop("text")             # free memory after grabbing
        approved: dict[str, str] = job.get("phonetics", {})

        job["status"] = "converting"
        job["progress"] = 5

        if approved:
            log(job_id, f"Applying {len(approved)} phonetic substitutions…")
            text = apply_phonetics(text, approved)
            merge_into_lexicon(approved)

        output_path = OUTPUT_DIR / f"{job_id}.mp3"
        last_pct = [0]

        def on_progress(pct: int) -> None:
            job["progress"] = pct
            if pct - last_pct[0] >= 10:
                log(job_id, f"TTS {pct}% ({time.monotonic() - t_start:.0f}s)")
                last_pct[0] = pct

        text_to_mp3(text, str(output_path), voice=job["voice"], engine=job.get("engine", "kokoro"), progress_callback=on_progress)

        job["status"] = "done"
        job["progress"] = 100
        job["output_path"] = str(output_path)
        log(job_id, f"Done in {time.monotonic() - t_start:.1f}s")

    except Exception as exc:
        log(job_id, f"ERROR during conversion: {exc}")
        job["status"] = "error"
        job["error"] = str(exc)


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/upload")
async def upload(file: UploadFile = File(...), scan: bool = True, voice: str = "af_heart", engine: str = "kokoro"):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "Only .epub and .txt files are supported.")

    job_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"{job_id}{suffix}"

    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    stem = Path(file.filename).stem
    jobs[job_id] = {
        "status": "queued",
        "progress": 0,
        "error": None,
        "filename": stem,
        "voice": voice,
        "engine": engine,
        "words": [],
        "phonetics": {},
        "text": None,
        "output_path": None,
    }
    log(job_id, f"Upload received — {file.filename} (scan={scan}, engine={engine})")

    if scan:
        threading.Thread(target=_scan, args=(job_id, str(file_path)), daemon=True).start()
    else:
        threading.Thread(target=_direct_convert, args=(job_id, str(file_path)), daemon=True).start()

    return {"job_id": job_id}


@app.get("/status/{job_id}")
async def status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found.")
    job = jobs[job_id]
    return {
        "status": job["status"],
        "progress": job["progress"],
        "error": job["error"],
        "words": job.get("words", []),
        "phonetics": job.get("phonetics", {}),
    }


class ApproveBody(BaseModel):
    phonetics: dict[str, str]   # original → phonetic (only words to substitute)


@app.post("/approve/{job_id}")
async def approve(job_id: str, body: ApproveBody):
    """Submit approved phonetics and start TTS conversion."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found.")
    job = jobs[job_id]
    if job["status"] != "awaiting_review":
        raise HTTPException(400, f"Job is not awaiting review (status: {job['status']}).")
    job["phonetics"] = body.phonetics
    threading.Thread(target=_convert, args=(job_id,), daemon=True).start()
    return {"ok": True}


class PreviewBody(BaseModel):
    text: str
    voice: str = "af_heart"
    engine: str = "kokoro"


@app.post("/preview")
def preview(body: PreviewBody):
    """Generate a short MP3 of a word or phonetic spelling for in-browser preview."""
    text = body.text.strip()[:200]
    if not text:
        raise HTTPException(400, "No text provided.")

    if body.engine == "orpheus":
        import orpheus_tts
        full_audio = orpheus_tts.generate_preview_audio(text, voice=body.voice)
        sample_rate = orpheus_tts.SAMPLE_RATE
    else:
        pipeline = get_pipeline()
        audio_arrays = []
        for _, _, audio in pipeline(text, voice=body.voice, speed=1.0):
            audio_arrays.append(audio)
        if not audio_arrays:
            raise HTTPException(500, "TTS produced no output.")
        full_audio = np.concatenate(audio_arrays)
        sample_rate = SAMPLE_RATE

    if full_audio.size == 0:
        raise HTTPException(500, "TTS produced no output.")

    wav_buf = io.BytesIO()
    sf.write(wav_buf, full_audio, sample_rate, format="WAV")
    wav_buf.seek(0)

    mp3_buf = io.BytesIO()
    AudioSegment.from_wav(wav_buf).export(mp3_buf, format="mp3", bitrate="128k")
    mp3_buf.seek(0)

    return StreamingResponse(mp3_buf, media_type="audio/mpeg")


@app.get("/download/{job_id}")
async def download(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found.")
    job = jobs[job_id]
    if job["status"] != "done":
        raise HTTPException(400, "Job is not complete yet.")
    output_path = job.get("output_path", "")
    if not output_path or not os.path.exists(output_path):
        raise HTTPException(404, "Output file missing.")
    return FileResponse(output_path, media_type="audio/mpeg", filename=f"{job['filename']}.mp3")
