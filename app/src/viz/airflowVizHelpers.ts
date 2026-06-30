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

export function buildStreamlineGeometry({
  density,
  enabled,
  fanTransform,
  origin,
  sampler,
  speed,
  spread,
}: {
  density: number
  enabled: boolean
  fanTransform: ObjectTransform
  origin: [number, number, number]
  sampler: AirflowSampler
  speed: number
  spread: number
}) {
  const positions: number[] = []

  if (!enabled) {
    const emptyGeometry = new THREE.BufferGeometry()
    emptyGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3))
    return emptyGeometry
  }

  const yaw = fanTransform.rotation[1]
  const direction = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw)).normalize()
  const side = new THREE.Vector3(-direction.z, 0, direction.x).normalize()
  const up = new THREE.Vector3(0, 1, 0)
  const sourceStrength = speed / 100
  const seeds: THREE.Vector3[] = []
  const seedRadius = Math.max(2, Math.min(5, Math.round(2 + density * 2)))
  const maxSeedDistance = seedRadius * 1.62

  for (let row = -seedRadius; row <= seedRadius; row += 1) {
    for (let column = -seedRadius; column <= seedRadius; column += 1) {
      if (Math.abs(row) + Math.abs(column) > maxSeedDistance) {
        continue
      }

      const seed = new THREE.Vector3(...origin)
        .addScaledVector(direction, -0.16 + ((row + seedRadius) % 2) * 0.035)
        .addScaledVector(side, (column / seedRadius) * spread * 0.42)
        .addScaledVector(up, (row / seedRadius) * spread * 0.34)
      seeds.push(seed)
    }
  }

  seeds.forEach((seed, seedIndex) => {
    const point = seed.clone()
    const stepCount = Math.round(38 + density * 22)

    for (let step = 0; step < stepCount; step += 1) {
      const velocity = sampler(point.x, point.y, point.z)

      if (
        velocity.solid ||
        point.x < -4.72 ||
        point.x > 4.72 ||
        point.y < 0.18 ||
        point.y > 2.62 ||
        point.z < -3.42 ||
        point.z > 3.42
      ) {
        break
      }

      const distanceFromFan = Math.max(0, point.clone().sub(new THREE.Vector3(...origin)).dot(direction))
      const jetBias = Math.max(0, 1 - distanceFromFan / 2.8) * sourceStrength * 0.48
      const swirlPhase = seedIndex * 1.73 + step * 0.35
      const swirl = Math.sin(swirlPhase) * 0.065 * Math.max(0.2, 1 - distanceFromFan / 4.2)
      const vector = new THREE.Vector3(
        velocity.x * 70 + direction.x * jetBias + side.x * swirl,
        velocity.y * 48 + Math.cos(swirlPhase * 0.7) * 0.025,
        velocity.z * 70 + direction.z * jetBias + side.z * swirl,
      )

      if (vector.lengthSq() < 0.0004) {
        vector.copy(direction).multiplyScalar(0.12 * sourceStrength)
      }

      vector.clampLength(0.045, 0.18)
      const next = point.clone().add(vector)
      const nextVelocity = sampler(next.x, next.y, next.z)

      if (nextVelocity.solid) {
        break
      }

      positions.push(point.x, point.y, point.z, next.x, next.y, next.z)
      point.copy(next)
    }
  })

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.computeBoundingSphere()

  return geometry
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
