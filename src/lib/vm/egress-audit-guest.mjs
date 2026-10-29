/** Self-contained: serialized into the target slot over stdin, no npm packages in the guest. */
export async function runAuditGuest({
  sites,
  readPage,
  noSandbox = false,
  browserExecutable = null,
  profileParent = null,
  traceStderr = false,
  displayExecutable = null,
}) {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawn } = await import('node:child_process')
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
  ]
  const executable = (browserExecutable ? [browserExecutable] : candidates).find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  if (!executable) {
    emit({
      kind: 'error',
      code: 'browser_missing',
      message: 'VM 内未安装 Chromium / Chrome；请使用带检测浏览器的槽位镜像。',
    })
    return
  }
  const cache = profileParent || path.join(os.homedir(), '.cache')
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
  const profile = fs.mkdtempSync(path.join(cache, 'kin-egress-audit-'))
  let displayServer = null
  let display = null
  const xvfb = (displayExecutable ? [displayExecutable] : ['/usr/bin/Xvfb']).find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  if (xvfb) {
    displayServer = spawn(xvfb, ['-displayfd', '1', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp', '-noreset'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    try {
      display = await new Promise((resolve, reject) => {
        let output = ''
        const timer = setTimeout(() => reject(new Error('display_start_failed')), 10000)
        const finish = (fn, value) => {
          clearTimeout(timer)
          fn(value)
        }
        displayServer.once('error', () => finish(reject, new Error('display_start_failed')))
        displayServer.once('exit', () => finish(reject, new Error('display_start_failed')))
        displayServer.stdout.on('data', (chunk) => {
          output += chunk.toString()
          if (/^\d+\n$/.test(output)) finish(resolve, `:${output.trim()}`)
          else if (output.length > 32) finish(reject, new Error('display_start_failed'))
        })
      })
    } catch {
      displayServer.kill('SIGKILL')
      fs.rmSync(profile, { recursive: true, force: true })
      emit({ kind: 'error', code: 'display_start_failed', message: '检测虚拟显示启动失败，请检查 Xvfb 与 XKB 依赖。' })
      return
    }
  }
  const browserMode = display ? 'headed' : 'headless'
  const documentResponses = new Map()
  const browser = spawn(
    executable,
    [
      ...(display ? [] : ['--headless=new']),
      '--remote-debugging-pipe',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      ...(noSandbox ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
    },
  )
  let closed = false
  let sequence = 0
  let buffer = Buffer.alloc(0)
  const pending = new Map()
  const rejectAll = (error) => {
    closed = true
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }
  browser.on('error', () => rejectAll(new Error('browser_launch_failed')))
  browser.on('exit', () => rejectAll(new Error('browser_exited')))
  // Browser stderr is deliberately not returned: it can contain environment paths.
  if (traceStderr) browser.stderr.pipe(process.stderr)
  else browser.stderr.resume()
  browser.stdio[3].on('error', () => rejectAll(new Error('browser_pipe_failed')))
  browser.stdio[4].on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 12 * 1024 * 1024) {
      rejectAll(new Error('browser_response_too_large'))
      return
    }
    for (;;) {
      const end = buffer.indexOf(0)
      if (end < 0) break
      const raw = buffer.subarray(0, end).toString()
      buffer = buffer.subarray(end + 1)
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        continue
      }
      if (msg.method === 'Network.responseReceived' && msg.params?.type === 'Document') {
        const response = msg.params.response
        documentResponses.set(msg.sessionId, { status: response.status, mime_type: response.mimeType })
      }
      const waiter = pending.get(msg.id)
      if (!waiter) continue
      clearTimeout(waiter.timer)
      pending.delete(msg.id)
      if (msg.error)
        waiter.reject(
          Object.assign(new Error('browser_command_failed'), {
            command: waiter.method,
            detail: String(msg.error.message || '').slice(0, 300),
          }),
        )
      else waiter.resolve(msg.result)
    }
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('browser_closed'))
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error('browser_command_timeout'), { command: method }))
      }, 12000)
      pending.set(id, { resolve, reject, timer, method })
      browser.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
    })
  const evaluate = async (expression, session) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)
    if (result.exceptionDetails) throw new Error('page_evaluation_failed')
    return result.result?.value
  }
  const shutdown = async () => {
    rejectAll(new Error('audit_finished'))
    if (browser.exitCode === null && browser.signalCode === null) {
      browser.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), sleep(1500)])
      if (browser.exitCode === null && browser.signalCode === null) {
        browser.kill('SIGKILL')
        await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), sleep(1000)])
      }
    }
    if (displayServer && displayServer.exitCode === null && displayServer.signalCode === null) {
      displayServer.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => displayServer.once('exit', resolve)), sleep(1000)])
      if (displayServer.exitCode === null && displayServer.signalCode === null) displayServer.kill('SIGKILL')
    }
    fs.rmSync(profile, { recursive: true, force: true })
  }
  // Covers a lost docker CLI/SSH connection as well as stalled pages.
  const deadline = setTimeout(() => {
    void shutdown().finally(() => process.exit(1))
  }, 150000)
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(1))
  })
  try {
    await send('Browser.getVersion')
    for (const site of sites) {
      let targetId
      let session
      let observation = { complete: false, error: 'navigation_failed' }
      let screenshot = null
      let leaksScreenshot = null
      try {
        ;({ targetId } = await send('Target.createTarget', { url: 'about:blank' }))
        ;({ sessionId: session } = await send('Target.attachToTarget', { targetId, flatten: true }))
        await send('Page.enable', {}, session)
        await send('Network.enable', {}, session)
        await send(
          'Emulation.setDeviceMetricsOverride',
          { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
          session,
        )
        const nav = await send('Page.navigate', { url: site.url }, session)
        if (nav.errorText) throw Object.assign(new Error('navigation_failed'), { detail: nav.errorText })
        const until = Date.now() + 35000
        let triggered = site.id !== 'fuck-claude'
        while (Date.now() < until) {
          try {
            // Retry only the initial Start scan button after page scripts are ready.
            if (!triggered) {
              triggered = await evaluate(
                `(() => { const b = document.querySelector('#retest'); if (document.readyState !== 'complete' || !b || b.disabled || !/start\\s*scan|开始.*(?:检测|扫描|测试)/i.test(b.innerText)) return false; b.click(); return false })()`,
                session,
              )
            }
            observation = await evaluate(`(${readPage.toString()})(${JSON.stringify(site.id)})`, session)
            const finished =
              site.id === 'net-coffee'
                ? observation?.complete && observation.dns?.complete && observation.webrtc?.complete
                : site.id === 'ping0'
                  ? observation?.complete &&
                    typeof observation.purity_green === 'boolean' &&
                    typeof observation.ai_green === 'boolean'
                  : observation?.complete
            // Let the site's own automatic verification finish; never click or solve a challenge.
            if (finished) break
            if (observation?.error === 'empty_response' && Date.now() > until - 32000) break
          } catch {
            /* Wait for the new document, never read the previous page. */
          }
          await sleep(500)
        }
        if (!observation?.complete && !observation?.error) observation.error = 'result_timeout'
      } catch (error) {
        observation = {
          complete: false,
          error: error.message === 'navigation_failed' ? 'navigation_failed' : 'browser_command_failed',
          command: error.command || null,
          detail: error.detail || error.message,
        }
      }
      observation.browser_mode = browserMode
      if (documentResponses.has(session)) observation.response = documentResponses.get(session)
      if (session) {
        try {
          const layout = await send('Page.getLayoutMetrics', {}, session)
          const height = Math.min(12000, Math.max(1000, Math.ceil(layout.cssContentSize?.height || 1000)))
          const shot = await send(
            'Page.captureScreenshot',
            {
              format: 'png',
              captureBeyondViewport: true,
              clip: { x: 0, y: 0, width: 1440, height, scale: 1 },
            },
            session,
          )
          if (shot.data?.length <= 7 * 1024 * 1024) screenshot = shot.data
          if (site.id === 'net-coffee') {
            const clip = await evaluate(
              `(() => {
              const cards = ['#dnsLeakContent', '#udpLeakContent'].map(s => document.querySelector(s)).filter(Boolean).map(e => (e.closest('.card') || e).getBoundingClientRect());
              if (cards.length !== 2) return null;
              const y = Math.max(0, Math.floor(Math.min(...cards.map(r => r.top)) + scrollY - 12));
              return {x: 0, y, width: 1440, height: Math.min(12000, Math.max(1, Math.ceil(Math.max(...cards.map(r => r.bottom)) + scrollY + 12 - y))), scale: 1};
            })()`,
              session,
            )
            if (clip) {
              const leaks = await send(
                'Page.captureScreenshot',
                { format: 'png', captureBeyondViewport: true, clip },
                session,
              )
              if (leaks.data?.length <= 7 * 1024 * 1024) leaksScreenshot = leaks.data
            }
          }
        } catch (error) {
          observation.screenshot_error = { command: error.command || null, detail: error.detail || error.message }
          /* A screenshot failure must not become a pass in the controller. */
        }
      }
      emit({
        kind: 'site',
        site: site.id,
        observation,
        screenshot,
        ...(site.id === 'net-coffee' ? { leaks_screenshot: leaksScreenshot } : {}),
      })
      documentResponses.delete(session)
      if (targetId) await send('Target.closeTarget', { targetId }).catch(() => {})
    }
  } catch {
    emit({
      kind: 'error',
      code: 'browser_launch_failed',
      message: 'VM 内浏览器启动失败，请检查依赖、沙箱支持和可用内存。',
    })
  } finally {
    clearTimeout(deadline)
    await shutdown()
  }
}
