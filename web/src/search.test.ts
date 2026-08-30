import { describe, expect, it } from 'vitest'
import { errorMessage, nextVisibleCount, validateSearch } from './search'

describe('search validation', () => {
  it('rejects blank queries without rewriting the input', () => {
    const input = '   '
    expect(validateSearch(input, ['CUHK-PEDES'], 24)).toBe('Enter a description to search')
    expect(input).toBe('   ')
  })

  it('requires a dataset and bounded top-k', () => {
    expect(validateSearch('blue coat', [], 24)).toBe('Select at least one dataset')
    expect(validateSearch('blue coat', ['CUHK-PEDES'], 100)).toBe('Choose 12, 24, or 48 results')
    expect(validateSearch('blue coat', ['CUHK-PEDES'], 24)).toBe('')
  })

  it('reveals results in groups of 24 without exceeding the total', () => {
    expect(nextVisibleCount(24, 80)).toBe(48)
    expect(nextVisibleCount(72, 80)).toBe(80)
  })

  it('turns status codes into recovery-oriented messages', () => {
    expect(errorMessage(503)).toContain('index is not ready')
    expect(errorMessage(500)).toContain('settings have been preserved')
  })
})
