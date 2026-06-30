import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { ObjectTransform } from '../state/appTypes'
import { resetParticle, type AirflowSampler } from './airflowVizHelpers'

export function StableFluidParticles({
  color,
  count,
  enabled,
  origin,
  fanTransform,
  sampler,
  speed,
  spread,
}: {
  color: string
  count: number
  enabled: boolean
  fanTransform: ObjectTransform
  origin: [number, number, number]
  sampler: AirflowSampler
  speed: number
  spread: number
}) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const particleState = useMemo(() => {
    const positions = new Float32Array(count * 3)
    const ages = new Float32Array(count)
    const randoms = new Float32Array(count * 5)

    for (let index = 0; index < count; index += 1) {
      randoms[index * 5] = Math.random() - 0.5
      randoms[index * 5 + 1] = Math.random() - 0.5
      randoms[index * 5 + 2] = Math.random()
      randoms[index * 5 + 3] = Math.random()
      randoms[index * 5 + 4] = Math.random()
      resetParticle(positions, ages, randoms, index, origin, fanTransform.rotation[1], spread)
    }

    return { ages, positions, randoms }
  }, [count, fanTransform.rotation[1], origin[0], origin[1], origin[2], spread])

  useFrame(({ clock }, delta) => {
    if (!mesh.current) {
      return
    }

    const stepDelta = Math.min(0.033, delta)
    const opacityScale = enabled ? 1 : 0
    const yaw = fanTransform.rotation[1]
    const directionX = -Math.cos(yaw)
    const directionZ = Math.sin(yaw)
    const sideX = -directionZ
    const sideZ = directionX
    const sourceStrength = speed / 100

    for (let index = 0; index < count; index += 1) {
      const base = index * 3
      const randomBase = index * 5
      particleState.ages[index] += stepDelta * (0.82 + speed / 85)

      const velocity = sampler(
        particleState.positions[base],
        particleState.positions[base + 1],
        particleState.positions[base + 2],
      )
      const dx = particleState.positions[base] - origin[0]
      const dz = particleState.positions[base + 2] - origin[2]
      const downJetDistance = dx * directionX + dz * directionZ
      const crossJetDistance = Math.abs(dx * sideX + dz * sideZ)
      const needsReset =
        particleState.ages[index] > 5.8 ||
        velocity.solid ||
        Math.abs(particleState.positions[base]) > 4.75 ||
        particleState.positions[base + 2] < -3.45 ||
        particleState.positions[base + 2] > 3.45 ||
        particleState.positions[base + 1] < 0.26 ||
        particleState.positions[base + 1] > 2.55 ||
        downJetDistance < -0.4

      if (needsReset || !enabled) {
        resetParticle(particleState.positions, particleState.ages, particleState.randoms, index, origin, yaw, spread)
      }

      const jetCore = Math.max(0, 1 - crossJetDistance / (0.65 + downJetDistance * 0.12))
      const dyeLift = Math.min(1, velocity.dye * 1.45)
      const flowScale = 68 + speed * 0.42
      const swirl = Math.sin(clock.elapsedTime * 2.4 + index * 1.91) * (0.025 + dyeLift * 0.03)
      const roll = Math.cos(clock.elapsedTime * 1.7 + randomBase) * (0.018 + sourceStrength * 0.018)
      const jetBias = Math.max(0.12, jetCore) * sourceStrength * 0.52

      particleState.positions[base] += (velocity.x * flowScale + directionX * jetBias + sideX * swirl) * stepDelta
      particleState.positions[base + 2] += (velocity.z * flowScale + directionZ * jetBias + sideZ * swirl) * stepDelta
      particleState.positions[base + 1] +=
        (velocity.y * flowScale * 0.74 +
          (origin[1] - particleState.positions[base + 1]) * 0.18 +
          Math.sin(clock.elapsedTime * 2.2 + particleState.randoms[randomBase + 3] * 9) * 0.18 +
          roll) *
        stepDelta

      dummy.position.set(
        particleState.positions[base],
        particleState.positions[base + 1],
        particleState.positions[base + 2],
      )
      dummy.scale.setScalar(opacityScale * (0.022 + Math.min(0.08, velocity.speed * 1.25 + dyeLift * 0.028)))
      dummy.updateMatrix()
      mesh.current.setMatrixAt(index, dummy.matrix)
    }

    mesh.current.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]}>
      <sphereGeometry args={[1, 10, 10]} />
      <meshBasicMaterial color={color} transparent opacity={0.58} depthWrite={false} />
    </instancedMesh>
  )
}
