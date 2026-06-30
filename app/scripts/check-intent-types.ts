import assert from 'node:assert/strict'
import { intentExamples, isAirflowIntent, isIntentParseResult } from '../src/intent/types.ts'

assert.equal(isAirflowIntent(intentExamples['Cool the sofa area slightly'][0]), true)
assert.equal(isAirflowIntent(intentExamples['Do not blow air onto the baby'][0]), true)
assert.equal(isAirflowIntent(intentExamples['Ventilate quietly'][0]), true)

assert.equal(
  isIntentParseResult({
    intents: [
      ...intentExamples['Cool the sofa area slightly'],
      ...intentExamples['Do not blow air onto the baby'],
    ],
    unresolvedReferences: [],
    needsSketch: false,
  }),
  true,
)

assert.equal(isAirflowIntent({ metric: 'temperature' }), false)

console.log('intent type checks passed')
