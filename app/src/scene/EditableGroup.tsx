import { useRef, type ReactNode } from 'react'
import { Html, TransformControls } from '@react-three/drei'
import * as THREE from 'three'
import { editableObjectNames } from '../state/appConstants'
import type { EditableObjectKey, ObjectTransform, TransformMode } from '../state/appTypes'
import { SelectionHighlight } from './SelectionHighlight'

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
        }}
      >
        {children}
        {isSelected ? <SelectionHighlight id={id} /> : null}
        {isSelected ? (
          <Html position={[0, 2.35, 0]} center className="scene-label selected-label">
            {editableObjectNames[id]}
          </Html>
        ) : null}
      </group>
      {isSelected && groupRef.current ? (
        <TransformControls
          mode={mode}
          object={groupRef.current}
          onMouseDown={() => onTransformActiveChange(true)}
          onMouseUp={() => {
            onTransformActiveChange(false)
            captureTransform()
          }}
          onObjectChange={captureTransform}
          showX={mode === 'translate'}
          showY
          showZ={mode === 'translate'}
          size={0.86}
          space="world"
        />
      ) : null}
    </>
  )
}
