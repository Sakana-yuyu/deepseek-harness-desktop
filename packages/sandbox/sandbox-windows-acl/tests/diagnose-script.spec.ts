/**
 * The diagnosis script shipped with the `diagnose-windows-sandbox-acl` skill is a
 * runnable artifact, so its classification and its two repairs are tested directly
 * rather than through a model.
 *
 * Every case builds its own scratch directory under the system temp directory and
 * never touches the user profile. The foreign package SID is synthetic: the access
 * check that blocks a below-Medium caller keys on the SID class, not on a profile
 * that exists, so a made-up `S-1-15-2-*` value exercises the same path. ACEs are
 * written with `icacls` and the `*SID` spelling, which no account name has to
 * resolve.
 *
 * Cleanup restores full control on the fixture directories before removing them.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const isWin32 = process.platform === 'win32'

function pwshAvailable(): boolean {
  try {
    execFileSync('where.exe', ['pwsh'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const script = fileURLToPath(new URL('../assets/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1', import.meta.url))
const PACKAGE_SID = 'S-1-15-2-1-2-3-4'
const CAPABILITY_SID = 'S-1-15-3-1-2-3-4'
// Process creation and Add-Type compilation share the Windows coverage budget.
const timeout = Math.max(90_000, Number(process.env.DSH_COVERAGE_TEST_TIMEOUT_MS ?? 0))

// Vitest's asymmetric factories return any; expected matchers are opaque values.
const containingObject = (value: Record<string, unknown>): unknown => expect.objectContaining(value)
const containingArray = (value: unknown[]): unknown => expect.arrayContaining(value)
const excludingArray = (value: unknown[]): unknown => expect.not.arrayContaining(value)
const containingString = (value: string): unknown => expect.stringContaining(value)
const anyValue = (constructor: object): unknown => expect.any(constructor)

interface ScriptRun {
  readonly code: number
  readonly output: string
}

interface ScriptReport {
  readonly kind: string
  readonly operation: string
  readonly path: string
  readonly status: string
  readonly reason: string
  readonly details: Record<string, unknown>
}

function reports(run: ScriptRun): ScriptReport[] {
  const result = run.output.split(/\r?\n/u).filter(line => line.startsWith('REPORT '))
    .map(line => JSON.parse(line.slice('REPORT '.length)) as ScriptReport)
  expect(result.length).toBeGreaterThan(0)
  for (const entry of result) expect(entry.reason.length).toBeGreaterThan(0)
  expect(result.at(-1)).toMatchObject({ kind: 'summary', details: { exitCode: run.code } })
  return result
}

function pwsh(command: string): string {
  return execFileSync('pwsh', ['/NoLogo', '/NonInteractive', '/NoProfile', '-Command', command], { encoding: 'utf8', timeout, windowsHide: true })
}

function runScript(args: readonly string[]): ScriptRun {
  return runPowerShell(['-File', script, ...args])
}

function runPowerShell(args: readonly string[]): ScriptRun {
  try {
    const stdout = execFileSync('pwsh', ['/NoLogo', '/NonInteractive', '/NoProfile', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true,
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    if (failure.status === null || failure.status === undefined) throw error
    return { code: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function icacls(path: string, ...args: readonly string[]): string {
  return execFileSync('icacls', [path, ...args], { encoding: 'utf8', timeout, windowsHide: true })
}

function sddlOf(path: string): string {
  return pwsh(`(Get-Acl -LiteralPath '${path.replaceAll("'", "''")}').Sddl`).trim()
}

function aclLines(path: string): string[] {
  return icacls(path).split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

function ownerOf(path: string): string {
  return pwsh(`(Get-Acl -LiteralPath '${path}').GetOwner([System.Security.Principal.SecurityIdentifier]).Value`).trim()
}

function normalized(path: string, lines: readonly string[]): string[] {
  return lines.map((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith(path) ? trimmed.slice(path.length).trim() : trimmed
  })
}

describe.skipIf(!isWin32 || !pwshAvailable())('diagnose-windows-sandbox-acl script', { timeout }, () => {
  let scratch!: string
  let outDir!: string
  let meSid!: string

  function makeDir(name: string): string {
    const dir = join(scratch, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function stamp(path: string, sid: string, type: 'grant' | 'deny' = 'grant'): void {
    icacls(path, `/${type}`, `*${sid}:(RX)`)
  }

  beforeAll(() => {
    // Windows runners may expose TEMP through an 8.3 alias; PowerShell reports long paths.
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-acl-diagnose-')))
    outDir = makeDir('out')
    meSid = pwsh('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value').trim()
    // Diagnosis inspects the real ancestor chain, including above our owned root.
    const baseline = reports(runScript(['-Path', scratch])).find(entry => entry.operation === 'classify')
    if (JSON.stringify(baseline?.details.packageObjects) !== '[]') {
      throw new Error('ACL fixtures require TEMP/TMP on a tree whose ancestors have no individual package allow ACEs; choose a clean test temp root. Host ACLs are never repaired by this suite.')
    }
  }, timeout)

  afterAll(() => {
    // Restore what the grant case withheld before deleting the scratch tree.
    pwsh(
      `Get-ChildItem -LiteralPath '${scratch}' -Recurse -Force -Directory -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { icacls $_.FullName /grant:r "*${meSid}:(F)" | Out-Null }; ` +
      `icacls '${scratch}' /grant:r "*${meSid}:(F)" | Out-Null`,
    )
    rmSync(scratch, { recursive: true, force: true })
  }, timeout)

  it('names a foreign package-SID ACE as the blocker and removes only that ACE', () => {
    const target = makeDir('stamped')
    stamp(target, PACKAGE_SID)
    const before = normalized(target, aclLines(target))
    expect(before.join('\n')).toContain(PACKAGE_SID)

    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=CULPRIT')
    expect(diagnosis.output, diagnosis.output).toContain(`PACKAGE_ACE SID=${PACKAGE_SID}`)

    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(repair.output, repair.output).toContain(`FIXED ${target} SID=${PACKAGE_SID}`)
    expect(repair.output, repair.output).toContain('SUMMARY FIXED=1 GRANTED=0 REFUSED=0')
    expect(reports(repair)).toEqual(containingArray([
      containingObject({ kind: 'action', operation: 'remove_package_allow', path: target, status: 'started' }),
      containingObject({ kind: 'action', operation: 'remove_package_allow', path: target, status: 'completed' }),
      containingObject({ kind: 'verification', operation: 'fix', path: target, status: 'verified' }),
    ]))

    // Exactly the foreign ACE disappears; every other line survives unchanged.
    expect(normalized(target, aclLines(target))).toEqual(before.filter(line => !line.includes(PACKAGE_SID)))
  }, timeout)

  it('reports a healthy directory as not this class and changes nothing', () => {
    const target = makeDir('healthy')
    const before = normalized(target, aclLines(target))

    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=NOT_THIS_CLASS')
    expect(diagnosis.output, diagnosis.output).not.toContain('PACKAGE_ACE')
    expect(reports(diagnosis)).toContainEqual(containingObject({ kind: 'decision', operation: 'diagnose', path: target, status: 'skipped' }))

    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(repair.output, repair.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=0')
    expect(reports(repair)).toContainEqual(containingObject({ kind: 'decision', operation: 'fix', path: target, status: 'skipped' }))
    expect(normalized(target, aclLines(target))).toEqual(before)
  }, timeout)

  it('reports every inspected ancestor and locates a package ACE present only on the parent', async () => {
    const parent = makeDir('parent-package-report')
    const target = join(parent, 'child')
    mkdirSync(target)
    stamp(parent, PACKAGE_SID)
    const before = [sddlOf(parent), sddlOf(target)]

    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.code, diagnosis.output).toBe(0)
    const entries = reports(diagnosis)
    const inspected = entries.filter(entry => entry.kind === 'observation' && entry.operation === 'inspect_acl')
    const expectedPaths = [target]
    for (let ancestor = dirname(target); ; ancestor = dirname(ancestor)) {
      expectedPaths.push(ancestor)
      if (dirname(ancestor) === ancestor) break
    }
    expect(inspected.map(entry => entry.path)).toEqual(expectedPaths)
    expect(inspected[0]).toMatchObject({
      path: target, status: 'read',
      details: { aces: excludingArray([containingObject({ sid: PACKAGE_SID })]) },
    })
    expect(inspected[1]).toMatchObject({
      path: parent, status: 'read',
      details: { aces: containingArray([containingObject({ sid: PACKAGE_SID, type: 'Allow', inherited: false })]) },
    })
    expect(entries).toContainEqual(containingObject({
      kind: 'decision', operation: 'classify', path: target, status: 'CULPRIT',
      details: containingObject({ packageObjects: [parent] }),
    }))
    expect(entries.filter(entry => entry.kind === 'action' && entry.details.effect !== 'none')).toEqual([])
    expect([sddlOf(parent), sddlOf(target)]).toEqual(before)

    // The example retains both fixture paths and the fixture SID. Host-owned ACEs
    // and ancestors remain covered by the assertions above instead of the snapshot.
    const transcript = entries.filter(entry => entry.path === parent || entry.path === target).map((entry) => {
      let details: Record<string, unknown> = {}
      if (entry.operation === 'inspect_acl') {
        details = { fixturePackageAces: (entry.details.aces as { readonly sid: string }[]).filter(ace => ace.sid === PACKAGE_SID) }
      } else if (entry.operation === 'classify') {
        details = { packageObjects: entry.details.packageObjects }
      } else if (entry.kind === 'summary') {
        details = {
          exitCode: entry.details.exitCode, operations: entry.details.operations, automaticRollback: entry.details.automaticRollback,
        }
      }
      return JSON.stringify({ ...entry, details })
    }).join('\n').replaceAll(JSON.stringify(parent).slice(1, -1), '{{parent}}') + '\n'
    await expect(transcript).toMatchFileSnapshot(fileURLToPath(new URL('./expected/parent-package-report.jsonl', import.meta.url)))
  }, timeout)

  it('reports an inert capability SID and an inert DENY ACE without touching either', () => {
    const capability = makeDir('capability')
    stamp(capability, CAPABILITY_SID)
    const deny = makeDir('denied-package')
    stamp(deny, PACKAGE_SID, 'deny')
    const before = new Map([
      [capability, normalized(capability, aclLines(capability))],
      [deny, normalized(deny, aclLines(deny))],
    ])

    const capabilityDiagnosis = runScript(['-Path', capability])
    expect(capabilityDiagnosis.output, capabilityDiagnosis.output).toContain(`OTHER_S1_15 SID=${CAPABILITY_SID}`)
    expect(capabilityDiagnosis.output, capabilityDiagnosis.output).not.toContain('PACKAGE_ACE')
    expect(capabilityDiagnosis.output, capabilityDiagnosis.output).not.toContain('VERDICT=CULPRIT')

    const denyDiagnosis = runScript(['-Path', deny])
    expect(denyDiagnosis.output, denyDiagnosis.output).not.toContain('PACKAGE_ACE')
    expect(denyDiagnosis.output, denyDiagnosis.output).not.toContain('VERDICT=CULPRIT')
    expect(reports(denyDiagnosis)).toContainEqual(containingObject({
      kind: 'observation', operation: 'inspect_acl', path: deny,
      details: containingObject({ aces: containingArray([containingObject({ sid: PACKAGE_SID, type: 'Deny', inherited: false })]) }),
    }))

    // `pwsh -File` passes `-Path a,b` literally, so each object is diagnosed on its own.
    for (const path of [capability, deny]) {
      const repair = runScript(['-Path', path, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
      expect(repair.output, repair.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=0')
      expect(normalized(path, aclLines(path))).toEqual(before.get(path))
    }
  }, timeout)

  it('grants full control for a Modify-only DACL without changing the owner', () => {
    const target = makeDir('missing-write-owner')
    pwsh(`icacls '${target}' /inheritance:r /grant:r "*${meSid}:(M)" | Out-Null`)
    const ownerBefore = ownerOf(target)

    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=PRECONDITION')

    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(repair.output, repair.output).toContain('SUMMARY FIXED=0 GRANTED=1 REFUSED=0')
    expect(aclLines(target).join('\n')).toMatch(/\(F\)/u)
    expect(ownerOf(target)).toBe(ownerBefore)
  }, timeout)

  it('refuses a target outside -AllowRoot and refuses contradictory switches', () => {
    const target = makeDir('outside-root')
    const unrelated = makeDir('unrelated-root')
    stamp(target, PACKAGE_SID)

    const refused = runScript(['-Path', target, '-AllowRoot', unrelated, '-Out', outDir, '-Fix'])
    expect(refused.output, refused.output).toContain('FIX_REFUSED')
    expect(refused.output, refused.output).toContain('is outside -AllowRoot')
    expect(refused.output, refused.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=1')
    expect(aclLines(target).join('\n')).toContain(PACKAGE_SID)

    const contradictory = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix', '-GrantFullControl'])
    expect(contradictory.code).toBe(2)
    expect(contradictory.output, contradictory.output).toContain('run one at a time')
    expect(reports(contradictory)).toContainEqual(containingObject({ kind: 'error', status: 'stopped' }))
  }, timeout)

  it.each(['-Fix', '-GrantFullControl'])('refuses ancestor junctions for %s without changing their destination', (repairSwitch) => {
    const allowed = makeDir(`junction-${repairSwitch}`)
    const outside = makeDir(`outside-${repairSwitch}`)
    const target = join(outside, 'target')
    mkdirSync(target)
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    stamp(target, PACKAGE_SID)
    const before = sddlOf(target)
    const link = join(allowed, 'link')
    symlinkSync(outside, link, 'junction')
    try {
      for (const allowRoot of [allowed, link]) {
        const repair = runScript(['-Path', join(link, 'target'), '-AllowRoot', allowRoot, '-Out', outDir, repairSwitch])
        expect(repair.output, repair.output).toContain('reparse point')
        expect(repair.code).not.toBe(0)
        expect(reports(repair)).toContainEqual(containingObject({ kind: 'decision', status: 'refused', reason: containingString('reparse point') }))
        expect(sddlOf(target)).toBe(before)
      }
    } finally {
      unlinkSync(link)
    }
  })

  it.each(['-Fix', '-GrantFullControl'])('restores the original DACL with the rollback emitted by %s', (repairSwitch) => {
    const target = makeDir(`rollback-${repairSwitch}'s-directory`)
    icacls(target, '/setintegritylevel', 'L')
    if (repairSwitch === '-GrantFullControl') icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    else icacls(target, '/grant', `*${PACKAGE_SID}:(OI)(CI)(RX)`)
    icacls(target, '/grant', `*${CAPABILITY_SID}:(OI)(CI)(RX)`)
    const before = sddlOf(target)
    const linesBefore = normalized(target, aclLines(target)).sort()
    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, repairSwitch])
    expect(repair.code, repair.output).toBe(0)
    expect(sddlOf(target)).not.toBe(before)
    const rollback = repair.output.split(/\r?\n/u).find(line => line.startsWith('ROLLBACK '))
    expect(rollback, repair.output).toBeDefined()
    const restored = pwsh(rollback!.slice('ROLLBACK '.length))
    expect(reports({ code: 0, output: restored })).toContainEqual(containingObject({ kind: 'verification', operation: 'restore', status: 'verified' }))
    expect(sddlOf(target)).toBe(before)
    expect(normalized(target, aclLines(target)).sort()).toEqual(linesBefore)
  }, timeout)

  it('repairs a directory whose full-control ACE only applies to children', () => {
    const target = makeDir('inherit-only-full-control')
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    icacls(target, '/grant', `*${meSid}:(OI)(CI)(IO)(F)`)
    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=PRECONDITION')
    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(repair.output, repair.output).toContain('SUMMARY FIXED=0 GRANTED=1 REFUSED=0')
    icacls(target, '/setintegritylevel', 'L')
  })

  it('refuses a recovery record for another path or a path outside the allowed root', () => {
    const target = makeDir('restore-guards')
    const other = makeDir('restore-other')
    const backups = makeDir('restore-backups')
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', backups, '-GrantFullControl'])
    expect(repair.code, repair.output).toBe(0)
    const record = join(backups, readdirSync(backups).find(file => file.endsWith('.json'))!)
    const before = sddlOf(target)
    const otherBefore = sddlOf(other)
    const mismatch = runScript(['-Path', other, '-AllowRoot', scratch, '-Restore', record])
    expect(mismatch.code).toBe(2)
    expect(mismatch.output).toContain('backup does not describe the requested path')
    expect(sddlOf(other)).toBe(otherBefore)
    const outside = runScript(['-Path', target, '-AllowRoot', other, '-Restore', record])
    expect(outside.code).toBe(2)
    expect(outside.output).toContain('outside -AllowRoot')
    expect(sddlOf(target)).toBe(before)
    const link = join(other, 'link')
    symlinkSync(target, link, 'junction')
    try {
      const throughLink = runScript(['-Path', link, '-AllowRoot', other, '-Restore', record])
      expect(throughLink.code).toBe(2)
      expect(throughLink.output).toContain('reparse point')
      expect(sddlOf(target)).toBe(before)
    } finally {
      unlinkSync(link)
    }
  }, timeout)

  it('does not report a successful grant when a deny ACE blocks WRITE_OWNER', async () => {
    const target = makeDir('denied-write-owner')
    icacls(target, '/deny', `*${meSid}:(WO)`)
    const before = sddlOf(target)
    try {
      const diagnosis = runScript(['-Path', target])
      expect(diagnosis.output, diagnosis.output).toContain('VERDICT=PRECONDITION')
      expect(reports(diagnosis)).toContainEqual(containingObject({
        kind: 'observation', operation: 'inspect_acl', path: target,
        details: containingObject({
          writeOwner: false,
          aces: containingArray([containingObject({ sid: meSid, type: 'Deny', rights: 'TakeOwnership', inherited: false })]),
        }),
      }))
      const grant = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
      expect(grant.code, `${grant.output}\n${aclLines(target).join('\n')}`).toBe(2)
      expect(grant.output, grant.output).toContain('GRANT_FAILED')
      expect(grant.output).toContain('GRANTED=0 REFUSED=1')
      expect(aclLines(target).join('\n')).toContain('(DENY)(WO)')
      expect(reports(grant)).toEqual(containingArray([
        containingObject({ kind: 'action', operation: 'grant_dacl', status: 'completed' }),
        containingObject({ kind: 'verification', operation: 'grant', status: 'failed', details: containingObject({ recovery: containingString('-Restore') }) }),
        containingObject({ kind: 'verification', operation: 'restore', status: 'verified' }),
        containingObject({ kind: 'summary', details: containingObject({ automaticRollback: true, granted: 0, restored: 1, rollback: 'verified', rollbackCommands: [], nextAction: 'stop' }) }),
      ]))
      expect(sddlOf(target)).toBe(before)
      const transcript = reports(grant)
        .filter(entry => entry.path === target && entry.kind !== 'observation')
        .map(entry => `${entry.kind} ${entry.operation} ${entry.status} path={{target}}: ${entry.reason.replaceAll(meSid, '{{caller_sid}}')}`)
        .join('\n') + '\n'
      await expect(transcript).toMatchFileSnapshot(fileURLToPath(new URL('./expected/denied-grant-report.txt', import.meta.url)))
    } finally {
      icacls(target, '/remove:d', `*${meSid}`)
    }
  })

  it('reports backup errors and no ACL write when the output path is a file', () => {
    const target = makeDir('backup-failure')
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    const outputFile = join(scratch, 'not-a-directory')
    writeFileSync(outputFile, 'Existing contents')
    const before = sddlOf(target)
    const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outputFile, '-GrantFullControl'])
    expect(run.code).toBe(1)
    const entries = reports(run)
    expect(entries).toContainEqual(containingObject({ kind: 'action', operation: 'backup', status: 'failed', details: containingObject({ error: anyValue(String) }) }))
    expect(entries.filter(entry => entry.kind === 'action' && entry.details.effect === 'acl')).toEqual([])
    expect(sddlOf(target)).toBe(before)
  })

  it('reports unreadable ACLs as missing observations without inventing permissions', () => {
    const target = makeDir('unreadable-observation')
    const before = sddlOf(target)
    const run = runPowerShell(['-Command', `
function Get-Acl { param([string]$LiteralPath); throw [System.IO.IOException]::new('ACL observation unavailable') }
& '${script.replaceAll("'", "''")}' -Path '${target.replaceAll("'", "''")}'
exit $LASTEXITCODE
`])
    expect(run.code).toBe(0)
    expect(run.output).toContain('VERDICT=UNREADABLE')
    const entries = reports(run)
    expect(entries).toContainEqual(containingObject({
      kind: 'observation', path: target, status: 'unreadable',
      details: { error: containingString('ACL observation unavailable') },
    }))
    expect(entries.at(-1)).toMatchObject({ status: 'partial', details: { observationFailures: anyValue(Number) } })
    expect(entries.filter(entry => entry.kind === 'action' && entry.details.effect !== 'none')).toEqual([])
    expect(sddlOf(target)).toBe(before)
  })

  it.each([false, true])('restores after a failed verification read and reports whether recovery was observed (recovery read fails: %s)', (recoveryReadFails) => {
    const target = makeDir(`post-write-read-failure-${recoveryReadFails}`)
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    const before = sddlOf(target)
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const wrapper = join(scratch, 'fail-verification.ps1')
    // The real grant runs; only its subsequent observation fails in this child.
    writeFileSync(wrapper, `
$global:targetReads = 0
function Get-Acl {
  param([string]$LiteralPath)
  if ($LiteralPath -eq ${quote(target)}) {
    $global:targetReads++
    if ($global:targetReads ${recoveryReadFails ? '-ge' : '-eq'} 4) { throw [System.IO.IOException]::new('verification read unavailable') }
  }
  Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $LiteralPath
}
& ${quote(script)} -Path ${quote(target)} -AllowRoot ${quote(scratch)} -Out ${quote(outDir)} -GrantFullControl
exit $LASTEXITCODE
`)
    const run = runPowerShell(['-File', wrapper])
    expect(run.code).toBe(2)
    const entries = reports(run)
    expect(entries).toEqual(containingArray([
      containingObject({ kind: 'action', operation: 'grant_dacl', status: 'completed' }),
      containingObject({ kind: 'observation', operation: 'inspect_acl', path: target, status: 'unreadable', details: containingObject({ error: containingString('verification read unavailable') }) }),
      containingObject({ kind: 'verification', operation: 'grant', status: 'failed', details: containingObject({ recovery: containingString('-Restore') }) }),
    ]))
    expect(sddlOf(target)).toBe(before)
    expect(entries.at(-1)).toMatchObject({ details: {
      rollback: recoveryReadFails ? 'failed' : 'verified',
      nextAction: recoveryReadFails ? 'restore_pending_then_stop' : 'stop',
      rollbackCommands: recoveryReadFails ? [containingString('-Restore')] : [],
    } })
    if (recoveryReadFails) {
      const commands = entries.at(-1)!.details.rollbackCommands as string[]
      const recovery = runPowerShell(['-Command', commands[0]!])
      expect(recovery.code, recovery.output).toBe(0)
      expect(reports(recovery)).toContainEqual(containingObject({ kind: 'verification', operation: 'restore', status: 'verified' }))
    }
  }, timeout)

  it('reports a missing path and an already-satisfied grant without mutating either', () => {
    const missing = join(scratch, 'missing')
    const run = runScript(['-Path', missing, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(run.code).toBe(2)
    expect(reports(run)).toContainEqual(containingObject({ kind: 'decision', path: missing, status: 'skipped', reason: containingString('does not exist') }))
    const healthy = makeDir('already-satisfied')
    const before = sddlOf(healthy)
    const grant = runScript(['-Path', healthy, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(grant.code, grant.output).toBe(0)
    expect(reports(grant)).toContainEqual(containingObject({ kind: 'decision', operation: 'grant', status: 'skipped', reason: containingString('already available') }))
    expect(sddlOf(healthy)).toBe(before)
  })

  it('reports well-known package groups without treating them as a removable package ACE', () => {
    const target = makeDir('well-known-package-groups')
    for (const sid of ['S-1-15-2-1', 'S-1-15-2-2']) stamp(target, sid)
    const before = sddlOf(target)
    const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(run.code, run.output).toBe(0)
    expect(run.output).toContain('VERDICT=NOT_THIS_CLASS')
    expect(reports(run)).toContainEqual(containingObject({
      kind: 'observation', operation: 'inspect_acl', path: target,
      details: containingObject({ aces: containingArray([
        containingObject({ sid: 'S-1-15-2-1', type: 'Allow' }),
        containingObject({ sid: 'S-1-15-2-2', type: 'Allow' }),
      ]) }),
    }))
    expect(sddlOf(target)).toBe(before)
  })

  it('grants missing rights before removing a package ACE when both problems are present', () => {
    const target = makeDir('both')
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    stamp(target, PACKAGE_SID)
    const ownerBefore = ownerOf(target)
    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=BOTH')
    const grant = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(grant.output, grant.output).toContain('SUMMARY FIXED=0 GRANTED=1 REFUSED=0')
    expect(aclLines(target).join('\n')).toContain(PACKAGE_SID)
    const fix = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(fix.output, fix.output).toContain('SUMMARY FIXED=1 GRANTED=0 REFUSED=0')
    expect(aclLines(target).join('\n')).not.toContain(PACKAGE_SID)
    expect(ownerOf(target)).toBe(ownerBefore)
  })

  it('refuses package removal when a deny blocks the prerequisite and restores a failed grant', () => {
    const target = makeDir('both-with-deny')
    stamp(target, PACKAGE_SID)
    icacls(target, '/deny', `*${meSid}:(WO)`)
    const before = sddlOf(target)
    try {
      for (const mode of ['-Fix', '-GrantFullControl', '-Fix']) {
        const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, mode, '-Compact'])
        expect(run.code, run.output).toBe(2)
        expect(reports(run).at(-1)).toMatchObject({ status: 'failed', details: { nextAction: 'stop', rollbackCommands: [] } })
        expect(sddlOf(target)).toBe(before)
      }
    } finally {
      icacls(target, '/remove:d', `*${meSid}`)
    }
  }, timeout)

  it('removes multiple package allow SIDs before verifying the resulting ACL', () => {
    const target = makeDir('multiple-packages')
    const otherSid = 'S-1-15-2-4-3-2-1'
    for (const sid of [PACKAGE_SID, otherSid]) stamp(target, sid)
    icacls(target, '/deny', `*${PACKAGE_SID}:(WO)`)
    const before = normalized(target, aclLines(target))
    const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(run.code, run.output).toBe(0)
    expect(normalized(target, aclLines(target))).toEqual(before.filter(line => line.includes('(DENY)') || (!line.includes(PACKAGE_SID) && !line.includes(otherSid))))
    expect(reports(run).filter(entry => entry.kind === 'verification' && entry.operation === 'fix')).toHaveLength(1)
  })

  it.each([false, true])('repairs inherited package entries at their sources and restores the tree (explicit child: %s)', (explicitChild) => {
    const parent = makeDir(`inherited-${explicitChild}`)
    const child = join(parent, 'child')
    const leaf = join(child, 'leaf')
    mkdirSync(leaf, { recursive: true })
    icacls(parent, '/setintegritylevel', '(OI)(CI)L')
    icacls(parent, '/grant', `*${PACKAGE_SID}:(OI)(CI)(RX)`)
    if (explicitChild) icacls(child, '/grant', '*S-1-15-2-4-3-2-1:(OI)(CI)(RX)')
    const paths = [parent, child, leaf]
    const before = paths.map(sddlOf)
    // The fixture's owner is the host token's default owner, which is not the invoking user on an
    // elevated runner; the repair must preserve whatever owner the fixture has.
    const ownersBefore = paths.map(ownerOf)
    const run = runScript(['-Path', leaf, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(run.code, run.output).toBe(0)
    const entries = reports(run)
    expect(entries.filter(entry => entry.operation === 'remove_package_allow' && entry.status === 'completed').map(entry => entry.path))
      .toEqual(explicitChild ? [parent, child] : [parent])
    expect(entries.filter(entry => entry.kind === 'verification' && entry.operation === 'fix').map(entry => entry.path)).toEqual([leaf, child, parent])
    for (const path of paths) {
      expect(aclLines(path).join('\n')).not.toContain('S-1-15-2-')
    }
    expect(paths.map(ownerOf)).toEqual(ownersBefore)
    const commands = entries.at(-1)!.details.rollbackCommands as string[]
    for (const command of commands) expect(runPowerShell(['-Command', command]).code).toBe(0)
    expect(paths.map(sddlOf)).toEqual(before)
  })

  it('refuses an inherited source outside AllowRoot before touching an in-root explicit entry', () => {
    const parent = makeDir('outside-inherited-source')
    const root = join(parent, 'allowed')
    const child = join(root, 'child')
    mkdirSync(child, { recursive: true })
    icacls(parent, '/grant', `*${PACKAGE_SID}:(OI)(CI)(RX)`)
    stamp(child, 'S-1-15-2-4-3-2-1')
    const before = [parent, child].map(sddlOf)
    const run = runScript(['-Path', child, '-AllowRoot', root, '-Out', outDir, '-Fix'])
    expect(run.code).toBe(2)
    expect(reports(run)).toContainEqual(containingObject({ kind: 'decision', status: 'refused', path: parent, reason: containingString('outside -AllowRoot') }))
    expect(reports(run).filter(entry => entry.kind === 'action' && entry.details.effect === 'acl')).toEqual([])
    expect([parent, child].map(sddlOf)).toEqual(before)
  })

  it('restores explicit sources and inherited entries when final verification fails', () => {
    const parent = makeDir('inherited-rollback')
    const child = join(parent, 'child')
    const leaf = join(child, 'leaf')
    mkdirSync(leaf, { recursive: true })
    icacls(parent, '/grant', `*${PACKAGE_SID}:(OI)(CI)(RX)`)
    icacls(child, '/grant', '*S-1-15-2-4-3-2-1:(OI)(CI)(RX)')
    const paths = [parent, child, leaf]
    const before = paths.map(sddlOf)
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const wrapper = join(scratch, 'fail-inherited-verification.ps1')
    writeFileSync(wrapper, `
$global:leafReads = 0
function Get-Acl {
  param([string]$LiteralPath)
  if ($LiteralPath -eq ${quote(leaf)}) {
    $global:leafReads++
    if ($global:leafReads -eq 2) { throw [System.IO.IOException]::new('final inherited verification unavailable') }
  }
  Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $LiteralPath
}
& ${quote(script)} -Path ${quote(leaf)} -AllowRoot ${quote(scratch)} -Out ${quote(outDir)} -Fix
exit $LASTEXITCODE
`)
    const run = runPowerShell(['-File', wrapper])
    expect(run.code, run.output).toBe(2)
    expect(reports(run).filter(entry => entry.kind === 'verification' && entry.operation === 'restore').map(entry => entry.path)).toEqual([child, parent])
    expect(reports(run).at(-1)).toMatchObject({ details: { rollback: 'verified', nextAction: 'stop' } })
    expect(paths.map(sddlOf)).toEqual(before)
  })

  it.each(['-Fix', '-GrantFullControl', '-Restore'])('rejects equivalent spellings of AllowRoot through %s', (mode) => {
    const target = makeDir(`root-spellings-${mode}`)
    const backups = makeDir(`root-backups-${mode}`)
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    let record: string | undefined
    if (mode === '-Restore') {
      const grant = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', backups, '-GrantFullControl'])
      expect(grant.code, grant.output).toBe(0)
      record = (reports(grant).at(-1)!.details.recoveries as { record: string }[])[0]!.record
    } else if (mode === '-Fix') stamp(target, PACKAGE_SID)
    const before = sddlOf(target)
    for (const path of [target, `${target}\\`, `${target}/`, `${target}\\\\`, `${target}\\.`, target.toUpperCase()]) {
      const args = ['-Path', path, '-AllowRoot', target, '-Out', backups, mode, ...(record ? [record] : [])]
      const run = runScript(args)
      expect(run.code, run.output).not.toBe(0)
      expect(run.output).toContain('outside -AllowRoot')
      expect(sddlOf(target)).toBe(before)
    }
  })

  it.each(['Packages', 'WindowsApps'])('refuses managed application trees even inside AllowRoot (%s)', (directory) => {
    const root = makeDir(`managed-${directory}`)
    const managed = join(root, directory)
    const child = join(managed, 'application')
    mkdirSync(child, { recursive: true })
    stamp(child, PACKAGE_SID)
    const key = directory === 'Packages' ? 'LOCALAPPDATA' : 'ProgramFiles'
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    // PowerShell initializes ProgramFiles at startup; redirect only this child's lookup after startup.
    const run = (path: string, mode: string): ScriptRun => runPowerShell(['-Command',
      `$env:${key} = ${quote(root)}; & ${quote(script)} -Path ${quote(path)} -AllowRoot ${quote(root)} -Out ${quote(outDir)} ${mode}; exit $LASTEXITCODE`,
    ])
    for (const path of [managed, child]) {
      icacls(path, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
      const before = sddlOf(path)
      const grant = run(path, '-GrantFullControl')
      expect(grant.code, grant.output).toBe(2)
      expect(grant.output).toContain('managed application directory')
      expect(sddlOf(path)).toBe(before)
    }
    const fix = run(child, '-Fix')
    expect(fix.code, fix.output).toBe(2)
    expect(fix.output).toContain('managed application directory')
    expect(aclLines(child).join('\n')).toContain(PACKAGE_SID)
  })

  it('rolls back earlier paths too when a later grant fails in the same invocation', () => {
    const first = makeDir('multi-grant-first')
    const second = makeDir('multi-grant-second')
    icacls(first, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    icacls(second, '/deny', `*${meSid}:(WO)`)
    const before = [sddlOf(first), sddlOf(second)]
    try {
      const run = runPowerShell(['-Command', `& '${script}' -Path @('${first}', '${second}') -AllowRoot '${scratch}' -Out '${outDir}' -GrantFullControl; exit $LASTEXITCODE`])
      expect(run.code, run.output).toBe(2)
      expect(reports(run).filter(entry => entry.operation === 'restore' && entry.kind === 'verification').map(entry => entry.path)).toEqual([second, first])
      expect([sddlOf(first), sddlOf(second)]).toEqual(before)
    } finally {
      icacls(second, '/remove:d', `*${meSid}`)
    }
  }, timeout)

  it('keeps all observations in unique reports and all ancestor paths in the compact summary', () => {
    const parent = makeDir('compact-parent')
    const target = join(parent, 'child')
    mkdirSync(target)
    stamp(parent, PACKAGE_SID)
    const before = [sddlOf(parent), sddlOf(target)]
    const reportPaths = new Set<string>()
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = runScript(['-Path', target, '-Out', outDir, '-Compact'])
      expect(run.code, run.output).toBe(0)
      const compact = reports(run)
      expect(compact).toHaveLength(1)
      const summary = compact[0]!
      expect(summary.details).toMatchObject({
        inspectedPaths: containingArray([target, parent, dirname(parent)]),
        findings: containingArray([containingObject({ path: parent, packageAllowSids: [PACKAGE_SID] })]),
        nextAction: 'review_findings',
      })
      const reportPath = summary.details.report as string
      reportPaths.add(reportPath)
      const full = readFileSync(reportPath, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line) as ScriptReport)
      expect(full.filter(entry => entry.operation === 'inspect_acl').map(entry => entry.path)).toEqual(summary.details.inspectedPaths)
      expect(full.every(entry => entry.reason.length > 0)).toBe(true)
      expect(full.at(-1)).toMatchObject({ kind: 'summary', status: 'completed' })
      expect(run.output.length).toBeLessThan(5_120)
    }
    expect(reportPaths.size).toBe(2)
    expect([sddlOf(parent), sddlOf(target)]).toEqual(before)
  }, timeout)

  it('reports compact-output setup failures without changing the target or overwriting files', () => {
    const target = makeDir('compact-failure')
    const outputFile = join(scratch, 'existing-report-output')
    writeFileSync(outputFile, 'preserve')
    const before = sddlOf(target)
    for (const args of [[], ['-Out', outputFile]]) {
      const run = runScript(['-Path', target, '-Compact', ...args])
      expect(run.code, run.output).not.toBe(0)
      expect(reports(run).at(-1)).toMatchObject({ status: 'failed', details: { nextAction: 'stop' } })
    }
    expect(readFileSync(outputFile, 'utf8')).toBe('preserve')
    expect(sddlOf(target)).toBe(before)
  })
})
