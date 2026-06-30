import assert from 'node:assert/strict'
import { resolveReference, sceneObjectById, sceneObjects } from '../src/scene/sceneGraph.ts'

assert.equal(sceneObjects.length, 10)
assert.equal(sceneObjectById.sofa.label, 'Sofa')
assert.deepEqual(resolveReference('window-side sofa').objectIds, ['sofa'])
assert.deepEqual(resolveReference('window-side sofa').zoneIds, ['sofaArea'])
assert.deepEqual(resolveReference('near crib').objectIds, ['crib'])
assert.deepEqual(resolveReference('near crib').zoneIds, ['cribArea'])
assert.deepEqual(resolveReference('avoid direct draft on the baby').objectIds, ['crib'])
assert.deepEqual(resolveReference('beside tv').objectIds, ['mediaConsole'])
assert.deepEqual(resolveReference('center table').objectIds, ['coffeeTable'])
assert.deepEqual(resolveReference('room center').zoneIds, ['centerArea'])
assert.deepEqual(resolveReference('near window').zoneIds, ['windowArea'])
assert.deepEqual(resolveReference('air conditioner outlet').zoneIds, ['acSupplyArea'])
assert.deepEqual(resolveReference('near vent').zoneIds, ['ventArea'])

console.log('scene graph checks passed')
