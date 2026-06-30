import type { ScalarFieldKey } from '../stableFluidSolver'

export type AirflowPreset = 'comfort' | 'cooling' | 'purge'
export type TransformMode = 'translate' | 'rotate'
export type FlowDisplayMode = 'particles' | 'streamlines'
export type ScalarOverlayMode = 'airflow' | ScalarFieldKey
export type ScalarOverlaySlice = 'average' | 'floor' | 'seated' | 'standing' | 'ceiling'
export type CameraView = 'iso' | 'top' | 'front' | 'fit'

export type EditableObjectKey =
  | 'sofa'
  | 'coffeeTable'
  | 'mediaConsole'
  | 'sideTable'
  | 'crib'
  | 'seatedPerson'
  | 'sleepingBaby'
  | 'plant'
  | 'lamp'
  | 'fan'

export type ObjectTransform = {
  position: [number, number, number]
  rotation: [number, number, number]
}

/** User-chosen room size in metres. width = X, depth = Z, height = Y. */
export type RoomDimensions = {
  width: number
  depth: number
  height: number
}
