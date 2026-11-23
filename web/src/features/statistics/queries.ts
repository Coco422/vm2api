import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import type {
  LeaderboardData,
  LeaderboardScope,
  StatisticsData,
  StatsDimension,
  StatsRange,
} from '@/types/panel-statistics'
import type {
  ActiveSessionsData,
  UsageLogsOverview,
} from '@/types/panel-usage-logs'
import { api } from '@/lib/api'

const STATS_KEY = ['panel', 'statistics'] as const

export function usageOverviewQueryOptions(tz: string, global = false) {
  return queryOptions({
    queryKey: ['panel', 'usage-logs-overview', tz, global] as const,
    queryFn: () =>
      api<UsageLogsOverview>(
        `/api/panel/usage-logs/overview?tz=${encodeURIComponent(tz)}${global ? '&visibility=global' : ''}`
      ),
    refetchInterval: 15_000,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  })
}

export function statisticsQueryOptions(
  range: StatsRange,
  dimension: StatsDimension,
  tz: string,
  global = false
) {
  return queryOptions({
    queryKey: [...STATS_KEY, 'chart', range, dimension, tz, global] as const,
    queryFn: () => {
      const qs = new URLSearchParams({ range, dimension, tz })
      if (global) qs.set('visibility', 'global')
      return api<StatisticsData>(`/api/panel/statistics?${qs.toString()}`)
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  })
}

export function leaderboardQueryOptions(
  range: StatsRange,
  scope: LeaderboardScope,
  limit: number,
  tz: string,
  global = false
) {
  return queryOptions({
    queryKey: [
      ...STATS_KEY,
      'leaderboard',
      range,
      scope,
      limit,
      tz,
      global,
    ] as const,
    queryFn: () => {
      const qs = new URLSearchParams({
        range,
        scope,
        limit: String(limit),
        tz,
      })
      if (global) qs.set('visibility', 'global')
      return api<LeaderboardData>(
        `/api/panel/statistics/leaderboard?${qs.toString()}`
      )
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  })
}

export function activeSessionsQueryOptions(minutes = 5, limit = 12) {
  return queryOptions({
    queryKey: ['panel', 'usage-logs-active-sessions', minutes, limit] as const,
    queryFn: () =>
      api<ActiveSessionsData>(
        `/api/panel/usage-logs/active-sessions?minutes=${minutes}&limit=${limit}`
      ),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  })
}
