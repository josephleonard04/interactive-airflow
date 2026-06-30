import * as THREE from 'three'
import type { StableFluidSnapshot } from '../stableFluidSolver'

export function buildObstacleOverlayGeometry(snapshot: StableFluidSnapshot) {
  if (!snapshot.flags.length) {
    return null
  }

  const positions: number[] = []
  const cellWidth = 9.8 / snapshot.width
  const cellDepth = 7.2 / snapshot.height

  for (let y = 0; y < snapshot.height; y += 1) {
    for (let x = 0; x < snapshot.width; x += 1) {
      if (snapshot.flags[y * snapshot.width + x] !== 1) {
        continue
      }

      const wx = -4.9 + x * cellWidth
      const wz = -3.6 + y * cellDepth
      positions.push(
        wx,
        wz,
        0,
        wx + cellWidth,
        wz,
        0,
        wx + cellWidth,
        wz + cellDepth,
        0,
        wx,
        wz,
        0,
        wx + cellWidth,
        wz + cellDepth,
        0,
        wx,
        wz + cellDepth,
        0,
      )
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.computeBoundingSphere()

  return geometry
}

export function buildVelocityOverlayGeometry(snapshot: StableFluidSnapshot) {
  if (!snapshot.velocities.length || snapshot.revision < 5) {
    return null
  }

  const positions: number[] = []
  const stride = 6
  const cellWidth = 9.8 / snapshot.width
  const cellDepth = 7.2 / snapshot.height

  for (let y = stride; y < snapshot.height - stride; y += stride) {
    for (let x = stride; x < snapshot.width - stride; x += stride) {
      const cellIndex = y * snapshot.width + x

      if (snapshot.flags[cellIndex] === 1) {
        continue
      }

      const velocityIndex = cellIndex * 4
      const vx = snapshot.velocities[velocityIndex]
      const vz = snapshot.velocities[velocityIndex + 1]
      const speed = snapshot.velocities[velocityIndex + 2]

      if (speed < 0.004) {
        continue
      }

      const wx = -4.9 + (x + 0.5) * cellWidth
      const wz = -3.6 + (y + 0.5) * cellDepth
      const scale = Math.min(0.42, 5.2 * speed)
      const length = Math.sqrt(vx * vx + vz * vz) || 1
      const dx = (vx / length) * scale
      const dz = (vz / length) * scale

      positions.push(wx, wz, 0, wx + dx, wz + dz, 0)
      positions.push(wx + dx, wz + dz, 0, wx + dx * 0.78 - dz * 0.18, wz + dz * 0.78 + dx * 0.18, 0)
      positions.push(wx + dx, wz + dz, 0, wx + dx * 0.78 + dz * 0.18, wz + dz * 0.78 - dx * 0.18, 0)
    }
  }

  if (!positions.length) {
    return null
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.computeBoundingSphere()

  return geometry
}
