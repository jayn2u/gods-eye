import { errorMessage } from './search'
import type {
  BenchmarkQueriesResponse,
  BenchmarkResponse,
  BenchmarkSearchResponse,
  ModelCatalogResponse,
  ModelId,
  Readiness,
  SearchResponse,
} from './types'

export class SearchApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SearchApiError'
    this.status = status
  }
}

export async function fetchReadiness(): Promise<Readiness> {
  const response = await fetch('/api/readiness')
  if (!response.ok) throw new Error('The search service is unavailable.')
  return response.json()
}

export async function fetchModels(): Promise<ModelCatalogResponse> {
  const response = await fetch('/api/models')
  if (!response.ok) throw new Error('The model catalog is unavailable.')
  return response.json()
}

export async function fetchBenchmark(): Promise<BenchmarkResponse> {
  const response = await fetch('/api/benchmark')
  if (!response.ok) throw new Error('The benchmark is unavailable.')
  return response.json()
}

export async function fetchBenchmarkQueries(): Promise<BenchmarkQueriesResponse> {
  const response = await fetch('/api/benchmark/queries')
  if (!response.ok) throw new Error('The benchmark queries are unavailable.')
  return response.json()
}

export async function searchGallery(query: string, topK: number, datasets: readonly string[], modelId: ModelId, signal: AbortSignal): Promise<SearchResponse> {
  const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, top_k: topK, datasets, model_id: modelId }), signal })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new SearchApiError(response.status, errorMessage(response.status, body.detail))
  }
  return response.json()
}

export async function searchBenchmark(
  queryId: string,
  modelId: ModelId,
  topK: number,
  signal: AbortSignal,
): Promise<BenchmarkSearchResponse> {
  const response = await fetch('/api/benchmark/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_id: queryId, model_id: modelId, top_k: topK }),
    signal,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new SearchApiError(response.status, errorMessage(response.status, body.detail))
  }
  return response.json()
}
