"""Detect, run, and sample OpenFOAM for the accurate engine.

The web app exports a complete OpenFOAM case (a map of relative paths ->
contents). This module writes it to a run directory, executes the meshing +
``buoyantSimpleFoam`` pipeline, then samples the latest-time velocity and
temperature at the exact grid points the web viewer expects (so the result
drops straight into the existing 3D visualization).

OpenFOAM on Windows usually runs under WSL or Docker. Rather than guess, the
runner is configurable:

  OPENFOAM_RUN_CMD   A shell-command *prefix* used to execute commands inside a
                     sourced OpenFOAM environment. The case directory path is
                     made available; the runner appends ``cd <dir> && ./Allrun``.
                     Examples:
                       wsl -e bash -lc        (WSL with OpenFOAM in ~/.bashrc)
                       docker-openfoam        (a wrapper script you provide)

  OPENFOAM_CASES_DIR Where run directories are created (default: ./runs).

If neither a native ``blockMesh`` nor OPENFOAM_RUN_CMD is found, the caller
falls back to the mock engine.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

CASES_DIR = Path(os.environ.get("OPENFOAM_CASES_DIR", Path(__file__).parent / "runs"))


def detect_openfoam() -> dict[str, Any]:
    """Best-effort detection. Returns {available, mode, version, detail}."""
    run_cmd = os.environ.get("OPENFOAM_RUN_CMD")
    if run_cmd:
        ok, out = _try(f"{run_cmd} 'blockMesh -help'")
        version = _parse_version(out)
        return {
            "available": ok,
            "mode": "run_cmd",
            "version": version,
            "detail": run_cmd if ok else f"OPENFOAM_RUN_CMD set but probe failed: {out[:200]}",
        }
    native = shutil.which("blockMesh")
    if native:
        ok, out = _try("blockMesh -help")
        return {
            "available": True,
            "mode": "native",
            "version": _parse_version(out),
            "detail": native,
        }
    return {
        "available": False,
        "mode": "none",
        "version": None,
        "detail": "No blockMesh on PATH and OPENFOAM_RUN_CMD not set.",
    }


def _try(cmd: str) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=30
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode == 0, out
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def _parse_version(text: str) -> str | None:
    m = re.search(r"Version:?\s*([\w.+-]+)", text)
    return m.group(1) if m else None


def write_case(name: str, files: dict[str, str], points: list[list[float]]) -> Path:
    CASES_DIR.mkdir(parents=True, exist_ok=True)
    case_dir = CASES_DIR / f"{_safe(name)}-{int(time.time())}"
    for rel, content in files.items():
        target = case_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
    # Make Allrun/Allclean executable where it matters.
    for script in ("Allrun", "Allclean"):
        p = case_dir / script
        if p.exists():
            p.chmod(0o755)
    # Probes function object for sampling the exact viewer grid points.
    (case_dir / "system" / "probes").write_text(_probes_dict(points), encoding="utf-8", newline="\n")
    return case_dir


def run_case(case_dir: Path, mode: str) -> tuple[bool, str]:
    """Run ./Allrun then sample probes. Returns (ok, combined_log)."""
    run_cmd = os.environ.get("OPENFOAM_RUN_CMD")
    posix_dir = _posix_path(case_dir, mode)
    inner = (
        f"cd {shlex.quote(posix_dir)} && ./Allrun && "
        f"postProcess -func probes -latestTime"
    )
    if mode == "run_cmd" and run_cmd:
        cmd = f"{run_cmd} {shlex.quote(inner)}"
    else:
        cmd = f"bash -lc {shlex.quote(inner)}"
    try:
        proc = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=1800
        )
        log = (proc.stdout or "") + "\n" + (proc.stderr or "")
        return proc.returncode == 0, log
    except subprocess.TimeoutExpired:
        return False, "OpenFOAM run timed out after 30 min."
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def sample_probes(case_dir: Path, n_points: int) -> dict[str, list[float]] | None:
    """Parse postProcessing/probes/<time>/U and T into flat arrays."""
    base = case_dir / "postProcessing" / "probes"
    if not base.exists():
        return None
    times = sorted(base.iterdir(), key=lambda p: _as_float(p.name))
    if not times:
        return None
    latest = times[-1]
    u = _read_probe_vectors(latest / "U", n_points)
    t = _read_probe_scalars(latest / "T", n_points)
    if u is None:
        return None
    velocity: list[float] = []
    for vec in u:
        velocity.extend(vec)
    temperature = t if t is not None else [297.15] * n_points
    return {"velocity": velocity, "temperature": temperature}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _probes_dict(points: list[list[float]]) -> str:
    pts = "\n".join(f"        ({p[0]} {p[1]} {p[2]})" for p in points)
    return (
        "/*--------------------------------*- C++ -*----------------------------------*/\n"
        "FoamFile { version 2.0; format ascii; class dictionary; object probes; }\n"
        "type            probes;\n"
        'libs            ("libsampling.so");\n'
        "fields          ( U T );\n"
        "probeLocations\n(\n"
        f"{pts}\n"
        ");\n"
    )


def _read_probe_vectors(path: Path, n: int) -> list[list[float]] | None:
    if not path.exists():
        return None
    last = _last_data_line(path)
    if last is None:
        return None
    vecs = re.findall(r"\(([^)]*)\)", last)
    out: list[list[float]] = []
    for v in vecs:
        parts = v.split()
        if len(parts) >= 3:
            out.append([float(parts[0]), float(parts[1]), float(parts[2])])
    if len(out) < n:
        out.extend([[0.0, 0.0, 0.0]] * (n - len(out)))
    return out[:n]


def _read_probe_scalars(path: Path, n: int) -> list[float] | None:
    if not path.exists():
        return None
    last = _last_data_line(path)
    if last is None:
        return None
    parts = last.split()
    # column 0 is the time value; the rest are per-probe scalars.
    vals = [float(x) for x in parts[1:]]
    if len(vals) < n:
        vals.extend([297.15] * (n - len(vals)))
    return vals[:n]


def _last_data_line(path: Path) -> str | None:
    last = None
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            last = s
    return last


def _as_float(name: str) -> float:
    try:
        return float(name)
    except ValueError:
        return -1.0


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "-", name) or "case"


def _posix_path(case_dir: Path, mode: str) -> str:
    """Translate a Windows path to a POSIX/WSL path when running via run_cmd."""
    p = str(case_dir)
    if mode == "run_cmd" and re.match(r"^[A-Za-z]:", p):
        drive = p[0].lower()
        rest = p[2:].replace("\\", "/")
        return f"/mnt/{drive}{rest}"
    return p.replace("\\", "/")
