#!/usr/bin/env python3
"""Turn an editor LfmScene (JSON) into LFM solver inputs.

The browser editor emits an `LfmScene` (see frontend/src/bc/lfm.ts): a metric
description of the room — domain grid, solid boxes, and flux-balanced inlet /
outlet patches. This script rasterises that into the files LFM's init path reads
(simulator/lfm/src/lfm/lfm_init.cu):

  config.json          the LFMConfiguration block, with the *_path fields filled
  solid_sdf.npy        signed distance field (negative inside solids)  -> SetBcByPhi
  init_u_x/y/z.npy     initial velocity (zeros)                        -> StagConToTile
  bc_patches.json      the inlet/outlet velocity patches               -> solver extension

Notes
-----
* solid_sdf + init velocity + config are everything LFM needs *today* to run a
  closed room with solids and buoyancy. The multiple inlet/outlet patches need
  the solver extension Yuchen described (write is_bc_{x,y,z} / bc_val_{x,y,z});
  until that lands they are emitted as bc_patches.json for that code to consume.
* No GPU and no CUDA needed — pure numpy, so this is testable on any laptop.
* Grid memory order: numpy array is (nx, ny, nz), saved C-contiguous. LFM's
  ReadNpy loads a flat buffer then ConToTile re-tiles it; confirm the expected
  flat ordering with Yuchen and flip FLAT_ORDER below if needed.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

FLAT_ORDER = "C"  # numpy C order: index = ((x)*ny + y)*nz + z. Confirm vs LFM.


def _grid_index(world, origin, dx):
    """World point -> fractional grid index (x, y, z)."""
    return tuple((world[i] - origin[i]) / dx for i in range(3))


def _box_to_cells(box, origin, dx, dims):
    """Inclusive cell-index ranges covered by a world-space box, clamped to grid."""
    lo = _grid_index(box["min"], origin, dx)
    hi = _grid_index(box["max"], origin, dx)
    out = []
    for i in range(3):
        a = max(0, int(math.floor(lo[i])))
        b = min(dims[i] - 1, int(math.ceil(hi[i])) - 1)
        out.append((a, b))
    return out  # [(x0,x1),(y0,y1),(z0,z1)]


def build_occupancy(scene) -> np.ndarray:
    """Boolean solid mask on the (nx, ny, nz) grid from the solid boxes."""
    dom = scene["domain"]
    nx, ny, nz = dom["gridDim"]
    dx = dom["dx"]
    origin = dom["gridOrigin"]
    occ = np.zeros((nx, ny, nz), dtype=bool)
    for s in scene["solids"]:
        (x0, x1), (y0, y1), (z0, z1) = _box_to_cells(s["world"], origin, dx, (nx, ny, nz))
        if x0 <= x1 and y0 <= y1 and z0 <= z1:
            occ[x0 : x1 + 1, y0 : y1 + 1, z0 : z1 + 1] = True
    return occ


def signed_distance(occ: np.ndarray, dx: float) -> np.ndarray:
    """Signed distance field in metres: negative inside solids, positive outside.

    Uses scipy's exact EDT when available, else a cheap ±half-cell fallback that
    is enough for LFM's SetBcByPhi (it only needs the sign / a thin band)."""
    try:
        from scipy.ndimage import distance_transform_edt

        outside = distance_transform_edt(~occ) * dx
        inside = distance_transform_edt(occ) * dx
        sdf = outside - inside
        # shift so the interface sits at 0 (cell-centre convention)
        return (sdf - 0.5 * dx).astype(np.float32)
    except Exception:
        print("  [warn] scipy not found — using coarse ±half-cell SDF fallback", file=sys.stderr)
        sdf = np.where(occ, -0.5 * dx, 0.5 * dx)
        return sdf.astype(np.float32)


def write_fields(scene, outdir: Path) -> dict:
    dom = scene["domain"]
    nx, ny, nz = dom["gridDim"]
    dx = dom["dx"]

    occ = build_occupancy(scene)
    sdf = signed_distance(occ, dx)
    np.save(outdir / "solid_sdf.npy", np.ascontiguousarray(sdf.ravel(order=FLAT_ORDER)))

    # zero initial velocity on the staggered MAC grid (faces have +1 along axis)
    np.save(outdir / "init_u_x.npy", np.zeros(((nx + 1) * ny * nz,), dtype=np.float32))
    np.save(outdir / "init_u_y.npy", np.zeros((nx * (ny + 1) * nz,), dtype=np.float32))
    np.save(outdir / "init_u_z.npy", np.zeros((nx * ny * (nz + 1),), dtype=np.float32))

    solid_cells = int(occ.sum())
    return {"solid_cells": solid_cells, "total_cells": nx * ny * nz}


def write_config(scene, outdir: Path) -> None:
    c = dict(scene["lfmConfig"])
    c["init_u_x_path"] = str((outdir / "init_u_x.npy").as_posix())
    c["init_u_y_path"] = str((outdir / "init_u_y.npy").as_posix())
    c["init_u_z_path"] = str((outdir / "init_u_z.npy").as_posix())
    c["init_smoke_path_prefix"] = str((outdir / "init_smoke").as_posix())
    c["solid_sdf_path"] = str((outdir / "solid_sdf.npy").as_posix())
    (outdir / "config.json").write_text(json.dumps({"lfm": c}, indent=2))


def write_bc_patches(scene, outdir: Path) -> None:
    """The inlet/outlet velocity patches, in grid-cell index space, for the
    solver extension to stamp into is_bc_{x,y,z} / bc_val_{x,y,z}."""
    dom = scene["domain"]
    origin, dx, dims = dom["gridOrigin"], dom["dx"], dom["gridDim"]
    patches = []
    for p in scene["inlets"] + scene["outlets"]:
        (x0, x1), (y0, y1), (z0, z1) = _box_to_cells(p["world"], origin, dx, dims)
        patches.append(
            {
                "id": p["id"],
                "role": p["role"],
                "cell_lo": [x0, y0, z0],
                "cell_hi": [x1, y1, z1],
                "normal": p["normal"],
                "velocity": p["velocity"],
            }
        )
    (outdir / "bc_patches.json").write_text(
        json.dumps({"balance": scene["balance"], "patches": patches}, indent=2)
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Compile an editor LfmScene into LFM inputs.")
    ap.add_argument("scene", help="path to the LfmScene JSON exported by the editor")
    ap.add_argument("-o", "--outdir", default="lfm_case", help="output directory")
    args = ap.parse_args()

    scene = json.loads(Path(args.scene).read_text())
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    bal = scene["balance"]
    if not bal["balanced"]:
        print(f"  [warn] flux not balanced: {bal.get('note', '')}", file=sys.stderr)

    stats = write_fields(scene, outdir)
    write_config(scene, outdir)
    write_bc_patches(scene, outdir)

    dom = scene["domain"]
    print(f"wrote {outdir}/  grid {dom['gridDim']} @ {dom['dx']:.3f} m")
    print(f"  solids: {len(scene['solids'])} boxes -> {stats['solid_cells']}/{stats['total_cells']} solid cells")
    print(f"  inlets {len(scene['inlets'])} / outlets {len(scene['outlets'])}  "
          f"(in {bal['inflow']:.3f} = out {bal['outflow']:.3f} m³/s, balanced={bal['balanced']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
