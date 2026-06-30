import assert from 'node:assert/strict'
import { evaluate, evaluateHeadlessAirflow } from '../src/solver/headlessEvaluate.ts'
import { getInitialObjectTransforms } from '../src/scene/sceneGraph.ts'
import { buildFlowLayout } from '../src/state/flowLayout.ts'

const initialObjectTransforms = getInitialObjectTransforms()
const layout = buildFlowLayout(initialObjectTransforms)
const active = evaluateHeadlessAirflow({
  fan: { enabled: true, speed: 58 },
  ac: { enabled: true, speed: 42 },
  vent: { enabled: true, speed: 36 },
}, layout, {
  transforms: initialObjectTransforms,
})
const disabled = evaluate(
  {
    fan: { enabled: false, speed: 0 },
    ac: { enabled: false, speed: 0 },
    vent: { enabled: false, speed: 0 },
  },
  layout,
  {
    transforms: initialObjectTransforms,
  },
)

assert.equal(active.snapshot.revision, 12)
assert.ok(active.metrics.fanArea.airflow > disabled.fanArea.airflow)
assert.ok(active.metrics.acSupplyArea.temp < disabled.acSupplyArea.temp)
assert.ok(active.metrics.ventArea.co2 <= disabled.ventArea.co2)
assert.ok(active.elapsedMs < 250)

console.log(`headless evaluation checks passed in ${active.elapsedMs.toFixed(1)}ms`)
