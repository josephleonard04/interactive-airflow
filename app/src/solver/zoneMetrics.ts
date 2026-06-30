import type { StableFluidSnapshot } from '../stableFluidSolver'
import { buildRoomZones, getZoneGridCells, type GridSpec, type ZoneId } from '../scene/zones.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'

export type ZoneMetricValues = {
  temp: number
  humidity: number
  pm25: number
  co2: number
  airflow: number
  noise: number
}

export type ZoneMetrics = Record<ZoneId, ZoneMetricValues>

export function readZoneMetrics(
  snapshot: StableFluidSnapshot,
  transforms?: Record<EditableObjectKey, ObjectTransform>,
): ZoneMetrics {
  const zones = buildRoomZones(transforms)
  const metrics = {} as ZoneMetrics
  const grid: GridSpec = {
    width: snapshot.width,
    height: snapshot.height,
    layers: snapshot.layers,
  }

  for (const zone of zones) {
    metrics[zone.id] = readSingleZoneMetrics(snapshot, zone.id, grid, transforms)
  }

  return metrics
}

export function readSingleZoneMetrics(
  snapshot: StableFluidSnapshot,
  zoneId: ZoneId,
  grid: GridSpec = {
    width: snapshot.width,
    height: snapshot.height,
    layers: snapshot.layers,
  },
  transforms?: Record<EditableObjectKey, ObjectTransform>,
): ZoneMetricValues {
  const cells = getZoneGridCells(zoneId, { grid, transforms })
  const openCells = cells.filter((cell) => snapshot.volumeFlags[cell.index] !== 1)
  const samples = openCells.length > 0 ? openCells : cells

  if (samples.length === 0) {
    return emptyMetrics()
  }

  let temp = 0
  let humidity = 0
  let pm25 = 0
  let co2 = 0
  let airflow = 0
  let noise = 0

  for (const cell of samples) {
    const velocityBase = cell.index * 4
    const speed = snapshot.volumeVelocities[velocityBase + 3]

    temp += snapshot.volumeScalars.temperature[cell.index]
    humidity += snapshot.volumeScalars.humidity[cell.index]
    pm25 += snapshot.volumeScalars.pm25[cell.index]
    co2 += snapshot.volumeScalars.co2[cell.index]
    noise += snapshot.volumeScalars.noise[cell.index]
    airflow += speed > 0
      ? speed
      : Math.hypot(
          snapshot.volumeVelocities[velocityBase],
          snapshot.volumeVelocities[velocityBase + 1],
          snapshot.volumeVelocities[velocityBase + 2],
        )
  }

  const weight = 1 / samples.length

  return {
    temp: temp * weight,
    humidity: humidity * weight,
    pm25: pm25 * weight,
    co2: co2 * weight,
    airflow: airflow * weight,
    noise: noise * weight,
  }
}

function emptyMetrics(): ZoneMetricValues {
  return {
    temp: 0,
    humidity: 0,
    pm25: 0,
    co2: 0,
    airflow: 0,
    noise: 0,
  }
}
