import { errorMessage } from './search'
import type { Readiness, SearchResult } from './types'

export async function fetchReadiness(): Promise<Readiness> {
  const response = await fetch('/api/readiness')
  if (!response.ok) throw new Error('The search service is unavailable.')
  return response.json()
}

export async function searchGallery(query: string, topK: number, datasets: string[], signal: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, top_k: topK, datasets }), signal })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(errorMessage(response.status, body.detail))
  }
  return (await response.json()).results
}
