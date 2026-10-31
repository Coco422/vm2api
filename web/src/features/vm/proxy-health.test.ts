import { describe, expect, it } from 'vitest'
import { proxyHealthOf } from './proxy-health'

describe('tenant exit availability', () => {
  it('recognizes a configured private exit without needing its address or proxy ID', () => {
    const health = proxyHealthOf(
      { id: 'vm-03', has_token: true, proxy_configured: true },
      { status: 'ok', enabled: true, latency_ms: 50 }
    )
    expect(health.score).toBeGreaterThan(0)
    expect(health.tone.key).not.toBe('bad')
  })

  it('still reports a missing exit when no binding is configured', () => {
    expect(proxyHealthOf({ id: 'vm-03', has_token: true }, {}).score).toBe(0)
  })
})
