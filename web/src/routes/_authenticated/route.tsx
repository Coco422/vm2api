import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createFileRoute,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { ApiError } from '@/lib/api'
import { hasSession } from '@/lib/session'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { meQueryOptions } from '@/features/auth/queries'
import { guardPanelRoute } from '@/features/auth/route-guard'
import { TenantAccountDialog } from '@/features/company/tenant-account-dialog'
import { FleetActions } from '@/features/fleet/fleet-actions'
import { onboardingQueryOptions } from '@/features/welcome/queries'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context, location, preload }) => {
    if (!hasSession()) {
      // Bare console entry is the public welcome; deep links go to the sign-in page.
      if (location.pathname === '/') throw redirect({ to: '/welcome' })
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    await guardPanelRoute({
      queryClient: context.queryClient,
      location,
      preload,
    })
  },
  component: Authenticated,
})

function Authenticated() {
  const navigate = useNavigate()
  const onKernelPage = useRouterState({
    select: (state) => state.location.pathname === '/wrap',
  })
  const meQuery = useQuery(meQueryOptions())
  const onboarding = useQuery(onboardingQueryOptions())
  const [accountOpen, setAccountOpen] = useState(false)
  const setMe = useAuthStore((s) => s.setMe)
  const signOut = useAuthStore((s) => s.signOut)
  const sessionExpired =
    meQuery.error instanceof ApiError && meQuery.error.status === 401
  useEffect(() => {
    if (meQuery.data) setMe(meQuery.data)
  }, [meQuery.data, setMe])
  useEffect(() => {
    if (sessionExpired) {
      signOut()
      navigate({ to: '/login' })
    }
  }, [sessionExpired, signOut, navigate])
  const needsGuide =
    onboarding.data?.role !== 'user' && onboarding.data?.guide_used === false
  useEffect(() => {
    if (needsGuide && !sessionExpired) {
      void navigate({ to: '/welcome', search: { setup: true }, replace: true })
    }
  }, [needsGuide, sessionExpired, navigate])
  if (sessionExpired) {
    return null
  }
  const me = meQuery.data
  const canManageAccount = me?.capabilities?.includes('account.manage')
  return (
    <>
      <AuthenticatedLayout
        headerActions={onKernelPage ? null : <FleetActions />}
        onAccountSettings={
          canManageAccount ? () => setAccountOpen(true) : undefined
        }
      />
      {me && accountOpen && canManageAccount && (
        <TenantAccountDialog
          currentUsername={me.user}
          onClose={() => setAccountOpen(false)}
        />
      )}
    </>
  )
}
