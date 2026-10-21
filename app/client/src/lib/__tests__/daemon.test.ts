import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { daemonApi, DAEMON_MODE, DAEMON_USER_ID } from '@/lib/daemon'

/** Obviously fake credentials — never put real secrets in test fixtures. */
const TEST_BOT_TOKEN = '123456789:TESTTOKEN_fake_for_unit_tests_only_0000'
const TEST_CHAT_ID = '123456789'

describe('daemon API client', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const okJson = (body: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    })

  const errJson = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status,
      json: () => Promise.resolve(body),
    })

  it('is inactive in non-daemon builds (tests run in vite test mode)', () => {
    expect(DAEMON_MODE).toBe(false)
  })

  it('requests status for the default bot user', async () => {
    okJson({ serverTime: 'x', snapshots: {}, userState: {}, paperTrades: [] })
    await daemonApi.status()
    const [path] = fetchMock.mock.calls[0] as [string]
    expect(path).toBe(`/api/bot/status?userId=${DAEMON_USER_ID}`)
  })

  it('posts start with the execution mode', async () => {
    okJson({ success: true })
    await daemonApi.start('live')
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/bot/start')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      userId: DAEMON_USER_ID,
      executionMode: 'live',
    })
  })

  it('posts stop, paper reset and config for the default user', async () => {
    okJson({})
    okJson({})
    okJson({})
    await daemonApi.stop()
    await daemonApi.resetPaper()
    await daemonApi.saveConfig({ strongThreshold: 15 } as never)

    const paths = fetchMock.mock.calls.map((c) => (c as [string])[0])
    expect(paths).toEqual([
      '/api/bot/stop',
      '/api/bot/paper-reset',
      '/api/bot/config',
    ])
    const configBody = JSON.parse(
      (fetchMock.mock.calls[2] as [string, RequestInit])[1].body as string,
    ) as { userId: string; config: { strongThreshold: number } }
    expect(configBody).toMatchObject({
      userId: DAEMON_USER_ID,
      config: { strongThreshold: 15 },
    })
  })

  it('posts exit with symbol and a default manual reason', async () => {
    okJson({ success: true })
    await daemonApi.exitPosition('NIFTY 50')
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/bot/trade/exit')
    expect(JSON.parse(init.body as string)).toEqual({
      userId: DAEMON_USER_ID,
      symbol: 'NIFTY 50',
      reason: 'Manual window exit',
    })
  })

  it('surfaces daemon error messages', async () => {
    errJson(400, { error: 'No open position for NIFTY 50' })
    await expect(daemonApi.exitPosition('NIFTY 50')).rejects.toThrow(
      'No open position for NIFTY 50',
    )
  })

  it('reads masked daemon settings and saves Upstox credentials', async () => {
    const masked = {
      upstox: {
        hasApiKey: true,
        apiKeyHint: 'abcd1234…',
        hasApiSecret: true,
        redirectUri: 'http://127.0.0.1:3000/auth/upstox/callback',
        hasMasterToken: false,
      },
    }
    okJson(masked)
    okJson({ success: true, ...masked })

    const view = await daemonApi.settings()
    expect(view.upstox.apiKeyHint).toBe('abcd1234…')

    await daemonApi.saveUpstoxSettings({
      apiKey: 'abcd1234efgh',
      apiSecret: 'shh',
      redirectUri: 'http://127.0.0.1:3000/auth/upstox/callback',
    })

    const [getPath] = fetchMock.mock.calls[0] as [string]
    expect(getPath).toBe('/api/daemon/settings')

    const [postPath, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(postPath).toBe('/api/daemon/settings/upstox')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      apiKey: 'abcd1234efgh',
      apiSecret: 'shh',
      redirectUri: 'http://127.0.0.1:3000/auth/upstox/callback',
    })
  })

  it('saves Telegram settings and sends test alerts through the daemon', async () => {
    okJson({
      success: true,
      telegram: {
        hasBotToken: true,
        botTokenHint: `${TEST_BOT_TOKEN.slice(0, 8)}…`,
        hasChatId: true,
        chatIdHint: `•••••${TEST_CHAT_ID.slice(-4)}`,
      },
    })
    okJson({ success: true })

    const saved = await daemonApi.saveTelegramSettings({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
    })
    expect(saved.telegram.botTokenHint).toBe(`${TEST_BOT_TOKEN.slice(0, 8)}…`)

    await daemonApi.testTelegram()

    const [savePath, saveInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(savePath).toBe('/api/daemon/settings/telegram')
    expect(saveInit.method).toBe('POST')
    expect(JSON.parse(saveInit.body as string)).toEqual({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
    })

    const [testPath, testInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ]
    expect(testPath).toBe('/api/daemon/settings/telegram/test')
    expect(testInit.method).toBe('POST')
  })

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    })
    await expect(daemonApi.status()).rejects.toThrow('daemon HTTP 500')
  })
})
