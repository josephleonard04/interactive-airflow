import * as THREE from 'three'
import type { ObjectTransform } from '../state/appTypes'
import type { createSampler } from '../stableFluidSolver'

export type AirflowSampler = ReturnType<typeof createSampler>

export function getFanParticleOrigin(transform: ObjectTransform): [number, number, number] {
  const yaw = transform.rotation[1]
  const directionX = -Math.cos(yaw)
  const directionZ = Math.sin(yaw)

  return [transform.position[0] + directionX * 0.38, 1.62, transform.position[2] + directionZ * 0.38]
}

export interface StreamlinePaths {
  /** Segment endpoint pairs (even length) ready for a fat-line in segments mode. */
  points: THREE.Vector3[]
  /** Per-vertex colours (speed gradient), matching `points`. */
  colors: THREE.Color[]
}

const ROOM_BOUNDS = { x: 4.72, yLow: 0.18, yHigh: 2.62, z: 3.42 }
const SPEED_REF = 0.06 // normalises sampled speed -> 0..1 for the colour ramp

// One advection step (clamped) of the flow field at `point`, including a jet
// bias near the source and a touch of swirl. Returned as a world-space delta.
function flowStep(
  sampler: AirflowSampler,
  point: THREE.Vector3,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  side: THREE.Vector3,
  sourceStrength: number,
  phase: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const velocity = sampler(point.x, point.y, point.z)
  const distanceFromFan = Math.max(0, point.clone().sub(origin).dot(direction))
  const jetBias = Math.max(0, 1 - distanceFromFan / 2.8) * sourceStrength * 0.42
  const swirl = Math.sin(phase) * 0.05 * Math.max(0.2, 1 - distanceFromFan / 4.2)
  out.set(
    velocity.x * 70 + direction.x * jetBias + side.x * swirl,
    velocity.y * 48,
    velocity.z * 70 + direction.z * jetBias + side.z * swirl,
  )
  if (out.lengthSq() < 0.0004) out.copy(direction).multiplyScalar(0.1 * sourceStrength)
  return out.clampLength(0.04, 0.16)
}

function colorAt(
  sampler: AirflowSampler,
  point: THREE.Vector3,
  base: THREE.Color,
  hot: THREE.Color,
  out: THREE.Color,
): THREE.Color {
  const s = sampler(point.x, point.y, point.z).speed
  const norm = Math.min(1, s / SPEED_REF)
  return out.copy(base).lerp(hot, norm * 0.78)
}

/**
 * Build smooth, speed-coloured streamlines. Paths are integrated with a midpoint
 * (RK2) step for stability, then resampled along a Catmull-Rom curve so the
 * rendered lines are smooth curves rather than jagged segments.
 */
export function buildStreamlinePaths({
  density,
  enabled,
  fanTransform,
  origin,
  sampler,
  speed,
  spread,
  color,
}: {
  density: number
  enabled: boolean
  fanTransform: ObjectTransform
  origin: [number, number, number]
  sampler: AirflowSampler
  speed: number
  spread: number
  color: string
}): StreamlinePaths {
  const points: THREE.Vector3[] = []
  const colors: THREE.Color[] = []
  if (!enabled) return { points, colors }

  const yaw = fanTransform.rotation[1]
  const direction = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw)).normalize()
  const side = new THREE.Vector3(-direction.z, 0, direction.x).normalize()
  const up = new THREE.Vector3(0, 1, 0)
  const originVec = new THREE.Vector3(...origin)
  const sourceStrength = speed / 100
  const base = new THREE.Color(color)
  const hot = new THREE.Color('#f3fbff')
  const seedRadius = Math.max(2, Math.min(5, Math.round(2 + density * 2)))
  const maxSeedDistance = seedRadius * 1.62

  const s1 = new THREE.Vector3()
  const s2 = new THREE.Vector3()
  const mid = new THREE.Vector3()

  const inBounds = (p: THREE.Vector3) =>
    p.x > -ROOM_BOUNDS.x &&
    p.x < ROOM_BOUNDS.x &&
    p.y > ROOM_BOUNDS.yLow &&
    p.y < ROOM_BOUNDS.yHigh &&
    p.z > -ROOM_BOUNDS.z &&
    p.z < ROOM_BOUNDS.z

  for (let row = -seedRadius; row <= seedRadius; row += 1) {
    for (let column = -seedRadius; column <= seedRadius; column += 1) {
      if (Math.abs(row) + Math.abs(column) > maxSeedDistance) continue

      const point = new THREE.Vector3(...origin)
        .addScaledVector(direction, -0.16 + ((row + seedRadius) % 2) * 0.035)
        .addScaledVector(side, (column / seedRadius) * spread * 0.42)
        .addScaledVector(up, (row / seedRadius) * spread * 0.34)

      const raw: THREE.Vector3[] = [point.clone()]
      const stepCount = Math.round(46 + density * 26)

      for (let step = 0; step < stepCount; step += 1) {
        if (sampler(point.x, point.y, point.z).solid || !inBounds(point)) break
        const phase = (row + column) * 1.73 + step * 0.32
        // RK2: sample the field at the midpoint of an Euler step.
        flowStep(sampler, point, originVec, direction, side, sourceStrength, phase, s1)
        mid.copy(point).addScaledVector(s1, 0.5)
        flowStep(sampler, mid, originVec, direction, side, sourceStrength, phase, s2)
        const next = point.clone().add(s2)
        if (sampler(next.x, next.y, next.z).solid) break
        raw.push(next)
        point.copy(next)
      }

      if (raw.length < 3) continue

      // Resample along a smooth curve so the polyline reads as a clean arc.
      const curve = new THREE.CatmullRomCurve3(raw, false, 'centripetal')
      const divisions = Math.min(72, raw.length * 3)
      const smooth = curve.getPoints(divisions)

      const c0 = new THREE.Color()
      const c1 = new THREE.Color()
      for (let i = 0; i < smooth.length - 1; i += 1) {
        points.push(smooth[i], smooth[i + 1])
        colors.push(
          colorAt(sampler, smooth[i], base, hot, c0).clone(),
          colorAt(sampler, smooth[i + 1], base, hot, c1).clone(),
        )
      }
    }
  }

  return { points, colors }
}

export function resetParticle(
  positions: Float32Array,
  ages: Float32Array,
  randoms: Float32Array,
  index: number,
  origin: [number, number, number],
  yaw: number,
  spread: number,
) {
  const base = index * 3
  const randomBase = index * 5
  const directionX = -Math.cos(yaw)
  const directionZ = Math.sin(yaw)
  const sideX = -directionZ
  const sideZ = directionX
  const sideOffset = randoms[randomBase] * spread * 0.58
  const heightOffset = randoms[randomBase + 1] * spread * 0.72
  const streamOffset = randoms[randomBase + 2] * 0.52

  positions[base] = origin[0] + sideX * sideOffset - directionX * streamOffset
  positions[base + 1] = origin[1] + heightOffset
  positions[base + 2] = origin[2] + sideZ * sideOffset - directionZ * streamOffset
  ages[index] = randoms[randomBase + 4] * 2.8
}
