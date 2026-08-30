/** TEMPORARY macOS diagnostic: how does hosted pwsh react to submitted sends? Remove after the pwsh CI fix lands. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ptyLocal from '@deepseek-ai/dsh-terminal-bash'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class PassthroughSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function visible(text: string): string {
  return JSON.stringify(text).replaceAll('\\u001b', '␛').replaceAll('\\r', '␍').replaceAll('\\n', '⏎')
}

function stubAgent(ctx: Context, rawId: string): Agent {
  const id = SessionId(rawId)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id)
  return {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pty-diagnose-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(PassthroughSandbox)
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: root })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ptyLocal, {
    shellDialect: 'pwsh',
    pollIntervalMs: 10,
    exactProbeAfterMs: 20,
    idleSilenceMs: 250,
    handoffGraceMs: 250,
    timeoutMs: 8_000,
    disposeGraceMs: 500,
    scrollbackLines: 400,
    scrollbackMaxBytes: 65_536,
    maxReadBytes: 16_384,
  })
  const agent = stubAgent(ctx, 'diagnose-agent')
  ctx.agents.register(agent)
  return { ctx, agent }
}

function dump(ctx: Context, agent: Agent, stage: string, sessionId: Parameters<Context['terminals']['read']>[1]): void {
  const page = ctx.terminals.read(agent, sessionId, { offset: 0, count: 400 })
  console.log(`\n##### ${stage} scrollback (${page.totalLines} lines) #####\n${visible(page.text)}`)
}

describe.skipIf(process.platform === 'win32')('pwsh execution diagnostic', () => {
  it('reports what executes and what the terminal echoes', async () => {
    const { ctx, agent } = await harness()
    const spawned = await ctx.terminals.spawn(agent, { type: 'shell' })
    const sessionId = spawned.sessionId
    console.log(`spawned session ${sessionId}, pid=${spawned.pid}`)

    // Wait for a REAL controlled prompt at a line start (echo false-positives
    // are mid-line), up to 15s, logging when it first appears.
    const deadline = Date.now() + 15_000
    let realPromptAt = -1
    while (Date.now() < deadline) {
      const text = ctx.terminals.read(agent, sessionId, { offset: 0, count: 400 }).text
      if (/^dsh> |[\r\n]dsh> /.test(text)) {
        realPromptAt = Date.now()
        break
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    console.log(`real line-start prompt seen: ${realPromptAt > 0} (after ${realPromptAt > 0 ? realPromptAt - (deadline - 15_000) : -1}ms)`)
    dump(ctx, agent, 'after startup wait', sessionId)

    const settle = async (operation: ReturnType<Context['terminals']['startSend']>, label: string): Promise<void> => {
      const result = await operation.done
      console.log(`${label} settled: waitReason=${result.waitReason} viewport=${visible(result.viewport.slice(-400))}`)
      dump(ctx, agent, label, sessionId)
    }

    await settle(ctx.terminals.startSend(agent, sessionId, { text: 'Write-Output AAA-EXEC-MARK', submit: true }), 'send-A (config terminator)')

    await new Promise(resolve => setTimeout(resolve, 1_000))
    await settle(ctx.terminals.startSend(agent, sessionId, { text: 'Write-Output BBB-EXEC-MARK', submit: false }), 'send-B (no terminator)')
    await settle(ctx.terminals.startSend(agent, sessionId, { text: '', submit: true }), 'send-C (terminator only)')

    dump(ctx, agent, 'final', sessionId)
    expect(true).toBe(true)
  }, 120_000)
})
