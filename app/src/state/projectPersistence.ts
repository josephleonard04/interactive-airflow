import type { DeviceState } from '../stableFluidSolver.ts'
import type { IntentMapperMode } from '../intent/heuristicMapper.ts'
import { emptyIntentSession, type IntentSessionState } from '../intent/session.ts'
import type { SketchPrimitive } from '../sketch/primitives.ts'
import { initialObjectTransforms, presets } from './appConstants.ts'
import type { AirflowPreset, EditableObjectKey, ObjectTransform } from './appTypes.ts'
import type { ZoneMetrics } from '../solver/zoneMetrics.ts'
import type { GoalFeedbackItem } from '../ui/goalFeedbackModel.ts'

export type RoomDesignProject = {
  version: 1
  savedAt: string
  devices: DeviceState
  intentSession: IntentSessionState
  mapperMode: IntentMapperMode
  objectTransforms: Record<EditableObjectKey, ObjectTransform>
  preset: AirflowPreset
  sketchPrimitives: SketchPrimitive[]
}

export type ResearchLog = RoomDesignProject & {
  kind: 'research-log'
  goalFeedback: GoalFeedbackItem[]
  zoneMetrics: ZoneMetrics
}

export function buildRoomDesignProject(input: Omit<RoomDesignProject, 'savedAt' | 'version'>): RoomDesignProject {
  return {
    ...input,
    version: 1,
    savedAt: new Date().toISOString(),
  }
}

export function buildResearchLog(input: Omit<ResearchLog, 'kind' | 'savedAt' | 'version'>): ResearchLog {
  return {
    ...input,
    kind: 'research-log',
    version: 1,
    savedAt: new Date().toISOString(),
  }
}

export function parseRoomDesignProject(text: string): RoomDesignProject {
  const candidate = JSON.parse(text) as Partial<RoomDesignProject>

  if (candidate.version !== 1) {
    throw new Error('Unsupported project file version.')
  }

  return {
    version: 1,
    savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : new Date().toISOString(),
    devices: normalizeDevices(candidate.devices),
    intentSession: normalizeSession(candidate.intentSession),
    mapperMode: candidate.mapperMode === 'heuristic' ? 'heuristic' : 'optimized',
    objectTransforms: normalizeTransforms(candidate.objectTransforms),
    preset: normalizePreset(candidate.preset),
    sketchPrimitives: Array.isArray(candidate.sketchPrimitives) ? candidate.sketchPrimitives : [],
  }
}

export function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function normalizeDevices(devices: unknown): DeviceState {
  if (!devices || typeof devices !== 'object') {
    return structuredClone(presets.comfort)
  }

  const candidate = devices as Partial<DeviceState>

  return {
    fan: normalizeDevice(candidate.fan, presets.comfort.fan),
    ac: normalizeDevice(candidate.ac, presets.comfort.ac),
    vent: normalizeDevice(candidate.vent, presets.comfort.vent),
  }
}

function normalizeDevice(device: unknown, fallback: DeviceState[keyof DeviceState]) {
  if (!device || typeof device !== 'object') {
    return { ...fallback }
  }

  const candidate = device as Partial<DeviceState[keyof DeviceState]>

  return {
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : fallback.enabled,
    speed: typeof candidate.speed === 'number' ? Math.max(0, Math.min(100, candidate.speed)) : fallback.speed,
  }
}

function normalizeSession(session: unknown): IntentSessionState {
  if (!session || typeof session !== 'object') {
    return emptyIntentSession
  }

  const candidate = session as Partial<IntentSessionState>

  return {
    entries: Array.isArray(candidate.entries) ? candidate.entries : [],
    turns: Array.isArray(candidate.turns) ? candidate.turns : [],
    sketchBindings: Array.isArray(candidate.sketchBindings) ? candidate.sketchBindings : [],
  }
}

function normalizeTransforms(transforms: unknown): Record<EditableObjectKey, ObjectTransform> {
  const base = structuredClone(initialObjectTransforms)

  if (!transforms || typeof transforms !== 'object') {
    return base
  }

  const candidate = transforms as Partial<Record<EditableObjectKey, ObjectTransform>>

  for (const key of Object.keys(base) as EditableObjectKey[]) {
    const transform = candidate[key]

    if (!transform) {
      continue
    }

    base[key] = {
      position: normalizeTuple(transform.position, base[key].position),
      rotation: normalizeTuple(transform.rotation, base[key].rotation),
    }
  }

  return base
}

function normalizeTuple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) {
    return [...fallback]
  }

  return [
    typeof value[0] === 'number' ? value[0] : fallback[0],
    typeof value[1] === 'number' ? value[1] : fallback[1],
    typeof value[2] === 'number' ? value[2] : fallback[2],
  ]
}

function normalizePreset(value: unknown): AirflowPreset {
  return value === 'cooling' || value === 'purge' || value === 'comfort' ? value : 'comfort'
}
