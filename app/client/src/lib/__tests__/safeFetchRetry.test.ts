import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { safeFetch } from '../marketService'

describe('safeFetch 429 retry handling', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch as unknown)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retries once on 429 and succeeds on the second attempt', async () => {
    const mockData = { status: 'success', data: { value: 42 } }
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too Many Requests' }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    const [data, error] = await safeFetch<typeof mockData>('/api/test')
    expect(error).toBeNull()
    expect(data).toEqual(mockData)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns the error when the retry also gets 429', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
      }),
    )

    const [data, error] = await safeFetch('/api/test')
    expect(data).toBeNull()
    expect(error).toContain('429')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry on non-429 errors', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const [data, error] = await safeFetch('/api/test')
    expect(data).toBeNull()
    expect(error).toContain('401')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry on successful responses', async () => {
    const mockData = { ok: true }
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const [data, error] = await safeFetch<typeof mockData>('/api/test')
    expect(error).toBeNull()
    expect(data).toEqual(mockData)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('handles missing Retry-After header gracefully', async () => {
    const mockData = { success: true }
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too Many Requests' }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    const [data, error] = await safeFetch<typeof mockData>('/api/test')
    expect(error).toBeNull()
    expect(data).toEqual(mockData)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  }, 10000)
})
