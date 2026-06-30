import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { modelUrls } from '../state/appConstants'
import type { EditableObjectKey, ObjectTransform, TransformMode } from '../state/appTypes'
import { EditableGroup } from './EditableGroup'
import { Cylinder, ModelAsset } from './primitives'

function createFanBladeGeometry() {
  const geometry = new THREE.BufferGeometry()
  const vertices = new Float32Array([
    -0.018, 0.08, -0.04,
    0.034, 0.12, 0.06,
    -0.032, 0.47, 0.13,
    0.052, 0.51, -0.055,
    -0.008, 0.18, -0.035,
    0.028, 0.24, 0.05,
    -0.018, 0.43, 0.09,
    0.04, 0.46, -0.04,
  ])

  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
  geometry.setIndex([0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6])
  geometry.computeVertexNormals()

  return geometry
}

export function StandingFan({
  enabled,
  mode,
  onSelect,
  onTransformActiveChange,
  onTransformChange,
  selectedId,
  speed,
  transform,
}: {
  enabled: boolean
  mode: TransformMode
  onSelect: (id: EditableObjectKey) => void
  onTransformActiveChange: (active: boolean) => void
  onTransformChange: (id: EditableObjectKey, transform: ObjectTransform) => void
  selectedId: EditableObjectKey | null
  speed: number
  transform: ObjectTransform
}) {
  const blades = useRef<THREE.Group>(null)
  const bladeGeometry = useMemo(createFanBladeGeometry, [])
  const bladeOpacity = enabled ? 0.92 : 0.55
  const blurOpacity = enabled ? Math.min(0.26, 0.08 + speed / 430) : 0.035
  const bladeColor = enabled ? '#2a9d8f' : '#a8adb4'

  useEffect(() => () => bladeGeometry.dispose(), [bladeGeometry])

  useFrame((_, delta) => {
    if (blades.current && enabled) {
      blades.current.rotation.x += delta * (12 + speed * 0.48)
    }
  })

  return (
    <EditableGroup
      id="fan"
      mode={mode}
      onSelect={onSelect}
      onTransformActiveChange={onTransformActiveChange}
      onTransformChange={onTransformChange}
      position={transform.position}
      rotation={transform.rotation}
      selectedId={selectedId}
    >
      <ModelAsset
        url={modelUrls.fanBody}
        fallback={
          <>
            <Cylinder position={[0, 0.07, 0]} args={[0.48, 0.58, 0.14, 48]} color="#2f343a" />
            <Cylinder position={[0, 0.78, 0]} args={[0.038, 0.05, 1.24, 20]} color="#68717a" />
            <Cylinder position={[0.17, 1.62, 0]} rotation={[0, 0, Math.PI / 2]} args={[0.22, 0.16, 0.36, 36]} color="#cbd5e1" />
          </>
        }
      />
      <group position={[0, 1.62, 0]}>
        <mesh position={[-0.15, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
          <circleGeometry args={[0.49, 72]} />
          <meshBasicMaterial color="#9edbd3" depthWrite={false} opacity={blurOpacity} side={THREE.DoubleSide} transparent />
        </mesh>

        <group ref={blades} position={[-0.08, 0, 0]}>
          {[0, 1, 2, 3, 4].map((blade) => (
            <group key={blade} rotation={[blade * ((Math.PI * 2) / 5), 0, 0]}>
              <mesh castShadow receiveShadow>
                <primitive object={bladeGeometry} attach="geometry" />
                <meshStandardMaterial color={bladeColor} opacity={bladeOpacity} roughness={0.34} side={THREE.DoubleSide} transparent />
              </mesh>
            </group>
          ))}
        </group>
      </group>
      <Html position={[0, 2.26, 0]} center className="scene-label">
        fan
      </Html>
    </EditableGroup>
  )
}
