import type { AirflowIntent, IntentParseResult, IntentPriority } from '../intent/types.ts'
import { priorityValue } from './objectives.ts'

export type ObjectiveConflict = {
  id: string
  intentIds: string[]
  type: 'cool-vs-quiet' | 'ventilation-vs-quiet' | 'cool-vs-protected-draft' | 'device-limit'
  severity: 'low' | 'medium' | 'high'
  chosenPriority: IntentPriority
  summary: string
}

export function detectObjectiveConflicts(parseResult: IntentParseResult): ObjectiveConflict[] {
  const conflicts: ObjectiveConflict[] = []
  const intents = parseResult.intents
  const quietIntents = intents.filter(isQuietIntent)
  const coolingIntents = intents.filter((intent) => intent.metric === 'temp' && intent.direction === 'down')
  const ventilationIntents = intents.filter((intent) =>
    (intent.metric === 'co2' || intent.metric === 'pm25') && intent.direction === 'down',
  )
  const protectedDraftIntents = intents.filter((intent) =>
    (intent.metric === 'airflow' && intent.direction === 'keep') ||
    intent.constraints.some((constraint) => constraint.type === 'avoid-zone' && (constraint.metric === undefined || constraint.metric === 'airflow')),
  )

  for (const quietIntent of quietIntents) {
    for (const coolingIntent of coolingIntents) {
      conflicts.push(buildConflict({
        type: 'cool-vs-quiet',
        intents: [coolingIntent, quietIntent],
        summary: 'Cooling wants more supply velocity, while quiet mode caps fan and vent speed.',
      }))
    }

    for (const ventilationIntent of ventilationIntents) {
      conflicts.push(buildConflict({
        type: 'ventilation-vs-quiet',
        intents: [ventilationIntent, quietIntent],
        summary: 'Ventilation wants stronger exchange, while quiet mode limits device speed.',
      }))
    }
  }

  for (const coolingIntent of coolingIntents) {
    for (const protectedIntent of protectedDraftIntents) {
      if (coolingIntent.id === protectedIntent.id) {
        continue
      }

      conflicts.push(buildConflict({
        type: 'cool-vs-protected-draft',
        intents: [coolingIntent, protectedIntent],
        summary: 'Targeted cooling may increase draft near a protected zone, so the optimizer will favor the higher-priority intent.',
      }))
    }
  }

  for (const intent of intents) {
    for (const constraint of intent.constraints) {
      if (constraint.type !== 'device-limit') {
        continue
      }

      const conflictsWithFan = constraint.device === 'fan' && constraint.enabled === false && (
        coolingIntents.length > 0 ||
        intents.some((item) => item.metric === 'airflow' && item.direction === 'up')
      )

      const conflictsWithVent = constraint.device === 'vent' && constraint.enabled === false && ventilationIntents.length > 0

      if (conflictsWithFan || conflictsWithVent) {
        conflicts.push(buildConflict({
          type: 'device-limit',
          intents: [intent, ...(conflictsWithFan ? coolingIntents : ventilationIntents)],
          summary: `${constraint.device} is limited by one request but needed by another objective.`,
        }))
      }
    }
  }

  return dedupeConflicts(conflicts)
}

export function summarizeConflicts(conflicts: ObjectiveConflict[]) {
  if (conflicts.length === 0) {
    return ''
  }

  const strongest = conflicts.reduce((best, conflict) =>
    severityRank(conflict.severity) > severityRank(best.severity) ? conflict : best,
  )

  return `Trade-off detected: ${strongest.summary}`
}

function buildConflict({
  intents,
  summary,
  type,
}: {
  intents: AirflowIntent[]
  summary: string
  type: ObjectiveConflict['type']
}): ObjectiveConflict {
  const chosen = intents.reduce((best, intent) =>
    priorityValue(intent.priority) > priorityValue(best.priority) ? intent : best,
  )
  const severity = intents.some((intent) => intent.priority === 'critical')
    ? 'high'
    : intents.some((intent) => intent.priority === 'high')
      ? 'medium'
      : 'low'

  return {
    id: `${type}:${intents.map((intent) => intent.id).sort().join(':')}`,
    intentIds: Array.from(new Set(intents.map((intent) => intent.id))),
    type,
    severity,
    chosenPriority: chosen.priority,
    summary: `${summary} Priority leans ${chosen.priority}.`,
  }
}

function isQuietIntent(intent: AirflowIntent) {
  return (
    intent.metric === 'noise' ||
    intent.constraints.some((constraint) => constraint.type === 'max-noise' && constraint.level === 'quiet')
  )
}

function dedupeConflicts(conflicts: ObjectiveConflict[]) {
  return Array.from(new Map(conflicts.map((conflict) => [conflict.id, conflict])).values())
}

function severityRank(severity: ObjectiveConflict['severity']) {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1
}
