import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  budgetWindowUsed,
  dayRequestsPath,
  EmployeeApiError,
  employeeRequest,
} from './api'

afterEach(() => vi.unstubAllGlobals())

describe('employee client isolation', () => {
  it('encodes the selected day and snapshot for request pagination without changing the HTTP method', async () => {
    const path = dayRequestsPath('2024-02-29', 2, '2024-02-29T10:00:00.000Z')
    const query = new URL(path, 'http://localhost').searchParams
    expect(query.get('day')).toBe('2024-02-29')
    expect(query.get('page')).toBe('2')
    expect(query.get('snapshot')).toBe('2024-02-29T10:00:00.000Z')
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: {} }),
    })
    vi.stubGlobal('fetch', fetch)
    await employeeRequest('local-key', path)
    expect(fetch).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ method: 'GET', credentials: 'omit' })
    )
  })
  it('sends Key only in header, omits cookies and caches, and never accepts another namespace', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { hello: true } }),
    })
    vi.stubGlobal('fetch', fetch)
    expect(await employeeRequest('local-key', '/api/company/me')).toEqual({
      hello: true,
    })
    expect(fetch).toHaveBeenCalledWith(
      '/api/company/me',
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        headers: { Authorization: 'Bearer local-key' },
      })
    )
    await expect(
      employeeRequest('local-key', 'https://external.invalid')
    ).rejects.toThrow('Invalid employee API route')
  })
  it('uses POST for actions with the same operation ID, no retry or configuration body', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: {} }),
    })
    vi.stubGlobal('fetch', fetch)
    await employeeRequest('local-key', '/api/company/vms/mine/reset-redeem', {
      operationId: 'operation-1',
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      '/api/company/vms/mine/reset-redeem',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({ 'Idempotency-Key': 'operation-1' }),
      })
    )
  })
  it('preserves revocation status and handles non-JSON maintenance responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: 'employee_access_denied', message: '已撤销' },
        }),
      })
    )
    await expect(
      employeeRequest('local-key', '/api/company/me')
    ).rejects.toMatchObject({ status: 403, code: 'employee_access_denied' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('HTML')
        },
      })
    )
    await expect(
      employeeRequest('local-key', '/api/company/me')
    ).rejects.toBeInstanceOf(EmployeeApiError)
  })
  it('does not show stale company window spend after the window expires', () => {
    const now = Date.now()
    expect(
      budgetWindowUsed(
        {
          window: '5h',
          limit_usd: 10,
          used_usd: 5,
          started_at: new Date(now - 6 * 3600_000).toISOString(),
        },
        now
      )
    ).toBe(0)
    expect(
      budgetWindowUsed(
        {
          window: '5h',
          limit_usd: 10,
          used_usd: 5,
          started_at: new Date(now - 3600_000).toISOString(),
        },
        now
      )
    ).toBe(5)
  })
})
