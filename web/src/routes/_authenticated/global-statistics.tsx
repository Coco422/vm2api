import { createFileRoute } from '@tanstack/react-router'
import { GlobalStatisticsPage } from '@/features/company/global-statistics'

export const Route = createFileRoute('/_authenticated/global-statistics')({
  component: GlobalStatisticsPage,
})
