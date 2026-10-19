import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTelegramNotifier } from '../services/notifier'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createTelegramNotifier', () => {
  it('is a silent no-op when env vars are missing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const notifier = createTelegramNotifier({})
    await expect(notifier('hello')).resolves.toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts the message to the Telegram bot API when configured', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchSpy)

    const notifier = createTelegramNotifier({
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '42',
    })
    await notifier('trade opened')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage')
    const body = JSON.parse(String(init?.body))
    expect(body.chat_id).toBe('42')
    expect(body.text).toBe('trade opened')
  })

  it('never rejects, even when the network call fails', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchSpy)

    const notifier = createTelegramNotifier({
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '42',
    })
    await expect(notifier('x')).resolves.toBeUndefined()
  })

  it('prefers window-saved settings over env values', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchSpy)

    const notifier = createTelegramNotifier(
      { TELEGRAM_BOT_TOKEN: 'env-bot', TELEGRAM_CHAT_ID: '11' },
      () => ({ botToken: 'saved-bot', chatId: '99' }),
    )
    await notifier('hello')

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.telegram.org/botsaved-bot/sendMessage')
    expect(JSON.parse(String(init?.body)).chat_id).toBe('99')
  })

  it('uses saved settings with no env values and falls through on blanks', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchSpy)

    // Saved-only config works without env values.
    await createTelegramNotifier({}, () => ({ botToken: 'saved-bot', chatId: '99' }))('a')
    // Blank saved fields fall through to env.
    await createTelegramNotifier(
      { TELEGRAM_BOT_TOKEN: 'env-bot', TELEGRAM_CHAT_ID: '11' },
      () => ({ botToken: '   ', chatId: null }),
    )('b')

    const urls = fetchSpy.mock.calls.map(([u]) => String(u))
    expect(urls).toEqual([
      'https://api.telegram.org/botsaved-bot/sendMessage',
      'https://api.telegram.org/botenv-bot/sendMessage',
    ])
  })

  it('falls back to env when the settings resolver throws', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchSpy)

    const notifier = createTelegramNotifier(
      { TELEGRAM_BOT_TOKEN: 'env-bot', TELEGRAM_CHAT_ID: '11' },
      () => {
        throw new Error('store closed')
      },
    )
    await notifier('hello')

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.telegram.org/botenv-bot/sendMessage')
  })
})
