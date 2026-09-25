import type { ModelAvailability } from './types'

export type Outcome = 'improved' | 'same' | 'worse'

const DEFAULT_HF_MODEL_ID = 'openai/clip-vit-base-patch16'

function registrationTime(model: ModelAvailability): number {
  const timestamp = Date.parse(model.registered_at ?? '')
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

export function outcome(baselineRank: number, candidateRank: number): Outcome {
  if (candidateRank < baselineRank) return 'improved'
  if (candidateRank > baselineRank) return 'worse'
  return 'same'
}

export function outcomeCounts(
  ranksA: Record<string, number>,
  ranksB: Record<string, number>,
): Record<Outcome, number> {
  const counts: Record<Outcome, number> = { improved: 0, same: 0, worse: 0 }
  for (const [id, baselineRank] of Object.entries(ranksA)) {
    const candidateRank = ranksB[id]
    if (candidateRank === undefined) continue
    counts[outcome(baselineRank, candidateRank)]++
  }
  return counts
}

export function defaultComparePair(
  models: readonly ModelAvailability[],
): { left: string | null; right: string | null } {
  const ready = models.filter(model => model.ready)
  const fineTuned = ready
    .filter(model => model.group === 'fine-tuned')
    .reduce<ModelAvailability | null>((newest, model) => {
      if (newest === null) return model
      const registeredAt = registrationTime(model)
      const newestRegisteredAt = registrationTime(newest)
      return registeredAt > newestRegisteredAt ? model : newest
    }, null)

  const pairedBaseline = fineTuned?.paired_baseline_id
    ? ready.find(model => model.model_id === fineTuned.paired_baseline_id)
    : undefined
  const baseline = pairedBaseline
    ?? ready.find(model => model.group === 'baseline')
    ?? ready.find(model => model.model_id === DEFAULT_HF_MODEL_ID)

  return { left: baseline?.model_id ?? null, right: fineTuned?.model_id ?? null }
}

export function formatDelta(pp: number): string {
  const rounded = Number(pp.toFixed(1))
  if (rounded === 0) return '±0.0 pp'
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded).toFixed(1)} pp`
}
