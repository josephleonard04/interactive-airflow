# simulator — real-time GPU fluid integration (LFM)

Bridges the room editor to **LFM**, Yuchen Sun's real-time GPU fluid simulator (CUDA + Vulkan volumetric renderer): https://github.com/yuchen-sun-cg/lfm

Per advisor direction, **do not use OpenFOAM** for the interactive loop — it's too slow. LFM provides the real-time flow field.

## Responsibilities

- Translate the editor's scene (room + object placements + supply/return vents) into the simulator's **boundary conditions / solid masks**.
- Step the simulation and surface the velocity / temperature / concentration fields back for visualization.
- Re-derive boundary conditions when an object moves (the central interaction).

## Open decisions

- **Integration shape:** clone LFM as a git **submodule** vs. a local checkout under `simulator/lfm/` (currently gitignored). Decide once the code is in hand.
- **Build:** CUDA + Vulkan toolchain on Windows — confirm GPU/driver/SDK prerequisites.
- **Coupling:** embed our editor in LFM's Vulkan renderer, or run LFM as a backend that a separate UI drives.

## Access

Granted by Yuchen Sun (Prof. Zhu's group). Ask Yuchen about build prerequisites and the boundary-condition / solid-object API.

_TODO: obtain build, get it running, document prerequisites here._
