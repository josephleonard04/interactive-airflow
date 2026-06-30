import { roomBounds } from '../scene/sceneGraph.ts'

export type SketchMode = 'point' | 'circle' | 'box' | 'arrow' | 'draw'
export type SketchHeightBand = 'floor' | 'seated' | 'standing' | 'crib-low'

export type SketchPoint = {
  x: number
  z: number
}

export type SketchPrimitiveBase = {
  id: string
  mode: SketchMode
  heightBand: SketchHeightBand
  createdAt: number
}

export type PointPrimitive = SketchPrimitiveBase & {
  mode: 'point'
  point: SketchPoint
}

export type CirclePrimitive = SketchPrimitiveBase & {
  mode: 'circle'
  center: SketchPoint
  radius: number
}

export type BoxPrimitive = SketchPrimitiveBase & {
  mode: 'box'
  min: SketchPoint
  max: SketchPoint
}

export type ArrowPrimitive = SketchPrimitiveBase & {
  mode: 'arrow'
  start: SketchPoint
  end: SketchPoint
}

export type DrawPrimitive = SketchPrimitiveBase & {
  mode: 'draw'
  points: SketchPoint[]
}

export type SketchPrimitive = PointPrimitive | CirclePrimitive | BoxPrimitive | ArrowPrimitive | DrawPrimitive

export type PlanViewport = {
  width: number
  height: number
}

export function screenToRoomPoint(
  screen: { x: number; y: number },
  viewport: PlanViewport,
): SketchPoint {
  return {
    x: roomBounds.minX + (screen.x / viewport.width) * roomBounds.width,
    z: roomBounds.minZ + (screen.y / viewport.height) * roomBounds.depth,
  }
}

export function roomToScreenPoint(point: SketchPoint, viewport: PlanViewport) {
  return {
    x: ((point.x - roomBounds.minX) / roomBounds.width) * viewport.width,
    y: ((point.z - roomBounds.minZ) / roomBounds.depth) * viewport.height,
  }
}

export function createSketchPrimitive({
  end,
  heightBand,
  id,
  mode,
  points,
  start,
}: {
  end: SketchPoint
  heightBand: SketchHeightBand
  id: string
  mode: SketchMode
  points?: SketchPoint[]
  start: SketchPoint
}): SketchPrimitive {
  const base = {
    id,
    mode,
    heightBand,
    createdAt: Date.now(),
  }

  if (mode === 'point') {
    return {
      ...base,
      mode,
      point: end,
    }
  }

  if (mode === 'circle') {
    return {
      ...base,
      mode,
      center: start,
      radius: Math.max(0.18, roomPointDistance(start, end)),
    }
  }

  if (mode === 'box') {
    return {
      ...base,
      mode,
      min: {
        x: Math.min(start.x, end.x),
        z: Math.min(start.z, end.z),
      },
      max: {
        x: Math.max(start.x, end.x),
        z: Math.max(start.z, end.z),
      },
    }
  }

  if (mode === 'draw') {
    return {
      ...base,
      mode,
      points: points && points.length > 1 ? points : [start, end],
    }
  }

  return {
    ...base,
    mode,
    start,
    end,
  }
}

export function sketchPrimitiveCenter(primitive: SketchPrimitive): SketchPoint {
  if (primitive.mode === 'point') {
    return primitive.point
  }

  if (primitive.mode === 'circle') {
    return primitive.center
  }

  if (primitive.mode === 'box') {
    return {
      x: (primitive.min.x + primitive.max.x) / 2,
      z: (primitive.min.z + primitive.max.z) / 2,
    }
  }

  if (primitive.mode === 'draw') {
    const bounds = sketchPrimitiveBounds(primitive)

    return {
      x: (bounds.min.x + bounds.max.x) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    }
  }

  return {
    x: (primitive.start.x + primitive.end.x) / 2,
    z: (primitive.start.z + primitive.end.z) / 2,
  }
}

export function sketchPrimitiveBounds(primitive: SketchPrimitive): { min: SketchPoint; max: SketchPoint } {
  if (primitive.mode === 'point') {
    return {
      min: primitive.point,
      max: primitive.point,
    }
  }

  if (primitive.mode === 'circle') {
    return {
      min: {
        x: primitive.center.x - primitive.radius,
        z: primitive.center.z - primitive.radius,
      },
      max: {
        x: primitive.center.x + primitive.radius,
        z: primitive.center.z + primitive.radius,
      },
    }
  }

  if (primitive.mode === 'box') {
    return {
      min: primitive.min,
      max: primitive.max,
    }
  }

  const points = primitive.mode === 'draw'
    ? primitive.points
    : [primitive.start, primitive.end]

  return points.reduce(
    (bounds, point) => ({
      min: {
        x: Math.min(bounds.min.x, point.x),
        z: Math.min(bounds.min.z, point.z),
      },
      max: {
        x: Math.max(bounds.max.x, point.x),
        z: Math.max(bounds.max.z, point.z),
      },
    }),
    {
      min: { ...points[0] },
      max: { ...points[0] },
    },
  )
}

export function sketchPrimitiveLabel(primitive: SketchPrimitive) {
  const center = sketchPrimitiveCenter(primitive)

  return `${primitive.mode} ${center.x.toFixed(1)}, ${center.z.toFixed(1)}`
}

export function roomPointDistance(left: SketchPoint, right: SketchPoint) {
  const dx = left.x - right.x
  const dz = left.z - right.z

  return Math.hypot(dx, dz)
}
