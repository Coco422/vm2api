import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, ScanLine } from 'lucide-react'
import { toast } from 'sonner'
import { api, panelFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Verdict = 'pass' | 'fail' | 'unknown'
type Result = {
  id: string
  site: string
  label: string
  rule: string
  status: Verdict
  value: number | string | null
}
type AuditReport = {
  id: string
  state: 'running' | 'completed' | 'error' | 'interrupted'
  verdict: Verdict
  started_at: string
  finished_at: string | null
  stale: boolean
  evidence_complete: boolean
  proxy_id: string | null
  browser_sandbox: boolean
  exit_consistent: boolean | null
  sites: Record<
    string,
    {
      screenshot?: string | null
      leaks_screenshot?: string | null
      error?: string | null
      ip?: string
      text?: string
    }
  >
  results: Result[]
  error: { code: string; message: string } | null
}
type AuditList = { criteria: Result[]; reports: AuditReport[] }

const labels: Record<Verdict, string> = {
  pass: '达标',
  fail: '未达标',
  unknown: '未确认',
}
const colors: Record<Verdict, string> = {
  pass: 'text-[color:var(--status-ok)]',
  fail: 'text-[color:var(--status-bad)]',
  unknown: 'text-muted-foreground',
}
const sites: Record<string, string> = {
  'net-coffee': 'Net.Coffee 评分',
  'net-coffee-leaks': 'DNS / WebRTC',
  ping0: 'Ping0',
  'fuck-claude': 'fuck-claude',
}

const errorLabels: Record<string, string> = {
  empty_response: '网站返回空白页，可能拒绝了当前浏览器模式',
  challenge_required: '网站要求人机验证，需人工处理后重试',
  unsupported_layout: '页面字段无法识别，未确认结果',
  result_timeout: '检测结果等待超时',
  navigation_failed: '网站连接失败',
}

export function EgressAuditCard({
  vmId,
  proxyConfigured,
}: {
  vmId: string
  proxyConfigured: boolean
}) {
  const client = useQueryClient()
  const base = `/api/panel/vms/${encodeURIComponent(vmId)}/egress-audit`
  const queryKey = ['vm-egress-audit', vmId, base]
  const query = useQuery({
    queryKey,
    queryFn: () => api<AuditList>(base),
    refetchInterval: (q) =>
      q.state.data?.reports.some((r) => r.state === 'running') ? 1500 : false,
  })
  const [selectedId, setSelectedId] = useState('')
  const [containerMode, setContainerMode] = useState(false)
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(
    null
  )
  const [loadingImage, setLoadingImage] = useState(false)
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url)
    },
    [preview]
  )
  const reports = query.data?.reports || []
  const report = reports.find((r) => r.id === selectedId) || reports[0]
  const running = reports.some((r) => r.state === 'running')
  const start = useMutation({
    mutationFn: () =>
      api<AuditReport>(base, {
        method: 'POST',
        body: JSON.stringify(containerMode ? { no_sandbox: true } : {}),
      }),
    onSuccess: (next) => {
      setSelectedId(next.id)
      void client.invalidateQueries({ queryKey })
    },
    onError: (error) => toast.error(error.message),
  })
  const viewScreenshot = async (site: string) => {
    if (!report) return
    setLoadingImage(true)
    try {
      const response = await panelFetch(
        `${base}/${report.id}/screenshots/${site}`
      )
      if (!response.ok) throw new Error('截图读取失败')
      const blob = await response.blob()
      setPreview({
        url: URL.createObjectURL(blob),
        title: `${sites[site]} · ${new Date(report.started_at).toLocaleString()}`,
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '截图读取失败')
    } finally {
      setLoadingImage(false)
    }
  }
  return (
    <Card>
      <CardHeader className='flex flex-row flex-wrap items-center justify-between gap-3 pb-2'>
        <CardTitle className='text-sm'>出口环境检测</CardTitle>
        <Button
          size='sm'
          variant='outline'
          onClick={() => start.mutate()}
          loading={start.isPending || running}
          disabled={!proxyConfigured || query.isPending || query.isError}
        >
          <ScanLine className='size-4' />
          一键检测并截图
        </Button>
      </CardHeader>
      <CardContent className='space-y-3 text-sm'>
        <p className='text-xs text-muted-foreground'>
          在此 VM
          内打开检测网站，使用当前出口和系统环境。三站四项全部达标且截图完整才通过；通常需要
          1–3 分钟。
        </p>
        {!proxyConfigured && (
          <p className='text-xs text-muted-foreground'>请先绑定出口代理。</p>
        )}
        <label className='flex items-start gap-2 text-xs text-muted-foreground'>
          <input
            type='checkbox'
            className='mt-0.5'
            checked={containerMode}
            disabled={running || start.isPending}
            onChange={(event) => setContainerMode(event.target.checked)}
          />
          <span>
            容器兼容模式：关闭 Chromium 内部沙箱，使用当前 VM
            的隔离。仅在沙箱启动失败时选择。
          </span>
        </label>
        {query.isError && (
          <p role='alert' className='text-destructive'>
            无法读取检测记录：{query.error.message}
          </p>
        )}
        {query.isPending && (
          <p className='text-muted-foreground'>正在读取检测记录…</p>
        )}
        {!query.isPending && !query.isError && !report && (
          <p className='text-muted-foreground'>
            尚无检测记录。VM 需要安装 Chromium / Chrome。
          </p>
        )}
        {reports.length > 1 && (
          <label className='flex flex-wrap items-center gap-2 text-xs'>
            检测记录
            <select
              aria-label='检测记录'
              className='max-w-full rounded-md border bg-background px-2 py-1'
              value={report?.id || ''}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.started_at).toLocaleString()} ·{' '}
                  {r.stale ? '已过期' : labels[r.verdict]}
                </option>
              ))}
            </select>
          </label>
        )}
        {report && (
          <>
            <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
              <span className={colors[report.verdict]}>
                {report.stale
                  ? '配置已变更，请重新检测'
                  : report.state === 'running'
                    ? '正在检测…'
                    : report.state === 'interrupted'
                      ? '检测被中断，请重试'
                      : labels[report.verdict]}
              </span>
              <span className='text-xs text-muted-foreground'>
                {new Date(report.started_at).toLocaleString()}
              </span>
            </div>
            <p className='text-xs text-muted-foreground'>
              浏览器沙箱：
              {report.browser_sandbox ? '启用' : '未启用（容器兼容模式）'}
            </p>
            {report.error && (
              <p role='alert' className='text-destructive'>
                {report.error.message}
              </p>
            )}
            {report.state === 'completed' && !report.evidence_complete && (
              <p className='text-xs text-muted-foreground'>
                四项截图尚未齐全，请重新检测补齐证据。
              </p>
            )}
            {report.exit_consistent === false && (
              <p className='text-destructive'>
                两个 IP 检测站看到的出口不同，请检查分流或动态出口。
              </p>
            )}
            <div className='divide-y'>
              {report.results.map((result) => (
                <div
                  key={result.id}
                  className='flex flex-wrap items-center justify-between gap-2 py-2'
                >
                  <div className='min-w-0'>
                    <div>{result.label}</div>
                    <div className='text-xs text-muted-foreground'>
                      {result.rule}
                      {result.value != null ? ` · ${result.value}` : ''}
                    </div>
                  </div>
                  <span className={`shrink-0 text-xs ${colors[result.status]}`}>
                    {labels[result.status]}
                  </span>
                </div>
              ))}
            </div>
            <div className='flex flex-wrap gap-2'>
              {Object.entries(sites).map(([site, label]) => (
                <div key={site} className='min-w-0'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={
                      !(site === 'net-coffee-leaks'
                        ? report.sites['net-coffee']?.leaks_screenshot
                        : report.sites[site]?.screenshot) || loadingImage
                    }
                    onClick={() => void viewScreenshot(site)}
                  >
                    <Camera className='size-3.5' />
                    {label} 截图
                  </Button>
                  {report.sites[site]?.error && (
                    <p className='mt-1 text-xs text-muted-foreground'>
                      {label}：
                      {errorLabels[report.sites[site].error] ||
                        report.sites[site].error}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className='text-xs text-muted-foreground'>
              绿色但缺少 DNS / UDP
              观测结果、验证码、超时或页面无法识别均不算通过。第三方评分仅作为本基准的诊断参考。
            </p>
          </>
        )}
      </CardContent>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null)
        }}
      >
        <DialogContent className='max-h-[90vh] overflow-auto sm:max-w-5xl'>
          <DialogHeader>
            <DialogTitle>{preview?.title || '检测截图'}</DialogTitle>
          </DialogHeader>
          {preview && (
            <img
              src={preview.url}
              alt={preview.title}
              className='h-auto w-full'
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
