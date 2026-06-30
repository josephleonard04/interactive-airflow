import type { DeviceState } from '../stableFluidSolver.ts'
import { getZoneById, type RoomZone } from '../scene/zones.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'
import type { SketchRegionBinding } from '../intent/bind.ts'
import type {
  AirflowIntent,
  IntentMagnitude,
  IntentMetric,
  IntentParseResult,
  IntentPriority,
  IntentTarget,
} from '../intent/types.ts'
import type { ZoneMetricValues, ZoneMetrics } from './zoneMetrics.ts'

export type ObjectiveTerm = {
  id: string
  intentId: string
  label: string
  metric: IntentMetric | 'device-noise'
  priority: IntentPriority
  weight: number
  value: number
  target: number
  penalty: number
  achievement: number
}

export type ObjectiveEvaluation = {
  achievement: number
  score: number
  penalty: number
  weightedPenalty: number
  totalWeight: number
  terms: ObjectiveTerm[]
  summary: string
}

export type ObjectiveEvaluationInput = {
  devices?: DeviceState
  metrics: ZoneMetrics
  objectTransforms: Record<EditableObjectKey, ObjectTransform>
  parseResult: IntentParseResult
  sketchBindings?: SketchRegionBinding[]
}

const priorityWeight: Record<IntentPriority, number> = {
  low: 0.7,
  normal: 1,
  high: 1.45,
  critical: 2.15,
}

const magnitudeWeight: Record<IntentMagnitude, number> = {
  slight: 0.8,
  moderate: 1,
  much: 1.25,
}

const downTargets: Record<Exclude<IntentMetric, 'airflow' | 'noise'>, Record<IntentMagnitude, number>> = {
  temp: { slight: 0.505, moderate: 0.47, much: 0.435 },
  humidity: { slight: 0.44, moderate: 0.39, much: 0.34 },
  pm25: { slight: 0.135, moderate: 0.095, much: 0.065 },
  co2: { slight: 0.235, moderate: 0.185, much: 0.145 },
}

const upTargets: Record<Exclude<IntentMetric, 'noise'>, Record<IntentMagnitude, number>> = {
  temp: { slight: 0.575, moderate: 0.61, much: 0.65 },
  humidity: { slight: 0.54, moderate: 0.61, much: 0.68 },
  pm25: { slight: 0.24, moderate: 0.32, much: 0.42 },
  co2: { slight: 0.34, moderate: 0.45, much: 0.56 },
  airflow: { slight: 0.06, moderate: 0.085, much: 0.12 },
}

const keepAirflowMax: Record<IntentMagnitude, number> = {
  slight: 0.055,
  moderate: 0.038,
  much: 0.026,
}

const metricScale: Record<IntentMetric | 'device-noise', number> = {
  temp: 0.16,
  humidity: 0.2,
  pm25: 0.2,
  co2: 0.24,
  airflow: 0.11,
  noise: 0.35,
  'device-noise': 70,
}

export function scoreIntentAchievement(input: ObjectiveEvaluationInput): ObjectiveEvaluation {
  const terms = buildObjectiveTerms(input)
  const totalWeight = terms.reduce((sum, term) => sum + term.weight, 0)
  const weightedPenalty = terms.reduce((sum, term) => sum + term.penalty * term.weight, 0)
  const normalizedPenalty = totalWeight > 0 ? weightedPenalty / totalWeight : 0
  const achievement = totalWeight > 0 ? clamp01(1 - normalizedPenalty) : 1
  const score = achievement * 100

  return {
    achievement,
    score,
    penalty: normalizedPenalty,
    weightedPenalty,
    totalWeight,
    terms,
    summary: terms.length > 0
      ? `Objective score ${Math.round(score)} with ${terms.length} term${terms.length === 1 ? '' : 's'}.`
      : 'No active objective terms.',
  }
}

export function buildObjectiveTerms(input: ObjectiveEvaluationInput): ObjectiveTerm[] {
  const terms: ObjectiveTerm[] = []

  for (const intent of input.parseResult.intents) {
    const targetZone = resolveObjectiveTargetZone(intent.target, input.objectTransforms, input.sketchBindings ?? [])
    const metricValues = targetZone ? input.metrics[targetZone.id] : undefined

    if (metricValues && targetZone) {
      const metricTerm = buildMetricTerm(intent, metricValues, targetZone)

      if (metricTerm) {
        terms.push(metricTerm)
      }
    }

    for (const constraint of intent.constraints) {
      if (constraint.type === 'avoid-zone' && (constraint.metric === undefined || constraint.metric === 'airflow')) {
        const values = input.metrics[constraint.zoneId]

        if (values) {
          terms.push(buildLimitTerm({
            id: `${intent.id}:avoid:${constraint.zoneId}`,
            intent,
            label: `keep draft out of ${constraint.zoneId}`,
            metric: 'airflow',
            value: values.airflow,
            target: keepAirflowMax[intent.magnitude],
            weightMultiplier: 1.75,
          }))
        }
      }

      if (constraint.type === 'keep-zone') {
        const values = input.metrics[constraint.zoneId]

        if (values) {
          const value = values[constraint.metric as keyof ZoneMetricValues]

          if (typeof value === 'number') {
            terms.push(buildLimitTerm({
              id: `${intent.id}:keep:${constraint.zoneId}:${constraint.metric}`,
              intent,
              label: `keep ${constraint.metric} steady in ${constraint.zoneId}`,
              metric: constraint.metric,
              value,
              target: constraint.metric === 'airflow' ? keepAirflowMax[intent.magnitude] : value,
              weightMultiplier: 1.25,
            }))
          }
        }
      }

      if (constraint.type === 'max-noise' && input.devices) {
        terms.push(buildNoiseTerm(intent, input.devices, constraint.level === 'quiet' ? 46 : 64))
      }

      if (constraint.type === 'device-limit' && input.devices) {
        const device = input.devices[constraint.device]

        if (constraint.enabled !== undefined && device.enabled !== constraint.enabled) {
          terms.push({
            id: `${intent.id}:device:${constraint.device}:enabled`,
            intentId: intent.id,
            label: `${constraint.device} ${constraint.enabled ? 'enabled' : 'disabled'}`,
            metric: 'device-noise',
            priority: intent.priority,
            weight: baseWeight(intent) * 1.6,
            value: device.enabled ? 1 : 0,
            target: constraint.enabled ? 1 : 0,
            penalty: 1,
            achievement: 0,
          })
        }

        if (constraint.maxSpeed !== undefined) {
          terms.push(buildLimitTerm({
            id: `${intent.id}:device:${constraint.device}:speed`,
            intent,
            label: `${constraint.device} speed cap`,
            metric: 'device-noise',
            value: device.speed,
            target: constraint.maxSpeed,
            weightMultiplier: 1.4,
          }))
        }
      }
    }

    if (intent.metric === 'noise' && input.devices) {
      terms.push(buildNoiseTerm(intent, input.devices, intent.magnitude === 'much' ? 38 : intent.magnitude === 'moderate' ? 46 : 56))
    }
  }

  return terms
}

export function resolveObjectiveTargetZone(
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

export function priorityValue(priority: IntentPriority) {
  return priorityWeight[priority]
}

function buildMetricTerm(intent: AirflowIntent, values: ZoneMetricValues, zone: RoomZone): ObjectiveTerm | null {
  const value = values[intent.metric as keyof ZoneMetricValues]

  if (typeof value !== 'number') {
    return null
  }

  if (intent.metric === 'noise' && intent.direction === 'down') {
    return buildLimitTerm({
      id: `${intent.id}:${zone.id}:noise:down`,
      intent,
      label: `${zone.id} noise below target`,
      metric: 'noise',
      value,
      target: intent.magnitude === 'much' ? 0.2 : intent.magnitude === 'moderate' ? 0.28 : 0.38,
      weightMultiplier: 1.35,
    })
  }

  if (intent.direction === 'down' && intent.metric !== 'airflow' && intent.metric !== 'noise') {
    const target = downTargets[intent.metric][intent.magnitude]

    return buildLimitTerm({
      id: `${intent.id}:${zone.id}:${intent.metric}:down`,
      intent,
      label: `${zone.id} ${intent.metric} below target`,
      metric: intent.metric,
      value,
      target,
    })
  }

  if (intent.direction === 'up' && intent.metric !== 'noise') {
    const target = upTargets[intent.metric][intent.magnitude]
    const penalty = clamp01((target - value) / metricScale[intent.metric])

    return {
      id: `${intent.id}:${zone.id}:${intent.metric}:up`,
      intentId: intent.id,
      label: `${zone.id} ${intent.metric} above target`,
      metric: intent.metric,
      priority: intent.priority,
      weight: baseWeight(intent),
      value,
      target,
      penalty,
      achievement: clamp01(1 - penalty),
    }
  }

  if (intent.metric === 'airflow' && intent.direction === 'keep') {
    return buildLimitTerm({
      id: `${intent.id}:${zone.id}:airflow:keep`,
      intent,
      label: `${zone.id} draft below target`,
      metric: 'airflow',
      value,
      target: keepAirflowMax[intent.magnitude],
      weightMultiplier: 1.5,
    })
  }

  return null
}

function buildLimitTerm({
  id,
  intent,
  label,
  metric,
  target,
  value,
  weightMultiplier = 1,
}: {
  id: string
  intent: AirflowIntent
  label: string
  metric: ObjectiveTerm['metric']
  target: number
  value: number
  weightMultiplier?: number
}): ObjectiveTerm {
  const penalty = clamp01((value - target) / metricScale[metric])

  return {
    id,
    intentId: intent.id,
    label,
    metric,
    priority: intent.priority,
    weight: baseWeight(intent) * weightMultiplier,
    value,
    target,
    penalty,
    achievement: clamp01(1 - penalty),
  }
}

function buildNoiseTerm(intent: AirflowIntent, devices: DeviceState, target: number): ObjectiveTerm {
  const value = noiseProxy(devices)
  const penalty = clamp01((value - target) / metricScale['device-noise'])

  return {
    id: `${intent.id}:noise`,
    intentId: intent.id,
    label: 'device noise proxy below target',
    metric: 'device-noise',
    priority: intent.priority,
    weight: baseWeight(intent) * 1.35,
    value,
    target,
    penalty,
    achievement: clamp01(1 - penalty),
  }
}

function noiseProxy(devices: DeviceState) {
  return (
    (devices.fan.enabled ? devices.fan.speed * 0.78 : 0) +
    (devices.ac.enabled ? devices.ac.speed * 0.36 : 0) +
    (devices.vent.enabled ? devices.vent.speed * 0.46 : 0)
  )
}

function baseWeight(intent: AirflowIntent) {
  return priorityWeight[intent.priority] * magnitudeWeight[intent.magnitude]
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}
