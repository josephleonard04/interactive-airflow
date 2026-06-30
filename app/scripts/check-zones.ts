import assert from 'node:assert/strict'
import {
  buildRoomZones,
  getPrimaryZoneAtPoint,
  getZoneById,
  getZoneGridCells,
  getZonesAtPoint,
  roomPointToGridCell,
} from '../src/scene/zones.ts'

const zones = buildRoomZones()
assert.ok(zones.length >= 10)

assert.equal(getPrimaryZoneAtPoint({ x: -2.45, y: 0.9, z: 0.9 })?.id, 'sofaArea')
assert.equal(getPrimaryZoneAtPoint({ x: -3.62, y: 0.55, z: 1.85 })?.id, 'sleepingBabyArea')
assert.equal(getPrimaryZoneAtPoint({ x: 0, y: 0.9, z: 0 })?.id, 'centerArea')
assert.equal(getZonesAtPoint({ x: 2.65, y: 1.9, z: -3.0 }).some((zone) => zone.id === 'acSupplyArea'), true)

const sofaCells = getZoneGridCells('sofaArea')
const cribCells = getZoneGridCells('cribArea')
const sleepingBabyCells = getZoneGridCells('sleepingBabyArea')
const windowCells = getZoneGridCells('windowArea')

assert.ok(sofaCells.length > 0)
assert.ok(cribCells.length > 0)
assert.ok(sleepingBabyCells.length > 0)
assert.ok(windowCells.length > 0)

const sofaGrid = roomPointToGridCell({ x: -2.45, y: 0.9, z: 0.9 })
assert.equal(sofaCells.some((cell) => cell.index === sofaGrid.index), true)
assert.equal(getZoneById('tvArea')?.sourceObjectId, 'mediaConsole')
assert.equal(getZoneById('seatedPersonArea')?.sourceObjectId, 'seatedPerson')

console.log('zone checks passed')
