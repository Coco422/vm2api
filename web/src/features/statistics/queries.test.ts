import { describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import {
  leaderboardQueryOptions,
  statisticsQueryOptions,
  usageOverviewQueryOptions,
} from './queries'

vi.mock('@/lib/api', () => ({ api: vi.fn(async () => ({})) }))

describe('statistics visibility', () => {
  it.each([
    ['overview', (global: boolean) => usageOverviewQueryOptions('UTC', global)],
    [
      'chart',
      (global: boolean) =>
        statisticsQueryOptions('today', 'model', 'UTC', global),
    ],
    [
      'leaderboard',
      (global: boolean) =>
        leaderboardQueryOptions('today', 'model', 3, 'UTC', global),
    ],
  ])(
    'isolates %s caches and opts into global aggregates explicitly',
    async (_name, options) => {
      const personal = options(false)
      const global = options(true)
      expect(personal.queryKey).not.toEqual(global.queryKey)
      // Query functions here do not use the QueryFunctionContext.
      await (personal.queryFn as () => Promise<unknown>)()
      expect(api).toHaveBeenLastCalledWith(
        expect.not.stringContaining('visibility=global')
      )
      await (global.queryFn as () => Promise<unknown>)()
      expect(api).toHaveBeenLastCalledWith(
        expect.stringContaining('visibility=global')
      )
    }
  )

  it('requests the global user leaderboard for the selected time range', async () => {
    const options = leaderboardQueryOptions('7days', 'user', 50, 'UTC', true)
    await (options.queryFn as () => Promise<unknown>)()
    expect(api).toHaveBeenLastCalledWith(
      '/api/panel/statistics/leaderboard?range=7days&scope=user&limit=50&tz=UTC&visibility=global'
    )
  })
})
