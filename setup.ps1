# setup.ps1 — one-time environment setup for AudiobookGenerator
# Run from the repo root: .\setup.ps1

$root = $PSScriptRoot
$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host "`n>> $msg" -ForegroundColor Cyan
}

# ── Python venv ──────────────────────────────────────────────────────────────
Write-Step "Checking Python..."
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host "ERROR: 'python' not found in PATH. Install Python 3.10+ and retry." -ForegroundColor Red
    exit 1
}
python --version

Write-Step "Creating virtual environment at .\venv ..."
if (-not (Test-Path "$root\venv")) {
    python -m venv "$root\venv"
} else {
    Write-Host "  venv already exists, skipping."
}

$pip = "$root\venv\Scripts\pip.exe"
$pythonExe = "$root\venv\Scripts\python.exe"

Write-Step "Installing Python dependencies from requirements.txt ..."
& $pip install --upgrade pip
& $pip install -r "$root\requirements.txt"

# ── PyTorch (CUDA 12.6) ───────────────────────────────────────────────────────
Write-Step "Installing PyTorch with CUDA 12.6 support ..."
Write-Host "  (This downloads ~2 GB — skip if already installed by pressing Ctrl+C within 5 seconds)"
Start-Sleep 5
& $pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126

# ── Node / npm ────────────────────────────────────────────────────────────────
Write-Step "Checking Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "ERROR: 'node' not found in PATH. Install Node.js 18+ from https://nodejs.org and retry." -ForegroundColor Red
    exit 1
}
node --version
npm --version

Write-Step "Installing frontend npm dependencies ..."
Push-Location "$root\frontend"
npm install
Pop-Location

# ── System dependencies reminder ─────────────────────────────────────────────
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Make sure these system tools are installed and on PATH:"
Write-Host "  ffmpeg    ->  winget install ffmpeg"
Write-Host "  espeak-ng ->  winget install eSpeak-NG"
Write-Host ""
Write-Host "To start the app, run:  .\start.ps1"
