import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type BatchStatistics = {
  batch: string
  started: number
  active: number
  stopped: number
  medianSurvivalDays: number | null
}

const days = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })

export function VmBatchStatistics() {
  const query = useQuery({
    queryKey: ['panel', 'statistics', 'vm-batches'],
    queryFn: () => api<BatchStatistics[]>('/api/panel/statistics/vm-batches'),
    refetchInterval: 60_000,
  })
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>VM 批次存活周期</CardTitle>
        <p className='text-xs text-muted-foreground'>
          仅统计已登记交付批次且有成功请求的 VM，含历史关机记录。中位数按已关机
          VM 计算。
        </p>
      </CardHeader>
      <CardContent>
        {query.data ? (
          <Table density='compact'>
            <TableHeader>
              <TableRow>
                <TableHead>批次</TableHead>
                <TableHead className='text-end'>接单台数</TableHead>
                <TableHead className='text-end'>在役台数</TableHead>
                <TableHead className='text-end'>已关机台数</TableHead>
                <TableHead className='text-end'>中位存活天数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.map((row) => (
                <TableRow key={row.batch} className='tabular-nums'>
                  <TableHead scope='row'>{row.batch}</TableHead>
                  <TableCell className='text-end'>{row.started}</TableCell>
                  <TableCell className='text-end'>{row.active}</TableCell>
                  <TableCell className='text-end'>{row.stopped}</TableCell>
                  <TableCell className='text-end'>
                    {row.medianSurvivalDays == null
                      ? '—'
                      : days.format(row.medianSurvivalDays)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className='text-sm text-muted-foreground' role='status'>
            {query.isPending ? '正在加载…' : '批次统计暂不可用'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
