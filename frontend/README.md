# frontend — home airflow designer

A homeowner-friendly 3D home designer: enter your home's size, get a furnished
layout (living room, bedroom, kitchen, bathroom), then drag furniture, edit
walls, and add/remove objects. Built with Vite + React + TypeScript +
[react-three-fiber](https://docs.pmnd.rs/react-three-fiber) / Three.js, state in
[zustand](https://github.com/pmndrs/zustand).

## Run

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

Everything runs in the browser — the Euler solver, the goal checking and the
placement search are all client-side. There is no server to stand up.

## Giving it to someone else

Two ways, neither of which asks them to install anything.

**A link — the one that keeps working.** `.github/workflows/pages.yml` rebuilds
the app from `main` and publishes it to GitHub Pages on every push, so the URL is
always current and no machine of yours has to be awake. It needs enabling once:
**Settings → Pages → Source: GitHub Actions**. After that the app lives at
`https://<user>.github.io/<repo>/`.

To build it yourself instead:

```bash
npm run build          # -> dist/
```

`dist/` is a plain static site — drop it on Netlify, Vercel, anything. `base` is
relative, so a project page served from `/repo-name/` works as-is.

**One file**, for someone who would rather not follow a link:

```bash
npm run build:single   # -> dist-single/interactive-airflow.html
```

A single ~1.5 MB HTML file with the stylesheet and the whole bundle inlined;
nothing else is fetched. Small enough to email, and it needs no network at all.

Verified served over http. Opening it straight off disk (`file://`) has not been
verified — the bundle is handed to the browser through a Blob URL and browsers
treat local files as an opaque origin — so open it once yourself before sending
it that way.

Either way the goal parser works, because there is nothing behind it to be
missing: `intent/objectives.ts` is a dictionary that runs in the page, with no
network call and no key. A single-file build understands exactly what the
deployed app understands.

## Collecting sessions

**Submit** scores the task one last time, seals the log, and downloads it as
JSON, naming the file on screen. That is the delivery mechanism: these sessions
are run with a facilitator on a call or in the room, who asks for the file at the
end. Nothing opens by itself — a mail client launching over the top of the study
is a surprise, and it replaces a person's clear instruction with a guess at one.

The report is also kept in `localStorage` under `airflow-last-session`, so a
participant who closes the tab has not taken the session with them.

One optional build-time setting adds to that. Put it in `frontend/.env.local`,
which is gitignored:

```dotenv
# POST the same report here as well, so the participant need do nothing at all.
VITE_LOG_ENDPOINT=https://…
```

There is no longer a researcher address in the bundle. The panel used to offer
"Email it" (a mail draft the participant then had to attach the file to by hand)
and "Copy" (a multi-megabyte JSON blob on the clipboard); both are gone. Three
ways to send one file is three chances to send it wrong, and an address that is
not compiled in cannot be scraped off the published page.

The report is built for analysis rather than for reading. Every event carries:

- **`method`** — `manual`, `text`, `sketch`, `solution` or `system`. RQ2 asks how
  people combine typing, drawing and direct manipulation; this is the field that
  answers it, and the log used to have no such field at all.
- **the whole layout after the event** — every item's position, heading, tilt,
  power, on/off and sweep, plus every opening. Any step can be scored, diffed or
  re-simulated on its own. It used to record deltas, and several events were
  written *before* the state they described, so replaying to reconstruct step 40
  silently diverged.
- **simulator readings whenever the value moves**, not only when a tick-box
  flips — otherwise ten minutes of moving a fan leaves one line in the log.

Typed sentences are logged verbatim together with how they were parsed, before
anything is done with them. A search logs what it was asked, what it was allowed
to touch, and every card it offered with that card's full layout and predicted
numbers — so an accepted suggestion can be compared against the ones passed over.
A drawn mark logs the pen, the shape and the whole pad. The file itself carries a
schema version, per-method counts, the task's goals and thresholds, and the
starting and final layouts.

## The four study tasks

The setup screen leads with them. Each is a prebuilt home, a fixed set of
controls, and one or two checkable goals chosen to pull against each other — see
[`src/floorplan/scenarios.ts`](src/floorplan/scenarios.ts), where every threshold
is recorded next to the sweep that produced it.

| Task | Home | Movable | Goals |
|---|---|---|---|
| Temperature (winter) | Single-bedroom home, freezing outside | heater (living room only), fan | both rooms comfortable, and no cold pool at the glass |
| Kitchen smell | Studio, hot summer day | fan; either window | keep the kitchen smell off the bed |
| Humidity | Bathroom, warm | extract vent; the window | dry the bathroom out fast after a shower |
| AC blowing on the bed | Single-bedroom apartment, hot summer day | AC louvre (tilt only), fan, bedroom door | no strong draft on the bed **and** both rooms cool everywhere |

Each goal is a threshold the solver checks. The participant is shown the goal;
the number behind it, and the sweep that set it, stay in `scenarios.ts`.

A task's `tools` decide what the participant may touch, and the placement search
is held to exactly the same list: it will not relocate a bolted vent, turn a
wall-mounted unit sideways, carry the winter heater out of the living room, or
switch off a device whose power dial the task hides. That last one was a real
bug — a card that switched the fan off on a locked task left it dead for the rest
of the session, because the on/off control is inside the hidden power block.

## Free play

1. **Setup screen** — pick a start mode, then enter Length × Width × Height in
   **meters or feet**:
   - **Example layout** — a fully furnished living room / bedroom / kitchen /
     bathroom (with the entrance into the living room and windows on exterior
     walls), placed door- and window-aware so nothing blocks an opening.
   - **Start from scratch** — just the outer walls + an entry door; you add the
     interior walls and furniture yourself.
2. The bathroom comes with sink, toilet, and bathtub; the bedroom has a standing
   floor fan; the living room has a wall AC, heater, and ceiling supply vent.

## Editing (drag-first, for non-experts)

Everything is on a **0.25 m grid** so things line up easily.

- **Undo / redo**: panel buttons, or **Ctrl/Cmd+Z** / **Ctrl+Shift+Z**. A drag is
  a single undo step.
- **Move**: click an item and **drag it across the floor**. Floor items stay on a
  grid and **inside one room** (can't straddle a wall) and **can't overlap** each
  other; **wall items (TV/AC) stay on the wall** and can slide sideways *and* up/
  down — they never float in mid-air.
- **Rotate**: floor items get a **free 0–360° dial** (good for aiming a fan)
  plus **R** / a 90° button. A quarter-turn changes the footprint, so a turn that
  would push an item through a wall slides it clear instead, and refuses if there
  is nowhere to go. **Wall-mounted items do not turn at all** — a television and
  a split AC are bolted flat, and which way they face is decided by the wall they
  are on; drag one to another wall and it re-faces itself. An AC's *vertical*
  louvre is a separate control and is offered where a task makes it adjustable.
- **Add / remove**: palette to add (furniture, bathroom, heating/cooling/air);
  select + Delete / ✕ / "Remove" to remove.
- **Walls**: "Add wall" shows the **grid as dots** — click a **start** dot, then
  an **end** dot, with a live preview between them. Click an existing wall +
  Delete to open up a room.
- **Doors & windows**: click a wall, then "Add door" / "Add window". Click one to
  **open/close** or remove it. Doors swing open; windows just go **clear** when
  open (glass when closed). Open openings let air through in the BC export.
- **Resize / restart**: "Change size" reopens the setup screen.

## Code map

```
floorplan/
  types.ts      FloorPlan, RoomDef, WallSeg, Opening, PlacedItem, OccupancyGrid, HomeSize
  home.ts       generateHome({length,width,height}) → the single 4-room home
  geometry.ts   walls from rooms, shared-edge detection, opening carving, wall render pieces
  raster.ts     rasterize rooms → labeled cell grid (room hierarchy for the solver)
  catalog.ts    item specs + add-palette
  palette.ts    room / item colors
components/
  SetupScreen.tsx   dimension entry (m / ft)
  Editor.tsx        Canvas, OrbitControls, drag-to-move, wall-draw, delete keys
  FloorPlanView.tsx color-coded room floors (no on-floor labels) + walls
  WallMesh.tsx      wall as boxes carved around doors/windows; selectable
  ItemMesh.tsx      a placed item: model + click target + selection outline
  models.tsx        composite furniture models (bed, desk, closet, couch, tv, …)
  Panel.tsx         home size, edit tools, add palette, room/object browser, save
scene/
  store.ts      zustand store (plan, selection, drag, edit mode, edit actions)
  sceneApi.ts   window.airflow programmatic control surface
bc/
  exportBoundaryConditions.ts   plan → solver-neutral JSON (room grid + geometry + flows)
  lfm.ts                        plan → LFM-ready scene (grid domain + solids + flux-balanced inlets/outlets)
```

## The two control paths (advisor requirement)

Both mutate the same store, so they never disagree:

1. **Mouse** — select + drag furniture, draw/delete walls, add/remove from the panel.
2. **Programmatic** — `window.airflow`:

   ```js
   airflow.generate({ length: 9, width: 7, height: 2.7 })
   airflow.list(); airflow.find("bed")
   airflow.add("couch", [2, 0, 2]); airflow.remove("tv-1")
   airflow.addWall([1, 1], [3, 1])
   airflow.translate("bed-1", [0.5, 0, 0])   // = change a boundary condition
   airflow.exportBoundaryConditions()        // solver-neutral geometry
   airflow.exportLfm()                       // LFM-ready scene + flux balance
   ```

## The simulator seam

Two exports off the same plan:

- `exportBoundaryConditions()` — solver-neutral geometry (room-label grid,
  wall/door/window geometry, furniture solids, HVAC flow patches). Stable seam.
- `exportLfm()` — compiles the home into an **LFM-ready scene** ([`bc/lfm.ts`](src/bc/lfm.ts)):
  maps the metric room onto LFM's grid (`tile_dim`×8 cells, `dx = len_y/(8·tile_dim.y)`),
  turns walls + closed openings + furniture into solid boxes, and turns vents/AC +
  open exterior windows/doors into **flux-balanced** inlet/outlet velocity patches
  (total inflow = total outflow, since LFM is incompressible). Moving an item
  re-derives all of it.

Feed the `exportLfm()` JSON to [`../bridge/lfm_bridge.py`](../bridge/README.md)
on the GPU machine to produce the `config.json`, `solid_sdf.npy`, and initial
fields LFM ingests. Confirmed APIs with Yuchen Sun (2026-06); the multi-patch
boundary conditions need the solver extension he described.

## Not done yet

- Furniture is axis-aligned in the BC export (`rotationY` is rendered but the BC
  uses axis-aligned bounding boxes).
- Live coupling to LFM (currently exports JSON; needs the GPU machine).
- Flow-field visualization overlay.
