export const GALLERIES = ['CUHK-PEDES'] as const
export const WORKFLOW_STEPS = ['Compose', 'Search progress', 'Results', 'Image detail'] as const

export type SearchResult = { rank: number; similarity: number; dataset: string; id: string; split: string; image_url: string }
export type Readiness = { ready: boolean; guidance?: string }
