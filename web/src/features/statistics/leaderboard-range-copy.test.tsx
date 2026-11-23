import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LeaderboardSection } from './leaderboard-section'
import { leaderboardQueryOptions } from './queries'
import { STATS_RANGES } from './stats-format'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

function renderBoard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  for (const { id } of STATS_RANGES) {
    client.setQueryData(
      leaderboardQueryOptions(id, 'vm', 50, 'Asia/Shanghai').queryKey,
      { entries: [] }
    )
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LeaderboardSection
        scopes={['vm']}
        tz='Asia/Shanghai'
        scope='vm'
        onScopeChange={() => {}}
      />
    </QueryClientProvider>
  )
}

describe('leaderboard range wording', () => {
  it('renders inclusive statistics labels on the production board', () => {
    const html = renderBoard()
    expect(html).toContain('>近 7 天（含今天）<')
    expect(html).toContain('>近 30 天（含今天）<')
    expect(html).toContain('>今天<')
    expect(html).toContain('>本月<')
    expect(html).toContain('>今日暂无数据<')
    expect(html).not.toContain('>7天<')
    expect(html).not.toContain('>30天<')
    expect(html).toContain('class="mb-6 flex flex-wrap items-center gap-1"')
  })
})
