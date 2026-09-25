import React from 'react'
import { formatDelta } from './compare'
import { BenchmarkChart } from './BenchmarkChart'
import type { BenchmarkResponse, ModelBenchmark } from './types'

function groupLabel(model: ModelBenchmark): string {
  if (model.group === 'fine-tuned') return 'Fine-tuned'
  if (model.group === 'baseline') return 'Paired baseline'
  return 'Reference (HF 224 center-crop)'
}

function metric(value: number | undefined): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

function provenanceValue(model: ModelBenchmark, key: string): string {
  const value = model.provenance?.[key]
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function ProvenanceCell({ model }: { model: ModelBenchmark }) {
  return <div className="benchmark-provenance">
    <span>W&B run: <code>{provenanceValue(model, 'wandb_run_id')}</code></span>
    <span>Epoch: {provenanceValue(model, 'epoch')}</span>
    <span>EMA: {provenanceValue(model, 'ema_enabled')}</span>
    {model.group === 'fine-tuned' && <span className={`verified-badge ${model.verified ? '' : 'unverified'}`} aria-label={model.verified ? 'Verified model' : 'Unverified model'}>
      {model.verified ? 'Verified' : 'Unverified'}
    </span>}
  </div>
}

export function BenchmarkScreen(props: {
  benchmark: BenchmarkResponse | null
  loading: boolean
  error: string
  selectedModelId: string | null
  onSelectedModel: (modelId: string) => void
}) {
  const models = props.benchmark?.models ?? []
  const fineTunedModels = models.filter(model => model.group === 'fine-tuned' && model.metrics !== null)
  const selectedFineTuned = fineTunedModels.find(model => model.model_id === props.selectedModelId)
    ?? fineTunedModels[0]
  const pairedBaseline = selectedFineTuned?.paired_baseline_id
    ? models.find(model => model.model_id === selectedFineTuned.paired_baseline_id)
    : undefined

  return <section className="benchmark-screen" aria-labelledby="benchmark-title">
    <div className="benchmark-heading">
      <div><p className="section-number">06 / BENCHMARK</p><h2 id="benchmark-title">Benchmark results</h2></div>
      <label className="select-label" htmlFor="benchmark-model">Fine-tuned model for chart
        <select
          id="benchmark-model"
          value={selectedFineTuned?.model_id ?? ''}
          disabled={fineTunedModels.length < 2}
          onChange={event => props.onSelectedModel(event.target.value)}
        >
          {fineTunedModels.map(model => <option key={model.model_id} value={model.model_id}>{model.label}</option>)}
        </select>
      </label>
    </div>
    <p className="benchmark-protocol">CUHK-PEDES test split · text→image · person-ID ground truth · computed from God&apos;s Eye&apos;s active index</p>
    {props.loading && <p className="benchmark-state" role="status">Loading benchmark results…</p>}
    {props.error && <aside className="notice" role="alert">{props.error}</aside>}
    {!props.loading && !props.error && !props.benchmark && <p className="benchmark-state">Benchmark results are not available.</p>}
    {props.benchmark && <>
      <div className="benchmark-table-wrap">
        <table className="benchmark-table">
          <caption>CUHK-PEDES test split retrieval metrics by model</caption>
          <colgroup>
            <col className="benchmark-col-model"/><col className="benchmark-col-group"/>
            <col/><col/><col/><col/><col/>
            <col className="benchmark-col-delta"/><col className="benchmark-col-reference"/>
            <col className="benchmark-col-provenance"/>
          </colgroup>
          <thead><tr>
            <th scope="col">Model</th><th scope="col">Group</th>
            <th scope="col">R@1</th><th scope="col">R@5</th><th scope="col">R@10</th>
            <th scope="col">mAP</th><th scope="col">mINP</th>
            <th scope="col">Δ R@1 vs paired baseline</th>
            <th scope="col">lab_clip ref (R@1, Δ)</th>
            <th scope="col">Provenance (W&amp;B run, epoch, EMA, verified)</th>
          </tr></thead>
          <tbody>{models.map(model => <tr key={model.model_id}>
            <th scope="row" className="benchmark-model-cell"><strong>{model.label}</strong><code>{model.model_id}</code></th>
            <td>{groupLabel(model)}</td>
            <td>{metric(model.metrics?.top1)}</td><td>{metric(model.metrics?.top5)}</td>
            <td>{metric(model.metrics?.top10)}</td><td>{metric(model.metrics?.mAP)}</td>
            <td>{metric(model.metrics?.mINP)}</td>
            <td>{model.delta_vs_baseline_pp
              ? formatDelta(model.delta_vs_baseline_pp.top1)
              : '—'}</td>
            <td>{model.reference ? <span className="reference-result">
              {metric(model.reference.metrics.top1)} ({formatDelta(model.reference.delta_top1_pp)})
              {model.reference.warning && <span className="reference-warning" title="Reference metrics differ by more than the expected tolerance" aria-label="Warning: lab_clip reference metrics differ by more than the expected tolerance"> ⚠</span>}
            </span> : '—'}</td>
            <td><ProvenanceCell model={model}/></td>
          </tr>)}</tbody>
        </table>
      </div>
      {selectedFineTuned?.metrics && pairedBaseline?.metrics && <section className="benchmark-chart-section" aria-labelledby="benchmark-chart-heading">
        <div className="chart-heading"><div><p className="section-number">MODEL COMPARISON</p><h3 id="benchmark-chart-heading">Recall and average precision</h3></div></div>
        <BenchmarkChart
          baselineLabel={pairedBaseline.label}
          baseline={pairedBaseline.metrics}
          fineTunedLabel={selectedFineTuned.label}
          fineTuned={selectedFineTuned.metrics}
        />
      </section>}
    </>}
  </section>
}
