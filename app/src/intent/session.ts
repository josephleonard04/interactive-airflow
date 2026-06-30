import { getZoneById, type ZoneBounds, type ZoneId } from '../scene/zones.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'
import type { SketchRegionBinding } from './bind.ts'
import type { AirflowIntent, IntentMagnitude, IntentParseResult, IntentTarget } from './types.ts'

export type IntentEntryStatus = 'pending' | 'accepted' | 'adjusted' | 'undone'

export type IntentSessionEntry = {
  entryId: string
  turnId: string
  sourceText: string
  intent: AirflowIntent
  status: IntentEntryStatus
  createdAt: number
  sketchBindingIds: string[]
}

export type IntentSessionTurn = {
  id: string
  sourceText: string
  createdAt: number
  entryIds: string[]
}

export type IntentSessionState = {
  entries: IntentSessionEntry[]
  turns: IntentSessionTurn[]
  sketchBindings: SketchRegionBinding[]
}

export type IntentSessionAction =
  | {
      result: IntentParseResult
      sketchBindings?: SketchRegionBinding[]
      sourceText: string
      type: 'add-turn'
    }
  | {
      entryId: string
      type: 'accept'
    }
  | {
      entryId: string
      type: 'adjust'
    }
  | {
      entryId: string
      type: 'undo'
    }

export type IntentGrounding = {
  id: string
  label: string
  status: IntentEntryStatus
  confidence: number
  target: IntentTarget
  bounds?: ZoneBounds
}

export const emptyIntentSession: IntentSessionState = {
  entries: [],
  turns: [],
  sketchBindings: [],
}

export function reduceIntentSession(
  state: IntentSessionState,
  action: IntentSessionAction,
): IntentSessionState {
  if (action.type === 'accept') {
    return updateEntryStatus(state, action.entryId, 'accepted')
  }

  if (action.type === 'adjust') {
    return {
      ...state,
      entries: state.entries.map((entry) =>
        entry.entryId === action.entryId
          ? {
              ...entry,
              intent: {
                ...entry.intent,
                magnitude: strengthenMagnitude(entry.intent.magnitude),
              },
              status: 'adjusted',
            }
          : entry,
      ),
    }
  }

  if (action.type === 'undo') {
    return updateEntryStatus(state, action.entryId, 'undone')
  }

  const now = Date.now()
  const turnId = `turn-${now}-${state.turns.length + 1}`
  const incomingBindings = action.sketchBindings ?? []
  const sketchBindings = mergeSketchBindings(state.sketchBindings, incomingBindings)
  const incomingIntents = resolveIncrementalIntents(state, action.sourceText, action.result.intents)
  const entryIds = incomingIntents.map((_intent, index) => `${turnId}-intent-${state.entries.length + index + 1}`)
  const entries = incomingIntents.map((intent, index): IntentSessionEntry => ({
    entryId: entryIds[index],
    turnId,
    sourceText: action.sourceText,
    intent,
    status: 'pending',
    createdAt: now,
    sketchBindingIds: incomingBindings.map((binding) => binding.regionId),
  }))

  return applyTextCorrection({
    ...state,
    entries: [...state.entries, ...entries],
    turns: [
      ...state.turns,
      {
        id: turnId,
        sourceText: action.sourceText,
        createdAt: now,
        entryIds,
      },
    ],
    sketchBindings,
  }, action.sourceText)
}

export function getActiveIntentEntries(state: IntentSessionState) {
  return state.entries.filter((entry) => entry.status !== 'undone')
}

export function buildSessionParseResult(state: IntentSessionState): IntentParseResult {
  return {
    intents: getActiveIntentEntries(state).map((entry) => entry.intent),
    unresolvedReferences: [],
    needsSketch: false,
  }
}

export function buildIntentGroundings(
  state: IntentSessionState,
  transforms: Record<EditableObjectKey, ObjectTransform>,
): IntentGrounding[] {
  return getActiveIntentEntries(state).map((entry) => {
    const target = entry.intent.target
    const binding = target.type === 'region'
      ? state.sketchBindings.find((item) => item.regionId === target.regionId)
      : null
    const bounds = binding
      ? bindingToBounds(binding)
      : targetToZoneBounds(target, transforms)

    return {
      id: entry.entryId,
      label: describeIntentEntry(entry),
      status: entry.status,
      confidence: entry.intent.confidence ?? 0.68,
      target: entry.intent.target,
      bounds,
    }
  })
}

export function describeIntentEntry(entry: IntentSessionEntry) {
  const time = entry.intent.timeCondition ? ` · ${entry.intent.timeCondition.label}` : ''

  return `${describeTarget(entry.intent.target)} ${describeMetricDirection(entry.intent)}${time}`
}

export function describeSession(state: IntentSessionState) {
  const active = getActiveIntentEntries(state)

  if (active.length === 0) {
    return 'No active intent yet.'
  }

  return `Current interpretation: ${active.map((entry) => describeIntentEntry(entry)).join('; ')}`
}

function updateEntryStatus(
  state: IntentSessionState,
  entryId: string,
  status: IntentEntryStatus,
): IntentSessionState {
  return {
    ...state,
    entries: state.entries.map((entry) => entry.entryId === entryId ? { ...entry, status } : entry),
  }
}

function resolveIncrementalIntents(
  state: IntentSessionState,
  sourceText: string,
  intents: AirflowIntent[],
): AirflowIntent[] {
  const active = getActiveIntentEntries(state)
  const latestCooling = [...active].reverse().find((entry) => entry.intent.metric === 'temp' && entry.intent.direction === 'down')

  if (/(cooler|more cooling|colder)/i.test(sourceText) && latestCooling) {
    return [
      {
        ...latestCooling.intent,
        id: `refine-${latestCooling.intent.id}-${Date.now()}`,
        sourceText,
        magnitude: strengthenMagnitude(latestCooling.intent.magnitude),
        confidence: Math.max(latestCooling.intent.confidence ?? 0.7, 0.78),
      },
    ]
  }

  return intents
}

function applyTextCorrection(state: IntentSessionState, sourceText: string): IntentSessionState {
  if (!/(wrong|not that|only|keep only)/i.test(sourceText)) {
    return state
  }

  if (/sofa/i.test(sourceText)) {
    return {
      ...state,
      entries: state.entries.map((entry) =>
        targetMatchesZone(entry.intent.target, 'sofaArea')
          ? entry
          : {
              ...entry,
              status: 'undone',
            },
      ),
    }
  }

  return state
}

function targetMatchesZone(target: IntentTarget, zoneId: ZoneId) {
  return (
    (target.type === 'zone' && target.zoneId === zoneId) ||
    (target.type === 'object' && target.derivedZoneId === zoneId)
  )
}

function strengthenMagnitude(magnitude: IntentMagnitude): IntentMagnitude {
  if (magnitude === 'slight') {
    return 'moderate'
  }

  return 'much'
}

function mergeSketchBindings(
  existing: SketchRegionBinding[],
  incoming: SketchRegionBinding[],
) {
  const merged = new Map(existing.map((binding) => [binding.regionId, binding]))

  for (const binding of incoming) {
    merged.set(binding.regionId, binding)
  }

  return Array.from(merged.values())
}

function targetToZoneBounds(
  target: IntentTarget,
  transforms: Record<EditableObjectKey, ObjectTransform>,
) {
  if (target.type === 'zone') {
    return getZoneById(target.zoneId, transforms)?.bounds
  }

  if (target.type === 'object' && target.derivedZoneId) {
    return getZoneById(target.derivedZoneId, transforms)?.bounds
  }

  return undefined
}

function bindingToBounds(binding: SketchRegionBinding): ZoneBounds {
  const radius = binding.radius ?? 0.42

  return {
    minX: binding.min?.x ?? binding.center.x - radius,
    maxX: binding.max?.x ?? binding.center.x + radius,
    minY: binding.height.minY,
    maxY: binding.height.maxY,
    minZ: binding.min?.z ?? binding.center.z - radius,
    maxZ: binding.max?.z ?? binding.center.z + radius,
  }
}

function describeTarget(target: IntentTarget) {
  if (target.type === 'zone') {
    return `[${zoneLabel(target.zoneId)}]`
  }

  if (target.type === 'object') {
    return `[${target.derivedZoneId ? zoneLabel(target.derivedZoneId) : target.objectId}]`
  }

  return `[${target.label ?? target.regionId}]`
}

function describeMetricDirection(intent: AirflowIntent) {
  if (intent.metric === 'temp' && intent.direction === 'down') {
    return intent.magnitude === 'much' ? 'much cooler' : intent.magnitude === 'moderate' ? 'cooler' : 'slightly cooler'
  }

  if (intent.metric === 'airflow' && intent.direction === 'keep') {
    return 'avoid direct draft'
  }

  if ((intent.metric === 'co2' || intent.metric === 'pm25') && intent.direction === 'down') {
    return intent.metric === 'co2' ? 'increase ventilation' : 'reduce particles'
  }

  if (intent.metric === 'noise' && intent.direction === 'down') {
    return 'quieter'
  }

  return `${intent.metric} ${intent.direction}`
}

function zoneLabel(zoneId: ZoneId) {
  const labels: Record<ZoneId, string> = {
    acSupplyArea: 'AC supply area',
    centerArea: 'Center area',
    coffeeTableArea: 'Coffee table area',
    cribArea: 'Crib area',
    fanArea: 'Fan area',
    lampArea: 'Floor lamp area',
    plantArea: 'Plant area',
    seatedPersonArea: 'Seated person',
    sleepingBabyArea: 'Sleeping baby',
    sofaArea: 'Sofa area',
    tvArea: 'TV area',
    ventArea: 'Exhaust vent area',
    windowArea: 'Window area',
  }

  return labels[zoneId]
}
