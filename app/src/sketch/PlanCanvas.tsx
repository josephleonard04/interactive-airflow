import { ArrowUpRight, Circle, Map, MousePointer2, PencilLine, Square } from 'lucide-react'
import { useMemo, useRef, useState, type PointerEvent } from 'react'
import { roomBounds, sceneObjects } from '../scene/sceneGraph.ts'
import { getPrimaryZoneAtPoint } from '../scene/zones.ts'
import { getHeightBinding, heightBindings } from './heightBinding.ts'
import {
  createSketchPrimitive,
  roomPointDistance,
  roomToScreenPoint,
  screenToRoomPoint,
  sketchPrimitiveCenter,
  sketchPrimitiveLabel,
  type PlanViewport,
  type SketchHeightBand,
  type SketchMode,
  type SketchPoint,
  type SketchPrimitive,
} from './primitives.ts'

const viewport: PlanViewport = {
  width: 320,
  height: 220,
}

const sketchModes: Array<{ mode: SketchMode; label: string; icon: typeof MousePointer2 }> = [
  { mode: 'point', label: 'Point', icon: MousePointer2 },
  { mode: 'circle', label: 'Circle', icon: Circle },
  { mode: 'box', label: 'Box', icon: Square },
  { mode: 'arrow', label: 'Arrow', icon: ArrowUpRight },
  { mode: 'draw', label: 'Draw', icon: PencilLine },
]

const heightBands: SketchHeightBand[] = ['floor', 'seated', 'standing', 'crib-low']

export function PlanCanvas({
  heightBand,
  mode,
  onChangeHeightBand,
  onChangeMode,
  onChangePrimitives,
  primitives,
}: {
  heightBand: SketchHeightBand
  mode: SketchMode
  onChangeHeightBand: (heightBand: SketchHeightBand) => void
  onChangeMode: (mode: SketchMode) => void
  onChangePrimitives: (primitives: SketchPrimitive[]) => void
  primitives: SketchPrimitive[]
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragStartRef = useRef<SketchPoint | null>(null)
  const [dragStart, setDragStart] = useState<SketchPoint | null>(null)
  const [drawPoints, setDrawPoints] = useState<SketchPoint[]>([])
  const [hoverPoint, setHoverPoint] = useState<SketchPoint | null>(null)
  const hoverZone = hoverPoint ? getPrimaryZoneAtPoint({ x: hoverPoint.x, y: heightCenter(heightBand), z: hoverPoint.z }) : null
  const latestPrimitive = primitives.at(-1)
  const latestZone = latestPrimitive
    ? getPrimaryZoneAtPoint({
        x: sketchPrimitiveCenter(latestPrimitive).x,
        y: heightCenter(latestPrimitive.heightBand),
        z: sketchPrimitiveCenter(latestPrimitive).z,
      })
    : null
  const furnitureRects = useMemo(
    () =>
      sceneObjects
        .filter((object) => object.footprint)
        .map((object) => {
          const center = roomToScreenPoint({ x: object.transform.position[0], z: object.transform.position[2] }, viewport)
          const width = ((object.footprint?.w ?? 0.4) / roomBounds.width) * viewport.width
          const height = ((object.footprint?.d ?? 0.4) / roomBounds.depth) * viewport.height

          return {
            id: object.id,
            label: object.label,
            x: center.x - width / 2,
            y: center.y - height / 2,
            width,
            height,
          }
        }),
    [],
  )

  const addPrimitive = (start: SketchPoint, end: SketchPoint, points?: SketchPoint[]) => {
    const primitive = createSketchPrimitive({
      end,
      heightBand,
      id: `${mode}-${Date.now()}`,
      mode,
      points,
      start,
    })

    onChangePrimitives([...primitives, primitive])
  }

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const point = eventToRoomPoint(event)
    dragStartRef.current = point
    setDragStart(point)
    setDrawPoints(mode === 'draw' ? [point] : [])
    setHoverPoint(point)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const point = eventToRoomPoint(event)

    setHoverPoint(point)

    if (mode === 'draw' && dragStartRef.current) {
      setDrawPoints((current) => {
        const previous = current.at(-1)

        if (!previous || roomPointDistance(previous, point) > 0.04) {
          return [...current, point]
        }

        return current
      })
    }
  }

  const handlePointerUp = (event: PointerEvent<SVGSVGElement>) => {
    const end = eventToRoomPoint(event)
    const start = dragStartRef.current

    if (start) {
      if (mode === 'draw') {
        const points = [...drawPoints, end]

        addPrimitive(points[0] ?? start, end, points)
      } else {
        addPrimitive(start, end)
      }
    }

    dragStartRef.current = null
    setDragStart(null)
    setDrawPoints([])
    setHoverPoint(end)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const eventToRoomPoint = (event: PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()

    if (!rect) {
      return { x: 0, z: 0 }
    }

    return screenToRoomPoint(
      {
        x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
        y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
      },
      {
        width: rect.width,
        height: rect.height,
      },
    )
  }

  return (
    <section className="panel-section plan-sketch" aria-label="Plan sketch">
      <div className="section-title">
        <Map size={18} />
        Plan sketch
        <span>{primitives.length} marks</span>
      </div>

      <div className="sketch-controls" aria-label="Sketch primitive mode">
        {sketchModes.map((item) => {
          const Icon = item.icon

          return (
            <button
              className={mode === item.mode ? 'selected' : ''}
              key={item.mode}
              onClick={() => onChangeMode(item.mode)}
              title={`${item.label} sketch`}
              type="button"
            >
              <Icon size={14} />
              {item.label}
            </button>
          )
        })}
      </div>

      <div className="height-controls" aria-label="Sketch height band">
        {heightBands.map((band) => (
          <button
            className={heightBand === band ? 'selected' : ''}
            key={band}
            onClick={() => onChangeHeightBand(band)}
            type="button"
          >
            {heightBindings[band].label}
          </button>
        ))}
      </div>

      <svg
        className="plan-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        ref={svgRef}
        role="img"
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      >
        <rect className="plan-room" height={viewport.height} width={viewport.width} x={0} y={0} />
        <line className="plan-window" x1={18} x2={viewport.width - 18} y1={3} y2={3} />
        {furnitureRects.map((rect) => (
          <rect
            className="plan-furniture"
            height={rect.height}
            key={rect.id}
            width={rect.width}
            x={rect.x}
            y={rect.y}
          />
        ))}
        {primitives.map((primitive) => (
          <SketchShape key={primitive.id} primitive={primitive} />
        ))}
        {dragStart && hoverPoint ? (
          <SketchShape
            primitive={createSketchPrimitive({
              end: hoverPoint,
              heightBand,
              id: 'preview',
              mode,
              points: mode === 'draw' ? [...drawPoints, hoverPoint] : undefined,
              start: dragStart,
            })}
            preview
          />
        ) : null}
      </svg>

      <div className="sketch-readout">
        <span>
          {hoverPoint
            ? `${hoverPoint.x.toFixed(2)}, ${hoverPoint.z.toFixed(2)}`
            : 'Move over plan'}
        </span>
        <strong>{hoverZone?.label ?? 'No zone'}</strong>
        <small>
          {latestPrimitive
            ? `${sketchPrimitiveLabel(latestPrimitive)} · ${latestZone?.label ?? 'region'} · ${getHeightBinding(latestPrimitive.heightBand).label}`
            : 'No sketch mark yet'}
        </small>
      </div>

      <button
        className="sketch-clear"
        disabled={primitives.length === 0}
        onClick={() => onChangePrimitives([])}
        type="button"
      >
        Clear sketch
      </button>
    </section>
  )
}

function SketchShape({ preview = false, primitive }: { preview?: boolean; primitive: SketchPrimitive }) {
  const className = preview ? 'sketch-shape preview' : 'sketch-shape'

  if (primitive.mode === 'point') {
    const point = roomToScreenPoint(primitive.point, viewport)

    return <circle className={className} cx={point.x} cy={point.y} r={4.5} />
  }

  if (primitive.mode === 'circle') {
    const center = roomToScreenPoint(primitive.center, viewport)
    const edge = roomToScreenPoint({ x: primitive.center.x + primitive.radius, z: primitive.center.z }, viewport)

    return <circle className={className} cx={center.x} cy={center.y} r={Math.abs(edge.x - center.x)} />
  }

  if (primitive.mode === 'box') {
    const min = roomToScreenPoint(primitive.min, viewport)
    const max = roomToScreenPoint(primitive.max, viewport)

    return (
      <rect
        className={className}
        height={Math.abs(max.y - min.y)}
        width={Math.abs(max.x - min.x)}
        x={Math.min(min.x, max.x)}
        y={Math.min(min.y, max.y)}
      />
    )
  }

  if (primitive.mode === 'draw') {
    const points = primitive.points
      .map((point) => roomToScreenPoint(point, viewport))
      .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
      .join(' ')

    return <polyline className={className} fill="none" points={points} />
  }

  const start = roomToScreenPoint(primitive.start, viewport)
  const end = roomToScreenPoint(primitive.end, viewport)

  return (
    <g className={className}>
      <line x1={start.x} x2={end.x} y1={start.y} y2={end.y} />
      <circle cx={end.x} cy={end.y} r={3.5} />
    </g>
  )
}

function heightCenter(heightBand: SketchHeightBand) {
  const binding = getHeightBinding(heightBand)

  return (binding.minY + binding.maxY) / 2
}
