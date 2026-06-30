import { obstacleFootprints } from '../state/appConstants'
import type { EditableObjectKey } from '../state/appTypes'

export function SelectionHighlight({ id }: { id: EditableObjectKey }) {
  const footprint = obstacleFootprints[id]
  const width = (footprint?.w ?? 0.9) + 0.22
  const depth = (footprint?.d ?? 0.9) + 0.22
  const height = id === 'fan' ? 2.25 : (footprint?.h ?? 0.8) + 0.12

  return (
    <group>
      <mesh position={[0, 0.06, 0]} scale={[width, 0.04, depth]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#38bdf8" depthTest={false} opacity={0.72} transparent wireframe />
      </mesh>
      <mesh position={[0, height / 2, 0]} scale={[width, height, depth]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#38bdf8" depthTest={false} opacity={0.22} transparent wireframe />
      </mesh>
    </group>
  )
}
