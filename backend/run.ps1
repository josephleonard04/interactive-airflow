# One-command start for the OpenFOAM backend (accurate engine).
# Creates the venv + installs deps on first run, then launches the server.
#
#   cd backend ; .\run.ps1
#
# To enable real OpenFOAM (after installing it under WSL), set this first:
#   $env:OPENFOAM_RUN_CMD = "wsl -e bash -lc"

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    python -m venv .venv
    & ".\.venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
}

# Sync dependencies on EVERY run, not just when creating the venv. Installing
# only at creation time meant a dependency added later (e.g. anthropic, for the
# plain-language goal parser) was silently missing for anyone whose venv already
# existed — the server started fine and the feature just never worked. pip is a
# no-op in a second or two when everything is already satisfied.
& ".\.venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt

if ($env:ANTHROPIC_API_KEY) {
    Write-Host "Plain-language goal parsing: enabled." -ForegroundColor Green
} else {
    Write-Host "Plain-language goal parsing: off (no ANTHROPIC_API_KEY)." -ForegroundColor Yellow
    Write-Host "  The keyword parser still works; only free-form wording is unavailable." -ForegroundColor DarkGray
}

if ($env:OPENFOAM_RUN_CMD) {
    Write-Host "OpenFOAM run command: $env:OPENFOAM_RUN_CMD" -ForegroundColor Green
} else {
    Write-Host "OpenFOAM not configured - runs return an approximate preview." -ForegroundColor Yellow
    Write-Host "  (set OPENFOAM_RUN_CMD to enable real CFD; see docs/openfoam-engine.md)" -ForegroundColor DarkGray
}

Write-Host "Starting backend on http://127.0.0.1:8000 ..." -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8000
