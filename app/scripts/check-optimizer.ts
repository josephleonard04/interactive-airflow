import assert from 'node:assert/strict'
import { mapIntentsHeuristically, mapIntentsToDeviceConfig } from '../src/intent/heuristicMapper.ts'
import { parseIntentHeuristically } from '../src/intent/parse.ts'
import { detectObjectiveConflicts } from '../src/solver/conflict.ts'
import { evaluateHeadlessAirflow } from '../src/solver/headlessEvaluate.ts'
import { scoreIntentAchievement } from '../src/solver/objectives.ts'
import { initialObjectTransforms, presets } from '../src/state/appConstants.ts'
import { buildFlowLayout } from '../src/state/flowLayout.ts'

const parseResult = parseIntentHeuristically('Cool the sofa area slightly, avoid direct draft on the baby')
const heuristic = mapIntentsHeuristically({
  devices: presets.comfort,
  objectTransforms: initialObjectTransforms,
  parseResult,
})
const optimized = mapIntentsToDeviceConfig({
  devices: presets.comfort,
  objectTransforms: initialObjectTransforms,
  parseResult,
  mapperMode: 'optimized',
})

assert.equal(optimized.changed, true)
assert.equal(optimized.optimization?.enabled, true)
assert.ok((optimized.optimization?.evaluations ?? 0) > 6)
assert.ok((optimized.optimization?.bestScore ?? 0) >= (optimized.optimization?.heuristicScore ?? 0) - 0.01)

const heuristicScore = scoreIntentAchievement({
  devices: heuristic.devices,
  metrics: evaluateHeadlessAirflow(heuristic.devices, buildFlowLayout(heuristic.objectTransforms), {
    width: 18,
    height: 14,
    layers: 8,
    steps: 9,
    dt: 0.035,
    transforms: heuristic.objectTransforms,
  }).metrics,
  objectTransforms: heuristic.objectTransforms,
  parseResult,
})
const optimizedScore = scoreIntentAchievement({
  devices: optimized.devices,
  metrics: evaluateHeadlessAirflow(optimized.devices, buildFlowLayout(optimized.objectTransforms), {
    width: 18,
    height: 14,
    layers: 8,
    steps: 9,
    dt: 0.035,
    transforms: optimized.objectTransforms,
  }).metrics,
  objectTransforms: optimized.objectTransforms,
  parseResult,
})

assert.ok(optimizedScore.score >= heuristicScore.score - 0.01)

const conflictResult = parseIntentHeuristically('Make the sofa cooler, ventilate quietly, avoid direct draft on the baby')
const conflicts = detectObjectiveConflicts(conflictResult)

assert.ok(conflicts.length >= 2)
assert.ok(conflicts.some((conflict) => conflict.type === 'cool-vs-quiet'))
assert.ok(conflicts.some((conflict) => conflict.type === 'cool-vs-protected-draft'))

console.log('optimizer checks passed')
