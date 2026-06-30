import type { IntentParseResult } from './types.ts'

export type IntentTemplateId = 'baby-sleep' | 'movie-cool' | 'post-cooking-purge'

export type IntentTemplate = {
  id: IntentTemplateId
  title: string
  description: string
  sourceText: string
  parseResult: IntentParseResult
}

export const intentTemplates: IntentTemplate[] = [
  {
    id: 'baby-sleep',
    title: 'Baby sleep',
    description: 'Keep the crib out of direct draft and reduce device noise.',
    sourceText: 'Baby sleep: after 20:00, keep the sleeping baby out of direct draft and make the room quieter',
    parseResult: {
      intents: [
        {
          id: 'template-baby-sleep-draft',
          sourceText: 'Baby sleep: after 20:00, keep the sleeping baby out of direct draft and make the room quieter',
          target: { type: 'zone', zoneId: 'sleepingBabyArea' },
          metric: 'airflow',
          direction: 'keep',
          magnitude: 'much',
          constraints: [
            { type: 'avoid-zone', zoneId: 'sleepingBabyArea', metric: 'airflow' },
            { type: 'max-noise', level: 'quiet' },
          ],
          priority: 'critical',
          confidence: 0.92,
          timeCondition: { type: 'at-clock', hour: 20, minute: 0, label: '20:00' },
        },
      ],
      unresolvedReferences: [],
      needsSketch: false,
    },
  },
  {
    id: 'movie-cool',
    title: 'Movie cooling',
    description: 'Cool the seated viewer while avoiding draft at the crib.',
    sourceText: 'Movie cooling: make the seated person cooler after 5 minutes, but avoid direct draft on the sleeping baby',
    parseResult: {
      intents: [
        {
          id: 'template-movie-cool-sofa',
          sourceText: 'Movie cooling: make the seated person cooler after 5 minutes, but avoid direct draft on the sleeping baby',
          target: { type: 'zone', zoneId: 'seatedPersonArea' },
          metric: 'temp',
          direction: 'down',
          magnitude: 'moderate',
          constraints: [{ type: 'avoid-zone', zoneId: 'sleepingBabyArea', metric: 'airflow' }],
          priority: 'high',
          confidence: 0.9,
          timeCondition: { type: 'after', minutes: 5, label: 'after 5 min' },
        },
        {
          id: 'template-movie-cool-crib',
          sourceText: 'Movie cooling: make the seated person cooler after 5 minutes, but avoid direct draft on the sleeping baby',
          target: { type: 'zone', zoneId: 'sleepingBabyArea' },
          metric: 'airflow',
          direction: 'keep',
          magnitude: 'much',
          constraints: [{ type: 'avoid-zone', zoneId: 'sleepingBabyArea', metric: 'airflow' }],
          priority: 'high',
          confidence: 0.9,
        },
      ],
      unresolvedReferences: [],
      needsSketch: false,
    },
  },
  {
    id: 'post-cooking-purge',
    title: 'Post-cooking purge',
    description: 'Prioritize CO2 and PM2.5 reduction to clear stale air quickly.',
    sourceText: 'Post-cooking purge: reduce CO2 and PM2.5 with fast ventilation',
    parseResult: {
      intents: [
        {
          id: 'template-purge-co2',
          sourceText: 'Post-cooking purge: reduce CO2 and PM2.5 with fast ventilation',
          target: { type: 'zone', zoneId: 'centerArea' },
          metric: 'co2',
          direction: 'down',
          magnitude: 'much',
          constraints: [],
          priority: 'high',
          confidence: 0.88,
        },
        {
          id: 'template-purge-pm25',
          sourceText: 'Post-cooking purge: reduce CO2 and PM2.5 with fast ventilation',
          target: { type: 'zone', zoneId: 'tvArea' },
          metric: 'pm25',
          direction: 'down',
          magnitude: 'much',
          constraints: [],
          priority: 'normal',
          confidence: 0.82,
        },
      ],
      unresolvedReferences: [],
      needsSketch: false,
    },
  },
]

export function getIntentTemplate(id: IntentTemplateId) {
  return intentTemplates.find((template) => template.id === id) ?? null
}
