import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { ScalarFieldKey, StableFluidSnapshot } from '../stableFluidSolver'
import type { ScalarOverlayMode, ScalarOverlaySlice } from '../state/appTypes'
import { buildObstacleOverlayGeometry, buildVelocityOverlayGeometry } from '../viz/flowOverlayGeometry'
import { Box } from './primitives'

export function RoomShell({
  scalarOverlayMode,
  scalarOverlaySlice,
  showFlowMap,
  snapshot,
  wallOpacity,
}: {
  scalarOverlayMode: ScalarOverlayMode
  scalarOverlaySlice: ScalarOverlaySlice
  showFlowMap: boolean
  snapshot: StableFluidSnapshot
  wallOpacity: number
}) {
  const obstacleGeometry = useMemo(() => buildObstacleOverlayGeometry(snapshot), [snapshot])
  const velocityGeometry = useMemo(() => buildVelocityOverlayGeometry(snapshot), [snapshot])
  const isScalarOverlay = scalarOverlayMode !== 'airflow'
  const overlayTexture = useMemo(() => {
    const source = scalarOverlayMode === 'airflow'
      ? snapshot.dye
      : buildScalarHeatmapTexture(snapshot, scalarOverlayMode, scalarOverlaySlice)
    const texture = new THREE.DataTexture(
      new Uint8Array(source),
      snapshot.width,
      snapshot.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    )
    texture.colorSpace = THREE.SRGBColorSpace
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearFilter
    texture.needsUpdate = true

    return texture
  }, [scalarOverlayMode, scalarOverlaySlice, snapshot])

  useEffect(() => () => overlayTexture.dispose(), [overlayTexture])

  return (
    <group>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[9.8, 7.2]} />
        <meshStandardMaterial color="#d7c6ac" roughness={0.82} />
      </mesh>
      {Array.from({ length: 12 }).map((_, index) => (
        <Box
          key={`floor-plank-${index}`}
          position={[-4.48 + index * 0.82, 0.012, 0]}
          scale={[0.035, 0.018, 7.04]}
          color={index % 2 === 0 ? '#c7ad88' : '#bfa580'}
          opacity={0.52}
        />
      ))}
      {Array.from({ length: 7 }).map((_, index) => (
        <Box
          key={`floor-cross-${index}`}
          position={[0, 0.014, -3.02 + index * 1.0]}
          scale={[9.42, 0.012, 0.018]}
          color="#f3eadc"
          opacity={0.36}
        />
      ))}
      <gridHelper args={[9.8, 14, '#6f7f7a', '#d5ded7']} position={[0, 0.018, 0]} />

      <Box position={[0, 1.75, -3.6]} scale={[9.8, 3.5, 0.12]} color="#f6f0e7" opacity={wallOpacity} />
      <Box position={[-4.9, 1.75, 0]} scale={[0.12, 3.5, 7.2]} color="#e7f0ec" opacity={wallOpacity * 0.86} />
      <Box position={[4.9, 1.75, 0]} scale={[0.12, 3.5, 7.2]} color="#eef1f6" opacity={wallOpacity * 0.86} />
      <Box position={[0, 2.86, -3.54]} scale={[9.9, 0.12, 0.18]} color="#7c8a83" opacity={0.82} />
      <Box position={[-4.84, 2.86, 0]} scale={[0.18, 0.12, 7.22]} color="#7c8a83" opacity={0.76} />
      <Box position={[4.84, 2.86, 0]} scale={[0.18, 0.12, 7.22]} color="#7c8a83" opacity={0.76} />
      <Box position={[0, 0.12, -3.52]} scale={[9.2, 0.12, 0.08]} color="#9c8a71" />
      <Box position={[-4.82, 0.12, 0]} scale={[0.08, 0.12, 6.65]} color="#8f9f98" />
      <Box position={[4.82, 0.12, 0]} scale={[0.08, 0.12, 6.65]} color="#8d9bb0" />
      <Box position={[0, 2.76, 0]} scale={[9.5, 0.035, 6.9]} color="#fff9ee" opacity={0.1} />

      <Box position={[-2.5, 0.024, 0.55]} scale={[3.8, 0.035, 2.4]} color="#b65d71" opacity={0.76} />
      <Box position={[-2.5, 0.048, 0.55]} scale={[3.55, 0.018, 2.16]} color="#e8adb8" opacity={0.42} />
      <Box position={[2.85, 1.55, -3.53]} scale={[1.55, 1.05, 0.05]} color="#cfe2d5" />
      <Box position={[-3.35, 1.5, -3.53]} scale={[1.15, 1.4, 0.05]} color="#d7e7ef" />
      <Box position={[2.85, 1.55, -3.565]} scale={[1.7, 1.18, 0.025]} color="#ffffff" opacity={0.2} roughness={0.18} />
      <Box position={[2.85, 1.55, -3.585]} scale={[0.04, 1.08, 0.03]} color="#9aa7a1" />
      <Box position={[2.85, 1.55, -3.59]} scale={[1.58, 0.04, 0.03]} color="#9aa7a1" />
      <Box position={[-3.35, 1.5, -3.565]} scale={[1.28, 1.52, 0.025]} color="#ffffff" opacity={0.18} roughness={0.18} />
      <Box position={[-3.35, 1.5, -3.59]} scale={[1.18, 0.04, 0.03]} color="#9aa7a1" />
      <Box position={[0.15, 1.06, -3.57]} scale={[0.82, 1.92, 0.045]} color="#b7c0b9" opacity={0.5} />
      <Box position={[0.15, 2.04, -3.61]} scale={[0.92, 0.08, 0.06]} color="#6e7b73" />

      {showFlowMap ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.048, 0]}>
          <planeGeometry args={[9.55, 6.95]} />
          <meshBasicMaterial depthWrite={false} map={overlayTexture} opacity={isScalarOverlay ? 0.92 : 0.95} side={THREE.DoubleSide} transparent />
        </mesh>
      ) : null}
      {showFlowMap ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 1.18, 0]}>
          <planeGeometry args={[9.1, 6.5]} />
          <meshBasicMaterial depthWrite={false} map={overlayTexture} opacity={isScalarOverlay ? 0.2 : 0.28} side={THREE.DoubleSide} transparent />
        </mesh>
      ) : null}
      {showFlowMap && obstacleGeometry ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.055, 0]}>
          <primitive object={obstacleGeometry} attach="geometry" />
          <meshBasicMaterial color="#374151" transparent opacity={isScalarOverlay ? 0.12 : 0.23} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
      {showFlowMap && !isScalarOverlay && velocityGeometry ? (
        <lineSegments rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.075, 0]}>
          <primitive object={velocityGeometry} attach="geometry" />
          <lineBasicMaterial color="#167f76" transparent opacity={0.72} />
        </lineSegments>
      ) : null}
    </group>
  )
}

function buildScalarHeatmapTexture(
  snapshot: StableFluidSnapshot,
  fieldKey: ScalarFieldKey,
  slice: ScalarOverlaySlice,
) {
  const projectedValues = new Float32Array(snapshot.width * snapshot.height)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (let z = 0; z < snapshot.height; z += 1) {
    for (let x = 0; x < snapshot.width; x += 1) {
      const value = sampleProjectedScalar(snapshot, fieldKey, slice, x, z)
      const index = z * snapshot.width + x

      projectedValues[index] = value
      min = Math.min(min, value)
      max = Math.max(max, value)
    }
  }

  const span = Math.max(0.025, max - min)
  const center = (min + max) / 2
  const low = center - span / 2
  const texture = new Uint8ClampedArray(snapshot.width * snapshot.height * 4)

  for (let index = 0; index < projectedValues.length; index += 1) {
    const normalized = Math.max(0, Math.min(1, (projectedValues[index] - low) / span))
    const [red, green, blue] = scalarHeatColor(fieldKey, normalized)
    const base = index * 4

    texture[base] = red
    texture[base + 1] = green
    texture[base + 2] = blue
    texture[base + 3] = 235
  }

  return texture
}

function sampleProjectedScalar(
  snapshot: StableFluidSnapshot,
  fieldKey: ScalarFieldKey,
  slice: ScalarOverlaySlice,
  x: number,
  z: number,
) {
  const field = snapshot.volumeScalars[fieldKey]

  if (slice !== 'average') {
    const y = sliceToLayer(slice, snapshot.layers)

    return field[index3(x, y, z, snapshot.width, snapshot.height)]
  }

  let total = 0
  let count = 0

  for (let y = 1; y < snapshot.layers - 1; y += 1) {
    total += field[index3(x, y, z, snapshot.width, snapshot.height)]
    count += 1
  }

  return count > 0 ? total / count : 0
}

function sliceToLayer(slice: ScalarOverlaySlice, layers: number) {
  const normalized: Record<ScalarOverlaySlice, number> = {
    average: 0.5,
    floor: 0.1,
    seated: 0.38,
    standing: 0.58,
    ceiling: 0.82,
  }

  return Math.max(1, Math.min(layers - 2, Math.round(normalized[slice] * (layers - 1))))
}

function scalarHeatColor(fieldKey: ScalarFieldKey, normalized: number): [number, number, number] {
  if (fieldKey === 'temperature') {
    return interpolateColorRamp(normalized, [
      [42, 117, 183],
      [245, 247, 249],
      [217, 70, 57],
    ])
  }

  if (fieldKey === 'humidity') {
    return interpolateColorRamp(normalized, [
      [229, 231, 235],
      [95, 165, 196],
      [29, 78, 216],
    ])
  }

  if (fieldKey === 'noise') {
    return interpolateColorRamp(normalized, [
      [34, 197, 94],
      [250, 204, 21],
      [220, 38, 38],
    ])
  }

  return interpolateColorRamp(normalized, [
    [34, 197, 94],
    [250, 204, 21],
    [220, 38, 38],
  ])
}

function interpolateColorRamp(value: number, colors: Array<[number, number, number]>): [number, number, number] {
  const scaled = Math.max(0, Math.min(1, value)) * (colors.length - 1)
  const index = Math.min(colors.length - 2, Math.floor(scaled))
  const local = scaled - index
  const from = colors[index]
  const to = colors[index + 1]

  return [
    Math.round(from[0] + (to[0] - from[0]) * local),
    Math.round(from[1] + (to[1] - from[1]) * local),
    Math.round(from[2] + (to[2] - from[2]) * local),
  ]
}

function index3(x: number, y: number, z: number, width: number, height: number) {
  return y * width * height + z * width + x
}
