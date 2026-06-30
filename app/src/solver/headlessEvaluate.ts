import {
  createStableFluidStepper,
  type DeviceState,
  type FlowLayout,
  type StableFluidSnapshot,
} from '../stableFluidSolver.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'
import { readZoneMetrics, type ZoneMetrics } from './zoneMetrics.ts'

export type HeadlessEvaluationOptions = {
  width?: number
  height?: number
  layers?: number
  steps?: number
  dt?: number
  transforms?: Record<EditableObjectKey, ObjectTransform>
}

export type HeadlessEvaluationResult = {
  metrics: ZoneMetrics
  snapshot: StableFluidSnapshot
  elapsedMs: number
  steps: number
}

export function evaluate(
  deviceConfig: DeviceState,
  layout: FlowLayout,
  options: HeadlessEvaluationOptions = {},
): ZoneMetrics {
  return evaluateHeadlessAirflow(deviceConfig, layout, options).metrics
}

export function evaluateHeadlessAirflow(
  deviceConfig: DeviceState,
  layout: FlowLayout,
  options: HeadlessEvaluationOptions = {},
): HeadlessEvaluationResult {
  const width = options.width ?? 24
  const height = options.height ?? 18
  const layers = options.layers ?? 10
  const steps = options.steps ?? 12
  const dt = options.dt ?? 0.03
  const start = performance.now()
  const solver = createStableFluidStepper({
    devices: deviceConfig,
    height,
    layers,
    layout,
    width,
  })

  for (let step = 0; step < steps; step += 1) {
    solver.step(dt)
  }

  const snapshot = solver.getSnapshot()
  const metrics = readZoneMetrics(snapshot, options.transforms)

  return {
    metrics,
    snapshot,
    elapsedMs: performance.now() - start,
    steps,
  }
}
