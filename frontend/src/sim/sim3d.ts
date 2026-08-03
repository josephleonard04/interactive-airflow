import { compileLfmScene, openingBox, type Box } from "../bc/lfm";
import { WALL_THICKNESS } from "../floorplan/geometry";
import type { FloorPlan, Opening, PlacedItem, Rect } from "../floorplan/types";
import { Euler3D } from "./euler3d";

// Voxelise the editor's home into a full 3D Euler simulation:
//   - walls + furniture            -> solids (furniture only blocks its real height)
//   - AC / supply vent             -> ducted inflow boundary + directed jet
//                                     (AC blows horizontally; a ceiling vent blows down)
//   - fan                          -> two-sided momentum jet (recirculating indoor air)
//   - open exterior windows/doors  -> free boundary cells (air leaves/enters)
//   - heater (hot) / AC (cold)     -> temperature sources; buoyancy lifts warm air
//   - a chosen room                -> contaminant source (full height)
//
// Coarsened to stay real-time in single-thread JS.

export interface Sim3DOptions {
  targetCells?: number;
  iterations?: number;
  /** |indoor − outdoor| in K, driving stack exchange through open windows and
   *  exterior doors. Bigger difference, stronger natural ventilation. */
  openingDriveDT?: number;
}

/** Outward normal of an exterior opening (points away from the room). */
function outwardNormalOf(plan: FloorPlan, o: Opening): [number, number, number] {
  const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3;
  const mid = vertical ? [o.a[0], (o.a[1] + o.b[1]) / 2] : [(o.a[0] + o.b[0]) / 2, o.a[1]];
  const inAnyRoom = (x: number, z: number) =>
    plan.rooms.some(
      (r) => x > r.rect.x + 1e-3 && x < r.rect.x + r.rect.w - 1e-3 && z > r.rect.z + 1e-3 && z < r.rect.z + r.rect.d - 1e-3,
    );
  if (vertical) return inAnyRoom(mid[0] + 0.1, mid[1]) ? [-1, 0, 0] : [1, 0, 0];
  return inAnyRoom(mid[0], mid[1] + 0.1) ? [0, 0, -1] : [0, 0, 1];
}

/** Fix the face of cell (i,j,k) on the `dir` side to carry `speed` along dir. */
function setFaceInto(
  sim: Euler3D,
  i: number,
  j: number,
  k: number,
  dir: [number, number, number],
  speed: number,
): void {
  if (dir[0] !== 0) {
    const f = dir[0] > 0 ? sim.uIdx(i, j, k) : sim.uIdx(i + 1, j, k);
    sim.uFixed[f] = 1;
    sim.uVal[f] = dir[0] * speed;
  } else if (dir[1] !== 0) {
    const f = dir[1] > 0 ? sim.vIdx(i, j, k) : sim.vIdx(i, j + 1, k);
    sim.vFixed[f] = 1;
    sim.vVal[f] = dir[1] * speed;
  } else {
    const f = dir[2] > 0 ? sim.wIdx(i, j, k) : sim.wIdx(i, j, k + 1);
    sim.wFixed[f] = 1;
    sim.wVal[f] = dir[2] * speed;
  }
}

/** The fidelity every REPORTED temperature is computed at — the numbers on the
 *  solution cards and the numbers in the goal verdict. They must be the same
 *  fidelity or the tool promises one temperature and then reports another. */
export const REPORT_FIDELITY = { targetCells: 4200, iterations: 8, steps: 22 };

export interface Sim3D {
  sim: Euler3D;
  nx: number;
  ny: number;
  nz: number;
  dx: number;
  origin: [number, number, number];
  worldToCell: (wx: number, wy: number, wz: number) => [number, number, number];
  cellCenter: (i: number, j: number, k: number) => [number, number, number];
  setSource: (rect: Rect | null) => void;
  /** Exterior-opening cells (open windows/doors) — sinks for BOTH temp and smell
   *  (heat and odour both leave the house here). */
  ambient: Uint8Array;
  /** Inflow-vent cells (AC / supply) — sink for SMELL ONLY: they blow clean air so
   *  odour reads low near them, but they must NOT drain temperature (an AC vent is
   *  cold, a supply vent neutral — zeroing heat here stops warm air from spreading). */
  ventDilute: Uint8Array;
  hasTemperature: boolean;
  /** 1 where the cell centre is INSIDE a room and below the roof. The solver
   *  domain is padded past the exterior walls, so air that leaves through an
   *  open window lands in cells that are outdoors — legitimate for the physics,
   *  but they must not be drawn: the tool visualizes the home, not the garden. */
  inside: Uint8Array;
  /** Index into plan.rooms for each cell, or -1 outside every room. Drives the
   *  per-room temperature readout. */
  roomIndex: Int16Array;
  /** Room ids in roomIndex order. */
  roomIds: string[];
  /** Points just in front of vents/AC/fans — where to seed airflow particles. */
  seeds: Array<[number, number, number]>;
  /** Carried through from the build options so geodesicFields — which is handed
   *  only the built sim — can honour the task's own tuning. */
  windowReach: number;
  ventSpread: number;
  sealedHalo: boolean;
  /** Is any exterior window or door actually open?
   *
   *  NOT the same as "are there ambient cells", which is what this used to be
   *  inferred from: an extract vent registers as an outlet, so its own cells are
   *  ambient too and the test came back true for a sealed room with a fan in it.
   *  Read from the plan's openings, where the question is actually answerable. */
  hasOpenExterior: boolean;
  /** Points just in front of EXHAUST vents (returns) — where air leaves. Kept
   *  separate from `seeds` because particles must not SPAWN at an extract (that
   *  would read as the exhaust blowing); streamlines seed here and trace
   *  upstream, which is what draws air visibly converging into the vent. */
  sinks: Array<[number, number, number]>;
  /** Cells at the GLASS of an exterior window. Glazing is the weak point in a
   *  wall: in winter its inner surface sits far below room temperature, so it
   *  chills the air touching it, that air sinks, and a cold draught pools under
   *  the window. Closed windows used to be plain wall — thermally inert — which
   *  made "the cold pours in through the window" untrue and made where a window
   *  sits irrelevant to a heating task. */
  glass: number[];
  /** Heat (red) / cold (blue) source locations, to anchor the temperature view. */
  markers: Array<{ pos: [number, number, number]; kind: "hot" | "cold" }>;
}

const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Nearest non-solid cell to (i,j,k), searched in expanding shells. Returns the
 *  cell index, or -1 if the whole neighbourhood is solid. */
function nearestFreeCell(
  sim: Euler3D,
  nx: number,
  ny: number,
  nz: number,
  i0: number,
  j0: number,
  k0: number,
): number {
  for (let r = 0; r <= 4; r++) {
    for (let dj = -r; dj <= r; dj++)
      for (let dk = -r; dk <= r; dk++)
        for (let di = -r; di <= r; di++) {
          // shell only: skip the interior already covered by a smaller r
          if (r > 0 && Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
          const i = i0 + di, j = j0 + dj, k = k0 + dk;
          if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
          const c = sim.cIdx(i, j, k);
          if (!sim.solid[c]) return c;
        }
  }
  return -1;
}
const clampf = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Heating and cooling are NOT symmetric, because the job is not symmetric: a
// winter heater lifts a room from ~2 °C to ~20 °C (+18 K), while a summer AC
// pulls 33 °C down to ~26 °C (−7 K). They were both ±10, which made every
// heating task literally unwinnable — with the heater at maximum the living
// room only reached 12.5 °C and the far bedroom 8.4 °C against a "≥ 18 °C"
// goal, because ±10 is the delta AT THE SOURCE and the room mean is well under
// it. The heater is sized so a room containing it settles around 20–22 °C at
// 2 °C outdoors; the AC is unchanged, since it was already landing correctly.
const HEATER_T = 19;
const AC_T = -10;
/** HOT WATER IS A HEAT SOURCE, and in a bathroom it is the only one.
 *
 *  Only the AC and the heater used to warm or cool anything, so the humidity
 *  task had no temperature field at all: the steam was a contaminant with no
 *  warmth behind it, air never rose off the shower, and the Airflow view —
 *  which colours every streamline by the temperature of the air it carries —
 *  drew the whole room one flat shade. The one thing that makes a bathroom
 *  behave like a bathroom, that the wet end is warm and the glazing is not so
 *  the air turns over between them, was invisible.
 *
 *  Kelvin above the room, and deliberately modest: this is a gentle convective
 *  turnover, not a radiator against one wall. The plume is the vapour itself,
 *  so it is the strongest; then the shower running; then a bath standing full. */
const WET_T: Record<string, number> = { damp: 9, shower: 6, bathtub: 4 };
const POWER: Record<number, number> = { 1: 0.5, 2: 1.0, 3: 1.6 };
/** The heater's OWN power curve, kept separate from POWER because POWER also
 *  scales the AC, the fan thrust and vent flux — raising it globally would have
 *  quietly made the summer cooling task easier too. On the shared curve, the
 *  heater's "medium" was half of high and left the living room at 14.6 °C, which
 *  is not what medium on a real heater does: medium is the everyday setting that
 *  holds a room comfortable, and high is the extra push for a cold snap. */
const HEATER_POWER: Record<number, number> = { 1: 0.85, 2: 1.3, 3: 1.75 };
/** Temperature of a window's inner glass surface, as a delta from outdoor. Glass
 *  is the coldest surface in a heated room in winter: it sits a few degrees ABOVE
 *  the outside air (the pane is not the outdoors) but far below the room, so the
 *  air against it is chilled and sinks. That downdraught is the whole reason
 *  radiators are traditionally put under windows. Slightly below outdoor here so
 *  it registers as a cold source for the buoyancy step; the REPORTED temperature
 *  never dips under outdoor, because geodesicFields treats glass as a heat-loss
 *  surface (attenuating toward outdoor) rather than as a cold source. */
const GLASS_DT = -4;
/** Fan thrust as an acceleration on the air in its cells (m/s²). Tuned so a
 *  medium fan settles at roughly 1 m/s in front of it in open air — about what
 *  a domestic pedestal fan does — while still being able to stall when it has
 *  nowhere to push. */
const FAN_FORCE = 26;

export function buildSim3D(plan: FloorPlan, opts: Sim3DOptions = {}): Sim3D {
  const scene = compileLfmScene(plan);
  const g = scene.domain.gridDim;
  let nx = g[0];
  let ny = g[1]; // vertical
  let nz = g[2];
  let dx = scene.domain.dx;
  const target = opts.targetCells ?? 27000; // ~18k cells: accurate yet real-time
  if (nx * ny * nz > target) {
    const f = Math.ceil(Math.cbrt((nx * ny * nz) / target));
    nx = Math.ceil(nx / f);
    ny = Math.ceil(ny / f);
    nz = Math.ceil(nz / f);
    dx = scene.domain.dx * f;
  }
  const origin = scene.domain.gridOrigin as [number, number, number];

  const sim = new Euler3D({ nx, ny, nz, dx, iterations: opts.iterations ?? 40 });

  const worldToCell = (wx: number, wy: number, wz: number): [number, number, number] => [
    clampi(Math.floor((wx - origin[0]) / dx), 0, nx - 1),
    clampi(Math.floor((wy - origin[1]) / dx), 0, ny - 1),
    clampi(Math.floor((wz - origin[2]) / dx), 0, nz - 1),
  ];
  const cellCenter = (i: number, j: number, k: number): [number, number, number] => [
    origin[0] + (i + 0.5) * dx,
    origin[1] + (j + 0.5) * dx,
    origin[2] + (k + 0.5) * dx,
  ];
  const cellsOf = (b: Box): Array<[number, number, number]> => {
    const [i0, j0, k0] = worldToCell(b.min[0], b.min[1], b.min[2]);
    const [i1, j1, k1] = worldToCell(b.max[0], b.max[1], b.max[2]);
    const out: Array<[number, number, number]> = [];
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push([i, j, k]);
    return out;
  };

  for (const s of scene.solids) for (const [i, j, k] of cellsOf(s.world)) sim.solid[sim.cIdx(i, j, k)] = 1;

  // An OPEN opening is a hole, and it must stay a hole. Carve every open door
  // and window back out after the solids are stamped.
  //
  // Without this the door's own swung leaf could seal the doorway it belongs to.
  // A leaf is ~0.9 m long; on the coarse grid the optimizer and the goal verdict
  // run at (dx = 0.4 m) that is ~2 cells, and it lands directly in front of a
  // doorway that is itself only 2 cells wide — so the one open cell led straight
  // into the leaf and the rooms were disconnected. Rooms beyond an open door
  // then read as completely unreachable: no airflow, and a temperature of
  // exactly the outdoor value however the doors were set.
  //
  // The leaf is still solid everywhere it actually stands, which is beside the
  // doorway; it just cannot plug the gap it swings out of.
  for (const o of [...plan.doors, ...plan.windows]) {
    if (!o.open) continue;
    for (const [i, j, k] of cellsOf(openingBox(o, WALL_THICKNESS))) sim.solid[sim.cIdx(i, j, k)] = 0;
  }

  // solid ceiling at the roof line so air stays inside the house (no escaping
  // above the roof; warm air pools under the ceiling, which is correct)
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (origin[1] + (j + 0.5) * dx > plan.wallHeight) sim.solid[sim.cIdx(i, j, k)] = 1;
      }

  // Inside-the-home mask + per-room labels, from the room rectangles.
  const roomIds = plan.rooms.map((r) => r.id);
  const inside = new Uint8Array(nx * ny * nz);
  const roomIndex = new Int16Array(nx * ny * nz).fill(-1);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const [wx, wy, wz] = cellCenter(i, j, k);
        if (wy > plan.wallHeight) continue;
        const ri = plan.rooms.findIndex(
          (r) => wx >= r.rect.x && wx <= r.rect.x + r.rect.w && wz >= r.rect.z && wz <= r.rect.z + r.rect.d,
        );
        if (ri < 0) continue;
        const c = sim.cIdx(i, j, k);
        inside[c] = 1;
        roomIndex[c] = ri;
      }

  const hasOpenExterior = [...plan.doors, ...plan.windows].some((o) => o.open && o.rooms.includes("outside"));
  const ambient = new Uint8Array(nx * ny * nz);
  const ventDilute = new Uint8Array(nx * ny * nz);
  for (const p of scene.outlets)
    for (const [i, j, k] of cellsOf(p.world)) {
      const c = sim.cIdx(i, j, k);
      sim.solid[c] = 0;
      sim.open[c] = 1;
      ambient[c] = 1; // exterior opening = sink for both temperature and smell
    }

  // A REAL WINDOW EXCHANGES AIR BOTH WAYS AT ONCE.
  //
  // Openings used to be single-signed outlets with nothing driving them, so an
  // open window on its own produced exactly 0.0000 m/s — it could only ever let
  // out air that something else had pushed in. That is why every task collapsed
  // onto a door or a vent: the window was never a lever.
  //
  // Warm air leaves through the top of an opening and cool air enters through
  // the bottom, with a neutral plane in between (the stack effect), plus
  // turbulent exchange from wind. So: drive INFLOW across the lower half of each
  // open exterior opening and leave the upper half as the free boundary it
  // already is. One window now ventilates by itself, two windows on opposite
  // walls set up a through-draught, and two close together exchange mostly with
  // each other and barely sweep the room — which is the short-circuit the whole
  // ventilation class of tasks turns on.
  //
  // Speed is a wind floor plus a stack term growing with |indoor − outdoor|:
  // v = WIND + K·√(g·h·ΔT/T̄), the standard buoyancy-driven form, coarsened.
  // COLD GLASS. Every exterior window chills the air against it, whether it is
  // open or shut — a shut window is not a wall, it is the thinnest part of the
  // envelope. Marked before the open-window inflow below so an open window is
  // both a cold surface and an air exchange.
  // The window box itself lands INSIDE the wall (a shut window is never carved
  // out of the solids), so those cells are all solid and marking them would do
  // nothing. What matters is the air ON THE ROOM SIDE of the pane — that is what
  // gets chilled — so take the non-solid indoor neighbours of the box.
  // WHY A RADIATOR GOES UNDER A WINDOW. Glazing chills the air against it; that
  // air sinks and spills across the floor as a cold draught. A heat source
  // directly below the glass sends a warm plume up the pane and cancels the
  // downdraught before it forms — which is exactly why radiators have been put
  // under windows for a century. Without this, the model only ever charged the
  // heater for standing in a cold spot, so the real-world answer measured WORSE
  // than an arbitrary corner and the task taught the opposite of the truth.
  const heaters = plan.items.filter((it) => it.type === "heater" && it.on !== false);
  const SHIELD_R = 1.3; // metres: how close the heater must be to blanket the pane
  const glass: number[] = [];
  const glassSeen = new Set<number>();
  for (const o of plan.windows) {
    if (!o.rooms.includes("outside")) continue;
    for (const [i, j, k] of cellsOf(openingBox(o, WALL_THICKNESS))) {
      for (const [di, dj, dk] of [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]] as const) {
        const a = i + di, b2 = j + dj, d2 = k + dk;
        if (a < 0 || b2 < 0 || d2 < 0 || a >= nx || b2 >= ny || d2 >= nz) continue;
        const c = sim.cIdx(a, b2, d2);
        if (sim.solid[c] || !inside[c] || glassSeen.has(c)) continue;
        glassSeen.add(c);
        const [wx, , wz] = cellCenter(a, b2, d2);
        const shielded = heaters.some(
          (h) => Math.hypot(h.position[0] - wx, h.position[2] - wz) <= SHIELD_R,
        );
        if (shielded) continue; // the plume covers this pane: no cold surface, no loss
        glass.push(c);
        // cold surface for the buoyancy step: air here is chilled and sinks
        sim.tempFixed[c] = 1;
        sim.tempVal[c] = GLASS_DT;
      }
    }
  }

  const dT = Math.abs(opts.openingDriveDT ?? 8);
  const stack = 0.6 * Math.sqrt((9.81 * 0.6 * dT) / 293);
  const exchange = clampf(0.12 + stack, 0.12, 0.9);
  for (const o of [...plan.doors, ...plan.windows]) {
    if (!o.open || !o.rooms.includes("outside")) continue;
    const box = openingBox(o, WALL_THICKNESS);
    const midY = (box.min[1] + box.max[1]) / 2;
    const inward = outwardNormalOf(plan, o).map((v) => -v) as [number, number, number];
    for (const [i, j, k] of cellsOf(box)) {
      const [, wy] = cellCenter(i, j, k);
      if (wy > midY) continue; // upper half stays a free outlet
      const c = sim.cIdx(i, j, k);
      sim.solid[c] = 0;
      // lower half: prescribe inflow, and stop it acting as a pressure sink or
      // the projection would just cancel the air we are pushing in
      sim.open[c] = 0;
      ambient[c] = 1; // still outdoor air: neutral temperature, no odour
      setFaceInto(sim, i, j, k, inward, exchange);
    }
  }

  const itemAabb = (it: PlacedItem): Box => {
    const [cx, cy, cz] = it.position;
    const [sw, sh, sd] = it.size;
    const q = ((Math.round(it.rotationY / (Math.PI / 2)) % 4) + 4) % 4;
    const ex = q === 1 || q === 3 ? sd : sw;
    const ez = q === 1 || q === 3 ? sw : sd;
    return { min: [cx - ex / 2, cy - sh / 2, cz - ez / 2], max: [cx + ex / 2, cy + sh / 2, cz + ez / 2] };
  };
  // Continuous aim from yaw (rotationY) + vertical tilt. At tilt 0 this matches
  // the old quantised facing (yaw 0 -> +z, yaw π/2 -> +x); a positive tilt aims
  // the jet UP, negative DOWN. This is what lets an AC be angled off a bed and a
  // fan be pointed up / down / diagonally.
  const aimVec = (rotY: number, tilt: number): [number, number, number] => {
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    return [Math.sin(rotY) * ct, st, Math.cos(rotY) * ct];
  };
  // Prescribe a directed jet along an arbitrary unit aim by fixing the outgoing
  // face on EACH axis in proportion to the aim — a diagonal or vertical jet, not
  // just one of six cardinal directions.
  const setJet = (i: number, j: number, k: number, a: [number, number, number], speed: number) => {
    if (Math.abs(a[0]) > 1e-3) { const f = a[0] > 0 ? sim.uIdx(i + 1, j, k) : sim.uIdx(i, j, k); sim.uFixed[f] = 1; sim.uVal[f] = a[0] * speed; }
    if (Math.abs(a[1]) > 1e-3) { const f = a[1] > 0 ? sim.vIdx(i, j + 1, k) : sim.vIdx(i, j, k); sim.vFixed[f] = 1; sim.vVal[f] = a[1] * speed; }
    if (Math.abs(a[2]) > 1e-3) { const f = a[2] > 0 ? sim.wIdx(i, j, k + 1) : sim.wIdx(i, j, k); sim.wFixed[f] = 1; sim.wVal[f] = a[2] * speed; }
  };

  let hasTemperature = false;
  const seeds: Array<[number, number, number]> = [];
  const sinks: Array<[number, number, number]> = [];
  const markers: Array<{ pos: [number, number, number]; kind: "hot" | "cold" }> = [];
  for (const it of plan.items) {
    const isAC = it.type === "ac";
    const isSupply = it.type === "supply";
    const isReturn = it.type === "return";
    const isFan = it.type === "fan";
    const isHeater = it.type === "heater";
    const wetT = it.on === false ? undefined : WET_T[it.type];
    // The wet fixtures are furniture, not hardware — they were skipped by this
    // guard and their warmth never reached the solver at all.
    if (!isAC && !isSupply && !isReturn && !isFan && !isHeater && wetT === undefined) continue;
    if (it.on === false) continue;
    const mult = POWER[it.power ?? 2] ?? 1;
    const cells = cellsOf(itemAabb(it));
    if (isAC) markers.push({ pos: [...it.position] as [number, number, number], kind: "cold" });
    if (isHeater || wetT !== undefined) markers.push({ pos: [...it.position] as [number, number, number], kind: "hot" });

    if (isAC || isSupply || isReturn || isFan) {
      // Direction follows how the unit is mounted (matches inwardNormal in
      // bc/lfm.ts): a ceiling vent acts straight down, a floor vent straight up,
      // and anything on a wall — AC, or a wall-mounted supply/exhaust vent —
      // blows along its facing.
      const dir: [number, number, number] =
        (isSupply || isReturn) && it.mount === "ceiling"
          ? [0, -1, 0]
          : (isSupply || isReturn) && it.mount === "floor"
            ? [0, 1, 0]
            : aimVec(it.rotationY, it.tilt ?? 0);
      // a RETURN vent sucks air OUT: same face, negated speed → air flows toward
      // the vent instead of away, pulling room air (and odour) into it. Pair a
      // supply in one room with a return in another and the air is drawn ACROSS
      // the house through the open doors — whole-house circulation.
      const mag = (isFan ? 1.0 : clampf((it.flow ?? 0) / 0.3, 0.4, 1.5)) * mult;
      const speed = isReturn ? -mag : mag;
      for (const [i, j, k] of cells) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c]) sim.solid[c] = 0;
        // `seeds` is WHERE TO START DRAWING, not where air comes from — it is
        // read only by the streamline seeding and the particle spawner, never by
        // the solver. A fan does not generate air, and it is still the single
        // most interesting place in the room to start a line from: it is the
        // thing the participant just placed and is reasoning about. Without it,
        // a studio with a fan and an open window had exactly two seeds — the
        // window's two gateway points — and the fan appeared to do nothing.
        // A return still does not seed: nothing is born at an extract, and its
        // lines are drawn from `sinks` by tracing upstream instead.
        if (isAC || isSupply || isFan) seeds.push(cellCenter(i, j, k));
        if (isReturn) {
          // one cell IN FRONT of the grille (dir faces into the room), so the
          // seed sits in open air rather than in the vent's own boundary cell
          const [cx2, cy2, cz2] = cellCenter(i, j, k);
          sinks.push([cx2 + dir[0] * dx, cy2 + dir[1] * dx, cz2 + dir[2] * dx]);
        }
        if (isFan) {
          // A FAN IS NOT A SOURCE OF AIR. It was modelled with fixed-velocity
          // faces, which PRESCRIBE the flow: the solver was ordered to hold
          // 1 m/s there no matter what the surrounding air was doing, so the fan
          // behaved like a vent that manufactures a jet and never loads up.
          // It is now a body force — it accelerates the air that is already in
          // the room, and the pressure projection routes the return path around
          // it. Blocked in, it stalls; in open air, it throws a jet. Nothing is
          // created, which is exactly the physical distinction.
          //
          // The force follows the full aim vector, so a fan can be pointed up,
          // down or diagonally, not only along a wall.
          const F = FAN_FORCE * mult;
          if (Math.abs(dir[0]) > 1e-3) { sim.uForce[sim.uIdx(i, j, k)] += dir[0] * F; sim.uForce[sim.uIdx(i + 1, j, k)] += dir[0] * F; }
          if (Math.abs(dir[1]) > 1e-3) { sim.vForce[sim.vIdx(i, j, k)] += dir[1] * F; sim.vForce[sim.vIdx(i, j + 1, k)] += dir[1] * F; }
          if (Math.abs(dir[2]) > 1e-3) { sim.wForce[sim.wIdx(i, j, k)] += dir[2] * F; sim.wForce[sim.wIdx(i, j, k + 1)] += dir[2] * F; }
          // An oscillating fan sweeps side to side. Averaged over the sweep that
          // is a broader, weaker push, so spread part of the force laterally in
          // the horizontal plane (perpendicular to the aim's heading) rather than
          // adding more of it — a sweeping fan spreads the same air over a wider
          // arc, it does not move more.
          if (it.oscillate) {
            const lat = F * 0.45;
            if (Math.abs(dir[0]) >= Math.abs(dir[2])) {
              sim.wForce[sim.wIdx(i, j, k + 1)] += lat;
              sim.wForce[sim.wIdx(i, j, k)] -= lat;
            } else {
              sim.uForce[sim.uIdx(i + 1, j, k)] += lat;
              sim.uForce[sim.uIdx(i, j, k)] -= lat;
            }
          }
        } else {
          // ducted vent: free boundary cell + directed jet face. Inflow vents
          // inject clean air, so they dilute odour locally (SMELL sink only —
          // not a temperature sink, or the AC's own cold / a heater's warmth
          // could never spread past the vent).
          sim.open[c] = 1;
          ventDilute[c] = 1;
          setJet(i, j, k, dir, speed);
        }
      }
    }
    if (isAC || isHeater || wetT !== undefined) {
      const dT =
        wetT !== undefined ? wetT : isAC ? AC_T * mult : HEATER_T * (HEATER_POWER[it.power ?? 2] ?? 1);
      let placed = 0;
      for (const [i, j, k] of cells) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c]) continue;
        sim.tempFixed[c] = 1;
        sim.tempVal[c] = dT;
        hasTemperature = true;
        placed++;
      }
      // A heater is a thin panel pressed against a wall (0.18 m deep). On a
      // coarse grid its whole footprint can land inside the wall's cells, and
      // the heat source then vanishes without a trace — the optimizer was
      // scoring "warm the living room" layouts that contained no heater at all.
      // If nothing landed, snap the source to the nearest open cell instead.
      if (placed === 0) {
        const [ci, cj, ck] = worldToCell(it.position[0], it.position[1], it.position[2]);
        const free = nearestFreeCell(sim, nx, ny, nz, ci, cj, ck);
        if (free >= 0) {
          sim.tempFixed[free] = 1;
          sim.tempVal[free] = dT;
          hasTemperature = true;
        }
      }
    }
  }

  // Sources of whatever the contaminant field is carrying in this scene. One
  // field, two costumes: "smell" for odour, "damp" for moisture. They behave
  // identically — what differs is the model the participant sees and the words
  // the panel uses, and a violet stink-blob in a bathroom is the wrong sentence.
  const baseSmell: number[] = [];
  for (const it of plan.items) {
    if ((it.type !== "smell" && it.type !== "damp") || it.on === false) continue;
    for (const [i, j, k] of cellsOf(itemAabb(it))) {
      const c = sim.cIdx(i, j, k);
      if (!sim.solid[c]) baseSmell.push(c);
    }
  }
  const applyBaseSmell = () => {
    for (const c of baseSmell) { sim.sFixed[c] = 1; sim.sVal[c] = 1; }
  };
  applyBaseSmell();

  const setSource = (rect: Rect | null) => {
    sim.sFixed.fill(0);
    sim.sVal.fill(0);
    applyBaseSmell(); // keep the placed smell sources
    if (!rect) return;
    const [i0, , k0] = worldToCell(rect.x, 0, rect.z);
    const [i1, , k1] = worldToCell(rect.x + rect.w, 0, rect.z + rect.d);
    for (let k = k0; k <= k1; k++)
      for (let j = 0; j < ny; j++)
        for (let i = i0; i <= i1; i++) {
          const c = sim.cIdx(i, j, k);
          if (sim.solid[c] || sim.open[c]) continue;
          sim.sFixed[c] = 1;
          sim.sVal[c] = 1;
        }
  };

  return { sim, nx, ny, nz, dx, origin, worldToCell, cellCenter, setSource, ambient, ventDilute, hasTemperature, inside, roomIndex, roomIds, seeds, sinks, glass, markers, windowReach: plan.windowReach ?? 1, ventSpread: plan.ventSpread ?? 1, sealedHalo: plan.sealedHalo === true, hasOpenExterior };
}

// Per-grid steady-state temperature & air-quality by GEODESIC DISTANCE from the
// sources through connected air. This replaces the slow diffusion relaxation
// (which needed thousands of iterations to cross the house): a multi-source BFS
// gives every cell its distance-to-source *through open doorways, blocked by
// walls and closed doors*, and the value falls off exponentially with that
// distance. So a heater/AC fills its whole connected part of the house (hot near
// the source, cooler further away, nothing past a shut door), and smell reads
// low near open windows / vents (fresh-air sinks). O(cells) — instant.
/** How long this spot takes to dry out, in MINUTES, once the shower is off.
 *
 *  Drying is governed by the local air-change rate: damp air has to be replaced
 *  by drier air, and a spot the fresh air barely reaches exchanges slowly and
 *  stays wet. The ventilation term already computed for the moisture field —
 *  `1 − exp(−dK / FRESH_TAU)`, which is 0 right at an opening and approaches 1
 *  where no outdoor air arrives — is exactly that effectiveness, inverted. So
 *  the drying time is proportional to it.
 *
 *  DRY_UNVENTILATED sets the scale: three hours for a corner the air never
 *  reaches, which is what an interior bathroom with the door shut actually
 *  behaves like, and a handful of minutes right beside an open window.
 *
 *  NOT the raw transport cost. dK is a travel time in SECONDS — a few metres at
 *  half a metre per second is under a minute — so scaling minutes off it
 *  reported the entire room as "0 min" and the goal could never fail.
 *
 *  Reported in minutes because that is the unit a person owns: "the corner is
 *  still wet two hours later" is a sentence about a bathroom, and 0.27 on a
 *  contaminant scale is not. */
const DRY_UNVENTILATED = 180;
/** The transport cost at which a spot is drying at roughly half the sealed-room
 *  rate. Its OWN constant, not FRESH_TAU: that one is tuned to 5 s for the
 *  moisture level in the studio task, and at 5 s the drying term saturates —
 *  almost every cell in a bathroom is more than five seconds of travel from an
 *  opening, so every layout reported the same two-and-a-half hours and the
 *  placement made no visible difference. Sized instead to the spread of costs
 *  ACROSS a bathroom (roughly 5–30 s), which is what has to be resolved. */
const DRY_TAU = 25;
/** Minutes reported when the cell has NO opening anywhere in reach — a sealed
 *  room never dries, and the checklist needs a finite number to print rather
 *  than an infinity. */
const DRY_NEVER = 999;

export function geodesicFields(s: Sim3D): { temp: Float32Array; smell: Float32Array; dry: Float32Array } {
  const { sim, nx, ny, nz, dx, ambient, ventDilute } = s;
  const n3 = nx * ny * nz;
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const DIRS: [number, number, number][] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];

  // Plain geodesic distance (metres) through connected air — used for sinks.
  const bfs = (seeds: number[]): Float32Array => {
    const dist = new Float32Array(n3).fill(Infinity);
    const q = new Int32Array(n3);
    let head = 0, tail = 0;
    for (const c of seeds) if (!sim.solid[c] && dist[c] === Infinity) { dist[c] = 0; q[tail++] = c; }
    while (head < tail) {
      const c = q[head++];
      const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0;
      const nd = dist[c] + dx;
      for (const [di, dj, dk] of DIRS) {
        const a = i + di, b = j + dj, d = k + dk;
        if (a < 0 || b < 0 || d < 0 || a >= nx || b >= ny || d >= nz) continue;
        const cc = idx(a, b, d);
        if (sim.solid[cc] || dist[cc] !== Infinity) continue;
        dist[cc] = nd; q[tail++] = cc;
      }
    }
    return dist;
  };

  // Airflow-WEIGHTED distance (Dijkstra): travel time from a source, where moving
  // DOWNWIND is fast (the air carries heat/smell) and upwind slow. A base spread
  // speed V0 (diffusion / gentle mixing) guarantees the whole connected house is
  // still reached; the flow just biases how far the field is carried each way.
  // Returns a time-like cost (s); combined with an exp falloff this is the
  // steady-state ("very long time") distribution advected by the airflow.
  const V0 = 0.6;    // base diffusive spread (m/s) — fills the house on its own
  // Airflow bias on top of that base spread. Raised from 0.5: at the old value
  // a fan barely changed where the heat ended up, so aiming one was close to a
  // no-op and "move air from the warm room to the cold one" — the whole point
  // of having a fan — was not a strategy the model rewarded. Now which way the
  // fan points measurably decides how far the warmth travels.
  const KADV = 1.6;
  /** How much moving AGAINST the flow costs, as a fraction of KADV.
   *
   *  Zero for heat, which is the behaviour everything was calibrated against:
   *  warmth also conducts and radiates, so a fan blowing away from a room does
   *  not stop it warming.
   *
   *  Non-zero for a contaminant, because a contaminant only moves if the air
   *  moves it. With no upwind penalty a fan could make smell travel FASTER in
   *  every direction and never hold it back anywhere — measured on the studio
   *  task, every fan placement raised the smell over the bed (0.19 with no fan,
   *  0.26 blowing from the bed toward the kitchen, which should have been the
   *  best case). "Blow the smell away from where you sleep" was not expressible,
   *  so the task could not be solved by the move it exists to teach. */
  const UPWIND = 2.4;
  /** Base spread for FRESHNESS, far below V0.
   *
   *  A contaminant has been pouring off the bin for hours, so diffusion has had
   *  time to fill the room and V0 is right for it. "How fresh is the air here"
   *  is a different quantity: it is set by how much outdoor air is actually
   *  delivered to this spot per unit time, and still air delivers almost none.
   *  Giving freshness the same generous base spread meant an open window
   *  cleaned the far side of the room by itself, whether or not any air was
   *  moving — which made the fan optional in a task about moving air.
   *
   *  0.45 → 0.30 because it was still too generous to show a SHORT CIRCUIT. In
   *  the studio the right-hand window sits ~2 m from the extract: air coming in
   *  there is pulled straight back out and never crosses the room, so opening it
   *  should leave the place much as it was. At 0.45 the freshness diffused far
   *  enough on its own to clear most of the floor anyway — the picture showed a
   *  room being aired out by a window whose air never reaches it, which is the
   *  opposite of the lesson. Freshness now has to be carried.
   *
   *  Not lower than this, and the limit is the bathroom, which reads its drying
   *  time off the same field. Best achievable design: 25 min at 0.45, 31 min at
   *  0.30, ~36 min extrapolated at 0.20 — against a 35-minute goal. At 0.20 the
   *  bathroom task stops being solvable at all.
   *
   *  WHAT THIS MODEL WILL NOT SAY, measured, so nobody re-derives it. Opening
   *  BOTH studio windows ought to be worse than opening the bed-side one alone —
   *  the right-hand window is supposed to rob it of the inflow that was crossing
   *  the room. It does not come out that way, and two attempts to force it
   *  failed for reasons worth keeping:
   *
   *  · Pushing freshness harder along the flow (KADV 1.6 → 4 → 7 for the
   *    freshness passes only) makes the SHORT CIRCUIT better, not worse — the
   *    trap window went 0.323 → 0.239 → 0.182 — and at 7 the bathroom starts
   *    almost dry (25 min against a 35-minute goal), so the task is over before
   *    it begins.
   *  · Seeding each opening behind by how little air it moves — physically the
   *    right idea, since an opening delivers fresh air in proportion to its flux
   *    — never engages here: measured at the openings, the bed-side window runs
   *    at 0.43 m/s alone and 0.51 m/s with the other one also open. It speeds
   *    UP. With the extract pulling a fixed flux and free outlets everywhere,
   *    this solver treats a second opening as another path, not as competition.
   *
   *  So "both windows" measures the same as the bed-side window alone (0.219 vs
   *  0.219) and fails the task either way, which is the part that matters: the
   *  right-hand window adds nothing. It is not made WORSE, and saying otherwise
   *  would mean overriding the flow solution rather than reading it. */
  const V0_FRESH = 0.30;
  const costFromSources = (
    seeds: number[],
    kUp = 0,
    reverse = false,
    v0 = V0,
    /** Per-seed head start, in the same cost units (seconds). Used to start a
     *  source BEHIND. Unused now that both opening discounts are charged as
     *  reach rather than as a head start; kept because the machinery is
     *  general and the next discount may genuinely belong at the source. */
    seedCost?: (cell: number) => number,
    /** Per-seed multiplier on every step of the path that leaves that seed, so
     *  a source can carry LESS FAR without being penalised at the source
     *  itself. `seedCost` cannot express that: it shifts the whole field by a
     *  constant, which makes the ground right at an open window read as stale —
     *  and the one thing an open window is certainly delivering is outdoor air
     *  to its own doorstep. See openingReach. */
    seedReach?: (cell: number) => number,
  ): Float64Array => {
    // Float64, NOT Float32. The heap carries full-precision costs while `dist`
    // stored them rounded, and the staleness test compares the two:
    //     dist[cc] = nc          // rounded to float32 on the way in
    //     if (cost > dist[c]) continue;   // full-precision cost vs that rounding
    // Whenever the rounding went DOWN, a perfectly current entry looked stale
    // and was thrown away, killing that branch of the frontier. About half of
    // every expansion was discarded, so the field died out a room or two from
    // the source: the AC's own room was only partly cooled and any further room
    // came back at exactly 0 — i.e. exactly outdoor temperature, no matter what
    // the doors were doing. Both numbers must have the same precision.
    const dist = new Float64Array(n3).fill(Infinity);
    // Binary min-heap over (cost, cell), with lazy deletion: a cell is pushed
    // again every time its distance improves, so the heap holds far MORE than
    // one entry per cell — up to one per incoming edge.
    //
    // This was sized n3 + 1, i.e. one slot per cell. Past that, `hc[p] = cost`
    // wrote beyond the end of a typed array, which JavaScript ignores silently:
    // no error, no growth, the entry simply disappeared. The frontier stopped
    // expanding partway through the house, every cell beyond it kept
    // dist = Infinity, and geodesicFields turned that into a temperature delta
    // of exactly 0. Result: the rooms nearest the AC were heated/cooled and the
    // FAR rooms read as exactly outdoor temperature no matter what — so heat and
    // cold never appeared to travel between rooms, the goal verdict for any
    // non-adjacent room was wrong, and the optimizer was scoring layouts against
    // a field that could not transport anything across the home.
    let cap = n3 + 1;
    let hc = new Float64Array(cap);
    let hi = new Int32Array(cap);
    let hn = 0;
    const push = (cost: number, cell: number) => {
      if (hn + 1 >= cap) {
        cap *= 2;
        const nc = new Float64Array(cap); nc.set(hc); hc = nc;
        const ni = new Int32Array(cap); ni.set(hi); hi = ni;
      }
      let p = ++hn; hc[p] = cost; hi[p] = cell;
      while (p > 1) { const q = p >> 1; if (hc[q] <= hc[p]) break; [hc[p], hc[q]] = [hc[q], hc[p]]; [hi[p], hi[q]] = [hi[q], hi[p]]; p = q; }
    };
    const pop = (): [number, number] => {
      const rc = hc[1], rcell = hi[1];
      hc[1] = hc[hn]; hi[1] = hi[hn]; hn--;
      let p = 1;
      for (;;) { let l = p << 1, r = l + 1, m = p;
        if (l <= hn && hc[l] < hc[m]) m = l;
        if (r <= hn && hc[r] < hc[m]) m = r;
        if (m === p) break;
        [hc[p], hc[m]] = [hc[m], hc[p]]; [hi[p], hi[m]] = [hi[m], hi[p]]; p = m; }
      return [rc, rcell];
    };
    // Which seed's multiplier a cell's best-known path is carrying. Dijkstra
    // already tracks the best path; this just rides along with it, so a
    // half-share window's air costs more per metre for the whole of its
    // journey rather than being docked a lump sum before it sets off.
    const reach = seedReach ? new Float64Array(n3).fill(1) : null;
    for (const c of seeds)
      if (!sim.solid[c] && dist[c] === Infinity) {
        const c0 = seedCost ? seedCost(c) : 0;
        dist[c] = c0;
        if (reach) reach[c] = seedReach!(c);
        push(c0, c);
      }
    while (hn > 0) {
      const [cost, c] = pop();
      if (cost > dist[c]) continue;
      const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0;
      const [u, v, w] = sim.velocityAt(i, j, k);
      for (const [di, dj, dk] of DIRS) {
        const a = i + di, b = j + dj, d = k + dk;
        if (a < 0 || b < 0 || d < 0 || a >= nx || b >= ny || d >= nz) continue;
        const cc = idx(a, b, d);
        if (sim.solid[cc]) continue;
        // Flow component along the move. `reverse` walks the field the other
        // way: cheap where the air is heading BACK toward the seed, which is
        // "how quickly does this cell drain into that opening" rather than
        // "how quickly does that opening's air get here".
        const vd = (u * di + v * dj + w * dk) * (reverse ? -1 : 1);
        // Downwind is fast; upwind is slow but never free — the floor keeps
        // diffusion alive so a strong jet cannot make a region unreachable.
        const speed = Math.max(0.05, v0 + KADV * Math.max(0, vd) - kUp * Math.max(0, -vd));
        const nc = cost + (dx / speed) * (reach ? reach[c] : 1);
        if (nc < dist[cc]) {
          dist[cc] = nc;
          if (reach) reach[cc] = reach[c];
          push(nc, cc);
        }
      }
    }
    return dist;
  };

  const TAU = 23;        // temperature decay time (s) — fills a house, keeps a gradient
  const SMELL_TAU = 9;
  // FRESH AIR IS CARRIED, NOT A HALO. This was a plain geodesic distance to the
  // nearest opening with a 0.7 m falloff, i.e. "standing near a window helps and
  // nothing else does". Two things were wrong with that. Opening a window on the
  // far side of a room did nothing measurable anywhere a person actually was
  // (0.190 over the bed with every window shut, 0.189 with both open — the
  // control did nothing). And a fan could never clean anything: it had no way to
  // bring the clean air TO you, so every fan placement only spread the smell
  // further. Fresh air now travels from the opening on the same airflow-weighted
  // cost the smell does, so blowing a window's air across the bed washes the bed
  // — which is the whole move the studio task is trying to teach.
  const FRESH_TAU = 5;

  // Glazing is HEAT LOSS, not a cold source. As a source it would drag the
  // reported temperature below the outdoor air, which a closed window cannot do.
  // Modelled instead as an attenuation toward outdoor with distance from the
  // glass: right at the pane most of the room's warmth is given up, a metre away
  // almost none. Same treatment cools a summer room's cool air near the glass
  // (heat gain), so it is correct in both seasons.
  const glassSet = new Set(s.glass);
  const GLASS_LOSS = 0.6;   // fraction of the local delta surrendered AT the pane
  const GLASS_LAMBDA = 0.8; // metres — how far the cold zone reaches into the room

  // temperature: hot (heater) & cold (AC) sources carried by the airflow
  const hotSeeds: number[] = [], coldSeeds: number[] = [];
  let hotMag = 0, coldMag = 0;
  for (let c = 0; c < n3; c++) if (sim.tempFixed[c] && !glassSet.has(c)) {
    if (sim.tempVal[c] > 0) { hotSeeds.push(c); hotMag = Math.max(hotMag, sim.tempVal[c]); }
    else if (sim.tempVal[c] < 0) { coldSeeds.push(c); coldMag = Math.max(coldMag, -sim.tempVal[c]); }
  }
  const dHot = hotSeeds.length ? costFromSources(hotSeeds) : null;
  const dCold = coldSeeds.length ? costFromSources(coldSeeds) : null;
  const dGlass = s.glass.length ? bfs(s.glass) : null;
  const temp = new Float32Array(n3);
  for (let c = 0; c < n3; c++) {
    if (sim.solid[c]) continue;
    let t = 0;
    if (dHot && dHot[c] !== Infinity) t += hotMag * Math.exp(-dHot[c] / TAU);
    if (dCold && dCold[c] !== Infinity) t -= coldMag * Math.exp(-dCold[c] / TAU);
    // heat bleeding out through the glazing, strongest right at the pane
    if (dGlass && dGlass[c] !== Infinity) t *= 1 - GLASS_LOSS * Math.exp(-dGlass[c] / GLASS_LAMBDA);
    temp[c] = t;
  }

  // air quality: smell carried from the source by the airflow; near a window/vent
  // sink it drops to ~0 (odour leaves, fresh air enters); a shut door blocks it.
  const smellSeeds: number[] = [], sinkSeeds: number[] = [], ventSeeds: number[] = [];
  for (let c = 0; c < n3; c++) {
    if (sim.sFixed[c]) smellSeeds.push(c);
    if (ambient[c] || ventDilute[c]) sinkSeeds.push(c);
    if (ventDilute[c]) ventSeeds.push(c);
  }

  /**
   * SHORT CIRCUIT. An opening a couple of metres from a running extract does not
   * air the room out: the air it lets in is pulled straight back out again and
   * never travels anywhere else. Treating every opening as an equally good
   * source of fresh air made the studio's trap window look like a fix — open it
   * and the floor greened out, when what actually happens is that the extract
   * eats its air and the room stays exactly as stale as it was.
   *
   * So an opening starts BEHIND by how close it sits to an extract, measured
   * along the air's own path rather than through walls. Right next to the
   * grille it is worth almost nothing; a couple of metres away it is heavily
   * discounted; across the room the discount has decayed to nothing and it
   * airs the place out normally.
   *
   * The extract's own cells are exempt. A grille pulling stale air outside DOES
   * clean the air around it — that is what an extract is for — and it is not
   * short-circuiting itself.
   */
    const SC_MULT = 20;      // extra cost per metre for an opening ON the grille
  const SC_LAMBDA = 2.0;  // metres over which that penalty decays
  const dVent = ventSeeds.length ? bfs(ventSeeds) : null;
  // …and the mirror image: how far the extract's own make-up air had to travel
  // to reach it. An extract cleans the air that flows THROUGH the room into it,
  // so a grille fed by a window a metre away sweeps that metre and nothing
  // more. Without this the vent kept a broad clean halo whatever was open, and
  // the short-circuited studio read "pale" — i.e. working — right where the
  // lesson is that it is not.
  const openingSeeds: number[] = [];
  for (let c = 0; c < n3; c++) if (ambient[c] && !ventDilute[c] && !sim.solid[c]) openingSeeds.push(c);
  const dOpening = openingSeeds.length ? bfs(openingSeeds) : null;

  /**
   * SPLIT MAKE-UP AIR. An extract pulls a fixed volume out of the home, and
   * exactly that volume has to come back in through whatever is open. So the
   * openings are not independent: they share one budget, and each one delivers
   * only its share of it. Open a second window and the first one is supplying
   * half as much fresh air as it was.
   *
   * Without this the model could not tell the difference between one open window
   * and two — freshness was reachability, so another opening could only ever
   * help. It is why opening BOTH studio windows measured the same as opening the
   * right one alone, when in fact the second window is stealing the first one's
   * inflow and feeding it to an extract two metres away.
   *
   * Share is taken from the opening's own size: the ambient cells are grouped
   * into connected openings, and each group's share is its cells over all of
   * them, which is area over total area — how the flux balance splits it too.
   *
   * IT COSTS REACH, NOT DOORSTEP. This was a lump added to the opening's
   * starting cost, which shifts its entire freshness field — including the
   * cell in the window frame. That reads wrong on screen and is wrong on the
   * physics: whatever else is open, the air arriving at an open window is
   * outdoor air, so its own doorstep is fresh. Opening a second window did not
   * make the first one's threshold stale; it made the air the first one brings
   * in run out of push sooner. So the share is now a multiplier on every metre
   * the air travels away from that opening (see seedReach): a half-share window
   * still greens the ground under it, and carries that green half as far into
   * the room.
   */
  /** Ceiling on the combined reach penalty, so a sliver of an opening on the
   *  extract's doorstep is heavily discounted rather than annihilated. */
  const REACH_MAX = 10;
  const openingShare = new Float32Array(n3);
  {
    const group = new Int32Array(n3).fill(-1);
    const sizes: number[] = [];
    const stack: number[] = [];
    let total = 0;
    for (let c0 = 0; c0 < n3; c0++) {
      // ventDilute cells are ambient too — an extract registers as an outlet —
      // but a grille is not a source of make-up air and must not take a share
      // of it. Left in, every window's share was diluted by the very fan the
      // window exists to feed.
      if (!ambient[c0] || ventDilute[c0] || group[c0] !== -1 || sim.solid[c0]) continue;
      const gid = sizes.length;
      let count = 0;
      stack.push(c0);
      group[c0] = gid;
      while (stack.length) {
        const c = stack.pop()!;
        count++;
        const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0;
        for (const [di, dj, dk] of DIRS) {
          const a = i + di, b = j + dj, d = k + dk;
          if (a < 0 || b < 0 || d < 0 || a >= nx || b >= ny || d >= nz) continue;
          const cc = idx(a, b, d);
          if (sim.solid[cc] || !ambient[cc] || ventDilute[cc] || group[cc] !== -1) continue;
          group[cc] = gid;
          stack.push(cc);
        }
      }
      sizes.push(count);
      total += count;
    }
    for (let c = 0; c < n3; c++) {
      const g = group[c];
      openingShare[c] = g === -1 || total === 0 ? 1 : sizes[g] / total;
    }
  }

  /** Cost multiplier per metre travelled, combining both discounts. Neither is
   *  charged at the opening itself — an open window's own threshold is outdoor
   *  air whatever else is going on, and the picture should say so. What each
   *  one costs is REACH: how far into the room that air gets before it runs
   *  out of push.
   *
   *  Short circuit: a window on the extract's doorstep greens its own corner
   *  and nothing else, because that is precisely what happens — the air comes
   *  in and goes straight back out two metres later. As a starting penalty this
   *  drew the trap window as though no air came through it at all, which hides
   *  the mechanism the task is about instead of showing it.
   *
   *  Split: an opening supplying half the make-up air pushes it half as far. */
  // AN EXTRACT IN A SEALED ROOM MOVES NOTHING. With every window and door shut
  // there is no make-up air, so the fan just depressurises the room slightly and
  // the air stays where it is. The freshness pass did not know that: the vent is
  // a sink whether or not anything can replace what it removes, so a shut-up
  // bathroom still dried out around the grille — and one vent position with the
  // window SHUT scored better than several with it open, which inverts the
  // lesson the task is built on. Sealed, the extract now barely reaches.
  /** How far a sealed extract's influence carries, in metres.
   *
   *  With nothing open there is no make-up air and the fan cannot turn the room
   *  over — that is the lesson, and the room-wide drying time has to keep
   *  saying so. But it is not doing nothing either: it is pulling on the air
   *  immediately in front of it, drawn from whatever leaks in around the door,
   *  and painting that patch as wet as the far corner reads as a fan that is
   *  switched off. So the grille clears its own metre and stops. */
  /** Restored: with the bounded halo OFF (every task but the bathroom) a sealed
   *  extract behaves exactly as it always has — a reach so long it clears
   *  nothing. The studio depends on it: its grille sits directly over the bin,
   *  and a halo there scrubbed the smelliest spot in the room clean. */
  const SEALED_REACH = 25;
  const SEALED_RADIUS = 2.4;
  /** …and how hard it pulls WITHIN that radius. Below 1 so the patch it does
   *  clear is unmistakably clear: at the room's own rate the difference between
   *  the grille's corner and the far one stayed inside the top of the colour
   *  ramp, where everything clamps to the same navy and a real 2x difference in
   *  concentration is invisible. */
  const SEALED_PULL = 0.35;

  /** In a sealed room, everything further than SEALED_RADIUS from a grille is
   *  simply not being ventilated — no fresh air reaches it by any route. */
  const sealedBeyondReach = (c: number): boolean =>
    s.sealedHalo && !s.hasOpenExterior && (!dVent || dVent[c] > SEALED_RADIUS);

  const openingReach = (c: number): number => {
    if (ventDilute[c]) {
      // SEALED, BUT NOT INERT — see SEALED_RADIUS. The grille clears the air
      // right in front of it at its normal rate; what a sealed room takes away
      // is how FAR that reaches, and that is imposed as a hard radius below
      // rather than as a slower spread. Scaling the spread could not express
      // it: it is one multiplier on the whole field, so every setting that made
      // the grille visibly dry also dried the room (at a reach that gave a
      // readable patch, the 90th percentile fell from 180 minutes to 43).
      if (!s.hasOpenExterior) return s.sealedHalo ? SEALED_PULL : SEALED_REACH;
      const dm = dOpening ? dOpening[c] : Infinity;
      if (dm === Infinity) return REACH_MAX;
      // `ventSpread` below 1 widens the grille's reach; it is 1 everywhere
      // unless a task asks otherwise, so this line is the behaviour every other
      // scenario has always had.
      return Math.min(REACH_MAX, s.ventSpread * (1 + SC_MULT * Math.exp(-dm / SC_LAMBDA)));
    }
    if (!ambient[c]) return 1;
    const d = dVent ? dVent[c] : Infinity;
    const sc = !dVent || d === Infinity ? 1 : 1 + SC_MULT * Math.exp(-d / SC_LAMBDA);
    const split = 1 / Math.max(1e-3, openingShare[c]);
    // The task's own dial: below 1 makes an open window carry less far, which
    // is the difference between a room the window airs out on its own and one
    // where the extract's position still decides the answer. See windowReach.
    const task = 1 / Math.max(0.1, s.windowReach);
    return Math.min(REACH_MAX, sc * split * task);
  };
  const smell = new Float32Array(n3);
  const dry = new Float32Array(n3).fill(DRY_NEVER);
  {
    const dFwd0 = sinkSeeds.length ? costFromSources(sinkSeeds, UPWIND, false, V0_FRESH, undefined, openingReach) : null;
    const dOut0 = sinkSeeds.length ? costFromSources(sinkSeeds, UPWIND, true, V0_FRESH, undefined, openingReach) : null;
    for (let c = 0; c < n3; c++) {
      if (sim.solid[c]) continue;
      if (sealedBeyondReach(c)) continue;
      const dK = Math.min(dFwd0 ? dFwd0[c] : Infinity, dOut0 ? dOut0[c] : Infinity);
      if (dK === Infinity) continue;
      dry[c] = DRY_UNVENTILATED * (1 - Math.exp(-dK / DRY_TAU));
    }
  }
  if (smellSeeds.length) {
    const dS = costFromSources(smellSeeds, UPWIND);
    // An opening cleans the air TWO ways, and a vent or a window does both:
    // it puts fresh air in, which then travels downwind; and it takes stale air
    // out, which cleans everything draining INTO it. The forward pass alone
    // missed the second one entirely — an extract emits nothing, so nothing
    // downstream of it existed, and the grille that is busy pulling the whole
    // kitchen's air outside was scoring no better than the middle of the room.
    // Whichever route reaches a cell sooner is the one that cleans it.
    const dFwd = sinkSeeds.length ? costFromSources(sinkSeeds, UPWIND, false, V0_FRESH, undefined, openingReach) : null;
    const dOut = sinkSeeds.length ? costFromSources(sinkSeeds, UPWIND, true, V0_FRESH, undefined, openingReach) : null;
    for (let c = 0; c < n3; c++) {
      if (sim.solid[c] || dS[c] === Infinity) continue;
      let v = Math.exp(-dS[c] / SMELL_TAU);
      const dK = sealedBeyondReach(c)
        ? Infinity
        : Math.min(dFwd ? dFwd[c] : Infinity, dOut ? dOut[c] : Infinity);
      if (dK !== Infinity) v *= 1 - Math.exp(-dK / FRESH_TAU);
      smell[c] = v;
    }
  }
  return { temp, smell, dry };
}

/** How long the SLOW parts of a room stay wet, in minutes.
 *
 *  The 90th percentile, not the maximum. A mean would let a well-aired doorway
 *  pay for a dead corner, which is the failure the task is about — but the
 *  outright maximum is worse: every room has one cell wedged behind the tub or
 *  under the shower screen that no arrangement can reach, and it pinned every
 *  layout to the same ~2.5 hours whatever the participant did. The 90th
 *  percentile still fails a genuinely stagnant corner while ignoring the single
 *  crevice nobody towels down.
 *
 *  Ignores the top of the room: a ceiling void would otherwise dominate, and
 *  nothing anyone cares about is drying up there. */
export function slowestDry(s: Sim3D, dry: Float32Array, rect: Rect): number {
  const { sim, nx, ny, nz, cellCenter, inside } = s;
  const vals: number[] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c] || !inside[c]) continue;
        const [x, y, z] = cellCenter(i, j, k);
        if (y > 2.0) continue;
        if (x < rect.x || x > rect.x + rect.w || z < rect.z || z > rect.z + rect.d) continue;
        vals.push(dry[c]);
      }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))];
}

/** Mean of a per-cell field over an arbitrary ZONE — a corner, a bed, a couch —
 *  rather than a whole room.
 *
 *  A room mean can look perfectly fine while the corner the air never reaches
 *  stays stale, and that corner is exactly what a ventilation task is about. It
 *  is also how a draught constraint has to be scored: what matters is the air
 *  over the pillow, not the average of the bedroom. `yRange` defaults to the
 *  occupied band (0.2–1.8 m), because nobody cares what the air is doing at
 *  ankle height under the bed or up against the ceiling. */
export function zoneMean(
  s: Sim3D,
  field: Float32Array,
  zone: Rect,
  yRange: [number, number] = [0.2, 1.8],
): number | null {
  const { sim, nx, ny, nz, cellCenter, inside } = s;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c] || !inside[c]) continue;
        const [x, y, z] = cellCenter(i, j, k);
        if (y < yRange[0] || y > yRange[1]) continue;
        if (x < zone.x || x > zone.x + zone.w || z < zone.z || z > zone.z + zone.d) continue;
        sum += field[c];
        n++;
      }
  return n > 0 ? sum / n : null;
}

/** Mean AIR SPEED over a zone — the draught measure. */
export function zoneSpeed(s: Sim3D, zone: Rect, yRange: [number, number] = [0.2, 1.8]): number | null {
  const { sim, nx, ny, nz, cellCenter, inside } = s;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c] || !inside[c]) continue;
        const [x, y, z] = cellCenter(i, j, k);
        if (y < yRange[0] || y > yRange[1]) continue;
        if (x < zone.x || x > zone.x + zone.w || z < zone.z || z > zone.z + zone.d) continue;
        const [u, v, w] = sim.velocityAt(i, j, k);
        sum += Math.hypot(u, v, w);
        n++;
      }
  return n > 0 ? sum / n : null;
}

/** Mean of a per-cell field over each room's interior air, keyed by room id.
 *  Solid and outdoor cells are excluded, so this is the value a person standing
 *  in the room would experience. */
export function roomMeans(s: Sim3D, field: Float32Array): Map<string, number> {
  const { sim, roomIndex, roomIds, inside } = s;
  const sum = new Float64Array(roomIds.length);
  const cnt = new Int32Array(roomIds.length);
  for (let c = 0; c < field.length; c++) {
    const r = roomIndex[c];
    if (r < 0 || !inside[c] || sim.solid[c]) continue;
    sum[r] += field[c];
    cnt[r]++;
  }
  const out = new Map<string, number>();
  for (let r = 0; r < roomIds.length; r++) if (cnt[r]) out.set(roomIds[r], sum[r] / cnt[r]);
  return out;
}

// Steady-state scalar field carried by the AIRFLOW: advection along the converged
// velocity field plus mixing (diffusion), so temperature / smell follow the air
// currents and fill the whole connected house. Sources hold their value, exterior
// openings vent to ambient (0), walls block. One-time relaxation on the frozen
// velocity — this is what "matches the airflow" at steady state.
export function advectDiffuseFill(
  s: Sim3D,
  fixed: Uint8Array,
  val: Float32Array,
  opts?: { iters?: number; kappa?: number; adv?: number; extraSink?: Uint8Array },
): Float32Array {
  const { sim, nx, ny, nz, ambient } = s;
  const extra = opts?.extraSink;
  const iters = opts?.iters ?? 320;
  const kappa = opts?.kappa ?? 0.32; // mixing strength (higher = spreads further)
  const adv = opts?.adv ?? 0.95; // cells moved per (m/s) per iteration
  const n3 = nx * ny * nz;
  const f = new Float32Array(n3);
  const tmp = new Float32Array(n3);
  for (let c = 0; c < n3; c++) if (fixed[c]) f[c] = val[c];
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

  const sample = (F: Float32Array, x: number, y: number, z: number, fb: number): number => {
    x = clamp(x, 0, nx - 1.001); y = clamp(y, 0, ny - 1.001); z = clamp(z, 0, nz - 1.001);
    const i0 = Math.floor(x), j0 = Math.floor(y), k0 = Math.floor(z);
    const tx = x - i0, ty = y - j0, tz = z - k0;
    const g = (i: number, j: number, k: number) => { const c = idx(i, j, k); return sim.solid[c] ? fb : F[c]; };
    const c00 = g(i0, j0, k0) * (1 - tx) + g(i0 + 1, j0, k0) * tx;
    const c10 = g(i0, j0 + 1, k0) * (1 - tx) + g(i0 + 1, j0 + 1, k0) * tx;
    const c01 = g(i0, j0, k0 + 1) * (1 - tx) + g(i0 + 1, j0, k0 + 1) * tx;
    const c11 = g(i0, j0 + 1, k0 + 1) * (1 - tx) + g(i0 + 1, j0 + 1, k0 + 1) * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  };

  for (let it = 0; it < iters; it++) {
    tmp.set(f);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = idx(i, j, k);
          if (sim.solid[c]) continue;
          if (fixed[c]) { f[c] = val[c]; continue; }
          if (ambient[c] || (extra && extra[c])) { f[c] = 0; continue; }
          // advect: trace back along the air velocity
          const uc = 0.5 * (sim.u[sim.uIdx(i, j, k)] + sim.u[sim.uIdx(i + 1, j, k)]);
          const vc = 0.5 * (sim.v[sim.vIdx(i, j, k)] + sim.v[sim.vIdx(i, j + 1, k)]);
          const wc = 0.5 * (sim.w[sim.wIdx(i, j, k)] + sim.w[sim.wIdx(i, j, k + 1)]);
          const adVal = sample(tmp, i - uc * adv, j - vc * adv, k - wc * adv, tmp[c]);
          // mix with neighbours (diffusion)
          let sum = 0, cnt = 0;
          if (i > 0 && !sim.solid[idx(i - 1, j, k)]) { sum += tmp[idx(i - 1, j, k)]; cnt++; }
          if (i < nx - 1 && !sim.solid[idx(i + 1, j, k)]) { sum += tmp[idx(i + 1, j, k)]; cnt++; }
          if (j > 0 && !sim.solid[idx(i, j - 1, k)]) { sum += tmp[idx(i, j - 1, k)]; cnt++; }
          if (j < ny - 1 && !sim.solid[idx(i, j + 1, k)]) { sum += tmp[idx(i, j + 1, k)]; cnt++; }
          if (k > 0 && !sim.solid[idx(i, j, k - 1)]) { sum += tmp[idx(i, j, k - 1)]; cnt++; }
          if (k < nz - 1 && !sim.solid[idx(i, j, k + 1)]) { sum += tmp[idx(i, j, k + 1)]; cnt++; }
          const diff = cnt > 0 ? sum / cnt : adVal;
          f[c] = adVal * (1 - kappa) + diff * kappa;
        }
  }
  return f;
}

