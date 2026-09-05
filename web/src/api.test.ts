import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchModels, searchGallery } from './api'

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
