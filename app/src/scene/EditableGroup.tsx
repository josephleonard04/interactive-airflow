import { useRef, type ReactNode } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { Html, TransformControls } from '@react-three/drei'
import * as THREE from 'three'
import { editableObjectNames, obstacleFootprints } from '../state/appConstants'
import type { EditableObjectKey, ObjectTransform, TransformMode } from '../state/appTypes'
import { SelectionHighlight } from './SelectionHighlight'

const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const dragPoint = new THREE.Vector3()
const roomLimits = { minX: -4.75, maxX: 4.75, minZ: -3.45, maxZ: 3.45 }

function clampPosition(id: EditableObjectKey, x: number, z: number): [number, number, number] {
  const footprint = obstacleFootprints[id]
  const halfWidth = (footprint?.w ?? 0.72) / 2
  const halfDepth = (footprint?.d ?? 0.72) / 2

  return [
    Math.max(roomLimits.minX + halfWidth, Math.min(roomLimits.maxX - halfWidth, x)),
    0,
    Math.max(roomLimits.minZ + halfDepth, Math.min(roomLimits.maxZ - halfDepth, z)),
  ]
}

export function EditableGroup({
  children,
  id,
  mode,
  onSelect,
  onTransformActiveChange,
  onTransformChange,
  position,
  rotation,
  selectedId,
}: {
  children: ReactNode
  id: EditableObjectKey
  mode: TransformMode
  onSelect: (id: EditableObjectKey) => void
  onTransformActiveChange: (active: boolean) => void
  onTransformChange: (id: EditableObjectKey, transform: ObjectTransform) => void
  position: [number, number, number]
  rotation?: [number, number, number]
  selectedId: EditableObjectKey | null
}) {
  const isSelected = selectedId === id
  const groupRef = useRef<THREE.Group>(null)
  const dragStateRef = useRef<{
    active: boolean
    offsetX: number
    offsetZ: number
    pointerId: number
  } | null>(null)
  const captureTransform = () => {
    const object = groupRef.current

    if (!object) {
      return
    }

    onTransformChange(id, {
      position: [object.position.x, object.position.y, object.position.z],
      rotation: mode === 'rotate' ? [0, object.rotation.y, 0] : [object.rotation.x, object.rotation.y, object.rotation.z],
    })
  }
  const updateDragPosition = (event: ThreeEvent<PointerEvent>) => {
    const object = groupRef.current
    const drag = dragStateRef.current

    if (!object || !drag?.active || !event.ray.intersectPlane(dragPlane, dragPoint)) {
      return
    }

    const [x, y, z] = clampPosition(id, dragPoint.x - drag.offsetX, dragPoint.z - drag.offsetZ)
    object.position.set(x, y, z)
    onTransformChange(id, {
      position: [x, y, z],
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    })
  }
  const stopDrag = (event: ThreeEvent<PointerEvent>) => {
    if (!dragStateRef.current) return

    event.stopPropagation()
    dragStateRef.current = null
    onTransformActiveChange(false)
    captureTransform()
    if (event.target instanceof Element && event.target.hasPointerCapture(event.pointerId)) {
      event.target.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <>
      <group
        ref={groupRef}
        name={editableObjectNames[id]}
        position={position}
        rotation={rotation}
        onPointerDown={(event) => {
          event.stopPropagation()
          onSelect(id)

          if (mode !== 'translate' || !groupRef.current || !event.ray.intersectPlane(dragPlane, dragPoint)) {
            return
          }

          dragStateRef.current = {
            active: true,
            offsetX: dragPoint.x - groupRef.current.position.x,
            offsetZ: dragPoint.z - groupRef.current.position.z,
            pointerId: event.pointerId,
          }
          onTransformActiveChange(true)
          if (event.target instanceof Element) {
            event.target.setPointerCapture(event.pointerId)
          }
        }}
        onPointerMove={(event) => {
          if (dragStateRef.current?.pointerId !== event.pointerId) return

          event.stopPropagation()
          updateDragPosition(event)
        }}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        {children}
        {isSelected ? <SelectionHighlight id={id} /> : null}
        {isSelected ? (
          <Html position={[0, 2.35, 0]} center className="scene-label selected-label">
            {editableObjectNames[id]}
          </Html>
        ) : null}
      </group>
      {isSelected && groupRef.current && mode === 'rotate' ? (
        <TransformControls
          mode={mode}
          object={groupRef.current}
          onMouseDown={() => onTransformActiveChange(true)}
          onMouseUp={() => {
            onTransformActiveChange(false)
            captureTransform()
          }}
          onObjectChange={captureTransform}
          showX={false}
          showY
          showZ={false}
          size={0.86}
          space="world"
        />
      ) : null}
    </>
  )
}
