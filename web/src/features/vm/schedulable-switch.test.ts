import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { vmSchedulableProps } from './schedulable-switch'

const vm = (over: Partial<Vm>): Vm => ({ id: 'vm-01', ...over })

describe('vmSchedulableProps', () => {
  it('受限 (incl. a maintenance hold) still reads as 调度开', () => {
    const props = vmSchedulableProps(
      vm({
        schedule_state: 'restricted',
        schedulable: false,
        restriction_reason: 'maintenance',
      })
    )
    expect(props.schedulable).toBe(true)
    expect(props.scheduleState).toBe('restricted')
  })

  it('不可调度 and 调度关 read as off', () => {
    const bad = vmSchedulableProps(
      vm({
        schedule_state: 'unschedulable',
        schedulable: false,
        unschedulable_text: '代理失配',
      })
    )
    expect(bad.schedulable).toBe(false)
    expect(bad.tenantState).toBe('enabled')
    expect(bad.unschedulableText).toBe('代理失配')
    expect(vmSchedulableProps(vm({ schedule_state: 'off' })).schedulable).toBe(
      false
    )
    expect(vmSchedulableProps(vm({ schedule_state: 'on' })).schedulable).toBe(
      true
    )
  })

  it('distinguishes a resumable tenant pause from an operator stop', () => {
    const paused = vm({
      schedule_state: 'off',
      schedule_off: true,
      schedulable: false,
    })
    expect(vmSchedulableProps(paused).tenantState).toBe('operator-off')
    expect(
      vmSchedulableProps({
        ...paused,
        schedule_disabled_reason: 'tenant_paused',
      }).tenantState
    ).toBe('paused')
    expect(
      vmSchedulableProps(
        vm({ schedule_state: 'restricted', schedulable: false })
      ).tenantState
    ).toBe('enabled')
  })
})
