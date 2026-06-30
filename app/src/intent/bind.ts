import { getPrimaryZoneAtPoint, type ZoneId } from '../scene/zones.ts'
import { getHeightBinding, heightBandToGridLayers, type HeightBinding } from '../sketch/heightBinding.ts'
import {
  sketchPrimitiveBounds,
  sketchPrimitiveCenter,
  type SketchPoint,
  type SketchPrimitive,
} from '../sketch/primitives.ts'
import type { AirflowIntent, IntentParseResult } from './types.ts'

export type SketchRegionBinding = {
  regionId: string
  primitiveId: string
  mode: SketchPrimitive['mode']
  center: SketchPoint
  height: HeightBinding
  gridLayers: {
    minLayer: number
    maxLayer: number
  }
  radius?: number
  min?: SketchPoint
  max?: SketchPoint
  direction?: {
    x: number
    z: number
    yaw: number
  }
  derivedZoneId?: ZoneId
}

export type BoundIntentParseResult = IntentParseResult & {
  sketchBindings: SketchRegionBinding[]
}

export function bindSketchToIntent(
  parseResult: IntentParseResult,
  primitives: SketchPrimitive[],
): BoundIntentParseResult {
  const latestPrimitive = primitives.at(-1)

  if (!latestPrimitive) {
    return {
      ...parseResult,
      sketchBindings: [],
    }
  }

  const binding = sketchPrimitiveToBinding(latestPrimitive)
  let usedSketch = false
  const intents = parseResult.intents.map((intent) => {
    if (!isDeicticIntent(intent)) {
      return intent
    }

    usedSketch = true

    if (latestPrimitive.mode === 'point' && binding.derivedZoneId) {
      return {
        ...intent,
        target: {
          type: 'zone',
          zoneId: binding.derivedZoneId,
        },
      } satisfies AirflowIntent
    }

    return {
      ...intent,
      target: {
        type: 'region',
        regionId: binding.regionId,
        label: `${latestPrimitive.mode} sketch`,
      },
    } satisfies AirflowIntent
  })
  const boundIntents = intents.length > 0
    ? intents
    : parseResult.needsSketch && parseResult.unresolvedReferences.length > 0
      ? [createIntentFromSketchReference(parseResult.unresolvedReferences[0], latestPrimitive, binding)]
      : intents

  usedSketch = usedSketch || boundIntents.length > intents.length

  return {
    ...parseResult,
    intents: boundIntents,
    unresolvedReferences: usedSketch ? [] : parseResult.unresolvedReferences,
    needsSketch: usedSketch ? false : parseResult.needsSketch,
    sketchBindings: usedSketch ? [binding] : [],
  }
}

export function sketchPrimitiveToBinding(primitive: SketchPrimitive): SketchRegionBinding {
  const center = sketchPrimitiveCenter(primitive)
  const derivedZone = getPrimaryZoneAtPoint({ x: center.x, y: heightCenter(primitive), z: center.z })
  const base = {
    regionId: `region-${primitive.id}`,
    primitiveId: primitive.id,
    mode: primitive.mode,
    center,
    height: getHeightBinding(primitive.heightBand),
    gridLayers: heightBandToGridLayers(primitive.heightBand, { width: 32, height: 24, layers: 14 }),
    derivedZoneId: derivedZone?.id,
  }

  if (primitive.mode === 'point') {
    return {
      ...base,
      mode: primitive.mode,
    }
  }

  if (primitive.mode === 'circle') {
    return {
      ...base,
      mode: primitive.mode,
      radius: primitive.radius,
    }
  }

  if (primitive.mode === 'box') {
    return {
      ...base,
      mode: primitive.mode,
      min: primitive.min,
      max: primitive.max,
    }
  }

  if (primitive.mode === 'draw') {
    const bounds = sketchPrimitiveBounds(primitive)

    return {
      ...base,
      mode: primitive.mode,
      min: bounds.min,
      max: bounds.max,
    }
  }

  const dx = primitive.end.x - primitive.start.x
  const dz = primitive.end.z - primitive.start.z
  const length = Math.max(0.001, Math.hypot(dx, dz))

  return {
    ...base,
    mode: primitive.mode,
    direction: {
      x: dx / length,
      z: dz / length,
      yaw: Math.atan2(dz, -dx),
    },
  }
}

export function hasDeicticReference(text: string) {
  return /(this area|that area|here|there|this zone|that zone|sketched area|drawn area)/i.test(text)
}

function createIntentFromSketchReference(
  sourceText: string,
  primitive: SketchPrimitive,
  binding: SketchRegionBinding,
): AirflowIntent {
  const target = primitive.mode === 'point' && binding.derivedZoneId
    ? {
        type: 'zone' as const,
        zoneId: binding.derivedZoneId,
      }
    : {
        type: 'region' as const,
        regionId: binding.regionId,
        label: `${primitive.mode} sketch`,
      }

  if (/(co2|ventilat|purge|stale|air quality|fresh air)/i.test(sourceText)) {
    return {
      id: `bound-${binding.regionId}-ventilate`,
      sourceText,
      target,
      metric: 'co2',
      direction: 'down',
      magnitude: 'moderate',
      constraints: [],
      priority: 'normal',
      confidence: 0.64,
    }
  }

  if (/((avoid|keep|do not|don't|no|not).*(draft|direct draft|blow|airflow|wind|air))/i.test(sourceText)) {
    const zoneId = binding.derivedZoneId ?? 'centerArea'

    return {
      id: `bound-${binding.regionId}-avoid-airflow`,
      sourceText,
      target,
      metric: 'airflow',
      direction: 'keep',
      magnitude: 'much',
      constraints: [{ type: 'avoid-zone', zoneId, metric: 'airflow' }],
      priority: 'high',
      confidence: 0.68,
    }
  }

  return {
    id: `bound-${binding.regionId}-cooler`,
    sourceText,
    target,
    metric: 'temp',
    direction: 'down',
    magnitude: 'slight',
    constraints: [],
    priority: 'normal',
    confidence: 0.66,
  }
}

function isDeicticIntent(intent: AirflowIntent) {
  return hasDeicticReference(intent.sourceText)
}

function heightCenter(primitive: SketchPrimitive) {
  const binding = getHeightBinding(primitive.heightBand)

  return (binding.minY + binding.maxY) / 2
}
