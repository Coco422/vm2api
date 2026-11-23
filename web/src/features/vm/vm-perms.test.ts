import { describe, expect, it } from 'vitest'
import {
  pickBindTarget,
  visibleTab,
  vmDetailTabs,
  vmPermsFor,
} from './vm-perms'

describe('vmPermsFor follows panel-acl roles', () => {
  it('admin can do everything', () => {
    expect(vmPermsFor('admin')).toEqual({
      known: true,
      admin: true,
      dashboard: true,
      power: true,
      test: true,
      testModels: true,
      usageQuery: true,
      credential: true,
      resetCredits: true,
      quotaThresholds: true,
      tenantSchedule: false,
      proxy: true,
      remove: true,
    })
  })

  it('tenant can test owned VM, refresh official usage and use reset credits', () => {
    const p = vmPermsFor('user')
    expect(p.known).toBe(true)
    expect(p.admin).toBe(false)
    expect(p.dashboard).toBe(false)
    expect(p.power).toBe(false)
    expect(p.test).toBe(true)
    // The backend only serves GET /api/panel/test-models to admins.
    expect(p.testModels).toBe(true)
    expect(p.usageQuery).toBe(true)
    expect(p.credential).toBe(false)
    expect(p.resetCredits).toBe(true)
    expect(p.quotaThresholds).toBe(true)
    expect(p.tenantSchedule).toBe(true)
    expect(p.remove).toBe(false)
  })

  it('super only reads dashboard and toggles scheduling', () => {
    const p = vmPermsFor('super')
    expect(p).toMatchObject({
      known: true,
      admin: false,
      dashboard: true,
      power: false,
      test: false,
      usageQuery: false,
      credential: false,
      quotaThresholds: false,
      proxy: true,
      remove: false,
    })
  })

  it('unknown role (me still loading) grants nothing so no 403 is fired', () => {
    for (const role of [undefined, null, '', 'root']) {
      expect(Object.values(vmPermsFor(role)).every((v) => v === false)).toBe(
        true
      )
    }
  })
})

describe('vmDetailTabs', () => {
  it('ops and seed are admin only; test needs test permission', () => {
    expect(vmDetailTabs(vmPermsFor('admin'))).toEqual([
      'overview',
      'account',
      'proxy',
      'test',
      'ops',
      'desktop',
      'seed',
    ])
    expect(vmDetailTabs(vmPermsFor('user'))).toEqual(['overview', 'test'])
    expect(vmDetailTabs(vmPermsFor('super'))).toEqual([
      'overview',
      'account',
      'proxy',
    ])
  })

  it('falls back to overview when the remembered tab is hidden', () => {
    const tabs = vmDetailTabs(vmPermsFor('user'))
    expect(visibleTab('ops', tabs)).toBe('overview')
    expect(visibleTab('seed', tabs)).toBe('overview')
    expect(visibleTab('desktop', tabs)).toBe('overview')
    expect(visibleTab('test', tabs)).toBe('test')
    expect(visibleTab('proxy', tabs)).toBe('overview')
  })
})

describe('pickBindTarget', () => {
  const free = [{ id: 'px-local' }, { id: 'px-2' }]

  it('keeps a still-offered pick', () => {
    expect(pickBindTarget('px-2', free)).toBe('px-2')
  })

  it('falls back to the first candidate when the pick left the list', () => {
    expect(pickBindTarget('px-old', free)).toBe('px-local')
    expect(pickBindTarget('', free)).toBe('px-local')
  })

  it('returns empty when nothing can be bound', () => {
    expect(pickBindTarget('px-old', [])).toBe('')
    expect(pickBindTarget('', [{ id: null }])).toBe('')
  })
})
