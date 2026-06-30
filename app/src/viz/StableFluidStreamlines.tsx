import { useEffect, useMemo } from 'react'
import type { ObjectTransform } from '../state/appTypes'
import { buildStreamlineGeometry, type AirflowSampler } from './airflowVizHelpers'

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
  const geometry = useMemo(
    () => buildStreamlineGeometry({ density, enabled, fanTransform, origin, sampler, speed, spread }),
    [density, enabled, fanTransform.rotation[1], origin[0], origin[1], origin[2], sampler, speed, spread],
  )

  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.82} depthWrite={false} />
    </lineSegments>
  )
}
