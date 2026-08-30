export const MIN_TOP_K = 1
export const MAX_TOP_K = 100

export function validateSearch(query: string, datasets: string[], topK: number): string {
  if (!query.trim()) return 'Enter a description to search'
  if (!datasets.length) return 'Select at least one dataset'
  if (!Number.isInteger(topK) || topK < MIN_TOP_K || topK > MAX_TOP_K) return 'Choose between 1 and 100 results'
  return ''
}

