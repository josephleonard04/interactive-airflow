import { modelUrls } from '../state/appConstants'
import type { EditableObjectKey, ObjectTransform, TransformMode } from '../state/appTypes'
import { EditableGroup } from './EditableGroup'
import { Box, Cylinder, ModelAsset } from './primitives'

export function FurnitureSet({
  mode,
  onSelect,
  onTransformActiveChange,
  onTransformChange,
  transforms,
  selectedId,
}: {
  mode: TransformMode
  onSelect: (id: EditableObjectKey) => void
  onTransformActiveChange: (active: boolean) => void
  onTransformChange: (id: EditableObjectKey, transform: ObjectTransform) => void
  transforms: Record<EditableObjectKey, ObjectTransform>
  selectedId: EditableObjectKey | null
}) {
  const editableProps = {
    mode,
    onSelect,
    onTransformActiveChange,
    onTransformChange,
    selectedId,
  }

  return (
    <group>
      <EditableGroup id="sofa" position={transforms.sofa.position} rotation={transforms.sofa.rotation} {...editableProps}>
        <ModelAsset
          url={modelUrls.sofa}
          fallback={
            <>
              <Box position={[0, 0.34, 0]} scale={[2.76, 0.46, 0.98]} color="#607451" />
              <Box position={[0, 0.72, -0.1]} scale={[2.62, 0.18, 0.84]} color="#6f835f" />
              <Box position={[0, 0.94, 0.43]} scale={[2.92, 0.88, 0.2]} color="#4f6045" />
            </>
          }
        />
      </EditableGroup>

      <EditableGroup id="coffeeTable" position={transforms.coffeeTable.position} rotation={transforms.coffeeTable.rotation} {...editableProps}>
        <ModelAsset
          url={modelUrls.coffeeTable}
          fallback={
            <>
              <Box position={[0, 0.31, 0]} scale={[1.6, 0.12, 0.86]} color="#8d6e63" />
              <Box position={[0, 0.39, 0]} scale={[1.42, 0.035, 0.72]} color="#c9d6d1" opacity={0.56} roughness={0.22} />
            </>
          }
        />
      </EditableGroup>

      <EditableGroup id="mediaConsole" position={transforms.mediaConsole.position} rotation={transforms.mediaConsole.rotation} {...editableProps}>
        <ModelAsset
          url={modelUrls.mediaConsole}
          fallback={
            <>
              <Box position={[0, 0.28, 0]} scale={[2.2, 0.55, 0.34]} color="#76534a" />
              <Box position={[0, 1.15, -0.04]} scale={[1.5, 0.86, 0.08]} color="#20262e" roughness={0.36} />
            </>
          }
        />
      </EditableGroup>

      <EditableGroup id="sideTable" position={transforms.sideTable.position} rotation={transforms.sideTable.rotation} {...editableProps}>
        <ModelAsset
          url={modelUrls.sideTable}
          fallback={
            <>
              <Cylinder position={[0, 0.32, 0]} args={[0.31, 0.26, 0.08, 28]} color="#9c6644" />
              <Cylinder position={[0, 0.17, 0]} args={[0.045, 0.045, 0.3, 14]} color="#6f4e37" />
            </>
          }
        />
      </EditableGroup>

      <EditableGroup id="crib" position={transforms.crib.position} rotation={transforms.crib.rotation} {...editableProps}>
        <ModelAsset
          url={modelUrls.crib}
          fallback={
            <>
              <Box position={[0, 0.28, 0]} scale={[1.22, 0.16, 0.64]} color="#f2e8cf" />
              <Box position={[0, 0.37, 0]} scale={[1.08, 0.08, 0.48]} color="#d7e7ef" />
            </>
          }
        />
      </EditableGroup>

      <EditableGroup id="seatedPerson" position={transforms.seatedPerson.position} rotation={transforms.seatedPerson.rotation} {...editableProps}>
        <group>
          <Cylinder position={[0, 0.78, 0]} args={[0.18, 0.22, 0.62, 24]} color="#6b7280" />
          <mesh castShadow position={[0, 1.18, 0]}>
            <sphereGeometry args={[0.18, 24, 16]} />
            <meshStandardMaterial color="#d6a77a" roughness={0.62} />
          </mesh>
          <Box position={[-0.16, 0.42, 0.06]} rotation={[0.15, 0, -0.16]} scale={[0.14, 0.5, 0.16]} color="#334155" />
          <Box position={[0.16, 0.42, 0.06]} rotation={[0.15, 0, 0.16]} scale={[0.14, 0.5, 0.16]} color="#334155" />
          <Box position={[0, 1.28, 0.22]} scale={[0.42, 0.18, 0.05]} color="#8dd3c7" opacity={0.34} />
        </group>
      </EditableGroup>

      <EditableGroup id="sleepingBaby" position={transforms.sleepingBaby.position} rotation={transforms.sleepingBaby.rotation} {...editableProps}>
        <group>
          <Box position={[0, 0.32, 0]} scale={[0.56, 0.16, 0.36]} color="#f8d7da" />
          <mesh castShadow position={[-0.16, 0.45, 0]}>
            <sphereGeometry args={[0.13, 20, 14]} />
            <meshStandardMaterial color="#e8b48f" roughness={0.66} />
          </mesh>
          <Box position={[0.06, 0.46, 0]} scale={[0.32, 0.1, 0.32]} color="#f2e8cf" opacity={0.86} />
          <Box position={[-0.12, 0.56, 0.18]} scale={[0.34, 0.12, 0.04]} color="#8dd3c7" opacity={0.32} />
        </group>
      </EditableGroup>

      <EditableGroup id="plant" position={transforms.plant.position} rotation={transforms.plant.rotation} {...editableProps}>
        <ModelAsset
          url={modelUrls.plant}
          fallback={
            <>
              <Cylinder position={[0, 0.28, 0]} args={[0.28, 0.2, 0.56, 18]} color="#9c6644" />
              <Cylinder position={[0, 0.82, 0]} args={[0.36, 0.2, 0.52, 18]} color="#6a994e" />
            </>
          }
        />
      </EditableGroup>

      <EditableGroup id="lamp" position={transforms.lamp.position} rotation={transforms.lamp.rotation} {...editableProps}>
        <ModelAsset
          url={modelUrls.lamp}
          fallback={
            <>
              <Cylinder position={[0, 0.82, 0]} args={[0.06, 0.06, 1.65, 16]} color="#4a4e69" />
              <Cylinder position={[0, 1.7, 0]} args={[0.34, 0.22, 0.42, 24]} color="#f6bd60" />
            </>
          }
        />
      </EditableGroup>
    </group>
  )
}
