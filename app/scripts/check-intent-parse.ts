import assert from 'node:assert/strict'
import {
  buildIntentParsePrompt,
  describeIntentParseResult,
  parseAirflowIntents,
  parseIntentHeuristically,
  safeParseIntentJson,
} from '../src/intent/parse.ts'
import type { IntentParseResult } from '../src/intent/types.ts'

const acceptanceText = 'Cool the window-side sofa slightly, avoid direct draft on the baby'
const heuristic = parseIntentHeuristically(acceptanceText)

assert.equal(heuristic.intents.length, 2)
assert.deepEqual(heuristic.unresolvedReferences, [])
assert.equal(heuristic.needsSketch, false)

const sofaIntent = heuristic.intents[0]
assert.equal(sofaIntent.target.type, 'zone')
assert.equal(sofaIntent.target.type === 'zone' ? sofaIntent.target.zoneId : '', 'sofaArea')
assert.equal(sofaIntent.metric, 'temp')
assert.equal(sofaIntent.direction, 'down')

const cribIntent = heuristic.intents[1]
assert.equal(cribIntent.target.type, 'zone')
assert.equal(cribIntent.target.type === 'zone' ? cribIntent.target.zoneId : '', 'cribArea')
assert.equal(cribIntent.metric, 'airflow')
assert.equal(cribIntent.direction, 'keep')
assert.deepEqual(cribIntent.constraints, [{ type: 'avoid-zone', zoneId: 'cribArea', metric: 'airflow' }])

const prompt = buildIntentParsePrompt(acceptanceText)
assert.match(prompt, /sofaArea/)
assert.match(prompt, /cribArea/)
assert.match(prompt, /Return one JSON object/)

const llmResult = await parseAirflowIntents(acceptanceText, {
  fallbackMode: 'never',
  llm: async () => ({
    json: heuristic,
    model: 'test-model',
    mock: false,
  }),
})

assert.equal(describeIntentParseResult(llmResult), 'Parsed 2 intents: sofaArea temp down; cribArea airflow keep. Constraints: avoid cribArea airflow.')

const fencedJson = safeParseIntentJson(`\`\`\`json\n${JSON.stringify(heuristic)}\n\`\`\``)
assert.equal(fencedJson.ok, true)

const unsafeResult: IntentParseResult = {
  intents: [
    {
      id: 'bad-zone',
      sourceText: 'unknown zone',
      target: { type: 'zone', zoneId: 'notAZone' as never },
      metric: 'temp',
      direction: 'down',
      magnitude: 'slight',
      constraints: [],
      priority: 'normal',
    },
  ],
  unresolvedReferences: [],
  needsSketch: false,
}
const unsafeParse = safeParseIntentJson(unsafeResult)
assert.equal(unsafeParse.ok, false)

console.log('intent parse checks passed')
