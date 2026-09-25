import { describe, expect, it } from 'vitest'
import { defaultComparePair, formatDelta, outcome, outcomeCounts } from './compare'
import type { ModelAvailability } from './types'

const model = (
  model_id: string,
  group: ModelAvailability['group'],
  overrides: Partial<ModelAvailability> = {},
): ModelAvailability => ({
  model_id,
  label: model_id,
  ready: true,
  active_index_version: 'fixture-v1',
  gallery_count: 3,
  guidance: null,
  group,
  paired_baseline_id: null,
  verified: true,
  registered_at: null,
  evaluation_ready: true,
  ...overrides,
})

describe('benchmark comparison helpers', () => {
  it('classifies a lower candidate rank as improved, equal as same, and higher as worse', () => {
    expect(outcome(37, 1)).toBe('improved')
    expect(outcome(4, 4)).toBe('same')
    expect(outcome(2, 9)).toBe('worse')
  })

  it('counts outcomes only for benchmark query ids present in both rank maps', () => {
    expect(outcomeCounts(
      { improved: 37, same: 4, worse: 2, baselineOnly: 8 },
      { improved: 1, same: 4, worse: 9, candidateOnly: 3 },
    )).toEqual({ improved: 1, same: 1, worse: 1 })
  })

  it('chooses the newest ready fine-tuned model and its ready paired baseline', () => {
    const models = [
      model('reference', 'reference'),
      model('baseline-old', 'baseline'),
      model('baseline-paired', 'baseline'),
      model('fine-tuned-old', 'fine-tuned', { registered_at: '2026-09-20T12:00:00Z' }),
      model('fine-tuned-new', 'fine-tuned', {
        registered_at: '2026-09-24T12:00:00Z',
        paired_baseline_id: 'baseline-paired',
      }),
    ]

    expect(defaultComparePair(models)).toEqual({ left: 'baseline-paired', right: 'fine-tuned-new' })
  })

  it('falls back from an unavailable paired baseline to the first ready baseline', () => {
    const models = [
      model('baseline-ready', 'baseline'),
      model('fine-tuned', 'fine-tuned', {
        paired_baseline_id: 'baseline-unready',
        registered_at: '2026-09-24T12:00:00Z',
      }),
      model('baseline-unready', 'baseline', { ready: false }),
    ]

    expect(defaultComparePair(models)).toEqual({ left: 'baseline-ready', right: 'fine-tuned' })
  })

  it('uses the default ready HF model when no ready baseline exists', () => {
    const models = [
      model('openai/clip-vit-base-patch16', 'reference'),
      model('fine-tuned', 'fine-tuned', { paired_baseline_id: 'baseline-unready' }),
      model('baseline-unready', 'baseline', { ready: false }),
    ]

    expect(defaultComparePair(models)).toEqual({
      left: 'openai/clip-vit-base-patch16',
      right: 'fine-tuned',
    })
  })

  it('uses a real minus sign and a plus sign, and formats zero as plus-minus zero', () => {
    expect(formatDelta(38.95)).toBe('+39.0 pp')
    expect(formatDelta(-1.24)).toBe('−1.2 pp')
    expect(formatDelta(-0.01)).toBe('±0.0 pp')
  })
})
