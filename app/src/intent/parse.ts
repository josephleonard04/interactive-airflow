import { callLLM, type LlmJsonRequest, type LlmJsonResponse } from '../llm/client.ts'
import { resolveReference, sceneObjects } from '../scene/sceneGraph.ts'
import { buildRoomZones, type ZoneId } from '../scene/zones.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'
import {
  isIntentParseResult,
  type AirflowIntent,
  type IntentConstraint,
  type IntentMagnitude,
  type IntentMetric,
  type IntentParseResult,
  type IntentPriority,
  type IntentTimeCondition,
} from './types.ts'

export type IntentParseFallbackMode = 'always' | 'mock-or-error' | 'never'

export type IntentParseOptions = {
  transforms?: Record<EditableObjectKey, ObjectTransform>
  fallbackMode?: IntentParseFallbackMode
  llm?: <T = unknown>(request: LlmJsonRequest) => Promise<LlmJsonResponse<T>>
}

export type SafeIntentParse =
  | {
      ok: true
      result: IntentParseResult
    }
  | {
      ok: false
      error: string
    }

const schemaName = 'IntentParseResult'
const systemPrompt = [
  'You convert indoor airflow design requests into JSON.',
  'Return only valid JSON. Do not include markdown, commentary, or code fences.',
  'Use only the provided zoneId and objectId values.',
  'Prefer zone targets for room areas and protected occupants.',
].join(' ')

export async function parseAirflowIntents(sourceText: string, options: IntentParseOptions = {}): Promise<IntentParseResult> {
  const fallbackMode = options.fallbackMode ?? 'mock-or-error'
  const llm = options.llm ?? callLLM
  const prompt = buildIntentParsePrompt(sourceText, options.transforms)

  try {
    const response = await llm<unknown>({
      prompt,
      system: systemPrompt,
      schemaName,
      temperature: 0,
    })
    const parsed = safeParseIntentJson(response.json)

    if (parsed.ok) {
      return parsed.result
    }

    if (fallbackMode === 'always' || (fallbackMode === 'mock-or-error' && response.mock)) {
      return parseIntentHeuristically(sourceText, options.transforms)
    }

    throw new Error(parsed.error)
  } catch (error) {
    if (fallbackMode !== 'never') {
      return parseIntentHeuristically(sourceText, options.transforms)
    }

    throw error
  }
}

export function buildIntentParsePrompt(
  sourceText: string,
  transforms?: Record<EditableObjectKey, ObjectTransform>,
) {
  const context = buildIntentSceneContext(transforms)

  return JSON.stringify(
    {
      task: 'Parse the user request into an IntentParseResult JSON object.',
      sourceText,
      schema: {
        intents: [
          {
            id: 'string, stable unique id',
            sourceText: 'string, the phrase that produced this intent',
            target: {
              type: 'zone | object | region',
              zoneId: 'required when type is zone',
              objectId: 'required when type is object',
              derivedZoneId: 'optional when object maps to a room zone',
              regionId: 'required when type is region',
            },
            metric: 'temp | airflow | humidity | pm25 | co2 | noise',
            direction: 'up | down | keep',
            magnitude: 'slight | moderate | much',
            constraints: [
              {
                type: 'avoid-zone | keep-zone | max-noise | device-limit',
                zoneId: 'for avoid-zone and keep-zone',
                metric: 'optional for avoid-zone, required for keep-zone',
                level: 'quiet | normal for max-noise',
                device: 'fan | ac | vent for device-limit',
                enabled: 'optional boolean for device-limit',
                maxSpeed: 'optional number 0-100 for device-limit',
              },
            ],
            priority: 'low | normal | high | critical',
            confidence: 'optional number 0-1',
            timeCondition: {
              type: 'optional after | at-clock | steady',
              minutes: 'required when type is after',
              hour: 'required when type is at-clock, 0-23',
              minute: 'required when type is at-clock, 0-59',
              label: 'user-facing text such as after 5 min or 20:00',
            },
          },
        ],
        unresolvedReferences: ['string[] of user references that cannot map to known zones or objects'],
        needsSketch: 'boolean, true when the user says this area/that part without a resolvable target',
      },
      sceneContext: context,
      examples: [
        {
          input: 'Cool the sofa near the window slightly, but avoid direct draft on the baby',
          output: {
            intents: [
              {
                id: 'intent-sofa-cooler',
                sourceText: 'Cool the sofa near the window slightly',
                target: { type: 'zone', zoneId: 'sofaArea' },
                metric: 'temp',
                direction: 'down',
                magnitude: 'slight',
                constraints: [],
                priority: 'normal',
                confidence: 0.9,
              },
              {
                id: 'intent-avoid-crib-draft',
                sourceText: 'avoid direct draft on the baby',
                target: { type: 'zone', zoneId: 'cribArea' },
                metric: 'airflow',
                direction: 'keep',
                magnitude: 'much',
                constraints: [{ type: 'avoid-zone', zoneId: 'cribArea', metric: 'airflow' }],
                priority: 'high',
                confidence: 0.9,
              },
            ],
            unresolvedReferences: [],
            needsSketch: false,
          },
        },
      ],
      outputRules: [
        'Return one JSON object matching IntentParseResult.',
        'No prose, no markdown, no explanations.',
        'Split compound requests into multiple intents when they affect different zones or metrics.',
        'For "avoid direct draft on the baby", target cribArea, metric airflow, direction keep, and add avoid-zone cribArea airflow constraint.',
        'For cooling requests, use metric temp, direction down, magnitude slight unless stronger wording is present.',
        'For time phrases like "after 5 min" or "20:00", preserve the phrase as timeCondition.',
      ],
    },
    null,
    2,
  )
}

export function safeParseIntentJson(value: unknown): SafeIntentParse {
  let candidate = value

  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(extractJsonObject(value))
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Intent JSON could not be parsed.',
      }
    }
  }

  if (!isIntentParseResult(candidate)) {
    return {
      ok: false,
      error: 'LLM result does not match IntentParseResult.',
    }
  }

  const referenceError = validateKnownReferences(candidate)

  if (referenceError) {
    return {
      ok: false,
      error: referenceError,
    }
  }

  return {
    ok: true,
    result: candidate,
  }
}

export function parseIntentHeuristically(
  sourceText: string,
  transforms?: Record<EditableObjectKey, ObjectTransform>,
): IntentParseResult {
  const clauses = splitIntentClauses(sourceText)
  const intents: AirflowIntent[] = []
  const unresolvedReferences = new Set<string>()
  const globalTimeCondition = inferTimeCondition(sourceText)
  let pendingTimeCondition: IntentTimeCondition | null = null

  clauses.forEach((clause, index) => {
    const intent = intentFromClause(clause, index, transforms)
    const clauseTimeCondition = inferTimeCondition(clause)

    if (intent) {
      intents.push({
        ...intent,
        timeCondition: mergeIntentTimeCondition(
          intent.timeCondition,
          preferExplicitTime(pendingTimeCondition, preferExplicitTime(globalTimeCondition, clauseTimeCondition)),
        ) ?? undefined,
      })
      pendingTimeCondition = null
      return
    }

    if (clauseTimeCondition && clauseTimeCondition.type !== 'steady') {
      pendingTimeCondition = clauseTimeCondition
    }

    if (hasSpatialDeixis(clause)) {
      unresolvedReferences.add(clause)
    }
  })

  if (intents.length === 0 && isVentilationQuietRequest(sourceText)) {
    intents.push(createIntent({
      id: 'intent-ventilate-quiet',
      sourceText,
      zoneId: 'centerArea',
      metric: 'co2',
      direction: 'down',
      magnitude: 'moderate',
      constraints: [{ type: 'max-noise', level: 'quiet' }],
      priority: 'normal',
      confidence: 0.72,
      timeCondition: globalTimeCondition ?? undefined,
    }))
  }

  return {
    intents,
    unresolvedReferences: Array.from(unresolvedReferences),
    needsSketch: unresolvedReferences.size > 0,
  }
}

export function describeIntentParseResult(result: IntentParseResult) {
  if (result.intents.length === 0) {
    return result.needsSketch
      ? `Needs a sketched region for: ${result.unresolvedReferences.join(', ')}`
      : 'No structured airflow intent found yet.'
  }

  const intentSummary = result.intents
    .map((intent) => {
      const target = intent.target.type === 'zone'
        ? intent.target.zoneId
        : intent.target.type === 'object'
          ? intent.target.objectId
          : intent.target.regionId

      return `${target} ${intent.metric} ${intent.direction}`
    })
    .join('; ')
  const constraints = result.intents.flatMap((intent) => intent.constraints.map(describeConstraint))
  const constraintSummary = constraints.length > 0 ? ` Constraints: ${constraints.join('; ')}.` : ''

  return `Parsed ${result.intents.length} intent${result.intents.length === 1 ? '' : 's'}: ${intentSummary}.${constraintSummary}`
}

function buildIntentSceneContext(transforms?: Record<EditableObjectKey, ObjectTransform>) {
  const zones = buildRoomZones(transforms)

  return {
    zones: zones.map((zone) => ({
      id: zone.id,
      label: zone.label,
      kind: zone.kind,
      aliases: zone.aliases,
      sourceObjectId: zone.sourceObjectId,
    })),
    objects: sceneObjects.map((object) => ({
      id: object.id,
      label: object.label,
      aliases: object.aliases,
      nearbyAliases: object.nearbyAliases ?? [],
      tags: object.tags,
      derivedZoneId: zoneForObjectId(object.id, transforms),
    })),
  }
}

function intentFromClause(
  clause: string,
  index: number,
  transforms?: Record<EditableObjectKey, ObjectTransform>,
): AirflowIntent | null {
  if (isAvoidDraftRequest(clause)) {
    const zoneId = inferZoneId(clause, transforms) ?? 'cribArea'

    return createIntent({
      id: `intent-${index + 1}-avoid-draft`,
      sourceText: clause,
      zoneId,
      metric: 'airflow',
      direction: 'keep',
      magnitude: 'much',
      constraints: [{ type: 'avoid-zone', zoneId, metric: 'airflow' }],
      priority: 'high',
      confidence: 0.86,
      timeCondition: inferTimeCondition(clause) ?? undefined,
    })
  }

  if (isCoolingRequest(clause)) {
    return createIntent({
      id: `intent-${index + 1}-cooler`,
      sourceText: clause,
      zoneId: inferZoneId(clause, transforms) ?? 'centerArea',
      metric: 'temp',
      direction: 'down',
      magnitude: inferMagnitude(clause),
      constraints: [],
      priority: 'normal',
      confidence: 0.78,
      timeCondition: inferTimeCondition(clause) ?? undefined,
    })
  }

  if (isVentilationQuietRequest(clause) || isVentilationRequest(clause)) {
    return createIntent({
      id: `intent-${index + 1}-ventilate`,
      sourceText: clause,
      zoneId: inferZoneId(clause, transforms) ?? 'centerArea',
      metric: 'co2',
      direction: 'down',
      magnitude: inferMagnitude(clause, 'moderate'),
      constraints: isQuietRequest(clause) ? [{ type: 'max-noise', level: 'quiet' }] : [],
      priority: 'normal',
      confidence: 0.68,
      timeCondition: inferTimeCondition(clause) ?? undefined,
    })
  }

  if (isQuietRequest(clause)) {
    return createIntent({
      id: `intent-${index + 1}-quiet`,
      sourceText: clause,
      zoneId: inferZoneId(clause, transforms) ?? 'centerArea',
      metric: 'noise',
      direction: 'down',
      magnitude: 'moderate',
      constraints: [{ type: 'max-noise', level: 'quiet' }],
      priority: 'normal',
      confidence: 0.66,
      timeCondition: inferTimeCondition(clause) ?? undefined,
    })
  }

  return null
}

function createIntent(input: {
  id: string
  sourceText: string
  zoneId: ZoneId
  metric: IntentMetric
  direction: 'up' | 'down' | 'keep'
  magnitude: IntentMagnitude
  constraints: IntentConstraint[]
  priority: IntentPriority
  confidence: number
  timeCondition?: IntentTimeCondition
}): AirflowIntent {
  return {
    id: input.id,
    sourceText: input.sourceText,
    target: {
      type: 'zone',
      zoneId: input.zoneId,
    },
    metric: input.metric,
    direction: input.direction,
    magnitude: input.magnitude,
    constraints: input.constraints,
    priority: input.priority,
    confidence: input.confidence,
    timeCondition: input.timeCondition,
  }
}

function inferZoneId(text: string, transforms?: Record<EditableObjectKey, ObjectTransform>): ZoneId | null {
  const normalizedText = normalizeText(text)
  const zones = buildRoomZones(transforms)
  const reference = resolveReference(text)
  const objectId = reference.objectIds[0]

  if (objectId) {
    return zoneForObjectId(objectId, transforms)
  }

  const referencedZoneId = reference.zoneIds[0]

  if (referencedZoneId) {
    return referencedZoneId as ZoneId
  }

  const zoneMatch = zones
    .flatMap((zone) =>
      zone.aliases.map((alias) => ({
        zoneId: zone.id,
        alias,
        priority: zone.priority,
      })),
    )
    .filter((item) => normalizedText.includes(normalizeText(item.alias)))
    .sort((left, right) => normalizeText(right.alias).length - normalizeText(left.alias).length || right.priority - left.priority)[0]

  if (zoneMatch) {
    return zoneMatch.zoneId
  }

  return null
}

function zoneForObjectId(
  objectId: EditableObjectKey,
  transforms?: Record<EditableObjectKey, ObjectTransform>,
): ZoneId | null {
  return buildRoomZones(transforms).find((zone) => zone.sourceObjectId === objectId)?.id ?? null
}

function splitIntentClauses(sourceText: string) {
  const clauses = sourceText
    .split(/[，,。；;\n]/g)
    .flatMap((part) => part.split(/(?:\band\b|\balso\b|\bplus\b)/gi))
    .map((part) => part.trim())
    .filter(Boolean)

  return clauses.length > 0 ? clauses : [sourceText.trim()].filter(Boolean)
}

function inferMagnitude(text: string, fallback: IntentMagnitude = 'slight'): IntentMagnitude {
  if (/(\bmuch\b|\bstrong\b|\bfast\b|\bquick\b|\ba lot\b|\bsignificant)/i.test(text)) {
    return 'much'
  }

  if (/(\bslight|\ba little|\bslightly|\bmoderate)/i.test(text)) {
    return 'slight'
  }

  return fallback
}

function isAvoidDraftRequest(text: string) {
  return /((avoid|keep|do not|don't|no|not).*(draft|direct draft|blow|airflow|wind|air))|((draft|direct draft|blow|airflow|wind).*(avoid|keep away|do not|don't|no|not))/i.test(text)
}

function isCoolingRequest(text: string) {
  return /(cool|cooler|cooling|too hot|hot|colder)/i.test(text)
}

function isVentilationRequest(text: string) {
  return /(co2|ventilat|purge|stale|air quality|fresh air|pm2\.?5|particles?)/i.test(text)
}

function isQuietRequest(text: string) {
  return /(quiet|quieter|silent|noise|low noise)/i.test(text)
}

export function inferTimeCondition(text: string): IntentTimeCondition | null {
  const minuteMatch = text.match(/(\d{1,3})\s*(?:min|minutes?)(?:\s*later)?/i)

  if (minuteMatch) {
    const minutes = Math.max(1, Math.min(240, Number(minuteMatch[1])))

    return {
      type: 'after',
      minutes,
      label: `after ${minutes} min`,
    }
  }

  const clockMatch = text.match(/\b(?:at|after)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)

  if (clockMatch && /(?:at|after|\d{1,2}:\d{2}|am|pm)/i.test(clockMatch[0])) {
    let hour = Number(clockMatch[1])
    const minute = clockMatch[2] ? Number(clockMatch[2]) : 0
    const ampm = clockMatch[3]?.toLowerCase()

    if (ampm === 'pm' && hour < 12) {
      hour += 12
    }

    if (ampm === 'am' && hour === 12) {
      hour = 0
    }

    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return {
        type: 'at-clock',
        hour,
        minute,
        label: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
      }
    }
  }


  if (/(steady|keep|maintain)/.test(text)) {
    return {
      type: 'steady',
      label: 'steady',
    }
  }

  return null
}

function preferExplicitTime(
  globalTimeCondition: IntentTimeCondition | null,
  clauseTimeCondition: IntentTimeCondition | null,
) {
  if (globalTimeCondition && globalTimeCondition.type !== 'steady') {
    return globalTimeCondition
  }

  return clauseTimeCondition ?? globalTimeCondition
}

function mergeIntentTimeCondition(
  localTimeCondition: IntentTimeCondition | undefined,
  inheritedTimeCondition: IntentTimeCondition | null,
) {
  if (inheritedTimeCondition && inheritedTimeCondition.type !== 'steady') {
    return inheritedTimeCondition
  }

  return localTimeCondition ?? inheritedTimeCondition
}

function isVentilationQuietRequest(text: string) {
  return isVentilationRequest(text) && isQuietRequest(text)
}

function hasSpatialDeixis(text: string) {
  return /(this area|that area|here|there|this zone|that zone|sketched area)/i.test(text)
}

function extractJsonObject(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')

  if (start < 0 || end < start) {
    throw new Error('Intent JSON text does not contain an object.')
  }

  return trimmed.slice(start, end + 1)
}

function validateKnownReferences(result: IntentParseResult) {
  const zoneIds = new Set(buildRoomZones().map((zone) => zone.id))
  const objectIds = new Set(sceneObjects.map((object) => object.id))

  for (const intent of result.intents) {
    if (intent.target.type === 'zone' && !zoneIds.has(intent.target.zoneId)) {
      return `Unknown zoneId: ${intent.target.zoneId}`
    }

    if (intent.target.type === 'object' && !objectIds.has(intent.target.objectId as EditableObjectKey)) {
      return `Unknown objectId: ${intent.target.objectId}`
    }

    for (const constraint of intent.constraints) {
      if ((constraint.type === 'avoid-zone' || constraint.type === 'keep-zone') && !zoneIds.has(constraint.zoneId)) {
        return `Unknown constraint zoneId: ${constraint.zoneId}`
      }
    }
  }

  return null
}

function describeConstraint(constraint: IntentConstraint) {
  if (constraint.type === 'avoid-zone') {
    return `avoid ${constraint.zoneId}${constraint.metric ? ` ${constraint.metric}` : ''}`
  }

  if (constraint.type === 'keep-zone') {
    return `keep ${constraint.zoneId} ${constraint.metric}`
  }

  if (constraint.type === 'max-noise') {
    return `noise ${constraint.level}`
  }

  return `${constraint.device} limit`
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[,.!?\s]/g, '')
}
