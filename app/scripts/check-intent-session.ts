import assert from 'node:assert/strict'
import { bindSketchToIntent } from '../src/intent/bind.ts'
import { mapIntentsToDeviceConfig } from '../src/intent/heuristicMapper.ts'
import { parseIntentHeuristically } from '../src/intent/parse.ts'
import {
  buildIntentGroundings,
  buildSessionParseResult,
  describeSession,
  emptyIntentSession,
  getActiveIntentEntries,
  reduceIntentSession,
} from '../src/intent/session.ts'
import { createSketchPrimitive } from '../src/sketch/primitives.ts'
import { initialObjectTransforms, presets } from '../src/state/appConstants.ts'

let session = emptyIntentSession

session = reduceIntentSession(session, {
  type: 'add-turn',
  sourceText: 'Cool the sofa area slightly',
  result: parseIntentHeuristically('Cool the sofa area slightly'),
})

assert.equal(getActiveIntentEntries(session).length, 1)
assert.match(describeSession(session), /Sofa area/)

session = reduceIntentSession(session, {
  type: 'add-turn',
  sourceText: 'make it cooler',
  result: parseIntentHeuristically('make it cooler'),
})

const activeAfterRefine = getActiveIntentEntries(session)
assert.equal(activeAfterRefine.length, 2)
assert.equal(activeAfterRefine.at(-1)?.intent.target.type, 'zone')
assert.equal(activeAfterRefine.at(-1)?.intent.target.type === 'zone' ? activeAfterRefine.at(-1)?.intent.target.zoneId : '', 'sofaArea')
assert.equal(activeAfterRefine.at(-1)?.intent.magnitude, 'moderate')

session = reduceIntentSession(session, {
  type: 'accept',
  entryId: activeAfterRefine[0].entryId,
})
assert.equal(getActiveIntentEntries(session)[0].status, 'accepted')

session = reduceIntentSession(session, {
  type: 'adjust',
  entryId: activeAfterRefine[1].entryId,
})
assert.equal(getActiveIntentEntries(session)[1].status, 'adjusted')
assert.equal(getActiveIntentEntries(session)[1].intent.magnitude, 'much')

const circle = createSketchPrimitive({
  id: 'protect-box',
  mode: 'box',
  heightBand: 'crib-low',
  start: { x: -4.1, z: 1.45 },
  end: { x: -3.1, z: 2.35 },
})
const boundProtect = bindSketchToIntent(parseIntentHeuristically('keep this area out of direct draft'), [circle])

session = reduceIntentSession(session, {
  type: 'add-turn',
  sourceText: 'keep this area out of direct draft',
  result: boundProtect,
  sketchBindings: boundProtect.sketchBindings,
})

assert.equal(session.sketchBindings.length, 1)
assert.equal(getActiveIntentEntries(session).length, 3)
assert.equal(buildIntentGroundings(session, initialObjectTransforms).length, 3)

const mappedWithAll = mapIntentsToDeviceConfig({
  devices: presets.comfort,
  objectTransforms: initialObjectTransforms,
  parseResult: buildSessionParseResult(session),
  sketchBindings: session.sketchBindings,
  mapperMode: 'heuristic',
})
assert.ok(mappedWithAll.devices.fan.speed > presets.comfort.fan.speed)

const lastEntry = getActiveIntentEntries(session).at(-1)
assert.ok(lastEntry)
session = reduceIntentSession(session, {
  type: 'undo',
  entryId: lastEntry.entryId,
})

assert.equal(session.sketchBindings.length, 1)
assert.equal(getActiveIntentEntries(session).length, 2)

const mappedAfterUndo = mapIntentsToDeviceConfig({
  devices: presets.comfort,
  objectTransforms: initialObjectTransforms,
  parseResult: buildSessionParseResult(session),
  sketchBindings: session.sketchBindings,
  mapperMode: 'heuristic',
})
assert.ok(mappedAfterUndo.devices.fan.speed >= presets.comfort.fan.speed)

session = reduceIntentSession(session, {
  type: 'add-turn',
  sourceText: 'wrong, keep only sofa',
  result: parseIntentHeuristically('wrong, keep only sofa'),
})
assert.equal(getActiveIntentEntries(session).every((entry) => entry.intent.target.type === 'zone' && entry.intent.target.zoneId === 'sofaArea'), true)

console.log('intent session checks passed')
