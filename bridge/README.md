# bridge — editor → LFM

Turns an `LfmScene` exported by the editor (`window.airflow.exportLfm()`) into the
files the LFM solver reads. Pure numpy — **no GPU or CUDA needed**, so it runs on
any laptop; only running LFM itself needs the RTX 4090.

## Usage

```bash
# 1. In the editor (browser console), copy the scene JSON:
#    copy(JSON.stringify(window.airflow.exportLfm()))   # then paste into scene.json

python lfm_bridge.py scene.json -o lfm_case
```

Produces in `lfm_case/`:

| File | Consumed by | Status |
|------|-------------|--------|
| `config.json` | LFM `LFMConfiguration::Load` | ready |
| `solid_sdf.npy` | `SetBcByPhiAsync` (solid obstacles) | ready |
| `init_u_{x,y,z}.npy` | `StagConToTileAsync` (initial velocity, zeros) | ready |
| `bc_patches.json` | solver extension (inlets/outlets) | **pending** Yuchen's `is_bc`/`bc_val` work |

`config.json` + `solid_sdf.npy` + the init fields are enough to run a closed room
with solids and buoyancy **today**. The multiple inlet/outlet patches need the
solver extension Yuchen described (stamp `is_bc_{x,y,z}` / `bc_val_{x,y,z}`); until
then they're emitted as `bc_patches.json` (cell-index ranges + velocity vectors)
for that code to consume.

## To confirm with Yuchen

- **Flat array order.** `solid_sdf.npy` is saved C-contiguous over `(nx, ny, nz)`.
  LFM's `ReadNpy` loads a flat buffer that `ConToTile` re-tiles — confirm the
  expected ordering and flip `FLAT_ORDER` in `lfm_bridge.py` if it differs.
- **SDF vs. binary mask.** `SetBcByPhiAsync` takes a signed distance field; this
  writes a true SDF when `scipy` is installed, else a ±half-cell sign fallback.
  (Install `scipy` on the GPU box for the exact field.)

## Dependencies

```bash
pip install numpy        # required
pip install scipy        # optional — exact SDF instead of the sign fallback
```
