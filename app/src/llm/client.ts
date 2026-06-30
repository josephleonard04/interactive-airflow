export type LlmJsonRequest = {
  prompt: string
  system?: string
  schemaName?: string
  temperature?: number
}

export type LlmJsonResponse<T = unknown> = {
  json: T
  model: string
  mock: boolean
}

export async function callLLM<T = unknown>(request: LlmJsonRequest): Promise<LlmJsonResponse<T>> {
  const response = await fetch('/api/llm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `LLM request failed with ${response.status}`
    throw new Error(message)
  }

  return payload as LlmJsonResponse<T>
}
