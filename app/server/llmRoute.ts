import type { IncomingMessage, ServerResponse } from 'node:http'

type LlmRouteRequest = {
  prompt?: unknown
  system?: unknown
  schemaName?: unknown
  temperature?: unknown
}

export async function handleLlmRoute(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'Method not allowed' })
    return
  }

  try {
    const body = parseRequest(await readBody(request))
    const mockMode = process.env.ROOMDESIG_LLM_MOCK === '1'

    if (mockMode) {
      writeJson(response, 200, {
        json: {
          mock: true,
          schemaName: body.schemaName,
          text: body.prompt,
        },
        model: 'mock',
        mock: true,
      })
      return
    }

    const apiKey = process.env.OPENAI_API_KEY

    if (!apiKey) {
      writeJson(response, 503, { error: 'OPENAI_API_KEY is not configured on the local server.' })
      return
    }

    const model = process.env.OPENAI_MODEL || 'gpt-5.5'
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'system',
            content: body.system || 'Return only valid JSON. Do not include markdown.',
          },
          {
            role: 'user',
            content: body.prompt,
          },
        ],
        temperature: body.temperature,
        text: {
          format: {
            type: 'json_object',
          },
        },
      }),
    })

    const data = await upstream.json()

    if (!upstream.ok) {
      writeJson(response, upstream.status, {
        error: getErrorMessage(data),
      })
      return
    }

    const text = extractOutputText(data)
    const json = JSON.parse(text)

    writeJson(response, 200, {
      json,
      model,
      mock: false,
    })
  } catch (error) {
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : 'Invalid LLM request.',
    })
  }
}

function parseRequest(body: unknown) {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be a JSON object.')
  }

  const candidate = body as LlmRouteRequest

  if (typeof candidate.prompt !== 'string' || candidate.prompt.trim().length === 0) {
    throw new Error('prompt is required.')
  }

  if (candidate.system !== undefined && typeof candidate.system !== 'string') {
    throw new Error('system must be a string.')
  }

  if (candidate.schemaName !== undefined && typeof candidate.schemaName !== 'string') {
    throw new Error('schemaName must be a string.')
  }

  if (candidate.temperature !== undefined && typeof candidate.temperature !== 'number') {
    throw new Error('temperature must be a number.')
  }

  return {
    prompt: candidate.prompt,
    system: candidate.system,
    schemaName: candidate.schemaName,
    temperature: candidate.temperature,
  }
}

function extractOutputText(data: any): string {
  if (typeof data.output_text === 'string') {
    return data.output_text
  }

  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return content.text
      }
    }
  }

  throw new Error('LLM response did not include output text.')
}

function getErrorMessage(data: unknown) {
  if (data && typeof data === 'object' && 'error' in data) {
    const error = (data as { error?: unknown }).error

    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message

      if (typeof message === 'string') {
        return message
      }
    }
  }

  return 'OpenAI request failed.'
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''

    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      raw += chunk

      if (raw.length > 32_000) {
        reject(new Error('Request body is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        reject(new Error('Request body must be valid JSON.'))
      }
    })
    request.on('error', reject)
  })
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}
