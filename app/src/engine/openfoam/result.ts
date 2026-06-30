// Accurate-engine result: the sampled OpenFOAM field, plus an adapter that
// turns it into a StableFluidSnapshot so the existing 3D visualization
// (streamlines, particles, temperature heatmap) renders accurate data with no
// changes to the viz layer.

import {
  createInitialSnapshot,
  ROOM,
  type StableFluidSnapshot,
} from '../../stableFluidSolver.ts'

// Must match the real-time solver grid so the snapshot adapter and viz line up.
export const OPENFOAM_GRID = { width: 32, height: 24, layers: 14 } as const
const AMBIENT_K = 297.15

export type OpenFoamRunStatus = 'ok' | 'mock' | 'error'

export interface OpenFoamResult {
  status: OpenFoamRunStatus
  /** Human-readable note (e.g. "OpenFOAM not installed — showing preview"). */
  message?: string
  /** Solver/meshing log tail, surfaced in the UI for real runs. */
  log?: string
  /** Wall-clock seconds the run took, when known. */
  seconds?: number
  grid?: {
    width: number
    height: number
    layers: number
    /** Velocity per cell, [vx,vy,vz] in m/s, in index3 order. */
    velocity: number[]
    /** Temperature per cell in Kelvin, in index3 order. */
    temperature: number[]
  }
}

function index3(x: number, y: number, z: number, width: number, height: number) {
  return (y * height + z) * width + x
}

/**
 * The exact world-space sample points the backend must evaluate, in index3
 * order, so `velocity[i]` lines up with cell `i` of the snapshot volume.
 * X = width, Y = height (up), Z = depth; origin at the room-floor centre.
 */
export function sampleGridPoints(): Array<[number, number, number]> {
  const { width, height, layers } = OPENFOAM_GRID
  const points: Array<[number, number, number]> = []
  for (let y = 0; y < layers; y += 1) {
    const wy = ((y + 0.5) / layers) * ROOM.height
    for (let z = 0; z < height; z += 1) {
      const wz = ((z + 0.5) / height) * ROOM.depth - ROOM.depth / 2
      for (let x = 0; x < width; x += 1) {
        const wx = ((x + 0.5) / width) * ROOM.width - ROOM.width / 2
        points.push([wx, wy, wz])
      }
    }
  }
  return points
}

/** Build a renderable snapshot from a sampled OpenFOAM field. */
export function openfoamResultToSnapshot(result: OpenFoamResult): StableFluidSnapshot | null {
  if (!result.grid) return null
  const { width, height, layers, velocity, temperature } = result.grid
  const snapshot = createInitialSnapshot(width, height, layers)
  const cellCount = width * height * layers

  for (let i = 0; i < cellCount; i += 1) {
    const vx = velocity[i * 3] ?? 0
    const vy = velocity[i * 3 + 1] ?? 0
    const vz = velocity[i * 3 + 2] ?? 0
    const base = i * 4
    snapshot.volumeVelocities[base] = vx
    snapshot.volumeVelocities[base + 1] = vy
    snapshot.volumeVelocities[base + 2] = vz
    snapshot.volumeVelocities[base + 3] = Math.hypot(vx, vy, vz)

    // Kelvin -> normalised 0..1 around ambient so the temperature heatmap and
    // colour ramp behave the same as the real-time engine.
    const t = temperature[i] ?? AMBIENT_K
    snapshot.volumeScalars.temperature[i] = clamp01(0.54 + (t - AMBIENT_K) / 40)
  }

  // Mirror solid cells from velocity==0 inside furniture is unnecessary here;
  // the snapshot's default flags already mark the room interior as fluid.
  snapshot.revision += 1
  return snapshot
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// Keep an explicit reference so callers importing only the type still pull the
// index helper's intent; also used by tests.
export const _internal = { index3 }
