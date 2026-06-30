import { AirVent, Fan, Snowflake, Wind } from 'lucide-react'
import type { DeviceKey, DeviceState } from '../stableFluidSolver'
import { getEditableObjectNames, getInitialObjectTransforms, getObstacleFootprints } from '../scene/sceneGraph.ts'
import type { AirflowPreset, CameraView, EditableObjectKey, ObjectTransform, ScalarOverlayMode, ScalarOverlaySlice } from './appTypes'

export const editableObjectNames = getEditableObjectNames()

export const initialObjectTransforms = getInitialObjectTransforms()

export const obstacleFootprints = getObstacleFootprints()

export const presets: Record<AirflowPreset, DeviceState> = {
  comfort: {
    fan: { enabled: true, speed: 58 },
    ac: { enabled: true, speed: 42 },
    vent: { enabled: true, speed: 36 },
  },
  cooling: {
    fan: { enabled: true, speed: 34 },
    ac: { enabled: true, speed: 68 },
    vent: { enabled: true, speed: 28 },
  },
  purge: {
    fan: { enabled: true, speed: 76 },
    ac: { enabled: false, speed: 28 },
    vent: { enabled: true, speed: 74 },
  },
}

export const deviceCopy: Record<DeviceKey, { title: string; role: string; icon: typeof Wind }> = {
  fan: { title: 'Standing fan', role: 'Circulates air across seating', icon: Fan },
  ac: { title: 'Wall AC', role: 'Adds cool supply air from the rear wall', icon: Snowflake },
  vent: { title: 'Exhaust vent', role: 'Pulls stale air toward the wall outlet', icon: AirVent },
}

export const deviceColors: Record<DeviceKey, string> = {
  fan: '#2a9d8f',
  ac: '#3b82f6',
  vent: '#64748b',
}

export const streamlineColor = '#38bdf8'
export const acFlowTransform: ObjectTransform = { position: [2.65, 0, -3.45], rotation: [0, Math.PI / 2, 0] }
export const acFlowOrigin: [number, number, number] = [2.65, 2.02, -3.04]

export const cameraViews: Record<
  CameraView,
  { label: string; position: [number, number, number]; target: [number, number, number]; up?: [number, number, number] }
> = {
  iso: { label: 'Iso', position: [8.2, 5.8, 8.0], target: [0, 0.9, 0] },
  top: { label: 'Top', position: [0, 10.6, 0.01], target: [0, 0.2, 0], up: [0, 0, -1] },
  front: { label: 'Front', position: [0, 3.2, 10.4], target: [0, 1.15, 0] },
  fit: { label: 'Fit', position: [0, 7.8, 10.8], target: [0, 0.75, 0] },
}

export const scalarOverlayCopy: Record<ScalarOverlayMode, { label: string; legend: string }> = {
  airflow: { label: 'Airflow', legend: 'device dye / airflow influence' },
  temperature: { label: 'Temp', legend: 'temperature field' },
  humidity: { label: 'Humidity', legend: 'humidity field' },
  pm25: { label: 'PM2.5', legend: 'PM2.5 concentration' },
  co2: { label: 'CO2', legend: 'CO2 concentration' },
  noise: { label: 'Noise', legend: 'device noise field' },
}

export const scalarOverlaySliceCopy: Record<ScalarOverlaySlice, { label: string; y: number | null }> = {
  average: { label: 'Avg', y: null },
  floor: { label: 'Floor', y: 0.28 },
  seated: { label: 'Seated', y: 1.05 },
  standing: { label: 'Standing', y: 1.65 },
  ceiling: { label: 'Ceiling', y: 2.25 },
}

export const modelUrls: Partial<Record<EditableObjectKey | 'fanBody', string>> = {
  sofa: '/models/sofa.glb',
  coffeeTable: '/models/coffee-table.glb',
  mediaConsole: '/models/media-console.glb',
  sideTable: '/models/side-table.glb',
  crib: '/models/crib.glb',
  plant: '/models/plant.glb',
  lamp: '/models/lamp.glb',
  fanBody: '/models/fan-body.glb',
}
