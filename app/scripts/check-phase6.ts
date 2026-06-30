import assert from 'node:assert/strict'
import { parseIntentHeuristically } from '../src/intent/parse.ts'
import { intentTemplates } from '../src/intent/templates.ts'
import { createStableFluidStepper } from '../src/stableFluidSolver.ts'
import { buildRoomZones, getZoneById } from '../src/scene/zones.ts'
import { evaluateHeadlessAirflow } from '../src/solver/headlessEvaluate.ts'
import { scoreIntentAchievement } from '../src/solver/objectives.ts'
import { readZoneMetrics } from '../src/solver/zoneMetrics.ts'
import { buildRoomDesignProject, parseRoomDesignProject } from '../src/state/projectPersistence.ts'
import { initialObjectTransforms, presets } from '../src/state/appConstants.ts'
import { buildFlowLayout } from '../src/state/flowLayout.ts'
import { emptyIntentSession, reduceIntentSession } from '../src/intent/session.ts'

const zones = buildRoomZones(initialObjectTransforms)
assert.ok(zones.some((zone) => zone.id === 'seatedPersonArea'))
assert.ok(zones.some((zone) => zone.id === 'sleepingBabyArea'))
assert.equal(getZoneById('seatedPersonArea', initialObjectTransforms)?.sourceObjectId, 'seatedPerson')
assert.equal(getZoneById('sleepingBabyArea', initialObjectTransforms)?.sourceObjectId, 'sleepingBaby')

const timedIntent = parseIntentHeuristically('Make the seated person cooler after 5 minutes')
assert.equal(timedIntent.intents[0]?.target.type, 'zone')
assert.equal(timedIntent.intents[0]?.target.type === 'zone' ? timedIntent.intents[0].target.zoneId : '', 'seatedPersonArea')
assert.equal(timedIntent.intents[0]?.timeCondition?.type, 'after')
assert.equal(timedIntent.intents[0]?.timeCondition?.type === 'after' ? timedIntent.intents[0].timeCondition.minutes : 0, 5)

const sleepIntent = parseIntentHeuristically('Baby sleeps at 20:00, keep quiet')
assert.equal(sleepIntent.intents[0]?.timeCondition?.type, 'at-clock')
assert.equal(sleepIntent.intents[0]?.metric, 'noise')

const layout = buildFlowLayout(initialObjectTransforms)
const solver = createStableFluidStepper({
  devices: { fan: { enabled: true, speed: 92 }, ac: { enabled: false, speed: 0 }, vent: { enabled: false, speed: 0 } },
  height: 10,
  layers: 8,
  layout,
  width: 12,
})

for (let index = 0; index < 8; index += 1) {
  solver.step(0.035)
}

const snapshot = solver.getSnapshot()
assert.ok(snapshot.volumeScalars.noise)
assert.ok(snapshot.scalarFields.noise)

const metrics = readZoneMetrics(snapshot, initialObjectTransforms)
assert.ok(metrics.fanArea.noise > 0.12)

const quietScore = scoreIntentAchievement({
  devices: presets.comfort,
  metrics,
  objectTransforms: initialObjectTransforms,
  parseResult: parseIntentHeuristically('Keep the seated person area quiet'),
})
assert.ok(quietScore.terms.some((term) => term.metric === 'noise'))

const template = intentTemplates.find((item) => item.id === 'baby-sleep')
assert.ok(template)
assert.equal(template.parseResult.intents[0]?.target.type === 'zone' ? template.parseResult.intents[0].target.zoneId : '', 'sleepingBabyArea')

const session = reduceIntentSession(emptyIntentSession, {
  type: 'add-turn',
  sourceText: template.sourceText,
  result: template.parseResult,
})
const project = buildRoomDesignProject({
  devices: presets.comfort,
  intentSession: session,
  mapperMode: 'optimized',
  objectTransforms: initialObjectTransforms,
  preset: 'comfort',
  sketchPrimitives: [],
})
const loaded = parseRoomDesignProject(JSON.stringify(project))
assert.equal(loaded.intentSession.entries.length, session.entries.length)
assert.equal(loaded.objectTransforms.seatedPerson.position[0], initialObjectTransforms.seatedPerson.position[0])
assert.equal(loaded.objectTransforms.sleepingBaby.position[2], initialObjectTransforms.sleepingBaby.position[2])

const evalResult = evaluateHeadlessAirflow(presets.comfort, layout, {
  transforms: initialObjectTransforms,
  width: 12,
  height: 10,
  layers: 8,
  steps: 4,
})
assert.ok(evalResult.metrics.seatedPersonArea)
assert.ok(evalResult.metrics.sleepingBabyArea)

console.log('phase 6 checks passed')
