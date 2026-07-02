import { Suspense, useMemo, type ReactNode } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'

export function Box({
  position,
  rotation,
  scale,
  color,
  opacity = 1,
  roughness = 0.72,
}: {
  position: [number, number, number]
  rotation?: [number, number, number]
  scale: [number, number, number]
  color: string
  opacity?: number
  roughness?: number
}) {
  return (
    <mesh castShadow receiveShadow position={position} rotation={rotation} scale={scale}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} depthWrite={opacity >= 1} opacity={opacity} roughness={roughness} transparent={opacity < 1} />
    </mesh>
  )
}

export function Cylinder({
  position,
  rotation,
  args,
  color,
}: {
  position: [number, number, number]
  rotation?: [number, number, number]
  args: [number, number, number, number]
  color: string
}) {
  return (
    <mesh castShadow receiveShadow position={position} rotation={rotation}>
      <cylinderGeometry args={args} />
      <meshStandardMaterial color={color} roughness={0.64} />
    </mesh>
  )
}

function GltfAsset({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  const model = useMemo(() => {
    const clone = scene.clone(true)

    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true
        child.receiveShadow = true

        const materials = Array.isArray(child.material) ? child.material : [child.material]
        materials.forEach((material) => {
          if (material instanceof THREE.MeshStandardMaterial) {
            material.roughness = Math.max(material.roughness, 0.48)
            material.metalness = Math.min(material.metalness, 0.18)
            material.envMapIntensity = 0.55
          }
        })
      }
    })

    return clone
  }, [scene])

  return <primitive object={model} />
}

export function ModelAsset({ fallback, url }: { fallback: ReactNode; url?: string }) {
  if (!url) {
    return <>{fallback}</>
  }

  return (
    <Suspense fallback={fallback}>
      <GltfAsset url={url} />
    </Suspense>
  )
}
