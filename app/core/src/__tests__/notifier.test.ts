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
})
