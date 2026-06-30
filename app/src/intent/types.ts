import type { ZoneId } from '../scene/zones'

export type IntentMetric = 'temp' | 'airflow' | 'humidity' | 'pm25' | 'co2' | 'noise'
export type IntentDirection = 'up' | 'down' | 'keep'
export type IntentMagnitude = 'slight' | 'moderate' | 'much'
export type IntentPriority = 'low' | 'normal' | 'high' | 'critical'

export type IntentTimeCondition =
  | {
      type: 'after'
      minutes: number
      label: string
    }
  | {
      type: 'at-clock'
      hour: number
      minute: number
      label: string
    }
  | {
      type: 'steady'
      label: string
    }

export type IntentTarget =
  | {
      type: 'zone'
      zoneId: ZoneId
    }
  | {
      type: 'object'
      objectId: string
      derivedZoneId?: ZoneId
    }
  | {
      type: 'region'
      regionId: string
      label?: string
    }

export type IntentConstraint =
  | {
      type: 'avoid-zone'
      zoneId: ZoneId
      metric?: IntentMetric
    }
  | {
      type: 'keep-zone'
      zoneId: ZoneId
      metric: IntentMetric
    }
  | {
      type: 'max-noise'
      level: 'quiet' | 'normal'
    }
  | {
      type: 'device-limit'
      device: 'fan' | 'ac' | 'vent'
      enabled?: boolean
      maxSpeed?: number
    }

export type AirflowIntent = {
  id: string
  sourceText: string
  target: IntentTarget
  metric: IntentMetric
  direction: IntentDirection
  magnitude: IntentMagnitude
  constraints: IntentConstraint[]
  priority: IntentPriority
  confidence?: number
  timeCondition?: IntentTimeCondition
}

export type IntentParseResult = {
  intents: AirflowIntent[]
  unresolvedReferences: string[]
  needsSketch: boolean
}

export const intentExamples: Record<string, AirflowIntent[]> = {
  'Cool the sofa area slightly': [
    {
      id: 'example-sofa-cooler',
      sourceText: 'Cool the sofa area slightly',
      target: { type: 'zone', zoneId: 'sofaArea' },
      metric: 'temp',
      direction: 'down',
      magnitude: 'slight',
      constraints: [],
      priority: 'normal',
      confidence: 0.9,
    },
  ],
  'Do not blow air onto the baby': [
    {
      id: 'example-protect-baby',
      sourceText: 'Do not blow air onto the baby',
      target: { type: 'zone', zoneId: 'cribArea' },
      metric: 'airflow',
      direction: 'keep',
      magnitude: 'much',
      constraints: [{ type: 'avoid-zone', zoneId: 'cribArea', metric: 'airflow' }],
      priority: 'high',
      confidence: 0.9,
    },
  ],
  'Ventilate quietly': [
    {
      id: 'example-ventilate-quiet',
      sourceText: 'Ventilate quietly',
      target: { type: 'zone', zoneId: 'centerArea' },
      metric: 'co2',
      direction: 'down',
      magnitude: 'moderate',
      constraints: [{ type: 'max-noise', level: 'quiet' }],
      priority: 'normal',
      confidence: 0.75,
    },
  ],
}

export function isAirflowIntent(value: unknown): value is AirflowIntent {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<AirflowIntent>

  return (
    typeof candidate.id === 'string' &&
    typeof candidate.sourceText === 'string' &&
    isIntentTarget(candidate.target) &&
    isOneOf(candidate.metric, ['temp', 'airflow', 'humidity', 'pm25', 'co2', 'noise']) &&
    isOneOf(candidate.direction, ['up', 'down', 'keep']) &&
    isOneOf(candidate.magnitude, ['slight', 'moderate', 'much']) &&
    Array.isArray(candidate.constraints) &&
    candidate.constraints.every(isIntentConstraint) &&
    isOneOf(candidate.priority, ['low', 'normal', 'high', 'critical']) &&
    (candidate.confidence === undefined || typeof candidate.confidence === 'number') &&
    (candidate.timeCondition === undefined || isIntentTimeCondition(candidate.timeCondition))
  )
}

export function isIntentParseResult(value: unknown): value is IntentParseResult {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<IntentParseResult>

  return (
    Array.isArray(candidate.intents) &&
    candidate.intents.every(isAirflowIntent) &&
    Array.isArray(candidate.unresolvedReferences) &&
    candidate.unresolvedReferences.every((item) => typeof item === 'string') &&
    typeof candidate.needsSketch === 'boolean'
  )
}

function isIntentTarget(value: unknown): value is IntentTarget {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<IntentTarget>

  if (candidate.type === 'zone') {
    return typeof candidate.zoneId === 'string'
  }

  if (candidate.type === 'object') {
    return typeof candidate.objectId === 'string'
  }

  if (candidate.type === 'region') {
    return typeof candidate.regionId === 'string'
  }

  return false
}

function isIntentConstraint(value: unknown): value is IntentConstraint {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<IntentConstraint>

  if (candidate.type === 'avoid-zone') {
    return typeof candidate.zoneId === 'string'
  }

  if (candidate.type === 'keep-zone') {
    return typeof candidate.zoneId === 'string' && isOneOf(candidate.metric, ['temp', 'airflow', 'humidity', 'pm25', 'co2', 'noise'])
  }

  if (candidate.type === 'max-noise') {
    return isOneOf(candidate.level, ['quiet', 'normal'])
  }

  if (candidate.type === 'device-limit') {
    return (
      isOneOf(candidate.device, ['fan', 'ac', 'vent']) &&
      (candidate.enabled === undefined || typeof candidate.enabled === 'boolean') &&
      (candidate.maxSpeed === undefined || typeof candidate.maxSpeed === 'number')
    )
  }

  return false
}

function isIntentTimeCondition(value: unknown): value is IntentTimeCondition {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<IntentTimeCondition>

  if (candidate.type === 'after') {
    return typeof candidate.minutes === 'number' && typeof candidate.label === 'string'
  }

  if (candidate.type === 'at-clock') {
    return typeof candidate.hour === 'number' && typeof candidate.minute === 'number' && typeof candidate.label === 'string'
  }

  if (candidate.type === 'steady') {
    return typeof candidate.label === 'string'
  }

  return false
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T)
}
