/** Owned local artifacts only. Never starts src/server.mjs or reads deployment credentials. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = path.join(root, '.local/company-tests')
const marker = path.join(sandbox, 'owner.json')
const command = process.argv[2] || 'status'

function ensure() {
  for (const dir of [path.join(root, '.local'), sandbox]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing symlink: ${dir}`)
  }
  if (fs.existsSync(sandbox) && !fs.existsSync(marker) && fs.readdirSync(sandbox).length)
    throw new Error('Unmarked nonempty sandbox; refusing ownership')
  fs.mkdirSync(sandbox, { recursive: true, mode: 0o700 })
  if (fs.existsSync(marker) && fs.lstatSync(marker).isSymbolicLink()) throw new Error('Refusing symlink marker')
  if (!fs.existsSync(marker))
    fs.writeFileSync(marker, JSON.stringify({ project: root, purpose: 'company-local-tests' }))
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8'))
  if (owner.project !== root || owner.purpose !== 'company-local-tests') throw new Error('Sandbox ownership mismatch')
  for (const dir of ['tmp', 'data', 'logs', 'artifacts']) fs.mkdirSync(path.join(sandbox, dir), { recursive: true })
}

function record(action, details = {}) {
  fs.appendFileSync(
    path.join(sandbox, 'actions.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), action, ...details }) + '\n',
  )
}

export function processIdentity(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

async function stop() {
  const processFile = path.join(sandbox, 'server.json')
  if (fs.existsSync(processFile)) {
    const proc = JSON.parse(fs.readFileSync(processFile, 'utf8'))
    const current = processIdentity(proc.pid)
    if (current && current === proc.identity && current.includes('company-local.mjs serve')) {
      process.kill(proc.pid, 'SIGTERM')
      for (let i = 0; i < 30 && processIdentity(proc.pid) === current; i++)
        await new Promise((resolve) => setTimeout(resolve, 100))
      if (processIdentity(proc.pid) === current) throw new Error('Local server did not stop; artifacts preserved')
    } else if (current) throw new Error('PID no longer matches our server; stop refused, artifacts preserved')
    fs.rmSync(processFile)
  }
}

async function clean() {
  if (!fs.existsSync(sandbox)) return console.log('No company test artifacts.')
  ensure()
  await stop()
  fs.rmSync(sandbox, { recursive: true, force: true })
  console.log('Removed only .local/company-tests (including its owned local server).')
}

function run(name, executable, args, cwd = root) {
  const log = path.join(sandbox, 'logs', `${Date.now()}-${name}.log`)
  record('start', { name, executable, args, outputs: [log], cwd })
  const env = {
    ...process.env,
    KIN_DATA_DIR: path.join(sandbox, 'data'),
    TMPDIR: path.join(sandbox, 'tmp'),
    COMPANY_TEST_ROOT: sandbox,
    TSR_TMP_DIR: path.join(sandbox, 'router-tmp'),
  }
  // These tasks never use actual env credentials or external service URLs.
  for (const key of Object.keys(env))
    if (/^(VM2API_|KIN_|ANTHROPIC_|OPENAI_)/.test(key) && key !== 'KIN_DATA_DIR') delete env[key]
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''))
  record('finish', { name, exit_code: result.status, log })
  console.log(`${name}: exit ${result.status}; ${path.relative(root, log)}`)
  if (result.status !== 0) {
    console.error((result.stdout || '').slice(-10000), (result.stderr || '').slice(-3000))
    process.exitCode = 1
    return false
  }
  return true
}

if (command === 'cleanup') await clean()
else {
  ensure()
  const viteConfig = path.join(sandbox, 'vite.config.mjs')
  if (command === 'build' || command === 'web-test') {
    fs.writeFileSync(
      viteConfig,
      `import base from ${JSON.stringify(new URL('../web/vite.config.ts', import.meta.url).href)}; export default {...base, cacheDir:${JSON.stringify(path.join(sandbox, 'vite-cache'))}};`,
    )
  }
  if (command === 'status') console.log(JSON.stringify({ root: sandbox, outputs: fs.readdirSync(sandbox) }, null, 2))
  else if (command === 'stop') await stop()
  else if (command === 'record') record(process.argv[3] || 'manual', { note: process.argv.slice(4).join(' ') })
  else if (command === 'test') {
    const bootstrap = path.join(sandbox, 'offline.mjs')
    fs.writeFileSync(
      bootstrap,
      `import {setPriceCatalogTestHooks} from ${JSON.stringify(new URL('../src/lib/admin/price-catalog.mjs', import.meta.url).href)}; setPriceCatalogTestHooks({backgroundRefresh:false}); globalThis.fetch=async()=>{throw new Error('External fetch disabled in local tests')};`,
    )
    const files = process.argv.slice(3)
    const targets = files.length
      ? files
      : [
          'company-employee',
          'company-usage',
          'company-reset',
          'company-local',
          'company-admin',
          'key-scope',
          'panel-acl',
          'claude-reset-credits',
          'tenant-billing',
          'panel-route-coverage',
          'panel-tenant-guards',
          'api-keys',
          'pricing',
        ]
    for (const file of targets) if (!/^[a-z0-9-]+$/.test(file)) throw new Error('Expected unit test basename')
    for (const file of targets)
      if (!run(file, process.execPath, ['--import', bootstrap, '--test', `test/unit/${file}.test.mjs`])) break
  } else if (command === 'format' || command === 'check') {
    const backend = [
      'src/company',
      'src/server.mjs',
      'src/lib/admin/panel-api.mjs',
      'scripts/company-local.mjs',
      'scripts/company-sandbox.mjs',
      'scripts/company-panel.mjs',
      'scripts/company-reset-review.mjs',
      ...fs
        .readdirSync(path.join(root, 'test/unit'))
        .filter((name) => name.startsWith('company-'))
        .map((name) => `test/unit/${name}`),
    ]
    const frontend = [
      'src/features/company',
      'src/routes/employee.tsx',
      'src/features/keys/index.tsx',
      'src/features/keys/key-limits-dialog.tsx',
      'src/features/keys/key-payload.ts',
      'src/features/keys/key-payload.test.ts',
      'src/types/panel-keys.ts',
    ]
    run('backend-format', process.execPath, [
      'node_modules/@biomejs/biome/bin/biome',
      'format',
      ...(command === 'format' ? ['--write'] : []),
      ...backend,
    ])
    run(
      'frontend-format',
      process.execPath,
      ['node_modules/prettier/bin/prettier.cjs', command === 'format' ? '--write' : '--check', ...frontend],
      path.join(root, 'web'),
    )
    if (command === 'check')
      run('frontend-lint', process.execPath, ['node_modules/eslint/bin/eslint.js', ...frontend], path.join(root, 'web'))
  } else if (command === 'web-test')
    run(
      'web-test',
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        viteConfig,
        '--configLoader',
        'runner',
        ...process.argv.slice(3),
      ],
      path.join(root, 'web'),
    )
  else if (command === 'build') {
    // tsbuildinfo is also written inside the owned sandbox, never into shared node_modules.
    if (
      run(
        'build',
        process.execPath,
        [
          'node_modules/vite/bin/vite.js',
          'build',
          '--config',
          viteConfig,
          '--configLoader',
          'runner',
          '--outDir',
          path.join(sandbox, 'site/web/dist'),
          '--emptyOutDir',
        ],
        path.join(root, 'web'),
      )
    ) {
      run(
        'typecheck',
        process.execPath,
        [
          'node_modules/typescript/bin/tsc',
          '-p',
          'tsconfig.app.json',
          '--incremental',
          '--tsBuildInfoFile',
          path.join(sandbox, 'app.tsbuildinfo'),
        ],
        path.join(root, 'web'),
      )
    }
  } else if (command === 'serve') {
    const processFile = path.join(sandbox, 'server.json')
    if (fs.existsSync(processFile)) {
      const prior = JSON.parse(fs.readFileSync(processFile, 'utf8'))
      if (processIdentity(prior.pid) === prior.identity) throw new Error('Local acceptance server already running')
    }
    record('serve', { outputs: ['data/demo.db', 'fixture/', 'server.json'], bind: '127.0.0.1' })
    const { startSandbox } = await import('./company-sandbox.mjs')
    await startSandbox({ root, sandbox, record })
    fs.writeFileSync(
      path.join(sandbox, 'server.json'),
      JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) }),
    )
  } else
    throw new Error('Commands: status | record | test | web-test | build | check | format | serve | stop | cleanup')
}
