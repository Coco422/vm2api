import { useEffect, useRef, useState } from 'react'
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  Activity,
  ArrowRight,
  Building2,
  KeyRound,
  LogOut,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  budgetWindowUsed,
  EmployeeApiError,
  employeeRequest,
  type EmployeeMe,
  type EmployeeUsage,
  type EmployeeVm,
  type ResetResult,
} from './api'
import { DayRequestsDialog } from './day-requests-dialog'

const number = (n: number) =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(n)
const usd = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(n)
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '暂无数据'

export function CompanyPage() {
  const [session, setSession] = useState<{
    key: string
    me: EmployeeMe
  } | null>(null)
  return session ? (
    <EmployeeSession session={session} onLogout={() => setSession(null)} />
  ) : (
    <EmployeeLogin onLogin={(key, me) => setSession({ key, me })} />
  )
}

function EmployeeSession({
  session,
  onLogout,
}: {
  session: { key: string; me: EmployeeMe }
  onLogout: () => void
}) {
  // Each login owns a fresh cache, so pending callbacks can never populate the next employee's data.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: 15_000,
            refetchOnWindowFocus: false,
          },
          mutations: { retry: false },
        },
      })
  )
  function logout() {
    void client.cancelQueries()
    client.clear()
    onLogout()
  }
  useEffect(
    () => () => {
      void client.cancelQueries()
      client.clear()
    },
    [client]
  )
  return (
    <QueryClientProvider client={client}>
      <Workspace
        employeeKey={session.key}
        initialMe={session.me}
        logout={logout}
      />
    </QueryClientProvider>
  )
}

function EmployeeLogin({
  onLogin,
}: {
  onLogin: (key: string, me: EmployeeMe) => void
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError('')
    try {
      const key = draft.trim()
      const me = await employeeRequest<EmployeeMe>(key, '/api/company/me')
      setDraft('')
      onLogin(key, me)
    } catch (err) {
      setError(err instanceof Error ? err.message : '暂时无法登录')
    } finally {
      setPending(false)
    }
  }
  return (
    <main className='min-h-svh bg-background p-6 text-foreground'>
      <header className='mx-auto flex max-w-6xl items-center justify-between border-b pb-5'>
        <Brand />
        <ThemeSwitch />
      </header>
      <div className='mx-auto grid max-w-6xl gap-12 py-20 lg:grid-cols-2 lg:items-center lg:py-32'>
        <section className='max-w-lg space-y-6'>
          <span className='text-xs font-medium tracking-widest text-muted-foreground'>
            SUBSCRIPTION WORKSPACE
          </span>
          <h1 className='text-4xl leading-tight font-semibold tracking-tight sm:text-5xl'>
            你的 AI 订阅，
            <br />
            在这里掌握。
          </h1>
          <p className='max-w-md text-base leading-7 text-muted-foreground'>
            查看专属账号的剩余额度、使用记录和恢复时间。在需要时，使用账号可用的限额重置券。
          </p>
          <div className='flex flex-wrap gap-5 pt-3 text-sm text-muted-foreground'>
            <span className='flex items-center gap-2'>
              <ShieldCheck className='size-4' />
              专属账号
            </span>
            <span className='flex items-center gap-2'>
              <Activity className='size-4' />
              用量透明
            </span>
          </div>
        </section>
        <section className='w-full max-w-md rounded-lg border bg-card p-6 sm:p-8 lg:justify-self-end'>
          <KeyRound className='mb-6 size-6 text-muted-foreground' />
          <h2 className='text-xl font-semibold'>进入员工工作台</h2>
          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
            使用管理员分配给你的 API Key。
          </p>
          <form className='mt-7 space-y-5' onSubmit={submit}>
            <div className='space-y-2'>
              <Label htmlFor='employee-key'>员工 Key</Label>
              <Input
                id='employee-key'
                type='password'
                autoComplete='off'
                spellCheck={false}
                placeholder='粘贴你的 API Key'
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                required
                maxLength={256}
                disabled={pending}
              />
            </div>
            {error && (
              <p role='alert' className='text-sm text-destructive'>
                {error}
              </p>
            )}
            <Button
              type='submit'
              className='w-full gap-2'
              disabled={pending || !draft.trim()}
            >
              {pending ? '验证中…' : '进入工作台'}
              <ArrowRight className='size-4' />
            </Button>
          </form>
          <p className='mt-5 text-xs leading-5 text-muted-foreground'>
            Key 仅保留在当前页面内存中。刷新或关闭页面后需要重新输入。
          </p>
        </section>
      </div>
      <footer className='mx-auto max-w-6xl border-t py-5 text-xs text-muted-foreground'>
        订阅管理 · Powered by vm2api
      </footer>
    </main>
  )
}

function Brand() {
  return (
    <div className='flex items-center gap-3'>
      <div className='flex size-9 items-center justify-center rounded-md border bg-card'>
        <Building2 className='size-4' />
      </div>
      <div>
        <p className='text-sm font-semibold'>订阅工作台</p>
        <p className='text-[11px] text-muted-foreground'>
          Subscription workspace
        </p>
      </div>
    </div>
  )
}

function Workspace({
  employeeKey,
  initialMe,
  logout,
}: {
  employeeKey: string
  initialMe: EmployeeMe
  logout: () => void
}) {
  const [days, setDays] = useState(30)
  // Credentials must not appear in cache keys/devtools; this cache belongs to one login only.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const me = useQuery({
    queryKey: ['company', 'me'],
    initialData: initialMe,
    queryFn: ({ signal }) =>
      employeeRequest<EmployeeMe>(employeeKey, '/api/company/me', { signal }),
    refetchInterval: 30_000,
  })
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- per-login cache; never cache the raw Key
  const usage = useQuery({
    queryKey: ['company', 'usage', days],
    queryFn: ({ signal }) =>
      employeeRequest<EmployeeUsage>(
        employeeKey,
        `/api/company/usage?days=${days}`,
        { signal }
      ),
  })
  const error = me.error || usage.error
  useEffect(() => {
    if (
      error instanceof EmployeeApiError &&
      [401, 403].includes(error.status)
    ) {
      logout()
      toast.error('Key 已失效，请重新进入')
    }
  }, [error, logout])
  return (
    <main className='min-h-svh bg-background text-foreground'>
      <header className='border-b bg-card'>
        <div className='mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8'>
          <Brand />
          <div className='flex items-center gap-2'>
            <span className='hidden text-sm text-muted-foreground sm:inline'>
              {me.data?.employee.name}
            </span>
            <ThemeSwitch />
            <Button variant='ghost' size='sm' onClick={logout}>
              <LogOut className='mr-1 size-4' />
              退出
            </Button>
          </div>
        </div>
      </header>
      <div className='mx-auto max-w-7xl space-y-8 px-5 py-8 sm:px-8'>
        <div className='flex flex-wrap items-end justify-between gap-4'>
          <div>
            <p className='mb-2 text-xs font-medium tracking-wider text-muted-foreground'>
              我的订阅
            </p>
            <h1 className='text-2xl font-semibold tracking-tight'>
              工作台概览
            </h1>
            <p className='mt-2 text-sm text-muted-foreground'>
              账号额度与个人用量，一目了然。
            </p>
          </div>
          <label className='flex items-center gap-3 text-sm text-muted-foreground'>
            统计范围
            <select
              aria-label='统计范围'
              className='rounded-md border bg-card px-3 py-2 text-foreground'
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {[7, 30, 90].map((n) => (
                <option key={n} value={n}>
                  最近 {n} 天
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <div
            role='alert'
            className='rounded-md border border-destructive/40 p-4 text-sm text-destructive'
          >
            {error.message}
            <Button
              variant='ghost'
              size='sm'
              onClick={() => {
                void me.refetch()
                void usage.refetch()
              }}
            >
              重试
            </Button>
          </div>
        )}
        {!me.data && !error && (
          <p role='status' className='py-12 text-muted-foreground'>
            正在读取账号状态…
          </p>
        )}
        {me.data && (
          <>
            {!me.data.key.inference_allowed && (
              <div
                role='status'
                className='rounded-md border border-amber-600/30 bg-amber-500/5 p-4 text-sm'
              >
                当前 Key 暂时不能调用模型（{me.data.key.inference_error}
                ）。你仍可查看额度和使用记录；Key 额度请联系管理员调整。
              </div>
            )}
            <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
              <Metric
                label='请求次数'
                value={usage.data ? number(usage.data.totals.requests) : '—'}
                note={`近 ${days} 天 · 当前 Key`}
              />
              <Metric
                label='Token 用量'
                value={
                  usage.data
                    ? number(
                        usage.data.totals.input_tokens +
                          usage.data.totals.output_tokens +
                          usage.data.totals.cache_read_tokens +
                          usage.data.totals.cache_creation_tokens
                      )
                    : '—'
                }
                note='含输入、输出与缓存读写'
              />
              <Metric
                label='API 价格折算消耗'
                value={
                  usage.data ? usd(usage.data.totals.official_cost_usd) : '—'
                }
                note='含缓存费用 · 非订阅采购支出'
              />
              <Metric
                label='Key 额度剩余'
                value={
                  me.data.key.quota_usd > 0
                    ? usd(
                        Math.max(
                          0,
                          me.data.key.quota_usd - me.data.key.quota_usd_used
                        )
                      )
                    : '无限制'
                }
                note={
                  me.data.key.quota_usd > 0
                    ? `已用 ${usd(me.data.key.quota_usd_used)} / ${usd(me.data.key.quota_usd)}`
                    : `已用 ${usd(me.data.key.quota_usd_used)} · 累计金额不设上限`
                }
              />
            </div>
            {!!usage.data?.totals.unpriced_requests && (
              <p className='text-sm text-amber-600 dark:text-amber-400'>
                有 {usage.data.totals.unpriced_requests}{' '}
                笔请求未取得价格，当前金额尚不完整。
              </p>
            )}
            <section className='space-y-4'>
              <div className='flex items-center justify-between'>
                <h2 className='text-base font-semibold'>专属账号</h2>
                <span className='text-xs text-muted-foreground'>
                  {me.data.vms.length} 台虚拟机
                </span>
              </div>
              {me.data.vms.length ? (
                <div
                  className={
                    me.data.vms.length > 1
                      ? 'grid gap-4 xl:grid-cols-2'
                      : 'grid gap-4'
                  }
                >
                  {me.data.vms.map((vm) => (
                    <VmCard key={vm.id} vm={vm} employeeKey={employeeKey} />
                  ))}
                </div>
              ) : (
                <div className='rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground'>
                  当前 Key 没有可访问的账号，请联系管理员分配。
                </div>
              )}
            </section>
            <Budget keyInfo={me.data.key} />
          </>
        )}
        {usage.data && (
          <UsageDetails usage={usage.data} employeeKey={employeeKey} />
        )}
        <footer className='border-t py-5 text-xs leading-6 text-muted-foreground'>
          用量按上海自然日统计，仅包含当前 Key
          以本人身份产生的网关记录。官方订阅限额与 Key
          额度分别计算；折算费用包含缓存读写，不代表额外产生的订阅账单。
        </footer>
      </div>
    </main>
  )
}

function Metric({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <div className='rounded-lg border bg-card p-5'>
      <p className='text-xs text-muted-foreground'>{label}</p>
      <p className='mt-3 text-2xl font-semibold tracking-tight tabular-nums'>
        {value}
      </p>
      <p className='mt-2 text-xs text-muted-foreground'>{note}</p>
    </div>
  )
}

function WindowMeter({
  label,
  window,
}: {
  label: string
  window: EmployeeVm['quota']['five_hour']
}) {
  return (
    <div>
      <div className='mb-2 flex justify-between text-sm'>
        <span className='text-muted-foreground'>{label}</span>
        <span className='font-medium tabular-nums'>
          {window.used_percent == null
            ? '未取得额度'
            : `已用 ${window.used_percent.toFixed(1)}%`}
        </span>
      </div>
      <div
        className='h-1.5 overflow-hidden rounded-full bg-muted'
        role='progressbar'
        aria-label={label}
        aria-valuenow={window.used_percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={
            window.used_percent != null && window.used_percent >= 90
              ? 'h-full bg-amber-500'
              : 'h-full bg-primary'
          }
          style={{ width: `${window.used_percent ?? 0}%` }}
        />
      </div>
      <p className='mt-2 text-xs text-muted-foreground'>
        恢复时间：{date(window.resets_at)}
      </p>
    </div>
  )
}

function VmCard({ vm, employeeKey }: { vm: EmployeeVm; employeeKey: string }) {
  const client = useQueryClient()
  const [result, setResult] = useState<ResetResult | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const operationId = useRef('')
  const action = useMutation({
    mutationFn: (operation: 'refresh' | 'reset-query' | 'reset-redeem') =>
      employeeRequest<ResetResult>(
        employeeKey,
        `/api/company/vms/${encodeURIComponent(vm.id)}/${operation}`,
        {
          operationId:
            operation === 'reset-redeem' ? operationId.current : undefined,
        }
      ),
    onSuccess: (data, operation) => {
      if (operation !== 'refresh') setResult(data)
      setConfirm(false)
      void client.invalidateQueries({ queryKey: ['company', 'me'] })
      if (operation === 'reset-redeem') {
        const messages: Record<string, string> = {
          reset: '已使用一次上游限额重置',
          already_used: '这次重置已处理',
          not_limited: '当前没有打满，未消耗重置',
          cooldown: '仍在冷却，未消耗重置',
          ineligible: '当前账号不能兑换',
          unknown: '结果未确认，请先查询状态并联系管理员',
        }
        const unknown = data.outcome === 'unknown' || data.warning != null
        setUncertain(unknown)
        if (!unknown) operationId.current = ''
        toast[unknown ? 'warning' : 'success'](
          data.warning
            ? '重置已处理，回读额度失败，请查询状态'
            : messages[data.outcome || ''] || '已使用一张上游重置券'
        )
      } else
        toast.success(
          operation === 'refresh' ? '已刷新官方额度' : '已查询重置券'
        )
    },
    onError: (error, operation) => {
      if (operation === 'reset-redeem') {
        setUncertain(true)
        setConfirm(false)
      }
      toast.error(error.message)
    },
  })
  const credits = result?.reset_credits
  const canRedeem =
    credits &&
    credits.available_count > 0 &&
    (vm.platform === 'openai' ||
      credits.credits.some((credit) => credit.redeemable))
  return (
    <article className='rounded-lg border bg-card p-5 sm:p-6'>
      <div className='mb-6 flex items-start justify-between gap-3'>
        <div className='flex items-center gap-3'>
          <Server className='size-5 text-muted-foreground' />
          <div>
            <h3 className='font-medium'>{vm.name}</h3>
            <p className='mt-1 text-xs text-muted-foreground'>
              {vm.platform === 'openai' ? 'Codex' : 'Claude'}
              {vm.tier && ` · ${vm.tier}`} · {vm.id}
            </p>
          </div>
        </div>
        <span className='rounded border px-2 py-1 text-[11px] text-muted-foreground'>
          {!vm.credential_ready
            ? '等待管理员配置'
            : vm.schedulable
              ? '已启用'
              : '调度已暂停'}
        </span>
      </div>
      <div className='grid gap-6 sm:grid-cols-2'>
        <WindowMeter label='5 小时额度' window={vm.quota.five_hour} />
        <WindowMeter label='7 天额度' window={vm.quota.seven_day} />
      </div>
      <div className='mt-6 flex flex-wrap items-center gap-2 border-t pt-4'>
        <Button
          variant='outline'
          size='sm'
          disabled={action.isPending}
          onClick={() => action.mutate('refresh')}
        >
          <RefreshCw
            className={`mr-1 size-3.5 ${action.isPending ? 'animate-spin' : ''}`}
          />
          刷新额度
        </Button>
        {vm.reset_supported && (
          <>
            <Button
              variant='ghost'
              size='sm'
              disabled={action.isPending}
              onClick={() => action.mutate('reset-query')}
            >
              查询重置券{credits && ` · ${credits.available_count}`}
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={action.isPending || !canRedeem || uncertain}
              onClick={() => {
                if (!operationId.current)
                  operationId.current = crypto.randomUUID()
                setConfirm(true)
              }}
            >
              <RotateCcw className='mr-1 size-3.5' />
              使用重置券
            </Button>
          </>
        )}
      </div>
      {credits && (
        <p className='mt-3 text-xs text-muted-foreground'>
          可用重置券 {credits.available_count} 次
          {credits.credits[0]?.expires_at &&
            ` · 到期 ${date(credits.credits[0].expires_at)}`}
        </p>
      )}
      {uncertain && (
        <p
          role='alert'
          className='mt-3 text-xs text-amber-600 dark:text-amber-400'
        >
          上一次重置结果尚未确认。请查询状态并联系管理员，暂不重复兑换。
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title='使用一次上游限额重置'
        desc='将消耗此账号的一次上游重置机会，不可退回。Key 额度保持不变。'
        confirmText='确认使用'
        cancelBtnText='取消'
        destructive
        isLoading={action.isPending}
        handleConfirm={() => action.mutate('reset-redeem')}
      />
    </article>
  )
}

function Budget({ keyInfo }: { keyInfo: EmployeeMe['key'] }) {
  const limits = keyInfo.windows
  return (
    <section className='rounded-lg border bg-card p-5'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h2 className='text-sm font-semibold'>Key 使用规则</h2>
        <p className='text-xs text-muted-foreground'>
          有效期：
          {keyInfo.expires_at ? date(keyInfo.expires_at) : '未设置到期时间'}
        </p>
      </div>
      <div className='mt-4 flex flex-wrap gap-x-8 gap-y-3 text-sm text-muted-foreground'>
        <span>
          请求额度：
          {keyInfo.quota_requests > 0
            ? `${number(keyInfo.quota_requests_used)} / ${number(keyInfo.quota_requests)}`
            : '无限制'}
        </span>
        {limits.map((window) => (
          <span key={window.window}>
            {window.window} 额度：
            {window.limit_usd > 0
              ? `${usd(budgetWindowUsed(window))} / ${usd(window.limit_usd)}`
              : '无限制'}
          </span>
        ))}
        <span>额度设为 0 表示无限制，配置调整请联系管理员</span>
      </div>
    </section>
  )
}

function UsageDetails({
  usage,
  employeeKey,
}: {
  usage: EmployeeUsage
  employeeKey: string
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const totals = usage.totals
  const categories = [
    ['普通输入', totals.input_tokens, totals.input_cost],
    ['模型输出', totals.output_tokens, totals.output_cost],
    ['缓存读取', totals.cache_read_tokens, totals.cache_read_cost],
    ['缓存写入', totals.cache_creation_tokens, totals.cache_creation_cost],
  ] as const
  return (
    <div className='grid gap-6 xl:grid-cols-2'>
      <section className='rounded-lg border bg-card p-5 sm:p-6'>
        <h2 className='mb-5 text-base font-semibold'>消耗明细</h2>
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead>
              <tr className='border-b text-left text-xs text-muted-foreground'>
                <th className='pb-3 font-normal'>类型</th>
                <th className='pb-3 text-right font-normal'>Tokens</th>
                <th className='pb-3 text-right font-normal'>折算费用</th>
              </tr>
            </thead>
            <tbody>
              {categories.map(([label, tokens, cost]) => (
                <tr className='border-b last:border-0' key={label}>
                  <td className='py-3'>{label}</td>
                  <td className='py-3 text-right text-muted-foreground tabular-nums'>
                    {number(tokens)}
                  </td>
                  <td className='py-3 text-right tabular-nums'>{usd(cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totals.web_search_cost > 0 && (
          <p className='mt-4 text-xs text-muted-foreground'>
            服务端搜索另计：{usd(totals.web_search_cost)}
          </p>
        )}
        <p className='mt-4 text-xs text-muted-foreground'>
          Key 额度扣减 {usd(totals.budget_cost_usd)}
          ，可能包含管理员设置的分组倍率。
        </p>
      </section>
      <section className='rounded-lg border bg-card p-5 sm:p-6'>
        <h2 className='mb-5 text-base font-semibold'>模型使用</h2>
        {usage.models.length ? (
          <div className='space-y-5'>
            {usage.models.map((model) => (
              <div key={model.name}>
                <div className='flex items-center justify-between gap-3 text-sm'>
                  <span className='truncate'>{model.name}</span>
                  <span className='shrink-0 text-muted-foreground tabular-nums'>
                    {number(model.requests)} 次 · {usd(model.official_cost_usd)}
                  </span>
                </div>
                <div className='mt-2 h-1 bg-muted'>
                  <div
                    className='h-full bg-foreground/50'
                    style={{
                      width: `${(model.requests / Math.max(1, totals.requests)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className='py-10 text-center text-sm text-muted-foreground'>
            此时间范围内还没有请求记录。
          </p>
        )}
      </section>
      <section className='rounded-lg border bg-card p-5 sm:p-6 xl:col-span-2'>
        <h2 className='mb-5 text-base font-semibold'>每日用量</h2>
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[520px] text-sm'>
            <thead>
              <tr className='border-b text-left text-xs text-muted-foreground'>
                <th className='pb-3 font-normal'>日期（上海）</th>
                <th className='pb-3 text-right font-normal'>请求</th>
                <th className='pb-3 text-right font-normal'>
                  Tokens（含缓存）
                </th>
                <th className='pb-3 text-right font-normal'>折算费用</th>
                <th className='pb-3 text-right font-normal'>请求详情</th>
              </tr>
            </thead>
            <tbody>
              {[...usage.history].reverse().map((day) => (
                <tr className='border-b last:border-0' key={day.day}>
                  <td className='py-3'>{day.day}</td>
                  <td className='py-3 text-right tabular-nums'>
                    {number(day.requests)}
                  </td>
                  <td className='py-3 text-right tabular-nums'>
                    {number(
                      day.input_tokens +
                        day.output_tokens +
                        day.cache_read_tokens +
                        day.cache_creation_tokens
                    )}
                  </td>
                  <td className='py-3 text-right tabular-nums'>
                    {usd(day.official_cost_usd)}
                  </td>
                  <td className='py-3 text-right'>
                    <Button
                      variant='ghost'
                      size='sm'
                      aria-label={`查看 ${day.day} 请求详情`}
                      onClick={() => setSelectedDay(day.day)}
                    >
                      查看详情
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!usage.history.length && (
            <p className='py-8 text-center text-sm text-muted-foreground'>
              尚无用量记录
            </p>
          )}
        </div>
      </section>
      {selectedDay && (
        <DayRequestsDialog
          key={selectedDay}
          day={selectedDay}
          employeeKey={employeeKey}
          onClose={() => setSelectedDay(null)}
        />
      )}
    </div>
  )
}
