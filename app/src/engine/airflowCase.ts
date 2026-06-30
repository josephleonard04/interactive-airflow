// Engine-neutral description of the airflow problem.
//
// Both simulation engines consume this single structure:
//   - the real-time engine (CPU Stable Fluids) drives the live view, and
//   - the accurate engine (OpenFOAM) is generated from the very same case.
// Keeping one source of truth guarantees the two engines describe the same
// physical room, devices and obstacles — only the fidelity differs.
//
// Coordinates are in metres, matching the 3D scene and the Stable Fluids
// solver: X = width, Y = height (up), Z = depth. The world origin is the
// centre of the room floor, so the room spans
//   x in [-width/2, +width/2], y in [0, height], z in [-depth/2, +depth/2].

import { ROOM, type DeviceState, type FlowLayout } from '../stableFluidSolver.ts'

export interface RoomDims {
  width: number
  height: number
  depth: number
}

/** A rotated axis-aligned box obstacle (furniture footprint extruded to h). */
export interface BoxObstacle {
  id: string
  cx: number
  cz: number
  w: number
  d: number
  h: number
  yaw: number
}

/** A supply patch on a wall: cool/neutral air pushed into the room. */
export interface InletPatch {
  id: string
  label: string
  center: [number, number, number]
  /** Patch extent on the wall plane: [horizontal, vertical] in metres. */
  size: [number, number]
  /** Unit flow direction into the room. */
  normal: [number, number, number]
  /** Inlet speed in m/s. */
  speed: number
  /** Supply air temperature in Kelvin. */
  temperature: number
}

/** An exhaust patch on a wall: air leaves the room (pressure outlet). */
export interface OutletPatch {
  id: string
  label: string
  center: [number, number, number]
  size: [number, number]
  normal: [number, number, number]
}

/** A free-standing fan modelled as an in-room momentum (jet) source. */
export interface MomentumSource {
  id: string
  label: string
  center: [number, number, number]
  direction: [number, number, number]
  /** Target jet speed in m/s. */
  speed: number
  /** Influence radius of the jet in metres. */
  radius: number
}

/** A localised heat source (warm body / lamp) used for buoyancy. */
export interface HeatSource {
  id: string
  center: [number, number, number]
  radius: number
  /** Temperature offset from ambient in Kelvin (positive = warming). */
  deltaT: number
}

export interface AirflowCase {
  name: string
  room: RoomDims
  /** Ambient (initial) air temperature in Kelvin. */
  ambientTemperature: number
  inlets: InletPatch[]
  outlets: OutletPatch[]
  fans: MomentumSource[]
  heat: HeatSource[]
  obstacles: BoxObstacle[]
}

// Device speed (0..100 UI units) → physical speed (m/s). These match the jet
// magnitudes the Stable Fluids solver injects, so the live preview and the
// accurate run start from the same momentum budget.
const AC_MAX_SPEED = 1.55
const FAN_MAX_SPEED = 2.2
const AMBIENT_K = 297.15 // 24 C
const AC_SUPPLY_DELTA = 8 // AC supplies air 8 K below ambient

/**
 * Build the engine-neutral case from the current scene transforms and device
 * state. `buildFlowLayout` already resolves device/obstacle world positions for
 * the real-time solver, so we reuse it rather than re-deriving geometry.
 */
export function buildAirflowCase(
  layout: FlowLayout,
  devices: DeviceState,
  name = 'living-room',
): AirflowCase {
  const room: RoomDims = { width: ROOM.width, height: ROOM.height, depth: ROOM.depth }

  const inlets: InletPatch[] = []
  const outlets: OutletPatch[] = []
  const fans: MomentumSource[] = []
  const heat: HeatSource[] = []

  // Wall air conditioner → cool supply inlet on the rear wall.
  if (devices.ac.enabled && devices.ac.speed > 0) {
    inlets.push({
      id: 'ac',
      label: 'Wall AC supply',
      center: [layout.ac.x, layout.ac.y, layout.ac.z],
      size: [0.9, 0.32],
      normal: normalize([layout.ac.directionX, 0, layout.ac.directionZ]),
      speed: (devices.ac.speed / 100) * AC_MAX_SPEED,
      temperature: AMBIENT_K - AC_SUPPLY_DELTA,
    })
  }

  // Exhaust vent → pressure outlet on the rear wall (normal points out of room).
  if (devices.vent.enabled && devices.vent.speed > 0) {
    outlets.push({
      id: 'vent',
      label: 'Exhaust vent',
      center: [layout.vent.x, layout.vent.y, layout.vent.z],
      size: [0.7, 0.3],
      normal: [0, 0, -1],
    })
  }

  // Standing fan → in-room jet. Direction matches the Stable Fluids convention
  // (see stableFluidSolver: directionX = -cos(yaw), directionZ = sin(yaw)).
  if (devices.fan.enabled && devices.fan.speed > 0) {
    const yaw = layout.fan.rotation
    fans.push({
      id: 'fan',
      label: 'Standing fan',
      center: [layout.fan.x, 1.1, layout.fan.z],
      direction: normalize([-Math.cos(yaw), 0, Math.sin(yaw)]),
      speed: (devices.fan.speed / 100) * FAN_MAX_SPEED,
      radius: 0.55,
    })
  }

  // Temperature scalar sources (lamp, warm bodies) → buoyant heat sources.
  for (const source of layout.scalarSources ?? []) {
    if (source.field !== 'temperature') continue
    heat.push({
      id: `heat-${heat.length}`,
      center: [source.x, source.y, source.z],
      radius: source.radius,
      // target is a normalised 0..1 scalar; map the warm offset to a few K.
      deltaT: Math.max(0, source.target - 0.54) * 18,
    })
  }

  const obstacles: BoxObstacle[] = (layout.obstacles ?? []).map((o, i) => ({
    id: `obstacle-${i}`,
    cx: o.x,
    cz: o.z,
    w: o.w,
    d: o.d,
    h: o.h ?? 1,
    yaw: o.rotation,
  }))

  return {
    name,
    room,
    ambientTemperature: AMBIENT_K,
    inlets,
    outlets,
    fans,
    heat,
    obstacles,
  }
}

function normalize([x, y, z]: [number, number, number]): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1
  return [x / length, y / length, z / length]
}
