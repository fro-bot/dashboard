import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchListenerMessages, ackListenerMessage, ackAllListenerMessages } from './listener.ts'

describe('listener API', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('fetchListenerMessages', () => {
    it('returns messages on success', async () => {
      const mockData = {
        messages: [
          {
            id: '1',
            source: 'infra',
            kind: 'deploy-health',
            severity: 'warning',
            title: 'Test',
            body: 'body',
            createdAt: '2026-07-11T12:00:00Z',
            receivedAt: '2026-07-11T12:00:01Z',
            read: false,
            links: [{ label: 'View', url: 'https://example.com' }]
          }
        ],
        unreadCount: 1
      }

      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(mockData), { status: 200 }))

      const res = await fetchListenerMessages()
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.messages).toHaveLength(1)
        expect(res.data.unreadCount).toBe(1)
        expect(res.data.messages[0]?.title).toBe('Test')
      }
    })

    it('handles query parameters', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], unreadCount: 0 }), { status: 200 }))
      await fetchListenerMessages({ unreadOnly: true, limit: 50 })

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('unreadOnly=true'),
        expect.any(Object)
      )
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=50'),
        expect.any(Object)
      )
    })

    it('fails closed on contract drift (invalid root shape)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ bad: 'shape' }), { status: 200 }))
      const res = await fetchListenerMessages()
      expect(res).toEqual({ ok: false, reason: 'contract-drift' })
    })

    it('skips malformed items but keeps valid ones', async () => {
      const mockData = {
        messages: [
          { bad: 'item' },
          {
            id: '2',
            source: 'agent',
            kind: 'report',
            severity: 'info',
            title: 'Valid',
            body: 'body',
            createdAt: '2026-07-11T12:00:00Z',
            receivedAt: '2026-07-11T12:00:01Z',
            read: true,
            links: []
          }
        ],
        unreadCount: 0
      }

      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(mockData), { status: 200 }))
      const res = await fetchListenerMessages()
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.messages).toHaveLength(1)
        expect(res.data.messages[0]?.id).toBe('2')
      }
    })

    it('handles timeout/abort', async () => {
      const abortError = new DOMException('Aborted', 'AbortError')
      vi.mocked(fetch).mockRejectedValueOnce(abortError)
      const res = await fetchListenerMessages()
      expect(res).toEqual({ ok: false, reason: 'timeout' })
    })

    it('handles network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      const res = await fetchListenerMessages()
      expect(res).toEqual({ ok: false, reason: 'network' })
    })

    it('handles non-ok status', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('error', { status: 500 }))
      const res = await fetchListenerMessages()
      expect(res).toEqual({ ok: false, reason: 'network' })
    })
  })

  describe('ackListenerMessage', () => {
    it('returns true on 202', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 202 }))
      const res = await ackListenerMessage('test-id')
      expect(res).toBe(true)
      expect(fetch).toHaveBeenCalledWith('/api/listener/messages/test-id/ack', expect.objectContaining({ method: 'POST' }))
    })

    it('returns false on other statuses', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 404 }))
      const res = await ackListenerMessage('test-id')
      expect(res).toBe(false)
    })
  })

  describe('ackAllListenerMessages', () => {
    it('returns true on 202', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 202 }))
      const res = await ackAllListenerMessages()
      expect(res).toBe(true)
      expect(fetch).toHaveBeenCalledWith('/api/listener/ack-all', expect.objectContaining({ method: 'POST' }))
    })
  })
})