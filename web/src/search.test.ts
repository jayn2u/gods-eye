import { describe, expect, it } from 'vitest'
import { validateSearch } from './search'

describe('search validation', () => {
  it('rejects blank queries without rewriting the input', () => {
    const input = '   '
    expect(validateSearch(input, ['CUHK-PEDES'], 24)).toBe('Enter a description to search')
    expect(input).toBe('   ')
  })

  it('requires a dataset and bounded top-k', () => {
    expect(validateSearch('blue coat', [], 24)).toBe('Select at least one dataset')
    expect(validateSearch('blue coat', ['CUHK-PEDES'], 101)).toBe('Choose between 1 and 100 results')
    expect(validateSearch('blue coat', ['CUHK-PEDES'], 24)).toBe('')
  })
})

