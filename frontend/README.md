# frontend — interactive 3D room editor

A 3D analogue of SketchFluid's Fig. 11: a room with movable objects (furniture, supply/return vents). The room layout is fixed; object placement and supply-air config are what the user changes.

## Requirements

- **Interactive editing** — select and move objects with the mouse.
- **Programmatic API** — a function call to translate/transform an object in the scene (so the intent layer and scripts can drive it too). Both paths must converge on the same scene-graph mutation.
- Moving an object updates the **boundary conditions** handed to the simulator.

## Open decisions

- Web (Three.js / React-three-fiber) vs. native (the simulator's own Vulkan renderer). The LFM simulator ships a Vulkan volumetric renderer; weigh embedding the editor there vs. a web UI that drives LFM as a backend.
- Reference: Prof. Zhu's computer-graphics assignment on translating objects in a scene (link pending).

_TODO: choose stack and scaffold._
