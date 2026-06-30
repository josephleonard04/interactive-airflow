import type { DeviceState } from '../stableFluidSolver'
import { getZoneById, type RoomZone, type ZoneId } from '../scene/zones.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'
import { optimizeIntentDeviceConfig, type OptimizationSummary } from '../solver/optimize.ts'
import type { SketchRegionBinding } from './bind.ts'
import type { AirflowIntent, IntentConstraint, IntentParseResult, IntentTarget } from './types.ts'

export type IntentMapperMode = 'optimized' | 'heuristic'

export type IntentMapperInput = {
  devices: DeviceState
  objectTransforms: Record<EditableObjectKey, ObjectTransform>
  parseResult: IntentParseResult
  sketchBindings?: SketchRegionBinding[]
  mapperMode?: IntentMapperMode
}

export type IntentMapperResult = {
  devices: DeviceState
  objectTransforms: Record<EditableObjectKey, ObjectTransform>
  autoFanSweep: boolean
  selectedObject: EditableObjectKey | null
  changed: boolean
  summary: string
  optimization?: OptimizationSummary
}

const fanBoostByMagnitude = {
  slight: 64,
  moderate: 74,
  much: 86,
} as const

export function mapIntentsToDeviceConfig(input: IntentMapperInput): IntentMapperResult {
  if (input.mapperMode === 'heuristic') {
    return mapIntentsHeuristically(input)
  }

  return optimizeIntentDeviceConfig(input, mapIntentsHeuristically)
}

export function mapIntentsHeuristically(input: IntentMapperInput): IntentMapperResult {
  const devices = cloneDevices(input.devices)
  const objectTransforms = cloneTransforms(input.objectTransforms)
  const fanTransform = objectTransforms.fan
  const notes: string[] = []
  let changed = false
  let preferredFanYaw: number | null = null
  let fanTargetZone: RoomZone | null = null

  const avoidAirflowZones = collectAvoidAirflowZones(input.parseResult.intents)
  const quietMode = input.parseResult.intents.some((intent) =>
    intent.metric === 'noise' ||
    intent.constraints.some((constraint) => constraint.type === 'max-noise' && constraint.level === 'quiet'),
  )

  for (const intent of input.parseResult.intents) {
    const targetZone = resolveIntentTargetZone(intent.target, input.objectTransforms, input.sketchBindings ?? [])

    if (intent.metric === 'temp' && intent.direction === 'down') {
      devices.fan.enabled = true
      devices.ac.enabled = true
      devices.fan.speed = Math.max(devices.fan.speed, quietMode ? 52 : fanBoostByMagnitude[intent.magnitude])
      devices.ac.speed = Math.max(devices.ac.speed, intent.magnitude === 'much' ? 72 : 58)

      if (targetZone) {
        fanTargetZone = targetZone
        preferredFanYaw = yawFromFanToZone(fanTransform, targetZone)
        notes.push(`fan aimed toward ${targetZone.id} for cooling`)
      }

      changed = true
    }

    if ((intent.metric === 'co2' || intent.metric === 'pm25') && intent.direction === 'down') {
      devices.vent.enabled = true
      devices.vent.speed = Math.max(devices.vent.speed, quietMode ? 58 : intent.magnitude === 'much' ? 82 : 68)

      if (!quietMode) {
        devices.fan.enabled = true
        devices.fan.speed = Math.max(devices.fan.speed, 58)
      }

      if (targetZone && preferredFanYaw === null) {
        fanTargetZone = targetZone
        preferredFanYaw = yawFromFanToZone(fanTransform, targetZone)
      }

      notes.push(`vent boosted for ${intent.metric}`)
      changed = true
    }

    if (intent.metric === 'airflow' && intent.direction === 'up' && targetZone) {
      devices.fan.enabled = true
      devices.fan.speed = Math.max(devices.fan.speed, fanBoostByMagnitude[intent.magnitude])
      fanTargetZone = targetZone
      preferredFanYaw = yawFromFanToZone(fanTransform, targetZone)
      notes.push(`fan aimed toward ${targetZone.id} for airflow`)
      changed = true
    }

    if (intent.metric === 'airflow' && intent.direction === 'keep') {
      if (preferredFanYaw === null) {
        devices.fan.speed = Math.min(devices.fan.speed, quietMode ? 42 : 56)
      }
      notes.push('fan draft reduced near protected zone')
      changed = true
    }
  }

  if (quietMode) {
    devices.fan.speed = Math.min(devices.fan.speed, 52)
    devices.vent.speed = Math.min(Math.max(devices.vent.speed, 50), 62)
    notes.push('quiet constraint capped fan speed')
    changed = true
  }

  if (preferredFanYaw !== null) {
    const adjustedYaw = avoidAirflowZones.reduce(
      (yaw, zoneId) => avoidZoneYaw(yaw, fanTransform, zoneId, input.objectTransforms),
      preferredFanYaw,
    )

    objectTransforms.fan = {
      ...fanTransform,
      rotation: [0, adjustedYaw, 0],
    }
    changed = changed || Math.abs(angleDelta(fanTransform.rotation[1], adjustedYaw)) > 0.01

    if (fanTargetZone && adjustedYaw !== preferredFanYaw) {
      notes.push(`fan yaw adjusted to avoid ${avoidAirflowZones.join(', ')}`)
    }
  } else if (avoidAirflowZones.length > 0) {
    const adjustedYaw = avoidAirflowZones.reduce(
      (yaw, zoneId) => avoidZoneYaw(yaw, fanTransform, zoneId, input.objectTransforms),
      fanTransform.rotation[1],
    )

    objectTransforms.fan = {
      ...fanTransform,
      rotation: [0, adjustedYaw, 0],
    }
    changed = changed || Math.abs(angleDelta(fanTransform.rotation[1], adjustedYaw)) > 0.01
    notes.push(`fan yaw adjusted away from ${avoidAirflowZones.join(', ')}`)
  }

  return {
    devices,
    objectTransforms,
    autoFanSweep: false,
    selectedObject: changed ? 'fan' : null,
    changed,
    summary: notes.length > 0 ? `Applied mapper: ${unique(notes).join('; ')}.` : 'No device changes mapped yet.',
  }
}

export function yawFromFanToZone(fanTransform: ObjectTransform, zone: RoomZone) {
  const dx = zone.anchor[0] - fanTransform.position[0]
  const dz = zone.anchor[2] - fanTransform.position[2]

  return normalizeAngle(Math.atan2(dz, -dx))
}

function collectAvoidAirflowZones(intents: AirflowIntent[]): ZoneId[] {
  const zoneIds: ZoneId[] = []

  for (const intent of intents) {
    for (const constraint of intent.constraints) {
      if (isAvoidAirflowConstraint(constraint)) {
        zoneIds.push(constraint.zoneId)
      }
    }

    if (intent.metric === 'airflow' && intent.direction === 'keep' && intent.target.type === 'zone') {
      zoneIds.push(intent.target.zoneId)
    }
  }

  return unique(zoneIds)
}

function resolveIntentTargetZone(
  target: IntentTarget,
  transforms: Record<EditableObjectKey, ObjectTransform>,
  sketchBindings: SketchRegionBinding[],
): RoomZone | null {
  if (target.type === 'zone') {
    return getZoneById(target.zoneId, transforms)
  }

  if (target.type === 'object' && target.derivedZoneId) {
    return getZoneById(target.derivedZoneId, transforms)
  }

  if (target.type === 'region') {
    const binding = sketchBindings.find((item) => item.regionId === target.regionId)

    if (!binding) {
      return null
    }

    return {
      id: binding.derivedZoneId ?? 'centerArea',
      label: target.label ?? 'Sketch region',
      kind: 'fixed',
      anchor: [
        binding.center.x,
        (binding.height.minY + binding.height.maxY) / 2,
        binding.center.z,
      ],
      bounds: {
        minX: binding.min?.x ?? binding.center.x - (binding.radius ?? 0.45),
        maxX: binding.max?.x ?? binding.center.x + (binding.radius ?? 0.45),
        minY: binding.height.minY,
        maxY: binding.height.maxY,
        minZ: binding.min?.z ?? binding.center.z - (binding.radius ?? 0.45),
        maxZ: binding.max?.z ?? binding.center.z + (binding.radius ?? 0.45),
      },
      aliases: [target.label ?? 'sketch region'],
      priority: 95,
    }
  }

  return null
}

function avoidZoneYaw(
  desiredYaw: number,
  fanTransform: ObjectTransform,
  zoneId: ZoneId,
  transforms: Record<EditableObjectKey, ObjectTransform>,
) {
  const protectedZone = getZoneById(zoneId, transforms)

  if (!protectedZone) {
    return desiredYaw
  }

  const protectedYaw = yawFromFanToZone(fanTransform, protectedZone)
  const separation = angleDelta(protectedYaw, desiredYaw)
  const minSeparation = 0.92

  if (Math.abs(separation) >= minSeparation) {
    return desiredYaw
  }

  const side = separation === 0 ? -1 : Math.sign(separation)

  return normalizeAngle(protectedYaw + side * minSeparation)
}

function isAvoidAirflowConstraint(constraint: IntentConstraint): constraint is Extract<IntentConstraint, { type: 'avoid-zone' }> {
  return constraint.type === 'avoid-zone' && (constraint.metric === undefined || constraint.metric === 'airflow')
}

function cloneDevices(devices: DeviceState): DeviceState {
  return {
    fan: { ...devices.fan },
    ac: { ...devices.ac },
    vent: { ...devices.vent },
  }
}

function cloneTransforms(transforms: Record<EditableObjectKey, ObjectTransform>) {
  return Object.fromEntries(
    Object.entries(transforms).map(([id, transform]) => [
      id,
      {
        position: [...transform.position],
        rotation: [...transform.rotation],
      },
    ]),
  ) as Record<EditableObjectKey, ObjectTransform>
}

function normalizeAngle(angle: number) {
  let value = angle

  while (value > Math.PI) {
    value -= Math.PI * 2
  }

  while (value < -Math.PI) {
    value += Math.PI * 2
  }

  return value
}

function angleDelta(from: number, to: number) {
  return normalizeAngle(to - from)
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values))
}
