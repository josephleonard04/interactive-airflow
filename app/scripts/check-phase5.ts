import assert from 'node:assert/strict'
import { intentTemplates } from '../src/intent/templates.ts'
import { emptyIntentSession, reduceIntentSession } from '../src/intent/session.ts'
import { buildGoalFeedbackItems } from '../src/ui/goalFeedbackModel.ts'
import { initialObjectTransforms, presets } from '../src/state/appConstants.ts'
import type { ZoneMetrics } from '../src/solver/zoneMetrics.ts'

assert.equal(intentTemplates.length, 3)
assert.ok(intentTemplates.every((template) => template.parseResult.intents.length > 0))

const movieTemplate = intentTemplates.find((template) => template.id === 'movie-cool')
assert.ok(movieTemplate)

const session = reduceIntentSession(emptyIntentSession, {
  type: 'add-turn',
  sourceText: movieTemplate.sourceText,
  result: movieTemplate.parseResult,
})

assert.equal(session.entries.length, 2)

const metrics = {
  sofaArea: { temp: 0.46, humidity: 0.48, pm25: 0.12, co2: 0.2, airflow: 0.05, noise: 0.2 },
  cribArea: { temp: 0.5, humidity: 0.48, pm25: 0.12, co2: 0.2, airflow: 0.018, noise: 0.18 },
  seatedPersonArea: { temp: 0.46, humidity: 0.48, pm25: 0.12, co2: 0.2, airflow: 0.05, noise: 0.2 },
  sleepingBabyArea: { temp: 0.5, humidity: 0.48, pm25: 0.12, co2: 0.2, airflow: 0.018, noise: 0.18 },
  tvArea: { temp: 0.52, humidity: 0.48, pm25: 0.08, co2: 0.2, airflow: 0.04, noise: 0.2 },
  coffeeTableArea: { temp: 0.52, humidity: 0.48, pm25: 0.1, co2: 0.2, airflow: 0.04, noise: 0.2 },
  centerArea: { temp: 0.52, humidity: 0.48, pm25: 0.1, co2: 0.18, airflow: 0.04, noise: 0.2 },
  windowArea: { temp: 0.52, humidity: 0.48, pm25: 0.1, co2: 0.2, airflow: 0.04, noise: 0.2 },
  fanArea: { temp: 0.52, humidity: 0.48, pm25: 0.1, co2: 0.2, airflow: 0.08, noise: 0.42 },
  acSupplyArea: { temp: 0.48, humidity: 0.48, pm25: 0.1, co2: 0.2, airflow: 0.05, noise: 0.28 },
  ventArea: { temp: 0.52, humidity: 0.48, pm25: 0.1, co2: 0.18, airflow: 0.05, noise: 0.3 },
  plantArea: { temp: 0.52, humidity: 0.55, pm25: 0.1, co2: 0.2, airflow: 0.04, noise: 0.2 },
  lampArea: { temp: 0.58, humidity: 0.48, pm25: 0.1, co2: 0.2, airflow: 0.04, noise: 0.2 },
} satisfies ZoneMetrics

const feedback = buildGoalFeedbackItems({
  devices: presets.comfort,
  metrics,
  session,
  transforms: initialObjectTransforms,
})

assert.equal(feedback.length, 2)
assert.ok(feedback.some((item) => item.title.includes('Seated person breathing zone')))
assert.ok(feedback.some((item) => item.title.includes('Sleeping baby breathing zone')))
assert.ok(feedback.every((item) => item.status === 'ok'))
assert.ok(feedback.every((item) => !/field|grid|revision|velocity/i.test(`${item.title} ${item.detail}`)))

console.log('phase 5 checks passed')
