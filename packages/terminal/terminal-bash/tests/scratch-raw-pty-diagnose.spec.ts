/** TEMPORARY macOS diagnostic: raw node-pty against the runner's pwsh. Remove after the pwsh CI fix lands. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local/src/resolve.ts'

interface RawPty {
  write(text: string): void
  onData(listener: (data: string) => void): void
}

// node-pty is a dependency of subprocess-local; resolve through its tree.
const requireFromSubprocessLocal = createRequire(join(process.cwd(), 'packages/subprocess/subprocess-local/src/index.ts'))
// eslint-disable-next-line @typescript-eslint/no-require-imports -- diagnostic-only CJS module access
const nodePty = requireFromSubprocessLocal('node-pty') as { spawn(file: string, args: string[], options: Record<string, unknown>): RawPty }

function visible(text: string): string {
  return JSON.stringify(text.slice(-3000))
    .replaceAll('\\u001b', '␛')
    .replaceAll('\\r', '␍')
    .replaceAll('\\n', '⏎')
}

const PWSH_PROMPT_SETUP =
  "function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); 'dsh> ' }"

interface Probe {
  buf: string
  write(text: string): void
}

function probe(): Probe {
  const pty = nodePty.spawn(resolvePwshPath(), ['-NoLogo', '-NoProfile'], {
    cols: 160,
    rows: 40,
    cwd: tmpdir(),
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
  })
  const state: Probe = { buf: '', write(text: string) { pty.write(text) } }
  pty.onData((data) => { state.buf += data })
  return state
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(process.platform !== 'darwin')('pwsh raw runner diagnostic', () => {
  it('reports version and input behavior', async () => {
    const version = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' })
    console.log(`##### pwsh version: ${JSON.stringify(version.stdout?.trim())} status=${version.status}`)

    // Probe 1: bare pwsh, TERM=dumb, default editor state — what submits a line?
    const a = probe()
    await sleep(5000)
    console.log(`##### probe1 (default, no bootstrap) after 5s: ${visible(a.buf)}`)
    a.buf = ''
    a.write("Write-Output 'AAAMARK'\r")
    await sleep(6000)
    console.log(`##### probe1 after CR submit: ${visible(a.buf)}`)
    a.write("Write-Output 'BBBMARK'\n")
    await sleep(4000)
    console.log(`##### probe1 after LF submit: ${visible(a.buf)}`)
    a.write("Write-Output 'CCCMARK'\r\n")
    await sleep(4000)
    console.log(`##### probe1 after CRLF submit: ${visible(a.buf)}`)

    // Probe 2: prompt function installed (product bootstrap, minus Remove-Module)
    const b = probe()
    await sleep(5000)
    b.write(PWSH_PROMPT_SETUP + '\r')
    await sleep(3000)
    console.log(`##### probe2 (prompt fn) after bootstrap: ${visible(b.buf.slice(-1200))}`)
    b.buf = ''
    b.write("Write-Output 'DDDMARK'\r")
    await sleep(6000)
    console.log(`##### probe2 after CR submit: ${visible(b.buf)}`)

    expect(true).toBe(true)
  }, 120_000)
})
