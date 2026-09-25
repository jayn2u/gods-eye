import React from 'react'
import { outcome, outcomeCounts, type Outcome } from './compare'
import type {
  BenchmarkQuery,
  BenchmarkResponse,
  BenchmarkSearchResponse,
  ModelAvailability,
  ModelGroup,
  SearchResponse,
} from './types'

type QuerySource = 'text' | 'benchmark'
type QueryFilter = Outcome | 'all'
type Side = 'left' | 'right'
type SearchResultSet = SearchResponse | BenchmarkSearchResponse

export type ComparisonResults = { left: SearchResultSet; right: SearchResultSet }

const MODEL_GROUPS: readonly { group: ModelGroup; label: string }[] = [
  { group: 'fine-tuned', label: 'Fine-tuned' },
  { group: 'baseline', label: 'Paired baseline' },
  { group: 'reference', label: 'Reference (HF 224 center-crop)' },
]

const OUTCOMES: readonly { outcome: Outcome; label: string }[] = [
  { outcome: 'improved', label: 'Improved' },
  { outcome: 'same', label: 'Same' },
  { outcome: 'worse', label: 'Worse' },
]

function resultIsBenchmark(result: SearchResultSet): result is BenchmarkSearchResponse {
  return 'first_match_rank' in result
}

function groupName(group: ModelGroup): string {
  if (group === 'baseline') return 'Baseline'
  if (group === 'fine-tuned') return 'Fine-tuned'
  return 'Reference'
}

export function CompareScreen(props: {
  models: readonly ModelAvailability[]
  benchmark: BenchmarkResponse | null
  benchmarkLoading: boolean
  benchmarkError: string
  queries: readonly BenchmarkQuery[]
  leftModelId: string | null
  rightModelId: string | null
  source: QuerySource
  queryText: string
  selectedQueryId: string
  queryFilter: QueryFilter
  topK: number
  results: ComparisonResults | null
  comparing: boolean
  error: string
  onModel: (side: Side, modelId: string) => void
  onSource: (source: QuerySource) => void
  onQueryText: (query: string) => void
  onSelectedQuery: (queryId: string) => void
  onQueryFilter: (filter: QueryFilter) => void
  onTopK: (topK: number) => void
  onCompare: () => void
}) {
  const readyModels = props.models.filter(model => model.ready)
  const leftModel = readyModels.find(model => model.model_id === props.leftModelId) ?? null
  const rightModel = readyModels.find(model => model.model_id === props.rightModelId) ?? null
  const leftBenchmark = props.benchmark?.models.find(model => model.model_id === props.leftModelId)
  const rightBenchmark = props.benchmark?.models.find(model => model.model_id === props.rightModelId)
  const counts = outcomeCounts(
    { ...leftBenchmark?.benchmark_query_ranks },
    { ...rightBenchmark?.benchmark_query_ranks },
  )
  const allCount = counts.improved + counts.same + counts.worse
  const queryRanks = props.queries.map(query => ({
    query,
    status: leftBenchmark?.benchmark_query_ranks[query.id] !== undefined
      && rightBenchmark?.benchmark_query_ranks[query.id] !== undefined
      ? outcome(
        leftBenchmark.benchmark_query_ranks[query.id],
        rightBenchmark.benchmark_query_ranks[query.id],
      )
      : null,
  }))
  const visibleQueries = queryRanks.filter(item => (
    props.queryFilter === 'all' || item.status === props.queryFilter
  ))
  function chooseQueryFilter(filter: QueryFilter) {
    const nextQueries = queryRanks.filter(item => filter === 'all' || item.status === filter)
    if (!nextQueries.some(item => item.query.id === props.selectedQueryId)) {
      props.onSelectedQuery(nextQueries[0]?.query.id ?? '')
    }
    props.onQueryFilter(filter)
  }
  const canCompare = leftModel !== null
    && rightModel !== null
    && !props.comparing
    && (props.source === 'text' ? props.queryText.trim().length > 0 : props.selectedQueryId.length > 0)

  return <section className="panel compare-screen" aria-labelledby="compare-title">
    <p className="section-number">05 / COMPARE</p>
    <h2 id="compare-title">Compare model retrieval</h2>
    <p className="lede">Run the same query against two prepared models and compare visually similar results.</p>
    <div className="compare-controls">
      <label className="select-label" htmlFor="compare-left-model">Left model
        <select id="compare-left-model" value={props.leftModelId ?? ''} onChange={event => props.onModel('left', event.target.value)}>
          {MODEL_GROUPS.map(group => {
            const models = readyModels.filter(model => model.group === group.group)
            return models.length ? <optgroup key={group.group} label={group.label}>
              {models.map(model => <option key={model.model_id} value={model.model_id}>{model.label}</option>)}
            </optgroup> : null
          })}
        </select>
      </label>
      <label className="select-label" htmlFor="compare-right-model">Right model
        <select id="compare-right-model" value={props.rightModelId ?? ''} onChange={event => props.onModel('right', event.target.value)}>
          {MODEL_GROUPS.map(group => {
            const models = readyModels.filter(model => model.group === group.group)
            return models.length ? <optgroup key={group.group} label={group.label}>
              {models.map(model => <option key={model.model_id} value={model.model_id}>{model.label}</option>)}
            </optgroup> : null
          })}
        </select>
      </label>
      <label className="select-label" htmlFor="compare-top-k">Top results
        <select id="compare-top-k" value={props.topK} onChange={event => props.onTopK(Number(event.target.value))}>
          <option value={12}>12</option><option value={24}>24</option><option value={48}>48</option>
        </select>
      </label>
    </div>

    <fieldset className="query-source">
      <legend>Query source</legend>
      <div className="source-options">
        <label><input type="radio" name="query-source" value="text" checked={props.source === 'text'} onChange={() => props.onSource('text')}/><span>Free text</span></label>
        <label><input type="radio" name="query-source" value="benchmark" checked={props.source === 'benchmark'} onChange={() => props.onSource('benchmark')}/><span>Benchmark Query</span></label>
      </div>
    </fieldset>

    {props.source === 'text' ? <label className="compare-query-label" htmlFor="compare-query">Person description
      <textarea id="compare-query" value={props.queryText} onChange={event => props.onQueryText(event.target.value)} placeholder="A person wearing a blue coat and carrying a shoulder bag…"/>
    </label> : <div className="benchmark-query-picker">
      <p className="compare-query-label">Filter Benchmark Queries by outcome</p>
      {props.benchmarkLoading && !props.queries.length && <p className="benchmark-state" role="status">Loading Benchmark Queries…</p>}
      {props.benchmarkError && <aside className="notice" role="alert">{props.benchmarkError}</aside>}
      <div className="outcome-filters" role="group" aria-label="Filter benchmark queries">
        {OUTCOMES.map(item => <button
          key={item.outcome}
          type="button"
          className={`outcome-chip ${props.queryFilter === item.outcome ? 'selected' : ''}`}
          aria-pressed={props.queryFilter === item.outcome}
          onClick={() => chooseQueryFilter(item.outcome)}
        >{item.label} {counts[item.outcome]}</button>)}
        <button
          type="button"
          className={`outcome-chip ${props.queryFilter === 'all' ? 'selected' : ''}`}
          aria-pressed={props.queryFilter === 'all'}
          onClick={() => chooseQueryFilter('all')}
        >All {allCount}</button>
      </div>
      <label className="select-label" htmlFor="benchmark-query">Benchmark Query (CUHK-PEDES test caption)
        <select id="benchmark-query" value={props.selectedQueryId} onChange={event => props.onSelectedQuery(event.target.value)}>
          {visibleQueries.map(({ query }) => <option key={query.id} value={query.id}>{query.caption}</option>)}
        </select>
      </label>
    </div>}

    <div className="compare-actions">
      <button className="primary" disabled={!canCompare} onClick={props.onCompare}>
        {props.comparing ? 'Comparing…' : 'Run comparison'}
      </button>
      {props.source === 'benchmark' && <p className="caption-note">This is a dataset test caption; results show visual similarity, not identity.</p>}
    </div>
    {props.error && <aside className="notice" role="alert">{props.error}</aside>}
    {props.results && leftModel && rightModel && <ComparisonView
      results={props.results}
      leftModel={leftModel}
      rightModel={rightModel}
      benchmarkMode={props.source === 'benchmark'}
      query={props.source === 'benchmark'
        ? props.queries.find(item => item.id === props.selectedQueryId)?.caption ?? ''
        : props.queryText}
      topK={props.topK}
    />}
  </section>
}

function ComparisonView(props: {
  results: ComparisonResults
  leftModel: ModelAvailability
  rightModel: ModelAvailability
  benchmarkMode: boolean
  query: string
  topK: number
}) {
  const leftBenchmark = resultIsBenchmark(props.results.left) ? props.results.left : null
  const rightBenchmark = resultIsBenchmark(props.results.right) ? props.results.right : null
  const rankSummary = leftBenchmark && rightBenchmark
    ? `${groupName(props.leftModel.group)} #${leftBenchmark.first_match_rank} → ${groupName(props.rightModel.group)} #${rightBenchmark.first_match_rank}`
    : null

  return <section className="comparison-results" aria-label="Side-by-side comparison results">
    <div className="comparison-query">
      <p className="section-number">RESULTS FOR</p>
      <p>“{props.query}”</p>
      {rankSummary && <strong className="rank-summary">{rankSummary}</strong>}
    </div>
    <div className="comparison-columns">
      <ComparisonColumn
        model={props.leftModel}
        response={props.results.left}
        benchmarkMode={props.benchmarkMode}
        topK={props.topK}
      />
      <ComparisonColumn
        model={props.rightModel}
        response={props.results.right}
        benchmarkMode={props.benchmarkMode}
        topK={props.topK}
      />
    </div>
  </section>
}

function ComparisonColumn(props: {
  model: ModelAvailability
  response: SearchResultSet
  benchmarkMode: boolean
  topK: number
}) {
  const firstMatchRank = resultIsBenchmark(props.response) ? props.response.first_match_rank : null

  return <section className="comparison-column" aria-label={`${props.model.label} results`}>
    <header className="comparison-column-heading">
      <div><p className="section-number">{groupName(props.model.group).toUpperCase()}</p><h3>{props.model.label}</h3></div>
      {props.benchmarkMode && firstMatchRank !== null && <strong className="ground-truth-rank">Ground truth first appears at #{firstMatchRank}</strong>}
    </header>
    <div className="compare-grid">
      {props.response.results.slice(0, props.topK).map(result => {
        const isMatch = 'is_match' in result ? Boolean(result.is_match) : false
        return <article className="compare-card" key={result.id}>
          <div className="compare-image-wrap">
            <img src={result.image_url} alt={`Gallery result ranked ${result.rank}`} loading="lazy"/>
            {isMatch && <span className="match-badge">Match</span>}
          </div>
          <div className="compare-card-meta"><strong>#{result.rank}</strong><span>{result.similarity.toFixed(3)}</span></div>
          <p>{result.dataset}</p>
          <code>{result.id}</code>
        </article>
      })}
      {!props.response.results.length && <p className="compare-empty">No results were returned.</p>}
    </div>
  </section>
}
