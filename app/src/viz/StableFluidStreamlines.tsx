import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import type { ObjectTransform } from '../state/appTypes'
import { buildStreamlinePaths, type AirflowSampler } from './airflowVizHelpers'

export function StableFluidStreamlines({
  color,
  density,
  enabled,
  fanTransform,
  origin,
  sampler,
  speed,
  spread,
}: {
  color: string
  density: number
  enabled: boolean
  fanTransform: ObjectTransform
  origin: [number, number, number]
  sampler: AirflowSampler
  speed: number
  spread: number
}) {
  const { points, colors } = useMemo(
    () => buildStreamlinePaths({ density, enabled, fanTransform, origin, sampler, speed, spread, color }),
    [density, enabled, fanTransform.rotation[1], origin[0], origin[1], origin[2], sampler, speed, spread, color],
  )

  if (points.length === 0) return null

  // Two passes: a soft wide halo for glow + a crisp bright core. Both are
  // anti-aliased fat lines (Line2) coloured by local flow speed.
  return (
    <group>
      <Line
        points={points}
        segments
        vertexColors={colors}
        lineWidth={5.4}
        transparent
        opacity={0.16}
        depthWrite={false}
      />
      <Line
        points={points}
        segments
        vertexColors={colors}
        lineWidth={2.1}
        transparent
        opacity={0.94}
        depthWrite={false}
      />
    </group>
  )
}
