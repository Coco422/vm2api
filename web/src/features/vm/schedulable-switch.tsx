import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ScheduleState, Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { expiresAtToMs } from '@/lib/fable-status'
import { isRestrictedSchedule, restrictionUntilOf } from '@/lib/vm-status'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  GEMINI_INVENTORY_KEY,
  geminiResource,
} from '@/features/import/gemini-operations'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

type TenantScheduleState = 'enabled' | 'paused' | 'operator-off'

function formatRestrictionUntil(until: number | null | undefined): string {
  const ms = expiresAtToMs(until)
  if (!ms) return ''
  return new Date(ms).toLocaleString()
}

export function vmSchedulableProps(vm: Vm) {
  const scheduleState: ScheduleState | undefined = isRestrictedSchedule(vm)
    ? 'restricted'
    : vm.schedule_state
  const off =
    vm.schedule_off === true ||
    scheduleState === 'off' ||
    (vm.schedule_manual === true && vm.schedulable === false)
  const tenantState: TenantScheduleState = !off
    ? 'enabled'
    : vm.schedule_disabled_reason === 'tenant_paused'
      ? 'paused'
      : 'operator-off'
  return {
    vmId: vm.id,
    isGemini: Boolean(vm.gemini),
    disabled: vm.gemini?.auth_state === 'disabled',
    // 受限（含维护 / 代理暂停）仍是「开」：开关只表达操作员意图和不可调度。
    schedulable:
      scheduleState === 'restricted'
        ? true
        : scheduleState
          ? scheduleState === 'on'
          : vm.schedulable !== false,
    scheduleState,
    tenantState,
    restrictionUntil: restrictionUntilOf(vm),
    restrictionReason: vm.restriction_reason,
    unschedulableText: vm.unschedulable_text || vm.unschedulable_reason || null,
  }
}

export function SchedulableSwitch({
  vmId,
  isGemini = false,
  disabled = false,
  schedulable,
  scheduleState,
  tenantState,
  restrictionUntil,
  unschedulableText,
  className,
}: {
  vmId: string
  isGemini?: boolean
  disabled?: boolean
  schedulable: boolean
  scheduleState?: ScheduleState
  tenantState: TenantScheduleState
  restrictionUntil?: number | null
  restrictionReason?: string | null
  unschedulableText?: string | null
  className?: string
}) {
  const qc = useQueryClient()
  const perms = useVmPerms()
  const canSchedule =
    perms.admin ||
    perms.dashboard ||
    (perms.tenantSchedule && !isGemini && tenantState !== 'operator-off')
  const restricted = scheduleState === 'restricted'
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const checked =
    optimistic ??
    (perms.tenantSchedule ? tenantState === 'enabled' : schedulable)
  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      api(
        isGemini
          ? `${geminiResource(vmId)}/schedulable`
          : `/api/panel/vms/${encodeURIComponent(vmId)}/schedulable`,
        {
          method: 'POST',
          body: JSON.stringify({ schedulable: next }),
        }
      ),
    onMutate: (next) => setOptimistic(next),
    onSuccess: async (_data, next) => {
      if (perms.tenantSchedule)
        toast.success(next ? '已解除暂停' : '已暂停调度')
      else toast.success(next ? '已开启调度' : '已关闭调度')
      await Promise.all(
        isGemini
          ? [
              qc.invalidateQueries({ queryKey: GEMINI_INVENTORY_KEY }),
              qc.invalidateQueries({
                queryKey: dashboardQueryOptions().queryKey,
              }),
            ]
          : [
              qc.invalidateQueries({
                queryKey: vmsListQueryOptions().queryKey,
              }),
              qc.invalidateQueries({
                queryKey: dashboardQueryOptions().queryKey,
              }),
              qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey }),
            ]
      )
    },
    onError: (error: Error) => {
      setOptimistic(null)
      toast.error(error.message)
    },
    onSettled: () => setOptimistic(null),
  })

  const untilText = formatRestrictionUntil(restrictionUntil)
  const operatorTooltip = !canSchedule
    ? '由管理员调整调度'
    : scheduleState === 'unschedulable' && !checked
      ? `不可调度：${unschedulableText || '错误'}。处理后点击重新开启调度`
      : restricted && checked
        ? untilText
          ? `调度开，当前受限至 ${untilText}`
          : '调度开，当前受限'
        : checked
          ? '点击关闭调度'
          : '点击开启调度'
  const tooltip = disabled
    ? '环境已停用，请先在详情中重新授权'
    : perms.tenantSchedule && !isGemini
      ? tenantState === 'operator-off'
        ? '管理员已关闭调度'
        : checked
          ? '暂停此 VM 的调度'
          : '解除此 VM 的调度暂停'
      : operatorTooltip

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={className}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            checked={checked}
            disabled={disabled || !canSchedule || mutation.isPending}
            onCheckedChange={(next) => mutation.mutate(next)}
            aria-label={tooltip}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
