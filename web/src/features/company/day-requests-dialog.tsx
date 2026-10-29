import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  dayRequestsPath,
  employeeRequest,
  type EmployeeDayRequests,
} from './api'

const num = (n: number | null) => new Intl.NumberFormat('zh-CN').format(n || 0)
const money = (n: number | null) =>
  n == null ? '—' : `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
const duration = (n: number | null) =>
  n == null ? '—' : `${(n / 1000).toFixed(2)} 秒`
const time = (value: string) =>
  new Date(value).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

export function DayRequestsDialog({
  day,
  employeeKey,
  onClose,
}: {
  day: string
  employeeKey: string
  onClose: () => void
}) {
  const [paging, setPaging] = useState<{
    page: number
    snapshot?: string
    revision: number
  }>({ page: 1, revision: 0 })
  const [expanded, setExpanded] = useState<string | null>(null)
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- this QueryClient belongs to one login; never include raw credentials
  const query = useQuery({
    queryKey: [
      'company',
      'requests',
      day,
      paging.page,
      paging.snapshot,
      paging.revision,
    ],
    queryFn: ({ signal }) =>
      employeeRequest<EmployeeDayRequests>(
        employeeKey,
        dayRequestsPath(day, paging.page, paging.snapshot),
        { signal }
      ),
  })
  const data = query.data
  function changePage(page: number) {
    if (!data) return
    setExpanded(null)
    setPaging({ ...paging, page, snapshot: data.snapshot })
  }
  function refresh() {
    setExpanded(null)
    setPaging({ page: 1, revision: paging.revision + 1 })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className='flex max-h-[92svh] flex-col gap-4 overflow-hidden sm:max-w-6xl'
        showCloseButton={false}
      >
        <DialogHeader className='pr-2'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <DialogTitle>{day} · 单日请求详情</DialogTitle>
            <Button variant='ghost' size='sm' onClick={onClose}>
              关闭
            </Button>
          </div>
          <DialogDescription>
            按上海时间显示，仅包含当前 Key
            以本人身份产生的请求。展开每笔请求可查看 Token 和费用明细。
          </DialogDescription>
        </DialogHeader>
        {data && (
          <div className='grid grid-cols-3 gap-3 rounded-md border bg-muted/20 p-3 text-sm'>
            <div>
              <p className='text-xs text-muted-foreground'>请求数</p>
              <p className='mt-1 font-medium tabular-nums'>{num(data.total)}</p>
            </div>
            <div>
              <p className='text-xs text-muted-foreground'>Tokens（含缓存）</p>
              <p className='mt-1 font-medium tabular-nums'>
                {num(
                  data.totals.input_tokens +
                    data.totals.output_tokens +
                    data.totals.cache_read_tokens +
                    data.totals.cache_creation_tokens
                )}
              </p>
            </div>
            <div>
              <p className='text-xs text-muted-foreground'>API 折算消耗</p>
              <p className='mt-1 font-medium tabular-nums'>
                {money(data.totals.official_cost_usd)}
              </p>
            </div>
          </div>
        )}
        {!!data?.totals.unpriced_requests && (
          <p className='text-xs text-amber-600 dark:text-amber-400'>
            有 {data.totals.unpriced_requests}{' '}
            笔请求未定价，合计仅包含已定价部分。
          </p>
        )}
        {query.error && (
          <div role='alert' className='text-sm text-destructive'>
            {query.error.message}
            <Button
              variant='ghost'
              size='sm'
              onClick={() => void query.refetch()}
            >
              重试
            </Button>
          </div>
        )}
        {query.isPending && (
          <p
            role='status'
            className='py-12 text-center text-sm text-muted-foreground'
          >
            正在读取请求记录…
          </p>
        )}
        {data && (
          <div className='min-h-0 overflow-auto rounded-md border'>
            <table className='w-full min-w-[960px] text-sm'>
              <thead className='sticky top-0 bg-card text-xs text-muted-foreground'>
                <tr className='border-b'>
                  {[
                    '时间（上海）',
                    '模型',
                    '结果',
                    '耗时',
                    '输入',
                    '输出',
                    '缓存读 / 写',
                    '折算费用',
                    '操作',
                  ].map((title) => (
                    <th key={title} className='px-3 py-3 text-left font-normal'>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <Fragment key={item.id}>
                    <tr className='border-b last:border-0'>
                      <td className='px-3 py-3 tabular-nums'>
                        {time(item.created_at)}
                      </td>
                      <td
                        className='max-w-48 truncate px-3 py-3'
                        title={item.model}
                      >
                        {item.model}
                      </td>
                      <td
                        className={`px-3 py-3 text-xs ${item.result === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                      >
                        {item.result === 'success'
                          ? '成功'
                          : item.result === 'error'
                            ? '失败'
                            : '未知'}
                        {item.status != null && ` · ${item.status}`}
                      </td>
                      <td className='px-3 py-3 whitespace-nowrap text-muted-foreground tabular-nums'>
                        {duration(item.duration_ms)}
                      </td>
                      <td className='px-3 py-3 tabular-nums'>
                        {num(item.input_tokens)}
                      </td>
                      <td className='px-3 py-3 tabular-nums'>
                        {num(item.output_tokens)}
                      </td>
                      <td className='px-3 py-3 whitespace-nowrap tabular-nums'>
                        {num(item.cache_read_tokens)} /{' '}
                        {num(item.cache_creation_tokens)}
                      </td>
                      <td className='px-3 py-3 tabular-nums'>
                        {item.official_cost_usd == null
                          ? '未定价'
                          : money(item.official_cost_usd)}
                      </td>
                      <td className='px-3 py-2'>
                        <Button
                          size='sm'
                          variant='ghost'
                          aria-label={`查看请求 ${item.request_id} 详情`}
                          aria-expanded={expanded === item.id}
                          onClick={() =>
                            setExpanded(expanded === item.id ? null : item.id)
                          }
                        >
                          {expanded === item.id ? '收起' : '详情'}
                        </Button>
                      </td>
                    </tr>
                    {expanded === item.id && (
                      <tr className='border-b bg-muted/20'>
                        <td colSpan={9} className='p-4'>
                          <RequestDetails item={item} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {data.items.length === 0 && (
              <p className='py-12 text-center text-sm text-muted-foreground'>
                当天暂无请求记录。
              </p>
            )}
          </div>
        )}
        <div className='flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground'>
          <Button
            variant='ghost'
            size='sm'
            disabled={query.isFetching}
            onClick={refresh}
          >
            <RefreshCw className='mr-1 size-3.5' />
            刷新记录
          </Button>
          <span>
            {data
              ? `共 ${data.total} 笔 · 第 ${paging.page} / ${Math.max(1, data.total_pages)} 页 · 每页 ${data.page_size} 笔`
              : '每页 20 笔'}
          </span>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={query.isFetching || !data || paging.page <= 1}
              onClick={() => changePage(paging.page - 1)}
            >
              <ChevronLeft className='mr-1 size-3.5' />
              上一页
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={
                query.isFetching || !data || paging.page >= data.total_pages
              }
              onClick={() => changePage(paging.page + 1)}
            >
              下一页
              <ChevronRight className='ml-1 size-3.5' />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RequestDetails({
  item,
}: {
  item: EmployeeDayRequests['items'][number]
}) {
  const fields = [
    ['请求 ID', item.request_id],
    ['完整模型', item.model],
    ['请求模型', item.requested_model || '—'],
    ['协议', item.protocol || '—'],
    ['响应模式', item.stream ? '流式' : '非流式'],
    ['首 Token 耗时', duration(item.first_token_ms)],
    ['总耗时', duration(item.duration_ms)],
    [
      '普通输入',
      `${num(item.input_tokens)} tokens · ${money(item.input_cost)}`,
    ],
    ['输出', `${num(item.output_tokens)} tokens · ${money(item.output_cost)}`],
    [
      '缓存读取',
      `${num(item.cache_read_tokens)} tokens · ${money(item.cache_read_cost)}`,
    ],
    [
      '缓存写入',
      `${num(item.cache_creation_tokens)} tokens · ${money(item.cache_creation_cost)}`,
    ],
    [
      '5 分钟 / 1 小时缓存写入',
      (item.cache_creation_tokens || 0) > 0 &&
      !(item.cache_creation_5m_tokens || item.cache_creation_1h_tokens)
        ? '未记录时长分项'
        : `${num(item.cache_creation_5m_tokens)} / ${num(item.cache_creation_1h_tokens)} tokens`,
    ],
    ['服务端搜索费用', money(item.web_search_cost)],
    [
      'API 价格折算费用',
      item.official_cost_usd == null ? '未定价' : money(item.official_cost_usd),
    ],
    ['Key 额度扣减', money(item.budget_cost_usd)],
  ]
  return (
    <dl className='grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-4'>
      {fields.map(([label, value]) => (
        <div key={label} className='min-w-0'>
          <dt className='text-xs text-muted-foreground'>{label}</dt>
          <dd className='mt-1 text-sm break-all tabular-nums'>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
