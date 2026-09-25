export const GALLERIES = ['CUHK-PEDES'] as const
export const WORKFLOW_STEPS = ['Compose', 'Search progress', 'Results', 'Image detail'] as const
export const MODEL_IDS = [
  'openai/clip-vit-base-patch32',
  'openai/clip-vit-base-patch16',
  'openai/clip-vit-large-patch14',
  'openai/clip-vit-large-patch14-336',
] as const

export type ModelId = string

export type SearchResult = { rank: number; similarity: number; dataset: string; id: string; split: string; image_url: string }
export type Readiness = { ready: boolean; guidance?: string }
export type ModelGroup = 'reference' | 'baseline' | 'fine-tuned'
export type ModelAvailability = {
  readonly model_id: ModelId
  readonly label: string
  readonly ready: boolean
  readonly active_index_version: string | null
  readonly gallery_count: number | null
  readonly guidance: string | null
  readonly group: ModelGroup
  readonly paired_baseline_id: ModelId | null
  readonly verified: boolean
  readonly registered_at: string | null
  readonly evaluation_ready: boolean
}
export type ModelCatalogResponse = {
  readonly default_model_id: ModelId
  readonly models: readonly ModelAvailability[]
}
export type SearchResponse = {
  readonly query: string
  readonly model_id: ModelId
  readonly active_index_version: string
  readonly results: readonly SearchResult[]
}

export type BenchmarkMetrics = {
  readonly top1: number
  readonly top5: number
  readonly top10: number
  readonly mAP: number
  readonly mINP: number
}

export type BenchmarkReference = {
  readonly source: string
  readonly metrics: BenchmarkMetrics
  readonly gallery: number
  readonly queries: number
  readonly delta_top1_pp: number
  readonly warning: boolean
}

export type ModelBenchmark = {
  readonly model_id: ModelId
  readonly label: string
  readonly group: ModelGroup
  readonly paired_baseline_id: ModelId | null
  readonly verified: boolean
  readonly index_version: string | null
  readonly metrics: BenchmarkMetrics | null
  readonly delta_vs_baseline_pp: BenchmarkMetrics | null
  readonly reference: BenchmarkReference | null
  readonly provenance: Readonly<Record<string, string | number | boolean | null>> | null
  readonly benchmark_query_ranks: Readonly<Record<string, number>>
}

export type BenchmarkProtocol = {
  readonly dataset: string
  readonly split: string
  readonly direction: string
  readonly ground_truth: string
  readonly query_count: number | null
  readonly gallery_count: number | null
}

export type BenchmarkResponse = {
  readonly protocol: BenchmarkProtocol
  readonly models: readonly ModelBenchmark[]
}

export type BenchmarkQuery = {
  readonly id: string
  readonly caption: string
}

export type BenchmarkQueriesResponse = {
  readonly queries: readonly BenchmarkQuery[]
}

export type BenchmarkSearchResult = SearchResult & { readonly is_match: boolean }

export type BenchmarkSearchResponse = {
  readonly query_id: string
  readonly caption: string
  readonly model_id: ModelId
  readonly active_index_version: string
  readonly first_match_rank: number
  readonly results: readonly BenchmarkSearchResult[]
}
