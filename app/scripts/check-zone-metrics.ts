import assert from 'node:assert/strict'
import { createInitialSnapshot } from '../src/stableFluidSolver.ts'
import { getZoneGridCells } from '../src/scene/zones.ts'
import { readSingleZoneMetrics, readZoneMetrics } from '../src/solver/zoneMetrics.ts'

const snapshot = createInitialSnapshot(32, 24, 14)
const cellCount = snapshot.width * snapshot.height * snapshot.layers

snapshot.volumeScalars.temperature.fill(0.5)
snapshot.volumeScalars.humidity.fill(0.4)
snapshot.volumeScalars.pm25.fill(0.2)
snapshot.volumeScalars.co2.fill(0.3)
snapshot.volumeVelocities.fill(0)
snapshot.volumeFlags.fill(0)

const sofaCells = getZoneGridCells('sofaArea')
assert.ok(sofaCells.length > 0)

for (const cell of sofaCells) {
  snapshot.volumeScalars.temperature[cell.index] = 0.82
  snapshot.volumeScalars.humidity[cell.index] = 0.61
  snapshot.volumeScalars.pm25[cell.index] = 0.12
  snapshot.volumeScalars.co2[cell.index] = 0.44
  snapshot.volumeVelocities[cell.index * 4] = 0.12
  snapshot.volumeVelocities[cell.index * 4 + 1] = 0.03
  snapshot.volumeVelocities[cell.index * 4 + 2] = 0.04
  snapshot.volumeVelocities[cell.index * 4 + 3] = 0.25
}

const blockedCell = sofaCells[0]
snapshot.volumeFlags[blockedCell.index] = 1
snapshot.volumeScalars.temperature[blockedCell.index] = 1
snapshot.volumeScalars.humidity[blockedCell.index] = 1
snapshot.volumeScalars.pm25[blockedCell.index] = 1
snapshot.volumeScalars.co2[blockedCell.index] = 1
snapshot.volumeVelocities[blockedCell.index * 4 + 3] = 1

const sofaMetrics = readSingleZoneMetrics(snapshot, 'sofaArea')
assert.equal(round(sofaMetrics.temp), 0.82)
assert.equal(round(sofaMetrics.humidity), 0.61)
assert.equal(round(sofaMetrics.pm25), 0.12)
assert.equal(round(sofaMetrics.co2), 0.44)
assert.equal(round(sofaMetrics.airflow), 0.25)

const allMetrics = readZoneMetrics(snapshot)
assert.equal(round(allMetrics.sofaArea.temp), 0.82)
assert.ok(allMetrics.cribArea.temp >= 0 && allMetrics.cribArea.temp <= 1)
assert.equal(snapshot.volumeVelocities.length, cellCount * 4)

console.log('zone metric checks passed')

function round(value: number) {
  return Math.round(value * 100) / 100
}
