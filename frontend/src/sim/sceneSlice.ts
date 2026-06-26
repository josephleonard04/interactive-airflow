import { compileLfmScene, type Box } from "../bc/lfm";
import type { FloorPlan, PlacedItem, Rect } from "../floorplan/types";
import { Euler2D } from "./euler2d";

// Project the editor's home onto a top-down (x–z) slice and configure a 2D Euler
// solver from it:
//   - walls + furniture crossing the slice  -> solids
//   - AC / fan                              -> directed momentum jets (they push air)
//   - open exterior windows / doors         -> free boundary cells (air leaves/enters here)
//   - open interior doors                   -> fluid gaps (air passes between rooms)
//   - heater (hot) / AC (cold)              -> temperature sources
//   - a chosen room                         -> contaminant source
//
// The jets + open boundaries (instead of forced per-window sinks) are what make the
// flow physical: air routes between rooms through open doors, and recirculates
// rather than running straight to the nearest window.

export interface SliceOptions {
  sliceY?: number;
  targetCells?: number;
  iterations?: number;
}

export interface Slice {
  sim: Euler2D;
  nx: number;
  ny: number;
  dx: number;
  originX: number;
  originZ: number;
  bounds: Rect;
  worldToCell: (wx: number, wz: number) => [number, number];
  setSource: (rect: Rect | null) => void;
  hasTemperature: boolean;
}

const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clampf = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const HEATER_T = 12; // K above ambient
const AC_T = -8; // K below ambient (AC cools)
const POWER: Record<number, number> = { 1: 0.5, 2: 1.0, 3: 1.6 }; // low / med / high

export function buildSlice(plan: FloorPlan, opts: SliceOptions = {}): Slice {
  const scene = compileLfmScene(plan);
  const { gridDim, dx: dx0, gridOrigin } = scene.domain;

  let nx = gridDim[0];
  let ny = gridDim[2];
  let dx = dx0;
  const target = opts.targetCells ?? 14000;
  if (nx * ny > target) {
    const f = Math.ceil(Math.sqrt((nx * ny) / target));
    nx = Math.ceil(nx / f);
    ny = Math.ceil(ny / f);
    dx = dx0 * f;
  }
  const originX = gridOrigin[0];
  const originZ = gridOrigin[2];
  const sliceY = opts.sliceY ?? Math.min(1.2, plan.wallHeight * 0.5);

  const sim = new Euler2D({ nx, ny, dx, iterations: opts.iterations ?? 50 });

  const worldToCell = (wx: number, wz: number): [number, number] => [
    clampi(Math.floor((wx - originX) / dx), 0, nx - 1),
    clampi(Math.floor((wz - originZ) / dx), 0, ny - 1),
  ];
  const spansSlice = (b: Box) => b.min[1] <= sliceY && b.max[1] >= sliceY;
  const footprint = (b: Box): Array<[number, number]> => {
    const [i0, j0] = worldToCell(b.min[0], b.min[2]);
    const [i1, j1] = worldToCell(b.max[0], b.max[2]);
    const cells: Array<[number, number]> = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells.push([i, j]);
    return cells;
  };

  // solids
  for (const s of scene.solids) {
    if (!spansSlice(s.world)) continue;
    for (const [i, j] of footprint(s.world)) sim.solid[sim.cIdx(i, j)] = 1;
  }

  // open boundaries: open exterior windows/doors (scene.outlets are exactly those)
  for (const p of scene.outlets) {
    for (const [i, j] of footprint(p.world)) {
      const c = sim.cIdx(i, j);
      sim.solid[c] = 0;
      sim.open[c] = 1;
    }
  }

  // directed jets from AC + fans (horizontal facing from yaw); ceiling supply is
  // out-of-plane in a top-down slice, so it's skipped here (shown in 3D).
  const itemAabb = (it: PlacedItem): Box => {
    const [cx, cy, cz] = it.position;
    const [sw, sh, sd] = it.size;
    const q = ((Math.round(it.rotationY / (Math.PI / 2)) % 4) + 4) % 4;
    const ex = q === 1 || q === 3 ? sd : sw;
    const ez = q === 1 || q === 3 ? sw : sd;
    return { min: [cx - ex / 2, cy - sh / 2, cz - ez / 2], max: [cx + ex / 2, cy + sh / 2, cz + ez / 2] };
  };
  const horizDir = (rotY: number): [number, number] => {
    const q = ((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4;
    return ([[0, 1], [1, 0], [0, -1], [-1, 0]] as [number, number][])[q]; // (dx, dz)
  };

  // HVAC devices are projected onto the slice regardless of mount height (their
  // effect applies to the room plane). Each honours on/off + power level.
  let hasTemperature = false;
  for (const it of plan.items) {
    const isAC = it.type === "ac";
    const isFan = it.type === "fan";
    const isHeater = it.type === "heater";
    if (!isAC && !isFan && !isHeater) continue;
    if (it.on === false) continue; // turned off
    const mult = POWER[it.power ?? 2] ?? 1;
    const box = itemAabb(it);
    const cells = footprint(box);

    if (isAC || isFan) {
      const [dxh, dzh] = horizDir(it.rotationY);
      const speed = (isAC ? clampf((it.flow ?? 0) / 0.3, 0.4, 1.5) : 1.0) * mult;
      for (const [i, j] of cells) {
        if (sim.solid[sim.cIdx(i, j)]) sim.solid[sim.cIdx(i, j)] = 0; // a vent isn't a wall
        // momentum jet, net-zero mass: set both faces along the flow axis
        if (dxh !== 0) {
          const val = dxh * speed;
          sim.uFixed[sim.uIdx(i, j)] = 1; sim.uVal[sim.uIdx(i, j)] = val;
          sim.uFixed[sim.uIdx(i + 1, j)] = 1; sim.uVal[sim.uIdx(i + 1, j)] = val;
        } else {
          const val = dzh * speed;
          sim.vFixed[sim.vIdx(i, j)] = 1; sim.vVal[sim.vIdx(i, j)] = val;
          sim.vFixed[sim.vIdx(i, j + 1)] = 1; sim.vVal[sim.vIdx(i, j + 1)] = val;
        }
      }
    }
    if (isAC || isHeater) {
      const dT = (isAC ? AC_T : HEATER_T) * mult;
      for (const [i, j] of cells) {
        const c = sim.cIdx(i, j);
        if (sim.solid[c]) continue;
        sim.tempFixed[c] = 1;
        sim.tempVal[c] = dT;
        hasTemperature = true;
      }
    }
  }

  const setSource = (rect: Rect | null) => {
    sim.sFixed.fill(0);
    sim.sVal.fill(0);
    if (!rect) return;
    const [i0, j0] = worldToCell(rect.x, rect.z);
    const [i1, j1] = worldToCell(rect.x + rect.w, rect.z + rect.d);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = sim.cIdx(i, j);
        if (sim.solid[c] || sim.open[c]) continue;
        sim.sFixed[c] = 1;
        sim.sVal[c] = 1;
      }
  };

  return { sim, nx, ny, dx, originX, originZ, bounds: plan.bounds, worldToCell, setSource, hasTemperature };
}
