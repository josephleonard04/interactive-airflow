import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { handleLlmRoute } from '../server/llmRoute.ts'

process.env.ROOMDESIG_LLM_MOCK = '1'

const response = await callRoute({
  prompt: 'Cool the sofa area slightly',
  schemaName: 'IntentParseResult',
})

assert.equal(response.statusCode, 200)
assert.equal(response.body.mock, true)
assert.equal(response.body.model, 'mock')
assert.equal(response.body.json.schemaName, 'IntentParseResult')

console.log('llm route checks passed')

function callRoute(payload: unknown) {
  return new Promise<{ statusCode: number; body: any }>((resolve) => {
    const request = Readable.from([JSON.stringify(payload)]) as any
    const chunks: string[] = []
    request.method = 'POST'
    request.headers = { 'content-type': 'application/json' }
    request.setEncoding = () => request

    const response = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk))
        callback()
      },
      final(callback) {
        resolve({
          statusCode: response.statusCode,
          body: JSON.parse(chunks.join('')),
        })
        callback()
      },
    }) as any

    response.statusCode = 200
    response.setHeader = () => response
    response.end = (chunk?: unknown) => {
      if (chunk !== undefined) {
        chunks.push(String(chunk))
      }
      resolve({
        statusCode: response.statusCode,
        body: JSON.parse(chunks.join('')),
      })
      return response
    }

    void handleLlmRoute(request, response)
  })
}
