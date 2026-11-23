import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

/** A service label, independent of the operator's private exit health. */
export function TenantProxyBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground',
        className
      )}
      title='独享代理'
    >
      <Globe className='size-3 shrink-0' aria-hidden />
      独享代理
    </span>
  )
}
