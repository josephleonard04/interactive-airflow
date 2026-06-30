import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { cameraViews } from '../state/appConstants'
import type { CameraView } from '../state/appTypes'

export function SceneCameraRig({ view }: { view: CameraView }) {
  const { camera } = useThree()

  useEffect(() => {
    const preset = cameraViews[view]
    camera.position.set(...preset.position)
    camera.up.set(...(preset.up ?? [0, 1, 0]))
    camera.lookAt(...preset.target)
    camera.updateProjectionMatrix()
  }, [camera, view])

  return null
}
