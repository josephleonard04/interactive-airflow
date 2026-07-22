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

const HEATER_T = 10; // heater (warm) and AC (cool) use equal magnitude
const AC_T = -10;
const POWER: Record<number, number> = { 1: 0.5, 2: 1.0, 3: 1.6 };
/** Fan thrust as an acceleration on the air in its cells (m/s²). Tuned so a
 *  medium fan settles at roughly 1 m/s in front of it in open air — about what
 *  a domestic pedestal fan does — while still being able to stall when it has
 *  nowhere to push. */
const FAN_FORCE = 14;

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
  const horizDir = (rotY: number): [number, number, number] => {
    const q = ((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4;
    return ([[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]] as [number, number, number][])[q];
  };
  const setFace = (i: number, j: number, k: number, dir: [number, number, number], speed: number) => {
    if (dir[0] !== 0) {
      const f = dir[0] > 0 ? sim.uIdx(i + 1, j, k) : sim.uIdx(i, j, k);
      sim.uFixed[f] = 1; sim.uVal[f] = dir[0] * speed;
    } else if (dir[1] !== 0) {
      const f = dir[1] > 0 ? sim.vIdx(i, j + 1, k) : sim.vIdx(i, j, k);
      sim.vFixed[f] = 1; sim.vVal[f] = dir[1] * speed;
    } else {
      const f = dir[2] > 0 ? sim.wIdx(i, j, k + 1) : sim.wIdx(i, j, k);
      sim.wFixed[f] = 1; sim.wVal[f] = dir[2] * speed;
    }
  };

  let hasTemperature = false;
  const seeds: Array<[number, number, number]> = [];
  const markers: Array<{ pos: [number, number, number]; kind: "hot" | "cold" }> = [];
  for (const it of plan.items) {
    const isAC = it.type === "ac";
    const isSupply = it.type === "supply";
    const isReturn = it.type === "return";
    const isFan = it.type === "fan";
    const isHeater = it.type === "heater";
    if (!isAC && !isSupply && !isReturn && !isFan && !isHeater) continue;
    if (it.on === false) continue;
    const mult = POWER[it.power ?? 2] ?? 1;
    const cells = cellsOf(itemAabb(it));
    if (isAC) markers.push({ pos: [...it.position] as [number, number, number], kind: "cold" });
    if (isHeater) markers.push({ pos: [...it.position] as [number, number, number], kind: "hot" });

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
            : horizDir(it.rotationY);
      // a RETURN vent sucks air OUT: same face, negated speed → air flows toward
      // the vent instead of away, pulling room air (and odour) into it. Pair a
      // supply in one room with a return in another and the air is drawn ACROSS
      // the house through the open doors — whole-house circulation.
      const mag = (isFan ? 1.0 : clampf((it.flow ?? 0) / 0.3, 0.4, 1.5)) * mult;
      const speed = isReturn ? -mag : mag;
      for (const [i, j, k] of cells) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c]) sim.solid[c] = 0;
        // only AC / supply generate air → seed airflow particles here; a fan only
        // pushes existing air and a return only removes it, so neither seeds
        if (isAC || isSupply) seeds.push(cellCenter(i, j, k));
        if (isFan) {
          // A FAN IS NOT A SOURCE OF AIR. It was modelled with fixed-velocity
          // faces, which PRESCRIBE the flow: the solver was ordered to hold
          // 1 m/s there no matter what the surrounding air was doing, so the fan
          // behaved like a vent that manufactures a jet and never loads up.
          // It is now a body force — it accelerates the air that is already in
          // the room, and the pressure projection routes the return path around
          // it. Blocked in, it stalls; in open air, it throws a jet. Nothing is
          // created, which is exactly the physical distinction.
          const F = FAN_FORCE * mult;
          if (dir[0] !== 0) {
            sim.uForce[sim.uIdx(i, j, k)] += dir[0] * F;
            sim.uForce[sim.uIdx(i + 1, j, k)] += dir[0] * F;
          } else {
            sim.wForce[sim.wIdx(i, j, k)] += dir[2] * F;
            sim.wForce[sim.wIdx(i, j, k + 1)] += dir[2] * F;
          }
          // An oscillating fan sweeps side to side. Averaged over the sweep that
          // is a broader, weaker push, so spread part of the force laterally
          // rather than adding more of it — a sweeping fan does not move MORE
          // air than a fixed one, it spreads the same air over a wider arc.
          if (it.oscillate) {
            const lat = F * 0.45;
            if (dir[0] !== 0) {
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
          setFace(i, j, k, dir, speed);
        }
      }
    }
    if (isAC || isHeater) {
      const dT = (isAC ? AC_T : HEATER_T) * mult;
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

  // Smell sources the user placed in the scene (drag-and-drop icons). These are
  // the base smell sources; setSource can add a whole-room source on top.
  const baseSmell: number[] = [];
  for (const it of plan.items) {
    if (it.type !== "smell" || it.on === false) continue;
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

  return { sim, nx, ny, nz, dx, origin, worldToCell, cellCenter, setSource, ambient, ventDilute, hasTemperature, inside, roomIndex, roomIds, seeds, markers };
}

// Per-grid steady-state temperature & air-quality by GEODESIC DISTANCE from the
// sources through connected air. This replaces the slow diffusion relaxation
// (which needed thousands of iterations to cross the house): a multi-source BFS
// gives every cell its distance-to-source *through open doorways, blocked by
// walls and closed doors*, and the value falls off exponentially with that
// distance. So a heater/AC fills its whole connected part of the house (hot near
// the source, cooler further away, nothing past a shut door), and smell reads
// low near open windows / vents (fresh-air sinks). O(cells) — instant.
export function geodesicFields(s: Sim3D): { temp: Float32Array; smell: Float32Array } {
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
  const V0 = 0.6;    // base diffusive spread (m/s) — dominant, fills the house
  const KADV = 0.5;  // airflow bias on top of the base spread (carries downwind)
  const costFromSources = (seeds: number[]): Float64Array => {
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
    for (const c of seeds) if (!sim.solid[c] && dist[c] === Infinity) { dist[c] = 0; push(0, c); }
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
        const vd = u * di + v * dj + w * dk; // flow component along the move
        const speed = V0 + KADV * Math.max(0, vd);
        const nc = cost + dx / speed;
        if (nc < dist[cc]) { dist[cc] = nc; push(nc, cc); }
      }
    }
    return dist;
  };

  const TAU = 12;        // temperature decay time (s) — fills a house, keeps a gradient
  const SMELL_TAU = 9;
  const SINK_LAMBDA = 0.7; // smell drops to ~0 within ~3 cells of an open window/vent

  // temperature: hot (heater) & cold (AC) sources carried by the airflow
  const hotSeeds: number[] = [], coldSeeds: number[] = [];
  let hotMag = 0, coldMag = 0;
  for (let c = 0; c < n3; c++) if (sim.tempFixed[c]) {
    if (sim.tempVal[c] > 0) { hotSeeds.push(c); hotMag = Math.max(hotMag, sim.tempVal[c]); }
    else if (sim.tempVal[c] < 0) { coldSeeds.push(c); coldMag = Math.max(coldMag, -sim.tempVal[c]); }
  }
  const dHot = hotSeeds.length ? costFromSources(hotSeeds) : null;
  const dCold = coldSeeds.length ? costFromSources(coldSeeds) : null;
  const temp = new Float32Array(n3);
  for (let c = 0; c < n3; c++) {
    if (sim.solid[c]) continue;
    let t = 0;
    if (dHot && dHot[c] !== Infinity) t += hotMag * Math.exp(-dHot[c] / TAU);
    if (dCold && dCold[c] !== Infinity) t -= coldMag * Math.exp(-dCold[c] / TAU);
    temp[c] = t;
  }

  // air quality: smell carried from the source by the airflow; near a window/vent
  // sink it drops to ~0 (odour leaves, fresh air enters); a shut door blocks it.
  const smellSeeds: number[] = [], sinkSeeds: number[] = [];
  for (let c = 0; c < n3; c++) {
    if (sim.sFixed[c]) smellSeeds.push(c);
    if (ambient[c] || ventDilute[c]) sinkSeeds.push(c);
  }
  const smell = new Float32Array(n3);
  if (smellSeeds.length) {
    const dS = costFromSources(smellSeeds);
    const dK = sinkSeeds.length ? bfs(sinkSeeds) : null;
    for (let c = 0; c < n3; c++) {
      if (sim.solid[c] || dS[c] === Infinity) continue;
      let v = Math.exp(-dS[c] / SMELL_TAU);
      if (dK && dK[c] !== Infinity) v *= 1 - Math.exp(-dK[c] / SINK_LAMBDA);
      smell[c] = v;
    }
  }
  return { temp, smell };
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

