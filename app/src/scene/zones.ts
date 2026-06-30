import { getInitialObjectTransforms, roomBounds, sceneObjectById } from './sceneGraph.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'

export type ZoneId =
  | 'sofaArea'
  | 'cribArea'
  | 'seatedPersonArea'
  | 'sleepingBabyArea'
  | 'tvArea'
  | 'coffeeTableArea'
  | 'centerArea'
  | 'windowArea'
  | 'fanArea'
  | 'acSupplyArea'
  | 'ventArea'
  | 'plantArea'
  | 'lampArea'

export type RoomPoint = {
  x: number
  y?: number
  z: number
}

export type ZoneBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

export type RoomZone = {
  id: ZoneId
  label: string
  kind: 'object' | 'device' | 'fixed'
  bounds: ZoneBounds
  anchor: [number, number, number]
  aliases: string[]
  sourceObjectId?: EditableObjectKey
  priority: number
}

export type GridSpec = {
  width: number
  height: number
  layers: number
}

export type ZoneGridCell = {
  x: number
  y: number
  z: number
  index: number
  center: [number, number, number]
}

const defaultGrid: GridSpec = {
  width: 32,
  height: 24,
  layers: 14,
}

const objectZoneSpecs: Array<{
  id: ZoneId
  sourceObjectId: EditableObjectKey
  label: string
  aliases: string[]
  margin: number
  yRange: [number, number]
  priority: number
}> = [
  {
    id: 'sofaArea',
    sourceObjectId: 'sofa',
    label: 'Sofa area',
    aliases: ['sofa area', 'near sofa', 'seating area'],
    margin: 0.65,
    yRange: [0.2, 1.65],
    priority: 80,
  },
  {
    id: 'cribArea',
    sourceObjectId: 'crib',
    label: 'Baby crib area',
    aliases: ['crib area', 'baby area', 'near crib', 'near baby'],
    margin: 0.55,
    yRange: [0.1, 1.25],
    priority: 90,
  },
  {
    id: 'seatedPersonArea',
    sourceObjectId: 'seatedPerson',
    label: 'Seated person breathing zone',
    aliases: ['seated person area', 'viewer area', 'occupant area', 'adult breathing zone'],
    margin: 0.42,
    yRange: [0.55, 1.65],
    priority: 94,
  },
  {
    id: 'sleepingBabyArea',
    sourceObjectId: 'sleepingBaby',
    label: 'Sleeping baby breathing zone',
    aliases: ['sleeping baby area', 'baby breathing zone', 'infant breathing zone'],
    margin: 0.38,
    yRange: [0.25, 0.95],
    priority: 98,
  },
  {
    id: 'tvArea',
    sourceObjectId: 'mediaConsole',
    label: 'TV area',
    aliases: ['tv area', 'near tv', 'near media console'],
    margin: 0.55,
    yRange: [0.15, 1.65],
    priority: 70,
  },
  {
    id: 'coffeeTableArea',
    sourceObjectId: 'coffeeTable',
    label: 'Coffee table area',
    aliases: ['coffee table area', 'near coffee table', 'room center table'],
    margin: 0.45,
    yRange: [0.05, 1.15],
    priority: 68,
  },
  {
    id: 'fanArea',
    sourceObjectId: 'fan',
    label: 'Fan area',
    aliases: ['fan area', 'near fan', 'near standing fan'],
    margin: 0.55,
    yRange: [0.15, 2.35],
    priority: 72,
  },
  {
    id: 'plantArea',
    sourceObjectId: 'plant',
    label: 'Plant area',
    aliases: ['plant area', 'near plant', 'near green plant'],
    margin: 0.42,
    yRange: [0.1, 1.75],
    priority: 60,
  },
  {
    id: 'lampArea',
    sourceObjectId: 'lamp',
    label: 'Lamp area',
    aliases: ['lamp area', 'near lamp', 'near floor lamp'],
    margin: 0.38,
    yRange: [0.1, 2.05],
    priority: 58,
  },
]

export function buildRoomZones(
  transforms: Record<EditableObjectKey, ObjectTransform> = getInitialObjectTransforms(),
): RoomZone[] {
  const objectZones = objectZoneSpecs.map((zoneSpec) => {
    const object = sceneObjectById[zoneSpec.sourceObjectId]
    const transform = transforms[zoneSpec.sourceObjectId]
    const footprint = object.footprint ?? { w: 0.8, d: 0.8, h: 1 }
    const width = footprint.w + zoneSpec.margin * 2
    const depth = footprint.d + zoneSpec.margin * 2
    const bounds = clampBounds({
      minX: transform.position[0] - width / 2,
      maxX: transform.position[0] + width / 2,
      minY: zoneSpec.yRange[0],
      maxY: zoneSpec.yRange[1],
      minZ: transform.position[2] - depth / 2,
      maxZ: transform.position[2] + depth / 2,
    })

    return {
      id: zoneSpec.id,
      label: zoneSpec.label,
      kind: zoneSpec.sourceObjectId === 'fan' ? 'device' as const : 'object' as const,
      bounds,
      anchor: [transform.position[0], (bounds.minY + bounds.maxY) / 2, transform.position[2]] as [number, number, number],
      aliases: zoneSpec.aliases,
      sourceObjectId: zoneSpec.sourceObjectId,
      priority: zoneSpec.priority,
    }
  })

  const fixedZones: RoomZone[] = [
    {
      id: 'centerArea',
      label: 'Center area',
      kind: 'fixed',
      bounds: {
        minX: -1.75,
        maxX: 1.75,
        minY: 0.1,
        maxY: 1.8,
        minZ: -1.45,
        maxZ: 1.45,
      },
      anchor: [0, 0.95, 0],
      aliases: ['center area', 'center', 'room center', 'living room center'],
      priority: 30,
    },
    {
      id: 'windowArea',
      label: 'Window wall area',
      kind: 'fixed',
      bounds: {
        minX: roomBounds.minX + 0.25,
        maxX: roomBounds.maxX - 0.25,
        minY: 0.65,
        maxY: roomBounds.height,
        minZ: roomBounds.minZ,
        maxZ: roomBounds.minZ + 1.15,
      },
      anchor: [0, 1.65, roomBounds.minZ + 0.42],
      aliases: ['window area', 'window wall', 'near window', 'window-side area'],
      priority: 35,
    },
    {
      id: 'acSupplyArea',
      label: 'AC supply area',
      kind: 'device',
      bounds: {
        minX: 1.45,
        maxX: 3.85,
        minY: 1.25,
        maxY: 2.55,
        minZ: roomBounds.minZ,
        maxZ: roomBounds.minZ + 2.2,
      },
      anchor: [2.65, 1.9, -2.65],
      aliases: ['ac supply', 'air conditioner area', 'near air conditioner'],
      priority: 62,
    },
    {
      id: 'ventArea',
      label: 'Exhaust vent area',
      kind: 'device',
      bounds: {
        minX: -4.2,
        maxX: -2.7,
        minY: 1.25,
        maxY: 2.65,
        minZ: roomBounds.minZ,
        maxZ: roomBounds.minZ + 1.55,
      },
      anchor: [-3.45, 1.95, -3],
      aliases: ['vent area', 'exhaust area', 'near vent', 'near exhaust outlet'],
      priority: 62,
    },
  ]

  return [...objectZones, ...fixedZones]
}

export function getZoneById(
  zoneId: ZoneId,
  transforms: Record<EditableObjectKey, ObjectTransform> = getInitialObjectTransforms(),
) {
  return buildRoomZones(transforms).find((zone) => zone.id === zoneId) ?? null
}

export function getZonesAtPoint(
  point: RoomPoint,
  transforms: Record<EditableObjectKey, ObjectTransform> = getInitialObjectTransforms(),
) {
  const y = point.y ?? 0.9
  const pointWithY = { ...point, y }

  return buildRoomZones(transforms)
    .filter((zone) => containsPoint(zone.bounds, pointWithY))
    .sort(
      (left, right) =>
        zoneAnchorDistance(left, pointWithY) - zoneAnchorDistance(right, pointWithY) ||
        right.priority - left.priority ||
        zoneVolume(left.bounds) - zoneVolume(right.bounds),
    )
}

export function getPrimaryZoneAtPoint(
  point: RoomPoint,
  transforms: Record<EditableObjectKey, ObjectTransform> = getInitialObjectTransforms(),
) {
  return getZonesAtPoint(point, transforms)[0] ?? null
}

export function getZoneGridCells(
  zoneId: ZoneId,
  options: {
    grid?: GridSpec
    transforms?: Record<EditableObjectKey, ObjectTransform>
  } = {},
): ZoneGridCell[] {
  const grid = options.grid ?? defaultGrid
  const zone = getZoneById(zoneId, options.transforms ?? getInitialObjectTransforms())

  if (!zone) {
    return []
  }

  const cells: ZoneGridCell[] = []

  for (let y = 0; y < grid.layers; y += 1) {
    for (let z = 0; z < grid.height; z += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        const center = gridCellCenter({ x, y, z }, grid)

        if (!containsPoint(zone.bounds, { x: center[0], y: center[1], z: center[2] })) {
          continue
        }

        cells.push({
          x,
          y,
          z,
          index: gridCellIndex(x, y, z, grid),
          center,
        })
      }
    }
  }

  return cells
}

export function roomPointToGridCell(point: Required<RoomPoint>, grid: GridSpec = defaultGrid) {
  const x = Math.max(0, Math.min(grid.width - 1, Math.floor(((point.x - roomBounds.minX) / roomBounds.width) * grid.width)))
  const y = Math.max(0, Math.min(grid.layers - 1, Math.floor((point.y / roomBounds.height) * grid.layers)))
  const z = Math.max(0, Math.min(grid.height - 1, Math.floor(((point.z - roomBounds.minZ) / roomBounds.depth) * grid.height)))

  return {
    x,
    y,
    z,
    index: gridCellIndex(x, y, z, grid),
  }
}

function gridCellCenter(cell: { x: number; y: number; z: number }, grid: GridSpec): [number, number, number] {
  return [
    roomBounds.minX + ((cell.x + 0.5) / grid.width) * roomBounds.width,
    ((cell.y + 0.5) / grid.layers) * roomBounds.height,
    roomBounds.minZ + ((cell.z + 0.5) / grid.height) * roomBounds.depth,
  ]
}

function gridCellIndex(x: number, y: number, z: number, grid: GridSpec) {
  return (y * grid.height + z) * grid.width + x
}

function containsPoint(bounds: ZoneBounds, point: Required<RoomPoint>) {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY &&
    point.z >= bounds.minZ &&
    point.z <= bounds.maxZ
  )
}

function clampBounds(bounds: ZoneBounds): ZoneBounds {
  return {
    minX: Math.max(roomBounds.minX, bounds.minX),
    maxX: Math.min(roomBounds.maxX, bounds.maxX),
    minY: Math.max(0, bounds.minY),
    maxY: Math.min(roomBounds.height, bounds.maxY),
    minZ: Math.max(roomBounds.minZ, bounds.minZ),
    maxZ: Math.min(roomBounds.maxZ, bounds.maxZ),
  }
}

function zoneVolume(bounds: ZoneBounds) {
  return (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY) * (bounds.maxZ - bounds.minZ)
}

function zoneAnchorDistance(zone: RoomZone, point: Required<RoomPoint>) {
  const dx = zone.anchor[0] - point.x
  const dy = zone.anchor[1] - point.y
  const dz = zone.anchor[2] - point.z

  return dx * dx + dy * dy * 0.35 + dz * dz
}
