import { createFileRoute, redirect } from '@tanstack/react-router'
import { meQueryOptions } from '@/features/auth/queries'
import { OverviewPage } from '@/features/overview'

export const Route = createFileRoute('/_authenticated/overview')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions())
    // Existing welcome/header links still point here; tenants land on their VMs.
    if (me.role === 'user') throw redirect({ to: '/vm', replace: true })
  },
  component: OverviewPage,
})
