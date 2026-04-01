import asyncio
import io
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware # type: ignore
from fastapi.responses import FileResponse, StreamingResponse
from pydub import AudioSegment
from pydantic import BaseModel

from llm import get_phonetics_batched
from parser import extract_chapters
from scanner import (
    apply_phonetics,
    find_proper_nouns,
    find_proper_nouns_spacy,
    find_proper_nouns_stanza,
    find_unknown_words,
    load_lexicon,
    load_scan_cache,
    lookup_in_lexicon,
    lookup_alternatives_in_lexicon,
    merge_into_lexicon,
    save_book_approved,
    save_scan_cache,
    write_lexicon,
)
from tts import SAMPLE_RATE, get_pipeline, split_chunks, text_to_mp3


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
# Keys: status, progress, error, filename, file_type, voice, engine,
#       words, phonetics, text, chapters, per_chapter, output_path, output_type
jobs: dict[str, dict] = {}


# ── Background: parse only ───────────────────────────────────────────────────

def _parse_only(job_id: str, file_path: str) -> None:
    job = jobs[job_id]
    try:
        job["status"] = "parsing"
        job["progress"] = 2
        log(job_id, "Parsing file…")

        chapters = extract_chapters(file_path)

        if not chapters or not any(ch['text'].strip() for ch in chapters):
            raise ValueError("No readable text found in the uploaded file.")

        full_text = '\n\n'.join(ch['text'] for ch in chapters)
        job["chapters"] = chapters
        job["text"] = full_text
        job["status"] = "text_preview"
        job["progress"] = 100
        log(job_id, f"Parsed {len(full_text):,} chars, {len(chapters)} chapter(s)")

    except Exception as exc:
        log(job_id, f"ERROR during parsing: {exc}")
        job["status"] = "error"
        job["error"] = str(exc)
    finally:
        try:
            os.remove(file_path)
        except OSError:
            pass


# ── Background: scan for proper nouns (text already in job) ─────────────────

def _scan_from_job(job_id: str) -> None:
    job = jobs[job_id]
    try:
        job["status"] = "scanning"
        job["progress"] = 5

        text = job["text"]
        filename = job["filename"]
        if not text.strip():
            raise ValueError("No text to scan.")

        scan_method = job.get("scan_method", "regex")
        scan_unknown = job.get("scan_unknown", False)

        # Use cached word list if we've scanned this book before with the same method
        cached = load_scan_cache(filename, scan_method)
        if cached is not None:
            words_with_counts = cached
            log(job_id, f"Scan cache hit ({scan_method}) — {len(words_with_counts)} names loaded for '{filename}'")
        else:
            log(job_id, f"Parsed {len(text):,} chars. Finding proper nouns ({scan_method})…")
            job["progress"] = 20
            if scan_method == "spacy":
                words_with_counts = find_proper_nouns_spacy(text)
            elif scan_method == "stanza":
                words_with_counts = find_proper_nouns_stanza(text)
            else:
                words_with_counts = find_proper_nouns(text)
            save_scan_cache(filename, words_with_counts, scan_method)
            log(job_id, f"Found {len(words_with_counts)} candidate proper nouns — cached.")

        # Optional: also find non-dictionary words (neologisms, sci-fi terms, etc.)
        if scan_unknown:
            cached_unk = load_scan_cache(filename, "unknown")
            if cached_unk is not None:
                unknown_words = cached_unk
                log(job_id, f"Scan cache hit (unknown) — {len(unknown_words)} non-dictionary words for '{filename}'")
            else:
                log(job_id, "Finding non-dictionary words…")
                unknown_words = find_unknown_words(text)
                save_scan_cache(filename, unknown_words, "unknown")
                log(job_id, f"Found {len(unknown_words)} non-dictionary words — cached.")

            # Merge: deduplicate by lowercase, keep the word form with higher count
            merged: dict[str, tuple[str, int]] = {w.lower(): (w, c) for w, c in words_with_counts}
            for word, count in unknown_words:
                key = word.lower()
                if key not in merged or count > merged[key][1]:
                    merged[key] = (word, count)
            words_with_counts = sorted(merged.values(), key=lambda x: x[1], reverse=True)
            log(job_id, f"After merge: {len(words_with_counts)} total candidates.")

        word_list = [w for w, _ in words_with_counts]
        job["progress"] = 40

        # Prime the TTS pipeline now — overlaps with LLM call below
        threading.Thread(target=get_pipeline, daemon=True).start()

        voice: str = job["voice"]

        # Check master lexicon — skip LLM for words we already know (voice-aware)
        lexicon_hits = lookup_in_lexicon(word_list, voice)
        words_needing_llm = [w for w in word_list if w not in lexicon_hits]
        log(job_id, f"{len(lexicon_hits)} from lexicon, {len(words_needing_llm)} need LLM.")

        phonetics: dict[str, str] = dict(lexicon_hits)
        phonetic_sources: dict[str, str] = {w: "lexicon" for w in lexicon_hits}

        if words_needing_llm:
            try:
                llm_phonetics = asyncio.run(get_phonetics_batched(words_needing_llm))
                if llm_phonetics:
                    # Immediately persist new results to master lexicon so future books benefit
                    merge_into_lexicon(llm_phonetics, voice)
                    log(job_id, f"LLM returned {len(llm_phonetics)} phonetic mappings — merged into lexicon")
                phonetics.update(llm_phonetics)
                phonetic_sources.update({w: "llm" for w in llm_phonetics})
            except Exception as e:
                log(job_id, f"LLM call failed (continuing without phonetics): {e}")

        # Find words with no phonetic for this voice but alternatives from other voices
        words_without_phonetic = [w for w in word_list if w not in phonetics]
        phonetic_alternatives = lookup_alternatives_in_lexicon(words_without_phonetic, voice)

        job["words"] = [{"word": w, "count": n} for w, n in words_with_counts]
        job["phonetics"] = phonetics
        job["phonetic_sources"] = phonetic_sources
        job["phonetic_alternatives"] = phonetic_alternatives
        job["status"] = "awaiting_review"
        job["progress"] = 100
        log(job_id, "Scan complete — awaiting user review")

    except Exception as exc:
        log(job_id, f"ERROR during scan: {exc}")
        job["status"] = "error"
        job["error"] = str(exc)


# ── Background: TTS conversion ───────────────────────────────────────────────

def _convert(job_id: str) -> None:
    job = jobs[job_id]
    t_start = time.monotonic()
    try:
        chapters: list[dict] = job.pop("chapters", []) or []
        text: str = job.pop("text", "") or '\n\n'.join(ch['text'] for ch in chapters)
        approved: dict[str, str] = job.get("phonetics", {})
        per_chapter: bool = job.get("per_chapter", False)
        file_type: str = job.get("file_type", "txt")
        voice: str = job["voice"]
        engine: str = job.get("engine", "kokoro")
        filename: str = job["filename"]

        job["status"] = "converting"
        job["progress"] = 5

        # Apply phonetic substitutions
        if approved:
            log(job_id, f"Applying {len(approved)} phonetic substitutions…")
            if chapters:
                for ch in chapters:
                    ch['text'] = apply_phonetics(ch['text'], approved)
                text = '\n\n'.join(ch['text'] for ch in chapters)
            else:
                text = apply_phonetics(text, approved)
            merge_into_lexicon(approved, voice)
            save_book_approved(filename, approved)

            # Persist any manually-added words back into the scan cache so they
            # appear on the next review of this book.
            scan_method = job.get("scan_method", "regex")
            cached = load_scan_cache(filename, scan_method) or []
            cached_word_set = {w for w, _ in cached}
            new_entries = [(w, 1) for w in approved if w not in cached_word_set]
            if new_entries:
                save_scan_cache(filename, cached + new_entries, scan_method)
                log(job_id, f"Added {len(new_entries)} manually-added word(s) to scan cache.")

        # Metadata written into every output ZIP
        info_content = (
            f"Book: {filename}\n"
            f"Voice: {voice}\n"
            f"Engine: {engine}\n"
            f"Generated: {time.strftime('%Y-%m-%d')}\n"
        )

        use_chapters = file_type == "epub" and per_chapter and len(chapters) > 1

        if use_chapters:
            # ── Per-chapter output → ZIP ──────────────────────────────────────
            chapter_dir = OUTPUT_DIR / job_id
            chapter_dir.mkdir(exist_ok=True)
            total = len(chapters)

            for i, ch in enumerate(chapters):
                pct = 5 + int((i / total) * 85)
                job["progress"] = pct
                log(job_id, f"Converting chapter {i + 1}/{total}: {ch['title']}")

                safe_title = re.sub(r'[^\w\s-]', '', ch['title'])[:50].strip()
                safe_title = re.sub(r'\s+', '_', safe_title) or f"chapter_{i + 1:02d}"
                chapter_path = chapter_dir / f"{i + 1:02d}_{safe_title}.mp3"
                text_to_mp3(ch['text'], str(chapter_path), voice=voice, engine=engine)

            job["progress"] = 92
            zip_path = OUTPUT_DIR / f"{job_id}.zip"
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                for mp3_file in sorted(chapter_dir.glob("*.mp3")):
                    zf.write(mp3_file, mp3_file.name)
                zf.writestr("audiobook_info.txt", info_content)

            # Clean up per-chapter directory now that we have the zip
            shutil.rmtree(chapter_dir, ignore_errors=True)

            job["status"] = "done"
            job["progress"] = 100
            job["output_path"] = str(zip_path)
            job["output_type"] = "zip"
            job["output_filename"] = f"{filename}_chapters.zip"
            log(job_id, f"Done ({total} chapters → ZIP) in {time.monotonic() - t_start:.1f}s")

        else:
            # ── Single MP3 → ZIP with metadata ───────────────────────────────
            mp3_path = OUTPUT_DIR / f"{job_id}.mp3"
            last_pct = [0]

            def on_progress(pct: int) -> None:
                job["progress"] = pct
                if pct - last_pct[0] >= 10:
                    log(job_id, f"TTS {pct}% ({time.monotonic() - t_start:.0f}s)")
                    last_pct[0] = pct

            text_to_mp3(text, str(mp3_path), voice=voice, engine=engine, progress_callback=on_progress)

            job["progress"] = 97
            zip_path = OUTPUT_DIR / f"{job_id}.zip"
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                zf.write(mp3_path, f"{filename}.mp3")
                zf.writestr("audiobook_info.txt", info_content)
            mp3_path.unlink(missing_ok=True)

            job["status"] = "done"
            job["progress"] = 100
            job["output_path"] = str(zip_path)
            job["output_type"] = "zip"
            job["output_filename"] = f"{filename}.zip"
            log(job_id, f"Done in {time.monotonic() - t_start:.1f}s")

    except Exception as exc:
        log(job_id, f"ERROR during conversion: {exc}")
        job["status"] = "error"
        job["error"] = str(exc)


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/upload")
async def upload(file: UploadFile = File(...), voice: str = "af_heart", engine: str = "kokoro"):
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
        "file_type": suffix.lstrip("."),   # "epub" or "txt"
        "voice": voice,
        "engine": engine,
        "words": [],
        "phonetics": {},
        "phonetic_alternatives": {},
        "text": None,
        "chapters": [],
        "per_chapter": False,
        "output_path": None,
        "output_type": "mp3",
    }
    log(job_id, f"Upload received — {file.filename} (engine={engine})")

    threading.Thread(target=_parse_only, args=(job_id, str(file_path)), daemon=True).start()
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
        "phonetic_sources": job.get("phonetic_sources", {}),
        "phonetic_alternatives": job.get("phonetic_alternatives", {}),
        "file_type": job.get("file_type", "txt"),
        "chapter_count": len(job.get("chapters", [])),
        "output_type": job.get("output_type", "zip"),
        "per_chapter": job.get("per_chapter", False),
        "output_filename": job.get("output_filename", ""),
    }


@app.get("/text/{job_id}")
async def get_text(job_id: str):
    """Return the parsed text and chapter list for user editing."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found.")
    job = jobs[job_id]
    if job["status"] not in ("text_preview", "scanning", "awaiting_review"):
        raise HTTPException(400, f"Text not available for status: {job['status']}.")
    return {
        "text": job.get("text", ""),
        "chapters": job.get("chapters", []),
        "file_type": job.get("file_type", "txt"),
    }


class UpdateChaptersBody(BaseModel):
    chapters: list[dict]   # [{title: str, text: str}]
    per_chapter: bool = False
    scan_method: str = "regex"   # "regex", "spacy", or "stanza"
    scan_unknown: bool = False   # also scan for non-dictionary words


@app.post("/scan/{job_id}")
async def start_scan(job_id: str, body: UpdateChaptersBody):
    """Update chapters from user edits then start scanning for proper nouns."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found.")
    job = jobs[job_id]
    if job["status"] != "text_preview":
        raise HTTPException(400, f"Job is not in text_preview status (status: {job['status']}).")

    job["chapters"] = body.chapters
    job["text"] = '\n\n'.join(ch['text'] for ch in body.chapters)
    job["per_chapter"] = body.per_chapter
    job["scan_method"] = body.scan_method
    job["scan_unknown"] = body.scan_unknown

    threading.Thread(target=_scan_from_job, args=(job_id,), daemon=True).start()
    return {"ok": True}


@app.post("/convert/{job_id}")
async def start_convert(job_id: str, body: UpdateChaptersBody):
    """Update chapters from user edits then start TTS conversion directly."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found.")
    job = jobs[job_id]
    if job["status"] not in ("text_preview",):
        raise HTTPException(400, f"Job is not in text_preview status (status: {job['status']}).")

    job["chapters"] = body.chapters
    job["text"] = '\n\n'.join(ch['text'] for ch in body.chapters)
    job["per_chapter"] = body.per_chapter

    threading.Thread(target=_convert, args=(job_id,), daemon=True).start()
    return {"ok": True}


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


# ── Lexicon endpoints ────────────────────────────────────────────────────────

@app.get("/lexicon")
async def get_lexicon_entries():
    """Return the full global phonetic lexicon."""
    return load_lexicon()


class LexiconEntryBody(BaseModel):
    word: str
    phonetic: str
    voice: str = "_global"


@app.put("/lexicon")
async def upsert_lexicon_entry(body: LexiconEntryBody):
    """Add or update a single voice-scoped entry in the lexicon."""
    word = body.word.strip()
    phonetic = body.phonetic.strip()
    voice = body.voice.strip() or "_global"
    if not word:
        raise HTTPException(400, "Word cannot be empty.")
    lexicon = load_lexicon()
    if word not in lexicon:
        lexicon[word] = {}
    lexicon[word][voice] = phonetic
    write_lexicon(lexicon)
    return {"ok": True}


@app.delete("/lexicon/{word:path}")
async def delete_lexicon_entry(word: str, voice: str | None = None):
    """Remove a word (all voices) or a single voice entry from the lexicon."""
    lexicon = load_lexicon()
    if word not in lexicon:
        raise HTTPException(404, f"'{word}' not in lexicon.")
    if voice:
        if voice not in lexicon[word]:
            raise HTTPException(404, f"'{word}' has no entry for voice '{voice}'.")
        del lexicon[word][voice]
        if not lexicon[word]:   # remove word entirely if no voices left
            del lexicon[word]
    else:
        del lexicon[word]
    write_lexicon(lexicon)
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


class SampleBody(BaseModel):
    text: str
    voice: str = "af_heart"
    engine: str = "kokoro"


@app.post("/sample")
def generate_sample(body: SampleBody):
    """Generate an MP3 sample of up to ~4000 chars (≈5 pages) for previewing the book."""
    # Cap Orpheus lower since it's slower
    char_limit = 1500 if body.engine == "orpheus" else 4000
    text = body.text.strip()[:char_limit]
    if not text:
        raise HTTPException(400, "No text provided.")

    if body.engine == "orpheus":
        import orpheus_tts
        full_audio = orpheus_tts.generate_preview_audio(text, voice=body.voice)
        sample_rate = orpheus_tts.SAMPLE_RATE
    else:
        pipeline = get_pipeline()
        chunks = split_chunks(text)
        audio_arrays = []
        for chunk in chunks:
            for _, _, audio in pipeline(chunk, voice=body.voice, speed=1.0):
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

    if job.get("output_type") == "zip":
        fname = job.get("output_filename") or f"{job['filename']}.zip"
        return FileResponse(output_path, media_type="application/zip", filename=fname)
    return FileResponse(output_path, media_type="audio/mpeg", filename=f"{job['filename']}.mp3")
