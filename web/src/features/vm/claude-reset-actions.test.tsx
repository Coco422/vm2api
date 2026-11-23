import type { ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { ActiveUsageAction } from './active-usage-action'
import { ClaudeResetActions } from './claude-reset-actions'

const mocks = vi.hoisted(() => ({
  mutations: [] as Array<{ mutationFn: (arg?: unknown) => Promise<unknown> }>,
  role: 'user',
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: {
    mutationFn: (arg?: unknown) => Promise<unknown>
  }) => {
    mocks.mutations.push(options)
    return { isPending: false, mutate: vi.fn(), variables: undefined }
  },
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/features/vm/vm-perms', async (importOriginal) => {
  const real = await importOriginal<typeof import('./vm-perms')>()
  return { ...real, useVmPerms: () => real.vmPermsFor(mocks.role) }
})
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: (props: { open: boolean; title: ReactNode }) =>
    props.open ? <div role='alertdialog'>{props.title}</div> : null,
}))

const snapshot = {
  eligible: true,
  available_count: 2,
  held_count: 2,
  fetched_at: '2026-11-13T07:00:00Z',
  credits: [
    {
      ref: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      kind: 'fable' as const,
      state: 'ready' as const,
      gives_back_weekly: true,
      resets_left: 1,
      expires_at: '2026-11-17T07:59:00Z',
      clears: ['five_hour', 'seven_day_overage_included'],
    },
    {
      ref: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      kind: 'full' as const,
      state: 'ready' as const,
      resets_left: 1,
      expires_at: '2026-12-10T22:00:00Z',
      clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
    },
    {
      ref: 'cccccccccccccccccccccccc',
      kind: 'weekly' as const,
      state: 'unavailable' as const,
      resets_left: 1,
      clears: ['seven_day'],
    },
  ],
}

const now = Date.parse('2026-11-13T07:26:00Z')

const vm = (over: Partial<Vm> = {}) =>
  ({ id: 'Niutopia262', claude_reset_credits: snapshot, ...over }) as Vm

beforeEach(() => {
  mocks.mutations = []
  mocks.role = 'user'
  vi.mocked(api).mockClear()
})

describe('ActiveUsageAction', () => {
  it('offers the tenant a fresh usage query without calling the redemption endpoint', async () => {
    const slot = vm({ has_token: true, credential_mode: 'oauth' })
    const html = renderToStaticMarkup(<ActiveUsageAction vm={slot} />)
    expect(html).toContain('主动查询')
    expect(html).toContain('不消耗重置卡')
    expect(html).not.toContain(' disabled=""')
    await mocks.mutations[0].mutationFn()
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/vms/Niutopia262/usage/query',
      { method: 'POST', signal: expect.any(AbortSignal) }
    )
    mocks.role = 'super'
    expect(renderToStaticMarkup(<ActiveUsageAction vm={slot} />)).toBe('')
  })
})

describe('ClaudeResetActions', () => {
  it('keeps the compact buttons and shows only the total', () => {
    const html = renderToStaticMarkup(
      <ClaudeResetActions vm={vm()} compact now={now} />
    )
    expect(html).toContain('限额查询 3')
    expect(html).toContain('限额重置')
    expect(html).not.toContain('Fable 卡')
    expect(
      renderToStaticMarkup(
        <ClaudeResetActions vm={vm({ claude_reset_credits: null })} compact />
      )
    ).not.toContain('限额查询 0')
  })

  it('lists each held card with its own use button on the detail page', () => {
    const html = renderToStaticMarkup(
      <ClaudeResetActions vm={vm()} now={now} />
    )
    expect(html).toContain('Fable 卡')
    expect(html).toContain('全量卡')
    expect(html).toContain('每周卡')
    expect(html).toContain('清 5 小时、Fable 周额度（7 天不清）')
    expect(html).toContain('清 5 小时、7 天、Fable 周额度')
    expect(html.match(/title="使用/g)?.length).toBe(3)
    expect(html).toMatch(/重置卡 <b[^>]*>3<\/b> 张/)
  })

  it('shows a temporarily unavailable full card even when no cards are redeemable', () => {
    const slot = vm({
      claude_reset_credits: {
        held_count: 0,
        available_count: 0,
        credits: [{ ...snapshot.credits[1], state: 'unavailable' }],
      },
    })
    const detail = renderToStaticMarkup(
      <ClaudeResetActions vm={slot} now={now} />
    )
    expect(detail).toMatch(/重置卡 <b[^>]*>1<\/b> 张/)
    expect(detail).toContain('全量卡')
    expect(detail).toContain('暂不可兑')
    expect(detail).toMatch(/<button[^>]*disabled=""[^>]*title="使用全量卡"/)
    const compact = renderToStaticMarkup(
      <ClaudeResetActions vm={slot} compact now={now} />
    )
    expect(compact).toContain('限额查询 1')
    expect(compact).not.toContain(' disabled=""')
  })

  it('asks for a refresh when the snapshot predates card refs', () => {
    const legacy = {
      available_count: 1,
      credits: [{ resets_left: 1, redeemable: true }],
    }
    const html = renderToStaticMarkup(
      <ClaudeResetActions vm={vm({ claude_reset_credits: legacy })} />
    )
    expect(html).toContain('点「限额查询」刷新后才能选卡')
    expect(html).not.toMatch(/title="使用/)
  })

  it('sends the chosen card when spending a reset', async () => {
    renderToStaticMarkup(<ClaudeResetActions vm={vm()} />)
    const redeem = mocks.mutations[1]
    await redeem.mutationFn(snapshot.credits[1])
    const [path, init] = vi.mocked(api).mock.calls[
      vi.mocked(api).mock.calls.length - 1
    ] as [string, RequestInit]
    expect(path).toBe('/api/panel/vms/Niutopia262/claude-reset/redeem')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      card: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    })
  })
})
