import type { IntentGrounding } from '../intent/session.ts'

export function IntentGroundingHighlights({ groundings = [] }: { groundings?: IntentGrounding[] }) {
  return (
    <group>
      {groundings
        .filter((grounding) => grounding.bounds)
        .map((grounding, index) => (
          <GroundingBox grounding={grounding} index={index} key={grounding.id} />
        ))}
    </group>
  )
}

function GroundingBox({ grounding, index }: { grounding: IntentGrounding; index: number }) {
  const bounds = grounding.bounds

  if (!bounds) {
    return null
  }

  const width = Math.max(0.12, bounds.maxX - bounds.minX)
  const height = Math.max(0.12, bounds.maxY - bounds.minY)
  const depth = Math.max(0.12, bounds.maxZ - bounds.minZ)
  const color = grounding.status === 'accepted'
    ? '#22c55e'
    : grounding.status === 'adjusted'
      ? '#f59e0b'
      : '#ef4444'

  return (
    <group position={[(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, (bounds.minZ + bounds.maxZ) / 2]}>
      <mesh scale={[width, height, depth]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={color} depthTest={false} opacity={0.1 + index * 0.015} transparent />
      </mesh>
      <mesh scale={[width, height, depth]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={color} depthTest={false} opacity={0.72} transparent wireframe />
      </mesh>
    </group>
  )
}
