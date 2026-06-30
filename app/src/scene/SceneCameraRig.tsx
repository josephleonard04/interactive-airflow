import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { cameraViews } from '../state/appConstants'
import type { CameraView } from '../state/appTypes'

export function SceneCameraRig({
  view,
  scale = [1, 1, 1],
}: {
  view: CameraView
  scale?: [number, number, number]
}) {
  const { camera } = useThree()

  useEffect(() => {
    const preset = cameraViews[view]
    // The whole scene is rendered inside a group scaled to the chosen room
    // size, so scale the camera framing by the same factors to keep the room
    // filling the view regardless of dimensions.
    camera.position.set(
      preset.position[0] * scale[0],
      preset.position[1] * scale[1],
      preset.position[2] * scale[2],
    )
    camera.up.set(...(preset.up ?? [0, 1, 0]))
    camera.lookAt(preset.target[0] * scale[0], preset.target[1] * scale[1], preset.target[2] * scale[2])
    camera.updateProjectionMatrix()
  }, [camera, view, scale[0], scale[1], scale[2]])

  return null
}
