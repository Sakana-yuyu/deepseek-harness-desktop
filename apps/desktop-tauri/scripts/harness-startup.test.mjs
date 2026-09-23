import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// 使用安装过生产依赖的裁剪包，验证全新主目录不会借用用户已有的 profile。
test('裁剪包在全新主目录启动，并通过令牌交换访问受保护的首页', { timeout: 90000 }, async () => {
  const root = resolve(process.env.DSH_DESKTOP_SMOKE_ROOT
    ?? fileURLToPath(new URL('../bundled/harness', import.meta.url)))
  const prefix = join(tmpdir(), 'dsh-desktop-startup-')
  const home = await mkdtemp(prefix)
  let child
  let timer
  try {
    const patch = join(home, 'smoke.patch.yml')
    await writeFile(patch, '[]\n')
    child = spawn(process.execPath, [join(root, 'apps/cli/lib/bin.js'), 'web',
      '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: root, env: { ...process.env, DSH_HOME: home, NODE_ENV: 'production' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stderr.resume()
    const startup = await new Promise((done, fail) => {
      timer = setTimeout(() => fail(new Error('Host 启动超时')), 60000)
      let pending = ''
      child.once('error', fail)
      child.once('exit', code => fail(new Error(`Host 提前退出：${code}`)))
      child.stdout.on('data', chunk => {
        pending += chunk.toString()
        const lines = pending.split(/\r?\n/)
        pending = lines.pop()
        for (const line of lines) {
          if (/^dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(line)) {
            done(line.slice('dsh web: '.length).split(' ')[0])
          }
        }
      })
    })
    clearTimeout(timer)
    const base = new URL('/', startup).href
    assert.equal((await fetch(base)).status, 401)
    const exchange = await fetch(startup, { redirect: 'manual' })
    assert.equal(exchange.status, 303)
    assert.equal(exchange.headers.get('location'), './')
    const cookie = exchange.headers.get('set-cookie')
    assert.match(cookie, /HttpOnly; SameSite=Strict/)
    const page = await fetch(base, { headers: { cookie: cookie.split(';')[0] } })
    assert.equal(page.status, 200)
    const title = (await page.text()).match(/<title>(.*?)<\/title>/)?.[1]
    assert.equal(title, 'DeepSeek Harness')
    assert.equal(child.exitCode, null)
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) {
      const exited = new Promise(done => child.once('exit', done))
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else child.kill('SIGTERM')
      await exited
    }
    assert.ok(home.startsWith(prefix))
    await rm(home, { recursive: true, force: true, maxRetries: 3 })
  }
})
