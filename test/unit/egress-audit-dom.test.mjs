import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runAuditGuest } from '../../src/lib/vm/egress-audit-guest.mjs'
import { readAuditPage } from '../../src/lib/vm/egress-audit-dom.mjs'

const browser = [
  '/usr/lib/chromium/chromium',
  '/usr/bin/chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find(fs.existsSync)
const layout = (risk = 'limegreen', ai = 'green', extra = '') =>
  `<div>203.0.113.7</div><div class="line-risk"><div class="riskitem" style="background:green">Unused safe legend</div><div class="riskcurrent" style="background:${risk}">20% 纯净</div></div><div class="line-sceneinfo"><div class="scene-card"><span class="scene-name">AI 应用</span><div class="advice level-4" style="color:${ai}">✅ 适合</div></div>${extra}</div>`
const cases = [
  {
    name: 'current bands use selected background and AI advice color',
    html: layout(),
    expected: { complete: true, purity_green: true, ai_green: true, ip: '203.0.113.7' },
  },
  {
    name: 'green unused legend cannot hide a red selected risk band',
    html: layout('red'),
    expected: { complete: true, purity_green: false },
  },
  {
    name: 'yellow AI advice is not green',
    html: layout('limegreen', 'orange'),
    expected: { complete: true, ai_green: false },
  },
  {
    name: 'neutral color remains unknown',
    html: layout('#999', '#999'),
    expected: { purity_green: null, ai_green: null },
  },
  {
    name: 'duplicate AI cards remain unknown',
    html: layout(
      'limegreen',
      'green',
      '<div class="scene-card"><span class="scene-name">AI 应用</span><div class="advice" style="color:green">适合</div></div>',
    ),
    expected: { complete: false, error: 'unsupported_layout' },
  },
  {
    name: 'missing scene card remains unknown',
    html: '<div>203.0.113.7</div><div class="line-risk"><div class="riskcurrent" style="background:green">纯净</div></div>',
    expected: { complete: false },
  },
  {
    name: 'legacy labeled fields remain supported',
    html: '<div>203.0.113.7</div><div><span>风控值</span><span style="color:green">12 纯净</span></div><div><span>AI</span><span style="color:green">适用</span></div>',
    expected: { complete: true, purity_green: true, ai_green: true },
  },
  {
    name: 'empty HTML is not unsupported layout or a network failure',
    html: '',
    expected: { complete: false, error: 'empty_response' },
  },
  {
    name: 'textless Turnstile is a challenge',
    html: '<div id="captcha-element" class="cf-turnstile"></div>',
    expected: { complete: false, error: 'challenge_required' },
  },
  {
    name: 'unknown navigation cannot certify an exit',
    html: '<nav>AI 查询</nav>',
    expected: { complete: false, error: 'unsupported_layout' },
  },
]

test('Ping0 DOM regressions in a real browser', { skip: !browser, timeout: 45000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-dom-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const html = `<!doctype html><html><body><script>addEventListener('load',()=>{const read=${readAuditPage.toString()};const cases=${JSON.stringify(cases)};const results=[];for(const c of cases){document.body.innerHTML=c.html;results.push({name:c.name,actual:read('ping0'),expected:c.expected})}document.body.innerHTML='<pre id="results"></pre>';document.querySelector('#results').textContent=JSON.stringify(results)})</script></body></html>`
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const reader = function () {
    const el = document.querySelector('#results')
    return { complete: !!el, checks: el ? JSON.parse(el.textContent) : [] }
  }
  const program = `await (${runAuditGuest.toString()})({sites:[{id:'dom-check',url:${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)}}],readPage:${reader.toString()},browserExecutable:${JSON.stringify(browser)},profileParent:${JSON.stringify(tmp)}})`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], {
    timeout: 40000,
    maxBuffer: 12 * 1024 * 1024,
  })
  const events = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const result = events.find((e) => e.kind === 'site')
  assert.equal(result?.observation.complete, true, JSON.stringify(events.map(({ screenshot, ...e }) => e)))
  assert.equal(result.observation.checks.length, cases.length)
  for (const { name, actual, expected } of result.observation.checks)
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${name}: ${key}`)
  assert.deepEqual(result.observation.response, { status: 200, mime_type: 'text/html' })
  assert.equal(fs.readdirSync(tmp).length, 0, 'browser profile must be cleaned')
})

test('failed virtual display cleans the owned profile and reports an explicit error', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-display-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const program = `await (${runAuditGuest.toString()})({sites:[],readPage:()=>({}),browserExecutable:process.execPath,displayExecutable:process.execPath,profileParent:${JSON.stringify(tmp)}})`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], {
    timeout: 15000,
  })
  const events = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    events.map((event) => [event.kind, event.code]),
    [['error', 'display_start_failed']],
  )
  assert.equal(fs.readdirSync(tmp).length, 0)
})
