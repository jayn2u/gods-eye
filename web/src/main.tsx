import React from 'react'
import { createRoot } from 'react-dom/client'
import {
  fetchBenchmark,
  fetchBenchmarkQueries,
  fetchModels,
  searchBenchmark,
  searchGallery,
  SearchApiError,
} from './api'
import { defaultComparePair, type Outcome } from './compare'
import { BenchmarkScreen } from './BenchmarkScreen'
import { CompareScreen, type ComparisonResults } from './CompareScreen'
import { nextVisibleCount, validateSearch } from './search'
import { ComposeScreen, DetailScreen, ProgressScreen, ResultsScreen } from './screens'
import { useTheme } from './theme'
import { GALLERIES, WORKFLOW_STEPS, type ModelAvailability, type ModelCatalogResponse, type ModelId, type SearchResponse } from './types'
import './styles.css'

type Mode = 'search' | 'compare' | 'benchmark'

const MODES: readonly Mode[] = ['search', 'compare', 'benchmark']
const MODE_STORAGE_KEY = 'gods-eye-mode'

function rememberedMode(): Mode {
  if (typeof window === 'undefined') return 'search'
  try {
    const value = window.localStorage.getItem(MODE_STORAGE_KEY)
    return value === 'compare' || value === 'benchmark' ? value : 'search'
  } catch {
    return 'search'
  }
}

function storeMode(mode: Mode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode)
  } catch {
    // Blocked storage should not prevent changing the active mode.
  }
}

function App() {
  const [theme, chooseTheme] = useTheme()
  const [mode, setMode] = React.useState<Mode>(() => rememberedMode())
  const [query, setQuery] = React.useState('')
  const [datasets, setDatasets] = React.useState<string[]>([...GALLERIES])
  const [topK, setTopK] = React.useState(24)
  const [response, setResponse] = React.useState<SearchResponse | null>(null)
  const [responseModelLabel, setResponseModelLabel] = React.useState('')
  const [visible, setVisible] = React.useState(24)
  const [error, setError] = React.useState('')
  const [catalog, setCatalog] = React.useState<ModelCatalogResponse | null>(null)
  const [selectedModelId, setSelectedModelId] = React.useState<ModelId>('openai/clip-vit-base-patch16')
  const [submittedModel, setSubmittedModel] = React.useState<ModelAvailability | null>(null)
  const [step, setStep] = React.useState(0)
  const [selectedIndex, setSelectedIndex] = React.useState<number | null>(null)
  const activeRequest = React.useRef<{ id: number; controller: AbortController } | null>(null)
  const requestSequence = React.useRef(0)
  const comparisonRequest = React.useRef<{ id: number; controller: AbortController } | null>(null)
  const comparisonSequence = React.useRef(0)
  const backButton = React.useRef<HTMLButtonElement>(null)
  const modeTabs = React.useRef<Record<Mode, HTMLButtonElement | null>>({
    search: null,
    compare: null,
    benchmark: null,
  })
  const [comparePair, setComparePair] = React.useState<{ left: string | null; right: string | null }>({ left: null, right: null })
  const [comparisonSource, setComparisonSource] = React.useState<'text' | 'benchmark'>('text')
  const [comparisonQueryText, setComparisonQueryText] = React.useState('')
  const [selectedBenchmarkQueryId, setSelectedBenchmarkQueryId] = React.useState('')
  const [queryFilter, setQueryFilter] = React.useState<Outcome | 'all'>('all')
  const [comparisonTopK, setComparisonTopK] = React.useState(12)
  const [comparisonResults, setComparisonResults] = React.useState<ComparisonResults | null>(null)
  const [comparisonLoading, setComparisonLoading] = React.useState(false)
  const [comparisonError, setComparisonError] = React.useState('')
  const [benchmark, setBenchmark] = React.useState<Awaited<ReturnType<typeof fetchBenchmark>> | null>(null)
  const [benchmarkQueries, setBenchmarkQueries] = React.useState<Awaited<ReturnType<typeof fetchBenchmarkQueries>>['queries']>([])
  const [benchmarkLoading, setBenchmarkLoading] = React.useState(false)
  const [benchmarkError, setBenchmarkError] = React.useState('')
  const [selectedBenchmarkModelId, setSelectedBenchmarkModelId] = React.useState<string | null>(null)

  async function checkModels(onCatalogError?: (message: string) => void): Promise<string | null> {
    try {
      const nextCatalog = await fetchModels()
      setCatalog(nextCatalog)
      const searchModels = nextCatalog.models.filter(model => model.group === 'reference')
      setSelectedModelId(current => {
        if (searchModels.some(model => model.model_id === current && model.ready)) return current
        const defaultModel = searchModels.find(model => model.model_id === nextCatalog.default_model_id && model.ready)
        return defaultModel?.model_id ?? searchModels.find(model => model.ready)?.model_id ?? nextCatalog.default_model_id
      })
      return null
    } catch (caught) {
      setCatalog(null)
      const message = caught instanceof Error ? caught.message : 'The model catalog is unavailable.'
      if (onCatalogError) onCatalogError(message)
      else setError(message)
      return message
    }
  }

  React.useEffect(() => {
    void checkModels()
    return () => {
      activeRequest.current?.controller.abort()
      comparisonRequest.current?.controller.abort()
    }
  }, [])
  React.useEffect(() => { if (step === 3) backButton.current?.focus() }, [step])
  React.useEffect(() => {
    if (!catalog) return
    setComparePair(current => current.left || current.right
      ? current
      : defaultComparePair(catalog.models))
  }, [catalog])
  React.useEffect(() => {
    if (mode === 'search') return
    let current = true
    setBenchmarkLoading(true)
    setBenchmarkError('')
    Promise.all([fetchBenchmark(), fetchBenchmarkQueries()]).then(([nextBenchmark, nextQueries]) => {
      if (!current) return
      setBenchmark(nextBenchmark)
      setBenchmarkQueries(nextQueries.queries)
      setSelectedBenchmarkQueryId(value => nextQueries.queries.some(item => item.id === value)
        ? value
        : nextQueries.queries[0]?.id ?? '')
      setSelectedBenchmarkModelId(value => value
        ?? nextBenchmark.models.find(model => model.group === 'fine-tuned')?.model_id
        ?? null)
    }).catch(caught => {
      if (!current) return
      setBenchmarkError(caught instanceof Error ? caught.message : 'Benchmark data is unavailable.')
    }).finally(() => {
      if (current) setBenchmarkLoading(false)
    })
    return () => { current = false }
  }, [mode])

  function cancelComparison() {
    comparisonRequest.current?.controller.abort()
    comparisonRequest.current = null
    comparisonSequence.current++
    setComparisonLoading(false)
    setComparisonResults(null)
  }

  function changeMode(nextMode: Mode) {
    if (nextMode === mode) return
    cancelComparison()
    setComparisonError('')
    setMode(nextMode)
    storeMode(nextMode)
  }

  function handleModeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const currentIndex = MODES.indexOf(mode)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % MODES.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + MODES.length) % MODES.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = MODES.length - 1
    else return
    event.preventDefault()
    const nextMode = MODES[nextIndex]
    changeMode(nextMode)
    modeTabs.current[nextMode]?.focus()
  }

  function updateCompareModel(side: 'left' | 'right', modelId: string) {
    cancelComparison()
    setComparePair(current => ({ ...current, [side]: modelId }))
  }

  function updateComparisonSource(source: 'text' | 'benchmark') {
    cancelComparison()
    setComparisonError('')
    setComparisonSource(source)
  }

  function updateComparisonQueryText(value: string) {
    cancelComparison()
    setComparisonQueryText(value)
  }

  function updateBenchmarkQuery(value: string) {
    cancelComparison()
    setSelectedBenchmarkQueryId(value)
  }

  function updateQueryFilter(value: Outcome | 'all') {
    cancelComparison()
    setQueryFilter(value)
  }

  function updateComparisonTopK(value: number) {
    cancelComparison()
    setComparisonTopK(value)
  }

  async function runComparison(queryIdOverride?: string) {
    const leftModel = catalog?.models.find(model => model.model_id === comparePair.left && model.ready)
    const rightModel = catalog?.models.find(model => model.model_id === comparePair.right && model.ready)
    const requestedQueryId = queryIdOverride ?? selectedBenchmarkQueryId
    const selectedQuery = benchmarkQueries.find(item => item.id === requestedQueryId)
    const textQuery = comparisonQueryText.trim()
    if (!leftModel || !rightModel) {
      setComparisonError('Choose two prepared models to compare.')
      return
    }
    if (comparisonSource === 'text' && !textQuery) {
      setComparisonError('Enter a description to compare.')
      return
    }
    if (comparisonSource === 'benchmark' && !selectedQuery) {
      setComparisonError('Choose a Benchmark Query to compare.')
      return
    }

    comparisonRequest.current?.controller.abort()
    const controller = new AbortController()
    const requestId = ++comparisonSequence.current
    comparisonRequest.current = { id: requestId, controller }
    setComparisonLoading(true)
    setComparisonError('')
    setComparisonResults(null)
    try {
      const responses = comparisonSource === 'benchmark' && selectedQuery
        ? await Promise.all([
          searchBenchmark(selectedQuery.id, leftModel.model_id, comparisonTopK, controller.signal),
          searchBenchmark(selectedQuery.id, rightModel.model_id, comparisonTopK, controller.signal),
        ])
        : await Promise.all([
          searchGallery(textQuery, comparisonTopK, [...GALLERIES], leftModel.model_id, controller.signal),
          searchGallery(textQuery, comparisonTopK, [...GALLERIES], rightModel.model_id, controller.signal),
        ])
      if (requestId !== comparisonSequence.current) return
      setComparisonResults({ left: responses[0], right: responses[1] })
    } catch (caught) {
      if (controller.signal.aborted || requestId !== comparisonSequence.current) return
      controller.abort()
      let refreshError: string | null = null
      if (caught instanceof SearchApiError && caught.status === 409) {
        refreshError = await checkModels(message => { refreshError = message })
      }
      if (requestId === comparisonSequence.current) {
        setComparisonError(refreshError ?? (caught instanceof Error ? caught.message : 'Comparison could not be completed.'))
      }
    } finally {
      if (requestId === comparisonSequence.current) {
        setComparisonLoading(false)
        comparisonRequest.current = null
      }
    }
  }

  function toggleDataset(dataset: string) {
    setDatasets(current => current.includes(dataset)
      ? current.filter(item => item !== dataset)
      : [...current, dataset])
  }

  async function submit(event?: React.FormEvent) {
    event?.preventDefault()
    setError('')
    const invalid = validateSearch(query, datasets, topK)
    if (invalid) { setError(invalid); setStep(0); return }
    const model = catalog?.models.find(entry => entry.model_id === selectedModelId)
    if (!model?.ready) { setError(model?.guidance ?? 'Choose a prepared model.'); setStep(0); return }
    activeRequest.current?.controller.abort()
    const controller = new AbortController()
    const requestId = ++requestSequence.current
    activeRequest.current = { id: requestId, controller }
    setSubmittedModel(model)
    setStep(1)
    try {
      const nextResponse = await searchGallery(query, topK, datasets, model.model_id, controller.signal)
      if (requestId !== requestSequence.current) return
      setResponse(nextResponse)
      setResponseModelLabel(catalog?.models.find(entry => entry.model_id === nextResponse.model_id)?.label ?? nextResponse.model_id)
      setVisible(24)
      setSelectedIndex(null)
      setStep(2)
    } catch (caught) {
      if (controller.signal.aborted || requestId !== requestSequence.current) return
      if (caught instanceof SearchApiError && caught.status === 409) await checkModels()
      setError(caught instanceof Error ? caught.message : 'Search could not be completed.')
      setStep(0)
    }
  }

  function cancelSearch() {
    activeRequest.current?.controller.abort()
    requestSequence.current++
    setStep(0)
  }

  function closeDetail() {
    setStep(2)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(
      `[data-card="${selectedIndex}"]`,
    )?.focus())
  }

  const searchModels = catalog?.models.filter(model => model.group === 'reference') ?? []
  const searchCatalog = catalog ? { ...catalog, models: searchModels } : null
  const selectedModel = searchModels.find(model => model.model_id === selectedModelId) ?? null
  const results = response?.results ?? []
  const detail = selectedIndex === null ? null : results[selectedIndex]
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  return <><div className="desktop-required" role="alert"><strong>Desktop display required</strong><span>Use a viewport at least 1200 pixels wide.</span></div><main className="shell">
    <header className="masthead">
      <div><p className="eyebrow">TEXT-TO-IMAGE PERSON RETRIEVAL</p><h1>God’s Eye</h1></div>
      <div className="mode-switch" role="tablist" aria-label="Demo mode" onKeyDown={handleModeKeyDown}>
        {MODES.map(tab => <button
          key={tab}
          ref={element => { modeTabs.current[tab] = element }}
          id={`mode-${tab}`}
          type="button"
          role="tab"
          aria-selected={mode === tab}
          aria-controls={`${tab}-panel`}
          tabIndex={mode === tab ? 0 : -1}
          onClick={() => changeMode(tab)}
        >{tab === 'search' ? 'Search' : tab === 'compare' ? 'Compare' : 'Benchmark'}</button>)}
      </div>
      <div className="masthead-actions"><p>Search a research gallery using visible descriptions—not identity.</p><button type="button" className="theme-toggle" aria-label={`Switch to ${nextTheme} mode`} title={`Switch to ${nextTheme} mode`} onClick={() => chooseTheme(nextTheme)}><span className="theme-toggle-icon" aria-hidden="true">{theme === 'dark' ? '☼' : '☾'}</span><span>{nextTheme} mode</span></button></div>
    </header>
    <div role="tabpanel" id="search-panel" aria-labelledby="mode-search" hidden={mode !== 'search'} tabIndex={0}>
      {mode === 'search' && <>
      <nav aria-label="Search workflow"><ol className="steps">{WORKFLOW_STEPS.map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'complete' : ''} aria-current={index === step ? 'step' : undefined}><span>{String(index + 1).padStart(2, '0')}</span>{label}</li>)}</ol></nav>
      {step === 0 && <ComposeScreen
        query={query} datasets={datasets} topK={topK} catalog={searchCatalog} selectedModelId={selectedModelId}
        selectedModel={selectedModel}
        error={error} onQuery={setQuery} onToggle={toggleDataset} onTopK={setTopK}
        onModel={value => { const model = catalog?.models.find(entry => entry.model_id === value); if (model) setSelectedModelId(model.model_id) }} onSubmit={submit} onModels={() => void checkModels()}
      />}
      {step === 1 && <ProgressScreen
        query={query} model={submittedModel}
        onCancel={cancelSearch}
      />}
      {step === 2 && response && <ResultsScreen
        response={response} modelLabel={responseModelLabel} visible={visible} onRefine={() => setStep(0)}
        onSelect={index => { setSelectedIndex(index); setStep(3) }}
        onMore={() => setVisible(current => nextVisibleCount(current, results.length))}
      />}
      {step === 3 && detail && response && selectedIndex !== null && <DetailScreen
        detail={detail} response={response} modelLabel={responseModelLabel} selectedIndex={selectedIndex} total={results.length}
        backRef={backButton} onClose={closeDetail} onMove={setSelectedIndex}
      />}
      </>}
    </div>
    <div role="tabpanel" id="compare-panel" aria-labelledby="mode-compare" hidden={mode !== 'compare'} tabIndex={0}>
      {mode === 'compare' && <>
      <CompareScreen
        models={catalog?.models ?? []}
        benchmark={benchmark}
        benchmarkLoading={benchmarkLoading}
        benchmarkError={benchmarkError}
        queries={benchmarkQueries}
        leftModelId={comparePair.left}
        rightModelId={comparePair.right}
        source={comparisonSource}
        queryText={comparisonQueryText}
        selectedQueryId={selectedBenchmarkQueryId}
        queryFilter={queryFilter}
        topK={comparisonTopK}
        results={comparisonResults}
        comparing={comparisonLoading}
        error={comparisonError}
        onModel={updateCompareModel}
        onSource={updateComparisonSource}
        onQueryText={updateComparisonQueryText}
        onSelectedQuery={updateBenchmarkQuery}
        onQueryFilter={updateQueryFilter}
        onTopK={updateComparisonTopK}
        onCompare={queryId => void runComparison(queryId)}
      />
      </>}
    </div>
    <div role="tabpanel" id="benchmark-panel" aria-labelledby="mode-benchmark" hidden={mode !== 'benchmark'} tabIndex={0}>
      {mode === 'benchmark' && <>
      <BenchmarkScreen
        benchmark={benchmark}
        loading={benchmarkLoading}
        error={benchmarkError}
        selectedModelId={selectedBenchmarkModelId}
        onSelectedModel={setSelectedBenchmarkModelId}
      />
      </>}
    </div>
    <footer><strong>Research-only local demo.</strong> This system retrieves visually similar images; it does not identify people. Dataset images must not be redistributed.</footer>
  </main></>
}

const root = document.getElementById('root')
if (root === null) throw new Error('Application root is missing.')
createRoot(root).render(<React.StrictMode><App/></React.StrictMode>)
