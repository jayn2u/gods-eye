import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { validateSearch } from './search'

const DATASETS = ['CUHK-PEDES', 'ICFG-PEDES', 'RSTPReid'] as const
type Result = {rank:number; similarity:number; dataset:string; id:string; split:string; image_url:string}

function App() {
  const [query,setQuery]=React.useState('')
  const [datasets,setDatasets]=React.useState<string[]>([...DATASETS])
  const [topK,setTopK]=React.useState(24)
  const [results,setResults]=React.useState<Result[]>([])
  const [error,setError]=React.useState('')
  const [loading,setLoading]=React.useState(false)
  const [ready,setReady]=React.useState<boolean|null>(null)
  const [guidance,setGuidance]=React.useState('')
  React.useEffect(()=>{ fetch('/api/readiness').then(async response=>{
    if(!response.ok) throw new Error()
    const state=await response.json(); setReady(state.ready); setGuidance(state.guidance||'')
  }).catch(()=>{setReady(false);setGuidance('The search service is unavailable. Check that the API is running.')}) },[])
  function toggle(dataset:string) { setDatasets(current => current.includes(dataset) ? current.filter(x=>x!==dataset) : [...current,dataset]) }
  async function submit(event:React.FormEvent) {
    event.preventDefault(); setError('')
    const validationError = validateSearch(query, datasets, topK)
    if (validationError) { setError(validationError); return }
    setLoading(true)
    try {
      const response=await fetch('/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,top_k:topK,datasets})})
      if(!response.ok) throw new Error('Search could not be completed')
      setResults((await response.json()).results)
    } catch (e) { setError(e instanceof Error ? e.message : 'Search could not be completed') }
    finally { setLoading(false) }
  }
  return <main>
    <header><p className="eyebrow">TEXT-TO-IMAGE PERSON RETRIEVAL</p><h1>God’s Eye</h1><p>Describe a person in English to search the research gallery.</p></header>
    <form onSubmit={submit} noValidate>
      <label htmlFor="query">Person description</label>
      <textarea id="query" value={query} onChange={e=>setQuery(e.target.value)} aria-describedby="query-help error" placeholder="e.g. A person wearing a blue coat and carrying a black bag" />
      <small id="query-help">Use visible clothing, colors, and carried objects.</small>
      <fieldset><legend>Datasets</legend>{DATASETS.map(d=><label className="check" key={d}><input type="checkbox" checked={datasets.includes(d)} onChange={()=>toggle(d)}/>{d}</label>)}</fieldset>
      <label htmlFor="top-k">Results</label><select id="top-k" value={topK} onChange={e=>setTopK(Number(e.target.value))}><option>12</option><option>24</option><option>48</option><option>100</option></select>
      {ready===false&&<aside role="status"><strong>Search index unavailable.</strong><p>{guidance}</p></aside>}
      <p id="error" role="alert">{error}</p><button disabled={loading||ready!==true}>{loading?'Searching…':'Search gallery'}</button>
    </form>
    <section aria-live="polite" aria-label="Search results" className="grid">{results.map(r=><article key={r.id}><img src={r.image_url} alt={`Rank ${r.rank} fixture result`}/><div><strong>#{r.rank}</strong><span>Similarity {r.similarity.toFixed(3)}</span></div><p>{r.dataset} · {r.split}</p><code>{r.id}</code></article>)}</section>
  </main>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
