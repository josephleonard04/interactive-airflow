// Talks to the local OpenFOAM backend (see backend/). The backend writes the
// exported case to disk, runs the OpenFOAM pipeline, samples the field at the
// requested points, and returns the result. If OpenFOAM is not installed it
// returns a clearly-labelled mock so the two-engine UX is fully usable now.

import type { OpenFoamCase } from './exportCase.ts'
import { sampleGridPoints, OPENFOAM_GRID, type OpenFoamResult } from './result.ts'

const BASE_URL =
  (import.meta.env?.VITE_OPENFOAM_BACKEND as string | undefined)?.replace(/\/$/, '') ||
  'http://127.0.0.1:8000'

export interface BackendHealth {
  reachable: boolean
  openfoam: boolean
  version?: string
  message?: string
}

export async function checkBackendHealth(signal?: AbortSignal): Promise<BackendHealth> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal })
    if (!res.ok) return { reachable: true, openfoam: false, message: `Backend HTTP ${res.status}` }
    const data = (await res.json()) as { openfoam?: boolean; version?: string }
    return { reachable: true, openfoam: !!data.openfoam, version: data.version }
  } catch (err) {
    return {
      reachable: false,
      openfoam: false,
      message: err instanceof Error ? err.message : 'Backend unreachable',
    }
  }
}

export async function runOpenFoam(
  ofCase: OpenFoamCase,
  signal?: AbortSignal,
): Promise<OpenFoamResult> {
  const payload = {
    name: ofCase.name,
    files: ofCase.files,
    grid: OPENFOAM_GRID,
    points: sampleGridPoints(),
  }
  try {
    const res = await fetch(`${BASE_URL}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { status: 'error', message: `Backend HTTP ${res.status}`, log: text }
    }
    return (await res.json()) as OpenFoamResult
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { status: 'error', message: 'Run cancelled' }
    }
    return {
      status: 'error',
      message:
        (err instanceof Error ? err.message : 'Backend unreachable') +
        ' — is the local backend running? (see backend/README.md)',
    }
  }
}

export { BASE_URL as OPENFOAM_BACKEND_URL }
