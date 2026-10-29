import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { getVm } from '../vm/vm-registry.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import { runtimeKind } from '../vm/runtime-kind.mjs'
import { AUDIT_SITES, AUDIT_EVIDENCE, AUDIT_CRITERIA, evaluateAudit } from '../vm/egress-audit-rules.mjs'
import { readAuditPage } from '../vm/egress-audit-dom.mjs'
import { runAuditGuest } from '../vm/egress-audit-guest.mjs'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/
const MAX_IMAGE = 5 * 1024 * 1024
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex')
const NODE_LAUNCH =
  'for n in /usr/local/bin/node /usr/local/lib/nodejs/current/bin/node /usr/bin/node node; do if command -v "$n" >/dev/null 2>&1 && [ "$("$n" -e \'if (!process.versions.bun && Number(process.versions.node.split(".")[0]) >= 18) process.stdout.write("kin-audit-node")\' 2>/dev/null)" = kin-audit-node ]; then exec "$n" --input-type=module -; fi; done; exit 127'

function fault(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status })
}
function id(value) {
  if (!SAFE_ID.test(value || '')) throw fault('invalid_audit_id', '检测标识不合法', 400)
  return value
}
function fingerprint(vm) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        vm.proxy,
        vm.proxy_cli_enabled,
        vm.timezone,
        vm.node_id,
        vm.runtime?.type,
        vm.runtime?.container,
        vm.runtime?.user,
        vm.machine,
      ]),
    )
    .digest('hex')
}
function ownedDir(dir) {
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())
    throw fault('audit_storage_invalid', '检测目录不能是符号链接', 500)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Only the fixed guest program is piped into the slot. No secrets in argv or output. */
export async function executeAuditGuest(vm, onEvent, { noSandbox = false } = {}) {
  const host = slotHost(vm)
  if (host.native) throw fault('audit_runtime_unsupported', '暂不支持 macOS 原生槽位')
  const script = `(${runAuditGuest.toString()})({ sites: ${JSON.stringify(AUDIT_SITES)}, readPage: ${readAuditPage.toString()}, noSandbox: ${noSandbox === true} }).catch(() => process.exit(1))`
  const env = host.dockerEnv()
  const args = slotExecArgv(vm, ['sh', '-c', NODE_LAUNCH], { interactive: true, user: host.execUser(vm) })
  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { ...(env ? { env } : {}), stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let size = 0
    let eventError = null
    const timer = setTimeout(() => {
      eventError = fault('audit_timeout', '检测执行超时')
      child.kill('SIGTERM')
    }, 165000)
    child.stdin.on('error', () => {})
    child.stderr.resume()
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 32 * 1024 * 1024) {
        eventError = fault('audit_output_limit', '检测结果超出大小限制')
        child.kill('SIGTERM')
        return
      }
      buffer += chunk.toString('utf8')
      for (;;) {
        const pos = buffer.indexOf('\n')
        if (pos < 0) break
        const line = buffer.slice(0, pos)
        buffer = buffer.slice(pos + 1)
        try {
          const event = JSON.parse(line)
          if (event.kind === 'error') eventError = fault(event.code, event.message)
          else if (!eventError) onEvent(event)
        } catch (error) {
          eventError = error.code ? error : fault('audit_invalid_output', 'VM 返回了无法解析的检测结果')
        }
      }
    })
    child.once('error', () => {
      clearTimeout(timer)
      reject(fault('audit_exec_failed', '无法连接 VM 的槽内执行通道'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (eventError) reject(eventError)
      else if (code === 127)
        reject(
          fault(
            'audit_node_missing',
            'VM 内缺少标准 Node.js 运行时；cc-node / cli-node 不是 Node 解释器，请更新检测镜像',
          ),
        )
      else if (code !== 0 || buffer.trim())
        reject(fault('audit_exec_failed', 'VM 检测进程未正常结束，请检查 VM 状态与 Node 运行时'))
      else resolve()
    })
    child.stdin.end(script)
  })
}

export function createEgressAuditService({
  projectRoot,
  dataDir = path.join(projectRoot, 'data'),
  readVm = getVm,
  execute = executeAuditGuest,
  noSandbox = process.env.KIN_EGRESS_AUDIT_NO_SANDBOX === 'true',
} = {}) {
  const root = path.join(dataDir, 'egress-audits')
  const active = new Map()
  const vmRecord = (vmId) => {
    id(vmId)
    const vm = readVm(projectRoot, vmId)
    if (!vm) throw fault('vm_not_found', 'VM 不存在', 404)
    return vm
  }
  const vmDir = (vmId) => path.join(root, id(vmId))
  const jobDir = (vmId, jobId) => path.join(vmDir(vmId), id(jobId))
  const save = (report) => {
    ownedDir(root)
    ownedDir(vmDir(report.vm_id))
    const dir = ownedDir(jobDir(report.vm_id, report.id))
    const temp = path.join(dir, `${crypto.randomUUID()}.tmp`)
    fs.writeFileSync(temp, JSON.stringify(report), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, path.join(dir, 'report.json'))
  }
  const publicReport = (report, vm) => {
    const { _fingerprint, ...view } = report
    const stale = _fingerprint !== fingerprint(vm)
    const interrupted = report.state === 'running' && active.get(vm.id)?.id !== report.id
    const evidenceComplete = AUDIT_EVIDENCE.every((item) => !!report.sites?.[item.site]?.[item.field])
    return {
      ...view,
      stale,
      evidence_complete: evidenceComplete,
      state: interrupted ? 'interrupted' : report.state,
      verdict:
        stale || interrupted || report.state !== 'completed' || (report.verdict === 'pass' && !evidenceComplete)
          ? 'unknown'
          : report.verdict,
    }
  }
  const load = (vmId, jobId) => {
    const dir = jobDir(vmId, jobId)
    if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) throw fault('audit_not_found', '检测记录不存在', 404)
    const file = path.join(dir, 'report.json')
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink())
      throw fault('audit_not_found', '检测记录不存在', 404)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  function list(vmId) {
    const vm = vmRecord(vmId)
    const dir = vmDir(vmId)
    if (!fs.existsSync(dir)) return { criteria: AUDIT_CRITERIA, reports: [] }
    if (fs.lstatSync(dir).isSymbolicLink()) throw fault('audit_storage_invalid', '检测目录无效', 500)
    const reports = fs
      .readdirSync(dir)
      .filter((name) => SAFE_ID.test(name))
      .flatMap((jobId) => {
        try {
          return [publicReport(load(vmId, jobId), vm)]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
    return { criteria: AUDIT_CRITERIA, reports }
  }
  async function finish(report, vm) {
    try {
      await execute(
        vm,
        (event) => {
          if (event.kind !== 'site' || !AUDIT_SITES.some((site) => site.id === event.site))
            throw fault('audit_invalid_output', '未知检测站点')
          if (report.sites[event.site]) throw fault('audit_invalid_output', '检测站点重复返回')
          const observation = event.observation
          if (
            !observation ||
            typeof observation !== 'object' ||
            Array.isArray(observation) ||
            JSON.stringify(observation).length > 32000
          )
            throw fault('audit_invalid_output', '站点结果无效')
          const images = {}
          for (const evidence of AUDIT_EVIDENCE.filter((item) => item.site === event.site)) {
            images[evidence.field] = null
            if (typeof event[evidence.field] !== 'string') continue
            const image = Buffer.from(event[evidence.field], 'base64')
            if (image.length > 0 && image.length <= MAX_IMAGE && image.subarray(0, 8).equals(PNG_HEADER)) {
              images[evidence.field] = `${evidence.id}.png`
              fs.writeFileSync(path.join(jobDir(report.vm_id, report.id), images[evidence.field]), image, {
                flag: 'wx',
                mode: 0o600,
              })
            }
          }
          report.sites[event.site] = { ...observation, ...images }
          save(report)
        },
        { noSandbox: report.browser_sandbox === false },
      )
      const evaluation = evaluateAudit(report.sites)
      report.results = evaluation.results
      report.exit_consistent = evaluation.exit_consistent
      const completeEvidence = AUDIT_EVIDENCE.every((item) => !!report.sites[item.site]?.[item.field])
      report.verdict = evaluation.status === 'pass' && !completeEvidence ? 'unknown' : evaluation.status
      report.state = 'completed'
    } catch (error) {
      report.state = 'error'
      report.error = {
        code: error.code || 'audit_failed',
        message: error.code ? error.message : '检测执行失败，未确认达标',
      }
      report.results = evaluateAudit(report.sites).results
      report.verdict = 'unknown'
    } finally {
      report.finished_at = new Date().toISOString()
      try {
        save(report)
      } finally {
        active.delete(report.vm_id)
      }
    }
  }
  function start(vmId, { noSandbox: requestedNoSandbox } = {}) {
    if (requestedNoSandbox !== undefined && typeof requestedNoSandbox !== 'boolean')
      throw fault('invalid_audit_mode', 'no_sandbox 必须为布尔值', 400)
    const vm = vmRecord(vmId)
    if (active.has(vmId)) throw fault('audit_running', '该 VM 正在检测中')
    if (active.size >= 2) throw fault('audit_busy', '最多同时检测两个 VM，请稍后重试', 429)
    if (!hasBoundExit(vm.proxy)) throw fault('audit_proxy_required', '请先为 VM 绑定出口代理')
    if (slotHost(vm).native) throw fault('audit_runtime_unsupported', '暂不支持 macOS 原生槽位')
    // Bounded retention: only this feature's owned reports are removed; no VM files touched.
    const old = list(vmId).reports
    for (const report of old.slice(4)) fs.rmSync(jobDir(vmId, report.id), { recursive: true })
    const report = {
      id: crypto.randomUUID(),
      vm_id: vmId,
      state: 'running',
      verdict: 'unknown',
      started_at: new Date().toISOString(),
      finished_at: null,
      proxy_id: vm.proxy.id || null,
      node_id: vm.node_id || null,
      runtime: runtimeKind(vm),
      timezone: vm.timezone || null,
      browser_sandbox: !(requestedNoSandbox ?? noSandbox),
      _fingerprint: fingerprint(vm),
      sites: {},
      results: evaluateAudit().results,
      exit_consistent: null,
      error: null,
    }
    save(report)
    active.set(vmId, report)
    // The route returns 202 immediately; all completion errors are recorded in the report.
    void finish(report, structuredClone(vm)).catch(() => {})
    return publicReport(report, vm)
  }
  function screenshot(vmId, jobId, siteId) {
    vmRecord(vmId)
    const evidence = AUDIT_EVIDENCE.find((item) => item.id === siteId)
    if (!evidence) throw fault('audit_not_found', '截图不存在', 404)
    const report = load(vmId, jobId)
    const filename = report.sites?.[evidence.site]?.[evidence.field]
    if (filename !== `${siteId}.png`) throw fault('audit_not_found', '截图不存在', 404)
    const file = path.join(jobDir(vmId, jobId), filename)
    if (fs.lstatSync(file).isSymbolicLink()) throw fault('audit_not_found', '截图不存在', 404)
    return fs.readFileSync(file)
  }
  return { list, start, screenshot }
}
