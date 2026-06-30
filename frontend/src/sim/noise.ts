import type { FloorPlan } from "../floorplan/types";
import type { Sim3D } from "./sim3d";

// Appliance noise field. Noise does not flow like air — it radiates from each
// running appliance (AC, fan, heater, fridge, TV) and falls off with distance,
// attenuated further by each wall in between. We sum source energies (dB add in
// the energy domain), then normalise to a 0..1 field the haze layer can colour.

const SOURCE_DB: Record<string, number> = {
  ac: 47,
  fan: 40,
  heater: 34,
  fridge: 43,
  tv: 52,
};
const POWER_BOOST: Record<number, number> = { 1: 0, 2: 3, 3: 6 };
const WALL_LOSS_DB = 7; // attenuation per wall between source and listener
const DB_MIN = 33;
const DB_MAX = 70;

/** Count walls (solid runs) on the straight 2D line from (x0,z0) to (x1,z1). */
function wallsBetween(s: Sim3D, x0: number, z0: number, x1: number, z1: number, j: number): number {
  const { sim, dx, worldToCell } = s;
  const d = Math.hypot(x1 - x0, z1 - z0);
  const steps = Math.max(1, Math.ceil(d / (dx * 0.5)));
  let walls = 0;
  let inWall = false;
  for (let t = 1; t <= steps; t++) {
    const f = t / steps;
    const [i, , k] = worldToCell(x0 + (x1 - x0) * f, 0, z0 + (z1 - z0) * f);
    const solid = sim.solid[sim.cIdx(i, j, k)] === 1;
    if (solid && !inWall) walls++;
    inWall = solid;
  }
  return walls;
}

/**
 * Per-cell noise field (0..1), broadcast uniformly over height so the existing
 * top-down haze layer renders it like temperature/smell.
 */
export function computeNoiseField(plan: FloorPlan, s: Sim3D): Float32Array {
  const { sim, nx, ny, nz, cellCenter } = s;

  const sources: Array<{ x: number; z: number; L: number }> = [];
  for (const it of plan.items) {
    const base = SOURCE_DB[it.type];
    if (base === undefined) continue;
    const isHvac = it.type === "ac" || it.type === "fan" || it.type === "heater";
    if (isHvac && it.on === false) continue;
    let L = base;
    if (isHvac) L += POWER_BOOST[it.power ?? 2] ?? 3;
    if (it.type === "fan" && it.oscillate) L += 2;
    sources.push({ x: it.position[0], z: it.position[2], L });
  }

  const out = new Float32Array(nx * ny * nz);
  if (sources.length === 0) return out;

  const jMid = Math.max(1, Math.min(ny - 2, Math.round(ny * 0.4)));
  const map2d = new Float32Array(nx * nz);
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) {
      const [cx, , cz] = cellCenter(i, jMid, k);
      let energy = 1e-6;
      for (const src of sources) {
        const dist = Math.hypot(cx - src.x, cz - src.z);
        const walls = wallsBetween(s, src.x, src.z, cx, cz, jMid);
        const L = src.L - 20 * Math.log10(dist + 1) - WALL_LOSS_DB * walls;
        energy += Math.pow(10, L / 10);
      }
      const dB = 10 * Math.log10(energy);
      map2d[i + nx * k] = Math.max(0, Math.min(1, (dB - DB_MIN) / (DB_MAX - DB_MIN)));
    }

  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        out[sim.cIdx(i, j, k)] = map2d[i + nx * k];
      }
  return out;
}
