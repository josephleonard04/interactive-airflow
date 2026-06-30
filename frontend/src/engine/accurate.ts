// Accurate engine for the home editor: run an OpenFOAM CFD pass on the house the
// user drew, via the local backend (see ../../../backend). Reuses the editor's
// own scene compiler (compileLfmScene) so the accurate run describes exactly the
// same room, walls, furniture, and devices as the live solver.
//
// When OpenFOAM isn't installed, the backend returns a fast approximate field
// (clearly labelled) so the two-engine experience works immediately.

import { compileLfmScene, type Box, type LfmScene } from "../bc/lfm";
import { buildSim3D, type Sim3D } from "../sim/sim3d";
import type { FloorPlan } from "../floorplan/types";

// Local backend (see ../../../backend). Override at runtime with
// window.OPENFOAM_BACKEND if you run it on a different host/port.
const BACKEND_URL =
  ((globalThis as { OPENFOAM_BACKEND?: string }).OPENFOAM_BACKEND ?? "http://127.0.0.1:8000").replace(/\/$/, "");

export interface BackendHealth {
  reachable: boolean;
  openfoam: boolean;
  version?: string;
}

export type AccurateStatus = "ok" | "mock" | "error";

export interface AccurateField {
  nx: number;
  ny: number;
  nz: number;
  /** Per-cell velocity [vx,vy,vz] in sim.cIdx order. */
  velocity: Float32Array;
  /** Per-cell temperature in Kelvin in sim.cIdx order. */
  temperature: Float32Array;
}

export interface AccurateResult {
  status: AccurateStatus;
  message?: string;
  log?: string;
  seconds?: number;
  /** Flux balance from the scene compiler, surfaced to the user. */
  balance: LfmScene["balance"];
  field?: AccurateField;
}

const center = (b: Box): [number, number, number] => [
  (b.min[0] + b.max[0]) / 2,
  (b.min[1] + b.max[1]) / 2,
  (b.min[2] + b.max[2]) / 2,
];
const radiusOf = (b: Box): number =>
  0.5 * Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);

// Map the editor's compiled scene into the backend's case.json schema (what the
// mock engine reads) plus the raw scene for the real OpenFOAM path.
function buildCaseFiles(scene: LfmScene): Record<string, string> {
  const mockCase = {
    name: scene.name,
    ambientTemperature: scene.ambientT,
    inlets: scene.inlets.map((i) => ({
      center: center(i.world),
      normal: i.normal,
      speed: i.speed,
      temperature: i.kind === "ac" ? scene.ambientT - 8 : scene.ambientT,
    })),
    outlets: scene.outlets.map((o) => ({ center: center(o.world) })),
    fans: scene.fans.map((f) => ({
      center: center(f.world),
      direction: f.normal,
      speed: Math.max(0.4, Math.min(2.2, f.flux / 0.2)),
      radius: radiusOf(f.world),
    })),
    heat: scene.heatSources.map((h) => ({
      center: center(h.world),
      radius: radiusOf(h.world),
      deltaT: h.deltaT,
    })),
  };
  return {
    "case.json": JSON.stringify(mockCase, null, 2),
    "scene.json": JSON.stringify(scene, null, 2),
    "README.md": `# Accurate (OpenFOAM) case for ${scene.name}\n\nGenerated from the home editor. Multi-room OpenFOAM mesh generation is a\nfollow-up; the backend currently returns an approximate field unless OpenFOAM\nis installed. Flux balance: ${scene.balance.inflow.toFixed(3)} in / ${scene.balance.outflow.toFixed(3)} out m^3/s.\n`,
  };
}

/** Cell-centre sample points in sim.cIdx order (i + nx*(j + ny*k)). */
function gridPoints(built: Sim3D): Array<[number, number, number]> {
  const { nx, ny, nz, cellCenter } = built;
  const points: Array<[number, number, number]> = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) points.push(cellCenter(i, j, k));
  return points;
}

export async function checkBackendHealth(signal?: AbortSignal): Promise<BackendHealth> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, { signal });
    if (!res.ok) return { reachable: true, openfoam: false };
    const data = (await res.json()) as { openfoam?: boolean; version?: string };
    return { reachable: true, openfoam: !!data.openfoam, version: data.version };
  } catch {
    return { reachable: false, openfoam: false };
  }
}

export async function runAccurate(plan: FloorPlan, signal?: AbortSignal): Promise<AccurateResult> {
  const scene = compileLfmScene(plan);
  const built = buildSim3D(plan);
  const points = gridPoints(built);
  const payload = {
    name: scene.name,
    files: buildCaseFiles(scene),
    grid: { width: built.nx, height: built.ny, layers: built.nz },
    points,
  };

  try {
    const res = await fetch(`${BACKEND_URL}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      return { status: "error", message: `Backend HTTP ${res.status}`, balance: scene.balance };
    }
    const data = (await res.json()) as {
      status: AccurateStatus;
      message?: string;
      log?: string;
      seconds?: number;
      grid?: { velocity: number[]; temperature: number[] };
    };
    const field: AccurateField | undefined = data.grid
      ? {
          nx: built.nx,
          ny: built.ny,
          nz: built.nz,
          velocity: Float32Array.from(data.grid.velocity),
          temperature: Float32Array.from(data.grid.temperature),
        }
      : undefined;
    return {
      status: data.status,
      message: data.message,
      log: data.log,
      seconds: data.seconds,
      balance: scene.balance,
      field,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { status: "error", message: "Run cancelled", balance: scene.balance };
    }
    return {
      status: "error",
      message:
        (err instanceof Error ? err.message : "Backend unreachable") +
        " — start it with backend\\run.ps1",
      balance: scene.balance,
    };
  }
}

/**
 * Write an accurate velocity field into a freshly built sim's MAC faces, so the
 * existing airflow visualization can render the CFD result. Cell-centred values
 * are pushed to the surrounding faces (a reasonable approximation for viz).
 */
export function applyFieldToSim(built: Sim3D, field: AccurateField): void {
  const { sim, nx, ny, nz } = built;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = sim.cIdx(i, j, k);
        if (sim.solid[c]) continue;
        const vx = field.velocity[c * 3];
        const vy = field.velocity[c * 3 + 1];
        const vz = field.velocity[c * 3 + 2];
        sim.u[sim.uIdx(i, j, k)] = vx;
        sim.u[sim.uIdx(i + 1, j, k)] = vx;
        sim.v[sim.vIdx(i, j, k)] = vy;
        sim.v[sim.vIdx(i, j + 1, k)] = vy;
        sim.w[sim.wIdx(i, j, k)] = vz;
        sim.w[sim.wIdx(i, j, k + 1)] = vz;
      }
}
