import { Html } from '@react-three/drei'
import { Box } from './primitives'

export function WallAirConditioner({ enabled, speed }: { enabled: boolean; speed: number }) {
  const ventGlow = enabled ? Math.min(0.48, 0.16 + speed / 260) : 0.04

  return (
    <group position={[2.65, 2.18, -3.45]}>
      <Box position={[0, 0, 0]} scale={[1.55, 0.42, 0.16]} color="#f5f7f7" roughness={0.54} />
      <Box position={[0, -0.13, 0.085]} scale={[1.36, 0.07, 0.05]} color="#94a3b8" roughness={0.36} />
      <Box position={[-0.52, -0.2, 0.11]} scale={[0.36, 0.035, 0.035]} color="#475569" />
      <Box position={[0, -0.2, 0.11]} scale={[0.36, 0.035, 0.035]} color="#475569" />
      <Box position={[0.52, -0.2, 0.11]} scale={[0.36, 0.035, 0.035]} color="#475569" />
      <mesh position={[0, -0.36, 0.24]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.32, 0.32]} />
        <meshBasicMaterial color="#38bdf8" depthWrite={false} opacity={ventGlow} transparent />
      </mesh>
      <Html position={[0, 0.42, 0.08]} center className="scene-label">
        ac
      </Html>
    </group>
  )
}

export function ExhaustVent({ enabled, speed }: { enabled: boolean; speed: number }) {
  const glow = enabled ? Math.min(0.42, 0.12 + speed / 300) : 0.035

  return (
    <group position={[-3.45, 2.08, -3.48]}>
      <mesh castShadow receiveShadow rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.42, 0.42, 0.08, 48]} />
        <meshStandardMaterial color="#e2e8f0" roughness={0.48} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.045]}>
        <torusGeometry args={[0.3, 0.018, 8, 48]} />
        <meshStandardMaterial color="#64748b" roughness={0.38} />
      </mesh>
      {[-0.18, -0.06, 0.06, 0.18].map((offset) => (
        <Box key={offset} position={[offset, 0, 0.075]} scale={[0.025, 0.58, 0.025]} color="#475569" />
      ))}
      <mesh position={[0, 0, 0.12]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.38, 48]} />
        <meshBasicMaterial color="#94a3b8" depthWrite={false} opacity={glow} transparent />
      </mesh>
      <Html position={[0, 0.56, 0.05]} center className="scene-label">
        vent
      </Html>
    </group>
  )
}
