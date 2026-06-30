import type { DeviceState } from '../stableFluidSolver.ts'
import { getActiveIntentEntries, type IntentSessionEntry, type IntentSessionState } from '../intent/session.ts'
import { resolveObjectiveTargetZone, scoreIntentAchievement } from '../solver/objectives.ts'
import type { ZoneMetrics } from '../solver/zoneMetrics.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'

export type GoalFeedbackItem = {
  id: string
  status: 'ok' | 'warn'
  title: string
  detail: string
  score: number
}

export function buildGoalFeedbackItems({
  devices,
  metrics,
  session,
  transforms,
}: {
  devices: DeviceState
  metrics: ZoneMetrics
  session: IntentSessionState
  transforms: Record<EditableObjectKey, ObjectTransform>
}): GoalFeedbackItem[] {
  const entries = getActiveIntentEntries(session)

  return entries.map((entry) => buildGoalFeedbackItem({
    devices,
    entry,
    metrics,
    session,
    transforms,
  }))
}

function buildGoalFeedbackItem({
  devices,
  entry,
  metrics,
  session,
  transforms,
}: {
  devices: DeviceState
  entry: IntentSessionEntry
  metrics: ZoneMetrics
  session: IntentSessionState
  transforms: Record<EditableObjectKey, ObjectTransform>
}): GoalFeedbackItem {
  const parseResult = {
    intents: [entry.intent],
    needsSketch: false,
    unresolvedReferences: [],
  }
  const objective = scoreIntentAchievement({
    devices,
    metrics,
    objectTransforms: transforms,
    parseResult,
    sketchBindings: session.sketchBindings,
  })
  const targetZone = resolveObjectiveTargetZone(entry.intent.target, transforms, session.sketchBindings)
  const zoneLabel = targetZone?.label ?? targetFallbackLabel(entry)
  const weakestTerm = [...objective.terms].sort((left, right) => left.achievement - right.achievement)[0]
  const score = weakestTerm?.achievement ?? objective.achievement
  const status = score >= 0.72 ? 'ok' : 'warn'

  return {
    id: entry.entryId,
    status,
    title: resultTitle(entry, zoneLabel, status),
    detail: resultDetail(entry, zoneLabel, score, status),
    score,
  }
}

function resultTitle(entry: IntentSessionEntry, zoneLabel: string, status: GoalFeedbackItem['status']) {
  const { intent } = entry

  if (intent.metric === 'airflow' && intent.direction === 'keep') {
    return status === 'ok' ? `${zoneLabel} avoids direct draft` : `${zoneLabel} still feels drafty`
  }

  if (intent.metric === 'temp' && intent.direction === 'down') {
    return status === 'ok' ? `${zoneLabel} is cooling` : `${zoneLabel} needs more cooling`
  }

  if (intent.metric === 'co2' && intent.direction === 'down') {
    return status === 'ok' ? `${zoneLabel} CO2 is lower` : `${zoneLabel} needs more ventilation`
  }

  if (intent.metric === 'pm25' && intent.direction === 'down') {
    return status === 'ok' ? `${zoneLabel} PM2.5 is lower` : `${zoneLabel} still has elevated particles`
  }

  if (intent.metric === 'noise' && intent.direction === 'down') {
    return status === 'ok' ? `${zoneLabel} stays quiet` : `${zoneLabel} may still sound noticeable`
  }

  return status === 'ok' ? `${zoneLabel} is close to target` : `${zoneLabel} has not reached target`
}

function resultDetail(entry: IntentSessionEntry, zoneLabel: string, score: number, status: GoalFeedbackItem['status']) {
  const percent = Math.round(score * 100)
  const { intent } = entry

  if (intent.metric === 'temp' && intent.direction === 'down') {
    const timeLabel = entry.intent.timeCondition?.label ?? 'after about 5 min'

    return status === 'ok'
      ? `Expected to enter the comfort band ${timeLabel}; current achievement is ${percent}%.`
      : `More cooling or better fan direction is needed; current achievement is ${percent}%.`
  }

  if (intent.metric === 'airflow' && intent.direction === 'keep') {
    return status === 'ok'
      ? `Draft in the protected zone is reduced; current achievement is ${percent}%.`
      : `Try lowering fan speed or changing fan direction; current achievement is ${percent}%.`
  }

  if (intent.metric === 'co2' || intent.metric === 'pm25') {
    return status === 'ok'
      ? `Air exchange is moving in the right direction; current achievement is ${percent}%.`
      : `Increase ventilation or run it longer; current achievement is ${percent}%.`
  }

  if (intent.metric === 'noise') {
    const timeText = entry.intent.timeCondition ? `Target time ${entry.intent.timeCondition.label}; ` : ''

    return status === 'ok'
      ? `${timeText}local noise and device speed are constrained; current achievement is ${percent}%.`
      : `${timeText}noise reduction is trading off against other goals; current achievement is ${percent}%.`
  }

  return `${zoneLabel} current achievement is ${percent}%.`
}

function targetFallbackLabel(entry: IntentSessionEntry) {
  const { target } = entry.intent

  if (target.type === 'zone') {
    return target.zoneId
  }

  if (target.type === 'object') {
    return target.derivedZoneId ?? target.objectId
  }

  return target.label ?? target.regionId
}
