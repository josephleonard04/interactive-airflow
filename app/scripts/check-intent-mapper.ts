import assert from 'node:assert/strict'
import { mapIntentsToDeviceConfig, yawFromFanToZone } from '../src/intent/heuristicMapper.ts'
import { parseIntentHeuristically } from '../src/intent/parse.ts'
import { getZoneById } from '../src/scene/zones.ts'
import { presets } from '../src/state/appConstants.ts'
import { initialObjectTransforms } from '../src/state/appConstants.ts'

const parseResult = parseIntentHeuristically('Cool the window-side sofa slightly, avoid direct draft on the baby')
const mapped = mapIntentsToDeviceConfig({
  devices: presets.comfort,
  objectTransforms: initialObjectTransforms,
  parseResult,
  mapperMode: 'heuristic',
})

assert.equal(mapped.changed, true)
assert.equal(mapped.devices.fan.enabled, true)
assert.equal(mapped.devices.ac.enabled, true)
assert.ok(mapped.devices.fan.speed > presets.comfort.fan.speed)
assert.ok(mapped.devices.ac.speed > presets.comfort.ac.speed)
assert.equal(mapped.autoFanSweep, false)
assert.equal(mapped.selectedObject, 'fan')
assert.match(mapped.summary, /fan aimed toward sofaArea/)
assert.match(mapped.summary, /avoid cribArea/)

const sofaZone = getZoneById('sofaArea')
assert.ok(sofaZone)
const directSofaYaw = yawFromFanToZone(initialObjectTransforms.fan, sofaZone)
const mappedFanYaw = mapped.objectTransforms.fan.rotation[1]
assert.notEqual(mappedFanYaw.toFixed(2), initialObjectTransforms.fan.rotation[1].toFixed(2))
assert.notEqual(mappedFanYaw.toFixed(2), directSofaYaw.toFixed(2))

const quietResult = mapIntentsToDeviceConfig({
  devices: presets.purge,
  objectTransforms: initialObjectTransforms,
  parseResult: parseIntentHeuristically('Ventilate quietly'),
  mapperMode: 'heuristic',
})

assert.equal(quietResult.changed, true)
assert.equal(quietResult.devices.vent.enabled, true)
assert.ok(quietResult.devices.fan.speed <= 52)
assert.ok(quietResult.devices.vent.speed <= 62)

console.log('intent mapper checks passed')
