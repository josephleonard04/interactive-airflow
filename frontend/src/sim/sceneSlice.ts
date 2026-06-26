import { compileLfmScene, type Box } from "../bc/lfm";
import type { FloorPlan, Rect } from "../floorplan/types";
import { Euler2D } from "./euler2d";

// Project the editor's home onto a top-down (x–z) slice and configure a 2D Euler
// solver from it: walls + furniture become solids, vents/AC become divergence
// sources, open exterior windows/doors become sinks (mass-balanced), and a chosen
// room can emit a contaminant tracer. The source/sink model sidesteps imposing
// per-face velocities — the flow field emerges from the pressure solve, which is
// the robust thing for interactive HVAC-style inflow/outflow.

export interface SliceOptions {
  sliceY?: number; // height of the horizontal slice (m)
  targetCells?: number; // coarsen the grid to about this many cells for real-time 2D
  iterations?: number;
}

export interface Slice {
  sim: Euler2D;
  nx: number;
  ny: number; // along world z
  dx: number;
  originX: number;
  originZ: number;
  bounds: Rect;
  worldToCell: (wx: number, wz: number) => [number, number];
  /** Set (or clear) the contaminant source to a room's footprint. */
  setSource: (rect: Rect | null) => void;
}

const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function buildSlice(plan: FloorPlan, opts: SliceOptions = {}): Slice {
  const scene = compileLfmScene(plan);
  const { gridDim, dx: dx0, gridOrigin } = scene.domain;

  // top-down uses world x (gridDim[0]) and world z (gridDim[2])
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

  // cells covered by a world box's x–z footprint
  const footprint = (b: Box): Array<[number, number]> => {
    const [i0, j0] = worldToCell(b.min[0], b.min[2]);
    const [i1, j1] = worldToCell(b.max[0], b.max[2]);
    const cells: Array<[number, number]> = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells.push([i, j]);
    return cells;
  };

  // solids (only those crossing the slice height)
  for (const s of scene.solids) {
    if (!spansSlice(s.world)) continue;
    for (const [i, j] of footprint(s.world)) sim.solid[sim.cIdx(i, j)] = 1;
  }

  // inlets -> divergence sources (skip those whose footprint fell entirely on solid)
  const inletCells: Array<[number, number]> = [];
  let sourceTotal = 0;
  for (const p of scene.inlets) {
    if (!spansSlice(p.world) && Math.abs(p.normal[1]) < 0.5) continue; // out-of-slice in-plane vent
    for (const [i, j] of footprint(p.world)) {
      const c = sim.cIdx(i, j);
      if (sim.solid[c]) sim.solid[c] = 0; // a vent is an opening, not a wall
      sim.divTarget[c] += p.speed;
      sourceTotal += p.speed;
      inletCells.push([i, j]);
    }
  }

  // outlets -> divergence sinks, sharing the total so Σ divTarget = 0
  const outletCells: Array<[number, number]> = [];
  for (const p of scene.outlets) {
    for (const [i, j] of footprint(p.world)) {
      const c = sim.cIdx(i, j);
      if (sim.solid[c]) sim.solid[c] = 0;
      outletCells.push([i, j]);
    }
  }
  if (outletCells.length > 0 && sourceTotal > 0) {
    const per = -sourceTotal / outletCells.length;
    for (const [i, j] of outletCells) sim.divTarget[sim.cIdx(i, j)] += per;
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
        if (sim.solid[c]) continue;
        sim.sFixed[c] = 1;
        sim.sVal[c] = 1;
      }
  };

  return { sim, nx, ny, dx, originX, originZ, bounds: plan.bounds, worldToCell, setSource };
}
