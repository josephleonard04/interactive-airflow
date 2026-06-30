import type { DeviceState } from '../stableFluidSolver.ts'
import { getZoneById, type RoomZone } from '../scene/zones.ts'
import type { IntentMapperInput, IntentMapperResult } from '../intent/heuristicMapper.ts'
import type { AirflowIntent } from '../intent/types.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'
import { buildFlowLayout } from '../state/flowLayout.ts'
import { detectObjectiveConflicts, summarizeConflicts } from './conflict.ts'
import { evaluateHeadlessAirflow } from './headlessEvaluate.ts'
import { resolveObjectiveTargetZone, scoreIntentAchievement, type ObjectiveEvaluation } from './objectives.ts'

export type OptimizationSummary = {
  enabled: boolean
  bestScore: number
  heuristicScore: number
  evaluations: number
  elapsedMs: number
  conflictSummary: string
}

type FallbackMapper = (input: IntentMapperInput) => IntentMapperResult

type Candidate = {
  devices: DeviceState
  objectTransforms: Record<EditableObjectKey, ObjectTransform>
  label: string
}

type ScoredCandidate = Candidate & {
  objective: ObjectiveEvaluation
}

const fastHeadlessOptions = {
  width: 18,
  height: 14,
  layers: 8,
  steps: 9,
  dt: 0.035,
}

export function optimizeIntentDeviceConfig(input: IntentMapperInput, fallbackMapper: FallbackMapper): IntentMapperResult {
  if (input.parseResult.intents.length === 0) {
    return fallbackMapper(input)
  }

  const start = performance.now()
  const fallback = fallbackMapper(input)
  const conflicts = detectObjectiveConflicts(input.parseResult)
  const conflictSummary = summarizeConflicts(conflicts)
  const heuristicCandidate: Candidate = {
    devices: cloneDevices(fallback.devices),
    objectTransforms: cloneTransforms(fallback.objectTransforms),
    label: 'heuristic',
  }
  const currentCandidate: Candidate = {
    devices: cloneDevices(input.devices),
    objectTransforms: cloneTransforms(input.objectTransforms),
    label: 'current',
  }

  let evaluations = 0
  let best = scoreCandidate(input, heuristicCandidate)
  evaluations += 1

  const current = scoreCandidate(input, currentCandidate)
  evaluations += 1

  if (current.objective.score > best.objective.score) {
    best = current
  }

  for (const yaw of buildYawCandidates(input, fallback.objectTransforms)) {
    const candidate = withFanYaw(best, yaw, 'yaw')
    const scored = scoreCandidate(input, candidate)
    evaluations += 1

    if (isBetter(scored, best)) {
      best = scored
    }
  }

  for (const speed of buildSpeedCandidates(best.devices.fan.speed, [0, 34, 46, 58, 70, 84, 96])) {
    const candidate = withDevice(best, 'fan', { enabled: speed > 0, speed }, 'fan-speed')
    const scored = scoreCandidate(input, applyDeviceLimits(input, candidate))
    evaluations += 1

    if (isBetter(scored, best)) {
      best = scored
    }
  }

  for (const speed of buildSpeedCandidates(best.devices.ac.speed, [0, 38, 52, 66, 80, 92])) {
    const candidate = withDevice(best, 'ac', { enabled: speed > 0, speed }, 'ac-speed')
    const scored = scoreCandidate(input, applyDeviceLimits(input, candidate))
    evaluations += 1

    if (isBetter(scored, best)) {
      best = scored
    }
  }

  for (const speed of buildSpeedCandidates(best.devices.vent.speed, [0, 32, 48, 64, 82, 96])) {
    const candidate = withDevice(best, 'vent', { enabled: speed > 0, speed }, 'vent-speed')
    const scored = scoreCandidate(input, applyDeviceLimits(input, candidate))
    evaluations += 1

    if (isBetter(scored, best)) {
      best = scored
    }
  }

  const yawRefinement = buildYawCandidates(input, best.objectTransforms).slice(0, 7)

  for (const yaw of yawRefinement) {
    for (const fanSpeed of buildSpeedCandidates(best.devices.fan.speed, [Math.max(0, best.devices.fan.speed - 12), best.devices.fan.speed, Math.min(100, best.devices.fan.speed + 12)])) {
      const candidate = withDevice(withFanYaw(best, yaw, 'refine-yaw'), 'fan', { enabled: fanSpeed > 0, speed: fanSpeed }, 'refine-fan')
      const scored = scoreCandidate(input, applyDeviceLimits(input, candidate))
      evaluations += 1

      if (isBetter(scored, best)) {
        best = scored
      }
    }
  }

  const heuristicScore = scoreCandidate(input, heuristicCandidate).objective.score
  const bestScore = best.objective.score
  const elapsedMs = performance.now() - start
  const summaryParts = [
    `Optimized mapper score ${Math.round(bestScore)} vs heuristic ${Math.round(heuristicScore)} across ${evaluations} candidates`,
  ]

  if (conflictSummary) {
    summaryParts.push(conflictSummary)
  }

  return {
    devices: best.devices,
    objectTransforms: best.objectTransforms,
    autoFanSweep: false,
    selectedObject: best.label === 'current' ? fallback.selectedObject : 'fan',
    changed: fallback.changed || best.label !== 'current' || Math.abs(bestScore - current.objective.score) > 0.1,
    summary: `${summaryParts.join('. ')}.`,
    optimization: {
      enabled: true,
      bestScore,
      heuristicScore,
      evaluations,
      elapsedMs,
      conflictSummary,
    },
  }
}

function scoreCandidate(input: IntentMapperInput, candidate: Candidate): ScoredCandidate {
  const layout = buildFlowLayout(candidate.objectTransforms)
  const evaluation = evaluateHeadlessAirflow(candidate.devices, layout, {
    ...fastHeadlessOptions,
    transforms: candidate.objectTransforms,
  })

  return {
    ...candidate,
    objective: scoreIntentAchievement({
      devices: candidate.devices,
      metrics: evaluation.metrics,
      objectTransforms: candidate.objectTransforms,
      parseResult: input.parseResult,
      sketchBindings: input.sketchBindings,
    }),
  }
}

function buildYawCandidates(input: IntentMapperInput, seedTransforms: Record<EditableObjectKey, ObjectTransform>) {
  const fanTransform = seedTransforms.fan
  const yaws = [
    input.objectTransforms.fan.rotation[1],
    seedTransforms.fan.rotation[1],
  ]

  for (const intent of input.parseResult.intents) {
    const targetZone = resolveObjectiveTargetZone(intent.target, input.objectTransforms, input.sketchBindings ?? [])

    if (targetZone && shouldAimFan(intent)) {
      const yaw = yawFromFanToZone(fanTransform, targetZone)
      yaws.push(yaw, yaw - 0.38, yaw + 0.38, yaw - 0.72, yaw + 0.72)
    }

    for (const constraint of intent.constraints) {
      if (constraint.type !== 'avoid-zone' || (constraint.metric !== undefined && constraint.metric !== 'airflow')) {
        continue
      }

      const protectedZone = getZoneById(constraint.zoneId, input.objectTransforms)

      if (!protectedZone) {
        continue
      }

      const protectedYaw = yawFromFanToZone(fanTransform, protectedZone)
      yaws.push(protectedYaw - 1.05, protectedYaw + 1.05, protectedYaw + Math.PI)
    }
  }

  return unique(yaws.map(normalizeAngle))
}

function shouldAimFan(intent: AirflowIntent) {
  return (
    (intent.metric === 'temp' && intent.direction === 'down') ||
    (intent.metric === 'airflow' && intent.direction === 'up') ||
    ((intent.metric === 'co2' || intent.metric === 'pm25') && intent.direction === 'down')
  )
}

function buildSpeedCandidates(seed: number, anchors: number[]) {
  return unique([
    Math.round(seed),
    Math.max(0, Math.round(seed - 16)),
    Math.min(100, Math.round(seed + 16)),
    ...anchors,
  ]).filter((value) => value >= 0 && value <= 100)
}

function applyDeviceLimits(input: IntentMapperInput, candidate: Candidate): Candidate {
  const devices = cloneDevices(candidate.devices)

  for (const intent of input.parseResult.intents) {
    for (const constraint of intent.constraints) {
      if (constraint.type !== 'device-limit') {
        continue
      }

      if (constraint.enabled !== undefined) {
        devices[constraint.device].enabled = constraint.enabled
      }

      if (constraint.maxSpeed !== undefined) {
        devices[constraint.device].speed = Math.min(devices[constraint.device].speed, constraint.maxSpeed)
      }
    }
  }

  return {
    ...candidate,
    devices,
  }
}

function withFanYaw(candidate: Candidate, yaw: number, label: string): Candidate {
  return {
    devices: cloneDevices(candidate.devices),
    objectTransforms: {
      ...cloneTransforms(candidate.objectTransforms),
      fan: {
        ...candidate.objectTransforms.fan,
        rotation: [0, normalizeAngle(yaw), 0],
      },
    },
    label,
  }
}

function withDevice(
  candidate: Candidate,
  device: keyof DeviceState,
  next: { enabled: boolean; speed: number },
  label: string,
): Candidate {
  return {
    devices: {
      ...cloneDevices(candidate.devices),
      [device]: { ...next },
    },
    objectTransforms: cloneTransforms(candidate.objectTransforms),
    label,
  }
}

function yawFromFanToZone(fanTransform: ObjectTransform, zone: RoomZone) {
  const dx = zone.anchor[0] - fanTransform.position[0]
  const dz = zone.anchor[2] - fanTransform.position[2]

  return normalizeAngle(Math.atan2(dz, -dx))
}

function isBetter(candidate: ScoredCandidate, best: ScoredCandidate) {
  if (candidate.objective.score > best.objective.score + 0.01) {
    return true
  }

  if (Math.abs(candidate.objective.score - best.objective.score) > 0.01) {
    return false
  }

  return totalSpeed(candidate.devices) < totalSpeed(best.devices)
}

function totalSpeed(devices: DeviceState) {
  return (devices.fan.enabled ? devices.fan.speed : 0) +
    (devices.ac.enabled ? devices.ac.speed : 0) +
    (devices.vent.enabled ? devices.vent.speed : 0)
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

function unique<T>(values: T[]) {
  return Array.from(new Set(values))
}
