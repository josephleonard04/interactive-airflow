import assert from 'node:assert/strict'
import { bindSketchToIntent } from '../src/intent/bind.ts'
import { mapIntentsToDeviceConfig } from '../src/intent/heuristicMapper.ts'
import { parseIntentHeuristically } from '../src/intent/parse.ts'
import { heightBandToGridLayers } from '../src/sketch/heightBinding.ts'
import {
  createSketchPrimitive,
  roomPointDistance,
  roomToScreenPoint,
  screenToRoomPoint,
  type SketchPrimitive,
} from '../src/sketch/primitives.ts'
import { initialObjectTransforms, presets } from '../src/state/appConstants.ts'

const viewport = { width: 320, height: 220 }
const screenCenter = roomToScreenPoint({ x: 0, z: 0 }, viewport)
const roomCenter = screenToRoomPoint(screenCenter, viewport)
assert.ok(Math.abs(roomCenter.x) < 0.001)
assert.ok(Math.abs(roomCenter.z) < 0.001)

const start = { x: -2.8, z: 0.75 }
const end = { x: -1.85, z: 1.2 }
const primitives: SketchPrimitive[] = [
  createSketchPrimitive({ id: 'point-1', mode: 'point', heightBand: 'seated', start, end: start }),
  createSketchPrimitive({ id: 'circle-1', mode: 'circle', heightBand: 'seated', start, end }),
  createSketchPrimitive({ id: 'box-1', mode: 'box', heightBand: 'standing', start, end }),
  createSketchPrimitive({ id: 'arrow-1', mode: 'arrow', heightBand: 'floor', start, end }),
]

assert.equal(primitives[0].mode, 'point')
assert.equal(primitives[1].mode, 'circle')
assert.equal(primitives[1].mode === 'circle' ? primitives[1].radius.toFixed(2) : '', roomPointDistance(start, end).toFixed(2))
assert.equal(primitives[2].mode, 'box')
assert.equal(primitives[3].mode, 'arrow')

const floorLayers = heightBandToGridLayers('floor', { width: 32, height: 24, layers: 14 })
const standingLayers = heightBandToGridLayers('standing', { width: 32, height: 24, layers: 14 })
assert.notEqual(floorLayers.minLayer, standingLayers.minLayer)
assert.ok(standingLayers.maxLayer > floorLayers.maxLayer)

const parseResult = parseIntentHeuristically('make this area much cooler')
assert.equal(parseResult.intents.length, 1)
assert.equal(parseResult.intents[0].target.type, 'zone')

const bound = bindSketchToIntent(parseResult, [primitives[1]])
assert.equal(bound.needsSketch, false)
assert.equal(bound.unresolvedReferences.length, 0)
assert.equal(bound.sketchBindings.length, 1)
assert.equal(bound.intents[0].target.type, 'region')
assert.equal(bound.intents[0].target.type === 'region' ? bound.intents[0].target.regionId : '', 'region-circle-1')

const mapped = mapIntentsToDeviceConfig({
  devices: presets.comfort,
  objectTransforms: initialObjectTransforms,
  parseResult: bound,
  sketchBindings: bound.sketchBindings,
})

assert.equal(mapped.changed, true)
assert.equal(mapped.selectedObject, 'fan')
assert.notEqual(mapped.objectTransforms.fan.rotation[1].toFixed(2), initialObjectTransforms.fan.rotation[1].toFixed(2))

const synthBound = bindSketchToIntent({
  intents: [],
  unresolvedReferences: ['make this area much cooler'],
  needsSketch: true,
}, [primitives[1]])

assert.equal(synthBound.intents.length, 1)
assert.equal(synthBound.intents[0].target.type, 'region')
assert.equal(synthBound.needsSketch, false)

console.log('sketch phase 2 checks passed')
