import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchBenchmark,
  fetchBenchmarkQueries,
  fetchModels,
  searchBenchmark,
  searchGallery,
  SearchApiError,
} from './api'
import { errorMessage } from './search'

const catalog = {
  default_model_id: 'openai/clip-vit-base-patch16',
  models: [
    {
      model_id: 'openai/clip-vit-base-patch16',
      label: 'ViT-B/16',
      ready: true,
      active_index_version: 'fixture-b16-v1',
      gallery_count: 1,
      guidance: null,
      group: 'reference',
      paired_baseline_id: null,
      verified: true,
      registered_at: null,
      evaluation_ready: false,
    },
  ],
}

describe('model transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches the catalog when models are requested', async () => {
    // Given
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog)))
    vi.stubGlobal('fetch', request)

    // When
    const response = await fetchModels()

    // Then
    expect(request).toHaveBeenCalledWith('/api/models')
    expect(response).toEqual(catalog)
  })

  it('sends the selected model and retains response provenance when searching', async () => {
    // Given
    const responseBody = {
      query: 'blue coat',
      model_id: 'openai/clip-vit-large-patch14',
      active_index_version: 'fixture-l14-v1',
      results: [],
    }
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody)))
    vi.stubGlobal('fetch', request)

    // When
    const response = await searchGallery(
      'blue coat',
      12,
      ['CUHK-PEDES'],
      'openai/clip-vit-large-patch14',
      new AbortController().signal,
    )

    // Then
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      query: 'blue coat',
      top_k: 12,
      datasets: ['CUHK-PEDES'],
      model_id: 'openai/clip-vit-large-patch14',
    })
    expect(response).toEqual(responseBody)
  })
})

describe('benchmark transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches benchmark metrics and model provenance', async () => {
    const benchmark = {
      protocol: {
        dataset: 'CUHK-PEDES',
        split: 'test',
        direction: 'text-to-image',
        ground_truth: 'person-id',
        query_count: 3,
        gallery_count: 3,
      },
      models: [],
    }
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(benchmark)))
    vi.stubGlobal('fetch', request)

    await expect(fetchBenchmark()).resolves.toEqual(benchmark)
    expect(request).toHaveBeenCalledWith('/api/benchmark')
  })

  it('fetches only the benchmark query ids and captions', async () => {
    const queries = { queries: [{ id: 'bq_1', caption: 'A person in a blue coat' }] }
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(queries)))
    vi.stubGlobal('fetch', request)

    await expect(fetchBenchmarkQueries()).resolves.toEqual(queries)
    expect(request).toHaveBeenCalledWith('/api/benchmark/queries')
  })

  it('sends the selected benchmark query and model with the requested top-k', async () => {
    const responseBody = {
      query_id: 'bq_1',
      caption: 'A person in a blue coat',
      model_id: 'labclip:cuhk-pedes:0123456789ab',
      active_index_version: 'fixture-labclip-v1',
      first_match_rank: 1,
      results: [],
    }
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody)))
    vi.stubGlobal('fetch', request)
    const controller = new AbortController()

    await expect(searchBenchmark(
      'bq_1',
      'labclip:cuhk-pedes:0123456789ab',
      12,
      controller.signal,
    )).resolves.toEqual(responseBody)

    expect(request).toHaveBeenCalledWith('/api/benchmark/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_id: 'bq_1',
        model_id: 'labclip:cuhk-pedes:0123456789ab',
        top_k: 12,
      }),
      signal: controller.signal,
    })
  })

  it('maps benchmark search errors through the shared search message', async () => {
    const detail = 'Benchmark Query not found.'
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail }), { status: 404 }))
    vi.stubGlobal('fetch', request)

    await expect(searchBenchmark(
      'missing-query',
      'labclip:cuhk-pedes:0123456789ab',
      12,
      new AbortController().signal,
    )).rejects.toMatchObject({
      name: 'SearchApiError',
      status: 404,
      message: errorMessage(404, detail),
    } satisfies Partial<SearchApiError>)
  })
})
