# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

Converts EPUB and TXT ebooks into MP3 audiobooks using the [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS model. Python/FastAPI backend + minimal React/Vite frontend.

## Running the app

**Backend** (first time: installs model weights from HuggingFace on startup):
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```
Runs at `http://localhost:8000`.

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```
Runs at `http://localhost:5173`.

## System dependencies

- **ffmpeg** — required by `pydub` for MP3 encoding. Install via `winget install ffmpeg` or download from ffmpeg.org and add to PATH.
- **espeak-ng** — may be required by Kokoro's phonemizer on some systems. Install via `winget install eSpeak-NG`.

## Architecture

### Backend (`backend/`)

Three modules:

- **`main.py`** — FastAPI app. Handles file upload, spawns a background `threading.Thread` per job, tracks job state in an in-memory dict (`jobs`). Endpoints: `POST /upload`, `GET /status/{job_id}`, `GET /download/{job_id}`.
- **`parser.py`** — Extracts plain text from EPUB (via `ebooklib` + `BeautifulSoup`) or TXT files.
- **`tts.py`** — Wraps `kokoro.KPipeline`. Lazy-loads the pipeline singleton on first call (downloads ~300MB weights). Splits text into ~2000-char paragraph-aligned chunks, generates audio per chunk, concatenates with numpy, writes WAV in-memory, then exports MP3 via pydub.

**Job lifecycle:** `queued → parsing → converting (progress 5–90%) → done`

**No database** — jobs live only in memory; they disappear on server restart. Uploaded files are deleted immediately after processing; MP3 outputs persist in `backend/outputs/` until server restart.

### Frontend (`frontend/`)

Single-component React app (`src/App.jsx`). Polls `GET /status/{job_id}` every 1.5 seconds while a job is running and shows a progress bar. All styles are inline — no CSS framework.

## Key defaults

- Voice: `af_heart` (American English female)
- Speed: `1.0`
- MP3 bitrate: `128k`
- Audio sample rate: 24 000 Hz (Kokoro native)
