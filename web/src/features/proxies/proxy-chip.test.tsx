import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProxyChip } from './proxy-chip'

function markup(role: 'user' | 'admin', proxy: Vm['proxy'], compact = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  client.setQueryData(['panel', 'me'], { role })
  const vm = { id: 'vm-private', has_token: true, proxy } as Vm
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProxyChip vm={vm} compact={compact} />
    </QueryClientProvider>
  )
}

describe('tenant proxy service label', () => {
  it.each([false, true])(
    'stays neutral in compact=%s even when details are removed or unhealthy',
    (compact) => {
      const snapshots: Vm['proxy'][] = [
        undefined,
        { label: '独享代理' },
        {
          host: 'private.example',
          status: 'dead',
          latency_ms: 9999,
          blocked_reason: 'ipv6_disabled',
        },
      ]
      for (const proxy of snapshots) {
        const html = markup('user', proxy, compact)
        expect(html).toContain('独享代理')
        expect(html).not.toMatch(
          /缺代理|未测|private|9999|bg-red|text-red|role="button"/
        )
      }
    }
  )

  it('keeps actual missing-proxy warnings for administrators', () => {
    expect(markup('admin', undefined)).toContain('缺代理')
  })
})
