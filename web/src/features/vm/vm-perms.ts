import { useQuery } from '@tanstack/react-query'
import type { PanelRole } from '@/types/panel-auth'
import { meQueryOptions } from '@/features/auth/queries'

/** VM 页面按角色能做的事，对齐后端 src/lib/admin/panel-acl.mjs。 */
export type VmPerms = {
  /** me 已返回、角色已知。 */
  known: boolean
  admin: boolean
  /** GET /api/panel/dashboard（admin、super）。 */
  dashboard: boolean
  /** 开机 / 关机 / 探测。 */
  power: boolean
  /** 查看诊断并按当前状态申请恢复服务。 */
  recovery: boolean
  /** test-chat、定时测试。 */
  test: boolean
  /** GET /api/panel/test-models（后端目前只放行 admin）。 */
  testModels: boolean
  /** 手动刷新官方额度：管理员及槽位属主。 */
  usageQuery: boolean
  /** OAuth 凭证导入、授权和令牌刷新。 */
  credential: boolean
  /** 查询和使用当前 VM 的上游重置券；不授予凭证管理权限。 */
  resetCredits: boolean
  /** 修改本人 Claude VM 的 5h / 7d 闸线。 */
  quotaThresholds: boolean
  /** 暂停本人 VM 的调度，以及解除租户暂停。 */
  tenantSchedule: boolean
  /** 删除 VM。 */
  /** 槽位出口页。租户不开放代理。 */
  proxy: boolean
  /** DELETE /vms/:id（仅管理员）。 */
  remove: boolean
}

const NONE: VmPerms = {
  known: false,
  admin: false,
  dashboard: false,
  power: false,
  recovery: false,
  test: false,
  testModels: false,
  usageQuery: false,
  credential: false,
  resetCredits: false,
  quotaThresholds: false,
  tenantSchedule: false,
  proxy: false,
  remove: false,
}

/** 角色未知（me 还没回来）时一律不放行，避免先发一批 403。 */
export function vmPermsFor(
  role: PanelRole | string | null | undefined
): VmPerms {
  if (role === 'admin') {
    return {
      known: true,
      admin: true,
      dashboard: true,
      power: true,
      recovery: true,
      test: true,
      testModels: true,
      usageQuery: true,
      credential: true,
      resetCredits: true,
      quotaThresholds: true,
      tenantSchedule: false,
      proxy: true,
      remove: true,
    }
  }
  if (role === 'user')
    return {
      ...NONE,
      known: true,
      recovery: true,
      test: true,
      testModels: true,
      usageQuery: true,
      resetCredits: true,
      quotaThresholds: true,
      tenantSchedule: true,
    }
  if (role === 'super')
    return { ...NONE, known: true, dashboard: true, proxy: true }
  return NONE
}

export function useVmPerms(): VmPerms {
  const me = useQuery(meQueryOptions())
  return vmPermsFor(me.data?.role)
}

export type VmDetailTab =
  'overview' | 'account' | 'proxy' | 'test' | 'ops' | 'desktop' | 'seed'

export function vmDetailTabs(perms: VmPerms): VmDetailTab[] {
  const tabs: VmDetailTab[] = ['overview']
  if (perms.admin || perms.dashboard) tabs.push('account', 'proxy')
  if (perms.test) tabs.push('test')
  if (perms.admin) tabs.push('ops', 'desktop', 'seed')
  return tabs
}

/** 选中的页签当前角色看不到时回到概览。 */
export function visibleTab(tab: string, tabs: readonly string[]): string {
  return tabs.includes(tab) ? tab : 'overview'
}

/** 下拉里记住的出口已不在候选里（被绑满、切了槽）时回落到第一个候选。 */
export function pickBindTarget(
  bindId: string,
  candidates: readonly { id?: string | null }[]
): string {
  if (bindId && candidates.some((p) => p.id === bindId)) return bindId
  return candidates[0]?.id || ''
}
