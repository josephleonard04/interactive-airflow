import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'

export type SceneObjectFootprint = {
  w: number
  d: number
  h: number
}

export type SceneObjectNode = {
  id: EditableObjectKey
  label: string
  transform: ObjectTransform
  footprint?: SceneObjectFootprint
  aliases: string[]
  tags: string[]
  nearbyAliases?: string[]
  isObstacle: boolean
}

export type SceneReferenceResolution = {
  objectIds: EditableObjectKey[]
  zoneIds: string[]
  confidence: 'none' | 'low' | 'medium' | 'high'
  matchedTerms: string[]
}

export const roomBounds = {
  width: 9.8,
  depth: 7.2,
  height: 2.8,
  minX: -4.9,
  maxX: 4.9,
  minZ: -3.6,
  maxZ: 3.6,
} as const

export const sceneObjects: SceneObjectNode[] = [
  {
    id: 'sofa',
    label: 'Sofa',
    transform: { position: [-2.45, 0, 0.9], rotation: [0, 0.05, 0] },
    footprint: { w: 2.9, d: 1.18, h: 1.1 },
    aliases: ['sofa', 'couch', 'window sofa', 'window-side sofa'],
    nearbyAliases: ['near sofa', 'sofa area', 'beside sofa', 'seating area', 'living room seating'],
    tags: ['seating', 'occupant', 'left', 'window-side'],
    isObstacle: true,
  },
  {
    id: 'coffeeTable',
    label: 'Coffee table',
    transform: { position: [-1.0, 0, -0.55], rotation: [0, 0, 0] },
    footprint: { w: 1.7, d: 1.0, h: 0.45 },
    aliases: ['coffee table', 'table', 'living room table', 'center table'],
    nearbyAliases: ['near coffee table', 'coffee table area', 'near table', 'room center table'],
    tags: ['table', 'center'],
    isObstacle: true,
  },
  {
    id: 'mediaConsole',
    label: 'TV console',
    transform: { position: [-2.35, 0, -2.2], rotation: [0, 0.03, 0] },
    footprint: { w: 2.35, d: 0.48, h: 1.35 },
    aliases: ['tv', 'television', 'media console', 'tv console', 'tv wall'],
    nearbyAliases: ['near tv', 'tv area', 'near media console', 'beside tv'],
    tags: ['electronics', 'front-wall', 'pm25-source'],
    isObstacle: true,
  },
  {
    id: 'sideTable',
    label: 'Side table',
    transform: { position: [-3.96, 0, -0.18], rotation: [0, 0.12, 0] },
    footprint: { w: 0.62, d: 0.62, h: 0.72 },
    aliases: ['side table', 'small table', 'sofa side table'],
    nearbyAliases: ['near side table', 'near small table'],
    tags: ['table', 'left'],
    isObstacle: true,
  },
  {
    id: 'crib',
    label: 'Baby crib',
    transform: { position: [-3.62, 0, 1.85], rotation: [0, 0.08, 0] },
    footprint: { w: 1.38, d: 0.86, h: 0.95 },
    aliases: ['crib', 'baby crib', 'baby', 'child', 'infant'],
    nearbyAliases: ['near crib', 'near baby', 'baby area', 'crib area', 'child area'],
    tags: ['baby', 'protected', 'occupant', 'left', 'back'],
    isObstacle: true,
  },
  {
    id: 'seatedPerson',
    label: 'Seated person',
    transform: { position: [-2.55, 0, 0.82], rotation: [0, 0.04, 0] },
    footprint: { w: 0.52, d: 0.42, h: 1.25 },
    aliases: ['person', 'viewer', 'occupant', 'adult', 'me', 'seated person', 'movie viewer', 'user'],
    nearbyAliases: ['near person', 'my seat', 'viewer position', 'near seated person'],
    tags: ['occupant', 'protected', 'seating', 'breathing-zone'],
    isObstacle: true,
  },
  {
    id: 'sleepingBaby',
    label: 'Sleeping baby',
    transform: { position: [-3.62, 0, 1.86], rotation: [0, 0.08, 0] },
    footprint: { w: 0.42, d: 0.32, h: 0.28 },
    aliases: ['sleeping baby', 'baby occupant', 'sleeping infant'],
    nearbyAliases: ['baby breathing zone', 'infant breathing zone', 'sleeping area', 'baby sleep position'],
    tags: ['baby', 'occupant', 'protected', 'breathing-zone'],
    isObstacle: true,
  },
  {
    id: 'plant',
    label: 'Plant',
    transform: { position: [3.8, 0, -1.15], rotation: [0, 0, 0] },
    footprint: { w: 0.7, d: 0.7, h: 1.45 },
    aliases: ['plant', 'green plant', 'potted plant'],
    nearbyAliases: ['near plant', 'near green plant', 'near potted plant'],
    tags: ['humidity-source', 'right'],
    isObstacle: true,
  },
  {
    id: 'lamp',
    label: 'Lamp',
    transform: { position: [-4.22, 0, -1.1], rotation: [0, 0, 0] },
    footprint: { w: 0.55, d: 0.55, h: 1.8 },
    aliases: ['lamp', 'floor lamp', 'light'],
    nearbyAliases: ['near lamp', 'near floor lamp'],
    tags: ['heat-source', 'left'],
    isObstacle: true,
  },
  {
    id: 'fan',
    label: 'Standing fan',
    transform: { position: [3.65, 0, 1.05], rotation: [0, -0.62, 0] },
    aliases: ['fan', 'standing fan', 'electric fan'],
    nearbyAliases: ['near fan', 'near standing fan'],
    tags: ['device', 'air-source', 'right'],
    isObstacle: false,
  },
]

const directionalAliases: Record<string, (object: SceneObjectNode) => boolean> = {
  window: (object) => object.tags.includes('window-side') || object.transform.position[2] > 0.45,
  left: (object) => object.transform.position[0] < -1.2,
  right: (object) => object.transform.position[0] > 1.2,
  center: (object) => Math.abs(object.transform.position[0]) < 1.5 && Math.abs(object.transform.position[2]) < 1.2,
  corner: (object) => Math.abs(object.transform.position[0]) > 3.2 || Math.abs(object.transform.position[2]) > 2.4,
}

const objectZoneIds: Partial<Record<EditableObjectKey, string>> = {
  sofa: 'sofaArea',
  coffeeTable: 'coffeeTableArea',
  mediaConsole: 'tvArea',
  crib: 'cribArea',
  seatedPerson: 'seatedPersonArea',
  sleepingBaby: 'sleepingBabyArea',
  fan: 'fanArea',
  plant: 'plantArea',
  lamp: 'lampArea',
}

const fixedZoneAliases: Array<{ zoneId: string; aliases: string[] }> = [
  {
    zoneId: 'centerArea',
    aliases: ['center', 'center area', 'room center', 'living room center'],
  },
  {
    zoneId: 'windowArea',
    aliases: ['window area', 'window wall', 'near window', 'window-side area'],
  },
  {
    zoneId: 'acSupplyArea',
    aliases: ['ac area', 'ac supply', 'near air conditioner', 'air conditioner outlet'],
  },
  {
    zoneId: 'ventArea',
    aliases: ['vent area', 'exhaust area', 'near vent', 'near exhaust outlet'],
  },
]

export const sceneObjectById = Object.fromEntries(sceneObjects.map((object) => [object.id, object])) as Record<
  EditableObjectKey,
  SceneObjectNode
>

export function getEditableObjectNames(): Record<EditableObjectKey, string> {
  return Object.fromEntries(sceneObjects.map((object) => [object.id, object.label])) as Record<EditableObjectKey, string>
}

export function getInitialObjectTransforms(): Record<EditableObjectKey, ObjectTransform> {
  return Object.fromEntries(sceneObjects.map((object) => [object.id, object.transform])) as Record<EditableObjectKey, ObjectTransform>
}

export function getObstacleFootprints(): Partial<Record<EditableObjectKey, SceneObjectFootprint>> {
  return Object.fromEntries(
    sceneObjects.filter((object) => object.isObstacle && object.footprint).map((object) => [object.id, object.footprint]),
  ) as Partial<Record<EditableObjectKey, SceneObjectFootprint>>
}

export function getObstacleObjects() {
  return sceneObjects.filter((object) => object.isObstacle && object.footprint)
}

export function resolveReference(text: string): SceneReferenceResolution {
  const normalized = normalizeReference(text)
  const matchedTerms: string[] = []
  const directScores = new Map<EditableObjectKey, number>()
  const fixedZoneScores = new Map<string, number>()

  for (const object of sceneObjects) {
    const aliases = [...object.aliases, ...(object.nearbyAliases ?? [])]

    for (const alias of aliases) {
      const normalizedAlias = normalizeReference(alias)

      if (!normalizedAlias || !normalized.includes(normalizedAlias)) {
        continue
      }

      directScores.set(object.id, Math.max(directScores.get(object.id) ?? 0, normalizedAlias.length))
      matchedTerms.push(alias)
    }
  }

  for (const zone of fixedZoneAliases) {
    for (const alias of zone.aliases) {
      const normalizedAlias = normalizeReference(alias)

      if (!normalizedAlias || !normalized.includes(normalizedAlias)) {
        continue
      }

      fixedZoneScores.set(zone.zoneId, Math.max(fixedZoneScores.get(zone.zoneId) ?? 0, normalizedAlias.length))
      matchedTerms.push(alias)
    }
  }

  const directionMatches = Object.entries(directionalAliases).filter(([keyword]) => normalized.includes(normalizeReference(keyword)))
  const objectIds = Array.from(directScores.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id)
  const fixedZoneIds = Array.from(fixedZoneScores.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([zoneId]) => zoneId)

  if (objectIds.length > 0) {
    const filteredObjectIds = filterByDirectionalAliases(objectIds, directionMatches)

    return {
      objectIds: filteredObjectIds,
      zoneIds: uniqueStrings(filteredObjectIds.map((id) => objectZoneIds[id]).filter(Boolean)),
      confidence: directionMatches.length > 0 || matchedTerms.length > 0 ? 'high' : 'medium',
      matchedTerms,
    }
  }

  if (fixedZoneIds.length > 0) {
    return {
      objectIds: [],
      zoneIds: fixedZoneIds,
      confidence: 'high',
      matchedTerms,
    }
  }

  if (directionMatches.length > 0) {
    const directionalObjectIds = sceneObjects
      .filter((object) => directionMatches.every(([, predicate]) => predicate(object)))
      .map((object) => object.id)

    return {
      objectIds: directionalObjectIds,
      zoneIds: uniqueStrings(directionalObjectIds.map((id) => objectZoneIds[id]).filter(Boolean)),
      confidence: directionalObjectIds.length > 0 ? 'low' : 'none',
      matchedTerms: directionMatches.map(([keyword]) => keyword),
    }
  }

  return {
    objectIds: [],
    zoneIds: [],
    confidence: 'none',
    matchedTerms: [],
  }
}

function filterByDirectionalAliases(
  objectIds: EditableObjectKey[],
  directionMatches: Array<[string, (object: SceneObjectNode) => boolean]>,
) {
  if (directionMatches.length === 0 || objectIds.length <= 1) {
    return objectIds
  }

  const filtered = objectIds.filter((id) => directionMatches.every(([, predicate]) => predicate(sceneObjectById[id])))

  return filtered.length > 0 ? filtered : objectIds
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)))
}

function normalizeReference(text: string) {
  return text
    .toLowerCase()
    .replace(/[,.!?\s]/g, '')
}
