export const GALLERIES = ['CUHK-PEDES'] as const
export const WORKFLOW_STEPS = ['Compose', 'Search progress', 'Results', 'Image detail'] as const
export const MODEL_IDS = [
  'openai/clip-vit-base-patch32',
  'openai/clip-vit-base-patch16',
  'openai/clip-vit-large-patch14',
  'openai/clip-vit-large-patch14-336',
] as const

export type ModelId = typeof MODEL_IDS[number]

export type SearchResult = { rank: number; similarity: number; dataset: string; id: string; split: string; image_url: string }
export type Readiness = { ready: boolean; guidance?: string }
export type ModelAvailability = {
  readonly model_id: ModelId
  readonly label: string
  readonly ready: boolean
  readonly active_index_version: string | null
  readonly gallery_count: number | null
  readonly guidance: string | null
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
