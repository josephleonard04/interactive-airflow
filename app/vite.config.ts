import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { handleLlmRoute } from './server/llmRoute.ts'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  process.env.OPENAI_API_KEY ||= env.OPENAI_API_KEY
  process.env.OPENAI_MODEL ||= env.OPENAI_MODEL
  process.env.ROOMDESIG_LLM_MOCK ||= env.ROOMDESIG_LLM_MOCK

  return {
    plugins: [
      react(),
      {
        name: 'roomdesig-llm-route',
        configureServer(server) {
          server.middlewares.use('/api/llm', (request, response) => {
            void handleLlmRoute(request, response)
          })
        },
      },
    ],
  }
})
