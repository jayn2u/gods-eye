import React from 'react'
import { createRoot } from 'react-dom/client'
import { fetchReadiness, searchGallery } from './api'
import { nextVisibleCount, validateSearch } from './search'
import { ComposeScreen, DetailScreen, ProgressScreen, ResultsScreen } from './screens'
import { useTheme } from './theme'
import { GALLERIES, WORKFLOW_STEPS, type SearchResult } from './types'
import './styles.css'

function App() {
  const [theme, chooseTheme] = useTheme()
  const [query, setQuery] = React.useState('')
  const [datasets, setDatasets] = React.useState<string[]>([...GALLERIES])
  const [topK, setTopK] = React.useState(24)
  const [results, setResults] = React.useState<SearchResult[]>([])
  const [visible, setVisible] = React.useState(24)
  const [error, setError] = React.useState('')
  const [ready, setReady] = React.useState<boolean | null>(null)
  const [guidance, setGuidance] = React.useState('')
  const [step, setStep] = React.useState(0)
  const [selectedIndex, setSelectedIndex] = React.useState<number | null>(null)
  const activeRequest = React.useRef<{ id: number; controller: AbortController } | null>(null)
  const requestSequence = React.useRef(0)
  const backButton = React.useRef<HTMLButtonElement>(null)

  async function checkReadiness() {
    try {
      const status = await fetchReadiness()
      setReady(status.ready)
      setGuidance(status.guidance || '')
    } catch {
      setReady(false)
      setGuidance('The search service is unavailable. Check that the API is running.')
    }
  }

  React.useEffect(() => {
    void checkReadiness()
    return () => activeRequest.current?.controller.abort()
  }, [])
  React.useEffect(() => { if (step === 3) backButton.current?.focus() }, [step])

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
    activeRequest.current?.controller.abort()
    const controller = new AbortController()
    const requestId = ++requestSequence.current
    activeRequest.current = { id: requestId, controller }
    setStep(1)
    try {
      const matches = await searchGallery(query, topK, datasets, controller.signal)
      if (requestId !== requestSequence.current) return
      setResults(matches)
      setVisible(24)
      setSelectedIndex(null)
      setStep(2)
    } catch (caught) {
      if (controller.signal.aborted || requestId !== requestSequence.current) return
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

  const detail = selectedIndex === null ? null : results[selectedIndex]
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  return <><div className="desktop-required" role="alert"><strong>Desktop display required</strong><span>Use a viewport at least 1200 pixels wide.</span></div><main className="shell">
    <header className="masthead"><div><p className="eyebrow">TEXT-TO-IMAGE PERSON RETRIEVAL</p><h1>God’s Eye</h1></div><div className="masthead-actions"><p>Search a research gallery using visible descriptions—not identity.</p><button type="button" className="theme-toggle" aria-label={`Switch to ${nextTheme} mode`} title={`Switch to ${nextTheme} mode`} onClick={() => chooseTheme(nextTheme)}><span className="theme-toggle-icon" aria-hidden="true">{theme === 'dark' ? '☼' : '☾'}</span><span>{nextTheme} mode</span></button></div></header>
    <nav aria-label="Search workflow"><ol className="steps">{WORKFLOW_STEPS.map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'complete' : ''} aria-current={index === step ? 'step' : undefined}><span>{String(index + 1).padStart(2, '0')}</span>{label}</li>)}</ol></nav>
    {step === 0 && <ComposeScreen
      query={query} datasets={datasets} topK={topK} ready={ready} guidance={guidance}
      error={error} onQuery={setQuery} onToggle={toggleDataset} onTopK={setTopK}
      onSubmit={submit} onReadiness={() => void checkReadiness()}
    />}
    {step === 1 && <ProgressScreen
      query={query}
      onCancel={cancelSearch}
    />}
    {step === 2 && <ResultsScreen
      query={query} results={results} visible={visible} onRefine={() => setStep(0)}
      onSelect={index => { setSelectedIndex(index); setStep(3) }}
      onMore={() => setVisible(current => nextVisibleCount(current, results.length))}
    />}
    {step === 3 && detail && selectedIndex !== null && <DetailScreen
      detail={detail} selectedIndex={selectedIndex} total={results.length}
      backRef={backButton} onClose={closeDetail} onMove={setSelectedIndex}
    />}
    <footer><strong>Research-only local demo.</strong> This system retrieves visually similar images; it does not identify people. Dataset images must not be redistributed.</footer>
  </main></>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
