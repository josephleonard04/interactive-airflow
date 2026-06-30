import { roomBounds } from '../scene/sceneGraph.ts'
import type { GridSpec } from '../scene/zones.ts'
import type { SketchHeightBand } from './primitives.ts'

export type HeightBinding = {
  band: SketchHeightBand
  label: string
  minY: number
  maxY: number
}

export const heightBindings: Record<SketchHeightBand, HeightBinding> = {
  floor: {
    band: 'floor',
    label: 'Floor',
    minY: 0.05,
    maxY: 0.45,
  },
  seated: {
    band: 'seated',
    label: 'Seated',
    minY: 0.45,
    maxY: 1.35,
  },
  standing: {
    band: 'standing',
    label: 'Standing',
    minY: 0.85,
    maxY: 2.15,
  },
  'crib-low': {
    band: 'crib-low',
    label: 'Crib low',
    minY: 0.18,
    maxY: 0.95,
  },
}

export function getHeightBinding(band: SketchHeightBand) {
  return heightBindings[band]
}

export function heightBandToGridLayers(band: SketchHeightBand, grid: GridSpec) {
  const binding = getHeightBinding(band)
  const minLayer = clampLayer(Math.floor((binding.minY / roomBounds.height) * grid.layers), grid.layers)
  const maxLayer = clampLayer(Math.ceil((binding.maxY / roomBounds.height) * grid.layers) - 1, grid.layers)

  return {
    minLayer,
    maxLayer: Math.max(minLayer, maxLayer),
  }
}

function clampLayer(layer: number, layers: number) {
  return Math.max(0, Math.min(layers - 1, layer))
}
