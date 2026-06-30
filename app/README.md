# Living Room Airflow Designer

Living Room Airflow Designer is a React, TypeScript, and Three.js prototype for exploring indoor airflow in a furnished living room. The scene includes editable furniture, a standing fan, a wall-mounted air conditioner, and an exhaust vent. A low-resolution CPU-based 3D Stable Fluids solver drives velocity, dye, temperature, humidity, PM2.5, CO2, and noise fields, which are visualized as 3D streamlines, particles, floor heatmaps, transparent slices, and directional overlays.

The goal is fast interactive layout exploration, not engineering-grade CFD.

## Quick Start

```bash
npm install
npm run dev
```

The local development URL is usually:

```text
http://127.0.0.1:5173/
```

Build the app:

```bash
npm run build
```

Run validation checks:

```bash
npm run check:scene-graph
npm run check:zones
npm run check:zone-metrics
npm run check:headless
npm run check:intent
npm run check:sketch
npm run check:optimizer
npm run check:phase5
npm run check:phase6
npm run lint
```

## LLM Configuration

The intent parser can call a local Vite route that keeps the OpenAI API key on the server side. Copy `.env.example` to `.env.local` and configure:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.5
ROOMDESIG_LLM_MOCK=0
```

For local workflow testing without a live model call:

```text
ROOMDESIG_LLM_MOCK=1
```

If the model route is unavailable, the app falls back to a narrow deterministic parser for common airflow requests.

## Current UI

### Main 3D Scene

The main viewport renders an editable 3D living room. The room currently includes:

- Sofa
- Coffee table
- TV console and TV
- Side table
- Baby crib
- Seated person
- Sleeping baby
- Rug
- Plant
- Floor lamp
- Standing fan
- Wall air conditioner
- Exhaust vent

Walls are semi-transparent so the full scene and airflow can be inspected from outside the room.

### Camera And View Controls

The top toolbar provides:

- `Iso`, `Top`, `Front`, and `Fit` camera views
- Move and rotate tools for the selected object
- Flow map visibility toggle
- Particle and streamline visualization modes
- Comfort preset reset
- Control panel collapse and expand

Object rotation is intentionally restricted to horizontal yaw. This keeps furniture and devices upright while still allowing layout direction changes.

### Object Selection And Editing

Click an editable 3D object to select it. The selected object gets a blue wireframe highlight:

- The horizontal outline shows the obstacle footprint projected into the solver grid.
- The vertical outline shows the approximate 3D occupied volume.

Move mode allows horizontal placement edits. Rotate mode allows horizontal yaw edits. Moving or rotating furniture updates the solver obstacle mask.

### Right Control Panel

The right panel is organized into four tabs:

- `Intent`: natural-language requests, intent echo, goal feedback, and intent presets
- `Scene`: plan sketch, display detail, scalar overlay, selected object readout, flow legend, and asset summary
- `Devices`: airflow presets and equipment controls
- `Project`: JSON save/load and research log export

This keeps frequent tasks visible without forcing one long scrolling settings panel.

## Devices

The app currently supports three airflow devices.

### Standing Fan

The standing fan is the primary airflow source. It injects velocity and dye into the 3D Stable Fluids field. It also contributes to temperature, humidity, PM2.5, CO2, and noise scalar transport.

Controls:

- Enable or disable
- Speed
- Auto sweep

Auto sweep continuously updates the fan yaw, similar to a real oscillating fan. Manual fan rotation disables auto sweep to avoid conflicting controls.

### Wall Air Conditioner

The wall AC injects cool supply air from the rear wall. It influences the velocity field and the temperature, humidity, and noise scalar fields.

Controls:

- Enable or disable
- Speed

### Exhaust Vent

The exhaust vent pulls stale air toward the wall outlet. It is used to reduce local CO2 and PM2.5 while also contributing to the noise field.

Controls:

- Enable or disable
- Speed

## Scalar Overlay And Heatmaps

The `Scalar overlay` section can display:

- Airflow
- Temperature
- Humidity
- PM2.5
- CO2
- Noise

`Airflow` uses the solver dye field. Other scalar modes use dynamic heatmap visualization generated from the current 3D scalar volume.

Scalar heatmap modes include height slices:

- `Avg`: vertical average
- `Floor`: low-level slice
- `Seated`: seated breathing-zone slice
- `Standing`: standing breathing-zone slice
- `Ceiling`: upper-room slice

Color ramps:

- Temperature: blue, white, red
- Humidity: light gray, blue
- PM2.5, CO2, and noise: green, yellow, red

Scalar heatmaps use dynamic min/max normalization per field so local changes are visible. In scalar mode, the velocity line overlay is hidden and obstacle overlay opacity is reduced so the heatmap becomes the main visual layer.

## Flow Visualization

The app provides two 3D airflow visualizations.

### Streamlines

Streamlines are the default mode. Seeds are generated near the fan and AC outlet, then advanced through the 3D velocity sampler.

### Particles

Particles are instanced spheres that also sample the same 3D velocity field. They make height changes and recirculation easier to perceive.

The `Lines` slider controls streamline density. The `Flow map` button toggles the floor and transparent-slice overlays.

## Plan Sketch

The `Plan sketch` tool is a 2D top-down blueprint panel for spatial intent input. It is separate from the main 3D canvas, so sketching does not interfere with object selection or transform controls.

Supported sketch modes:

- `Point`: mark one location
- `Circle`: draw a circular target or protection area
- `Box`: draw a rectangular region
- `Arrow`: draw a directional hint
- `Draw`: freehand sketch input

Supported height bands:

- `Floor`
- `Seated`
- `Standing`
- `Crib low`

Sketches are converted into room coordinates and can be bound to requests such as:

```text
keep this area out of direct draft
cool this area slightly
```

For point sketches, the app tries to resolve the clicked location to a named room zone. For region sketches, the app creates a region target using the sketch geometry. Freehand drawings are converted to a bounded sketch region.

## Intent Workflow

The `Intent` tab includes a chat-style input for airflow goals. Example requests:

```text
Cool the sofa area slightly
Do not blow air onto the baby
Purge stale air after cooking
After sketching: keep this area out of direct draft
```

The workflow is:

1. `parseAirflowIntents()` converts text into an `IntentParseResult`.
2. `bindSketchToIntent()` links deictic phrases such as "this area" to the latest sketch mark.
3. `reduceIntentSession()` stores turns, active intent entries, sketch bindings, and user actions.
4. `mapIntentsToDeviceConfig()` maps active intents to device speeds, fan direction, and auto-sweep state.
5. The scene shows grounded intent highlights in 3D.

Intent echo cards support:

- Accept
- Adjust
- Undo

Undo removes that active intent and recalculates the device configuration from the remaining intents.

## Goal Feedback

Goal feedback compares active intents against current per-zone metrics. It reports whether goals are currently being met, such as:

- Direct draft avoidance
- Cooling progress
- CO2 reduction
- PM2.5 reduction
- Noise reduction

This is a deterministic prototype feedback layer. It is useful for UI iteration and scenario comparison, but it is not a calibrated comfort or air-quality model.

## Solver Overview

The current solver is a low-resolution 3D Stable Fluids prototype implemented with CPU typed arrays.

Default interactive grid:

```text
width: 32
height: 24
layers: 14
```

Solver room dimensions:

```text
roomWidth: 9.8
roomDepth: 7.2
roomHeight: 2.8
```

Each simulation step roughly does:

1. Inject fan, AC, and vent velocity sources.
2. Inject scalar sources for temperature, humidity, PM2.5, CO2, and noise.
3. Apply vorticity confinement, buoyancy, and scalar-driven forces.
4. Apply simplified obstacle boundary behavior.
5. Run pressure projection to reduce divergence.
6. Semi-Lagrangian advect velocity, dye, and scalar fields.
7. Build 2D projections and keep the full 3D volume for samplers and metrics.

The solver is intentionally small and responsive enough for interactive UI iteration.

## Scalar Fields

`StableFluidSnapshot` contains both 2D and 3D scalar data:

```ts
scalarFields: Record<ScalarFieldKey, Uint8ClampedArray>
volumeScalars: Record<ScalarFieldKey, Float32Array>
```

`scalarFields` is a projected texture format. `volumeScalars` is the actual 3D scalar volume used for:

- Zone metrics
- Heatmap slice generation
- Future sensor probes
- Potential particle coloring

Current scalar fields:

```ts
type ScalarFieldKey = 'temperature' | 'humidity' | 'pm25' | 'co2' | 'noise'
```

The scalar values are normalized prototype values, not real-world units.

## Obstacles

Furniture is simplified into rotated box footprints for the solver. The app does not voxelize the visible mesh geometry. Instead, each object has an obstacle footprint with width, depth, and height.

`buildFlowLayout()` reads the current object transforms and passes obstacle data into the solver. The solver rasterizes those boxes into a 3D solid-cell mask. Solid cells are skipped by metric readers and damped by the velocity solver.

This approach is fast enough for interactive layout editing and gives useful first-order blockage behavior.

## Project Persistence

The `Project` tab can:

- Save the current room airflow project as JSON
- Load a saved JSON project
- Export a research log JSON

Saved project data includes:

- Device state
- Current preset
- Object transforms
- Sketch primitives
- Intent session
- Intent mapper mode

## Main Code Structure

```text
src/App.tsx
src/App.css
src/state/
src/hooks/
src/ui/
src/sketch/
src/scene/
src/solver/
src/intent/
src/llm/
src/viz/
src/stableFluidSolver.ts
server/
public/models/*.glb
```

Important modules:

- `src/App.tsx`: top-level app state, toolbar, right panel, Canvas entry point
- `src/hooks/useStableFluidAirflow.ts`: React hook connecting the UI to the solver
- `src/stableFluidSolver.ts`: CPU 3D Stable Fluids solver
- `src/state/flowLayout.ts`: converts object transforms into solver layout data
- `src/scene/RoomShell.tsx`: room shell, walls, scalar heatmap overlays, obstacle and velocity overlays
- `src/scene/AirflowScene.tsx`: assembles room, furniture, devices, highlights, particles, and streamlines
- `src/scene/sceneGraph.ts`: semantic source of truth for room objects, labels, aliases, transforms, and footprints
- `src/scene/zones.ts`: named room zones and zone-grid lookup
- `src/sketch/PlanCanvas.tsx`: 2D blueprint sketch UI
- `src/sketch/primitives.ts`: sketch geometry types and coordinate conversion
- `src/intent/parse.ts`: LLM-backed and fallback intent parsing
- `src/intent/bind.ts`: links sketch regions to text intents
- `src/intent/session.ts`: multi-turn intent session reducer
- `src/intent/heuristicMapper.ts`: maps intents to device settings and fan direction
- `src/solver/zoneMetrics.ts`: reads per-zone airflow and scalar metrics
- `src/solver/headlessEvaluate.ts`: non-React headless evaluation entry point
- `src/viz/StableFluidStreamlines.tsx`: streamline visualization
- `src/viz/StableFluidParticles.tsx`: particle visualization

## GLB Assets

The app uses local GLB assets first and keeps primitive fallbacks for resilience.

Current model paths:

```text
public/models/sofa.glb
public/models/coffee-table.glb
public/models/media-console.glb
public/models/side-table.glb
public/models/crib.glb
public/models/plant.glb
public/models/lamp.glb
public/models/fan-body.glb
```

Future higher-quality furniture assets can replace these files as long as the approximate scale and local origin remain compatible.

## Known Limitations

- The solver is a low-resolution CPU prototype, not high-fidelity CFD.
- Furniture collision uses box footprints, not mesh-level voxelization.
- Wall and furniture boundary conditions are simplified.
- Scalar fields are normalized prototype values, not calibrated units.
- Comfort and goal feedback are simplified deterministic estimates.
- GLB assets are local prototype assets, not a full photorealistic furniture library.
- Auto sweep is driven by React state updates and is sufficient for prototype interaction, not maximum simulation throughput.

## Possible Next Steps

- Move the solver to WebGPU compute for higher grid resolution.
- Add sensor probes with real units for temperature, humidity, PM2.5, CO2, and noise.
- Improve obstacle masks with signed distance fields or mesh voxelization.
- Add editable room dimensions and furniture dimensions.
- Add multiple fans, multiple vents, and additional HVAC devices.
- Add particle coloring by scalar values.
- Add export to an external high-fidelity solver such as WaterLily, OpenFOAM, or FluidX3D.
