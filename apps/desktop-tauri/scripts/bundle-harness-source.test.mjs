import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildTrimmedWorkspaceYaml, stripUnbundledWorkspaceDependencies } from './bundle-harness-source.mjs'

test('buildTrimmedWorkspaceYaml keeps upstream patch and build declarations verbatim', () => {
  const source = `packages:
  - vendor/*
  - packages/*/*
  - apps/*
  - examples
  - python/sdk-runtime

linkWorkspacePackages: true

overrides:
  '@deepseek-ai/cosmokit': 'link:vendor/cosmokit'

allowBuilds:
  esbuild: true
  node-pty: true

patchedDependencies:
  node-pty@1.2.0-beta.15: patches/node-pty@1.2.0-beta.15.patch
`
  const trimmed = buildTrimmedWorkspaceYaml(source)

  assert.match(trimmed, /^packages:\n(?:  - .*\n)+/)
  for (const name of ['vendor/*', 'packages/*/*', 'native/system', 'native/system/packages/*', 'apps/cli', 'apps/web']) {
    assert.ok(trimmed.includes(`  - ${name}\n`), `trimmed packages must include ${name}`)
  }
  assert.ok(!trimmed.includes('apps/*'))
  assert.ok(!trimmed.includes('native/landlock-run'))
  assert.ok(!trimmed.includes('examples'))

  assert.ok(
    trimmed.includes('  node-pty@1.2.0-beta.15: patches/node-pty@1.2.0-beta.15.patch\n'),
    'patchedDependencies must be copied from the source workspace, not hardcoded',
  )
  assert.ok(trimmed.includes('allowBuilds:\n  esbuild: true\n  node-pty: true\n'))
  assert.ok(trimmed.includes('linkWorkspacePackages: true\n'))
  assert.ok(trimmed.includes('allowUnusedPatches: true\n'))
})

test('buildTrimmedWorkspaceYaml preserves comments after the packages block', () => {
  const source = `# workspace header
packages:
  - apps/*

# Why linkWorkspacePackages is on.
linkWorkspacePackages: true
`
  const trimmed = buildTrimmedWorkspaceYaml(source)

  assert.ok(trimmed.startsWith('# workspace header\n'))
  assert.ok(trimmed.includes('# Why linkWorkspacePackages is on.\n'))
})

test('buildTrimmedWorkspaceYaml rejects a workspace without a packages block', () => {
  assert.throws(() => buildTrimmedWorkspaceYaml('linkWorkspacePackages: true\n'), /packages/)
})

test('stripUnbundledWorkspaceDependencies drops only workspace refs to absent packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bundle-strip-'))
  try {
    const presentDir = join(root, 'packages', 'core', 'present')
    const consumerDir = join(root, 'packages', 'core', 'consumer')
    const cliDir = join(root, 'apps', 'cli')
    await mkdir(presentDir, { recursive: true })
    await mkdir(consumerDir, { recursive: true })
    await mkdir(cliDir, { recursive: true })
    await writeFile(
      join(presentDir, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh-present' }, null, 2)}\n`,
    )
    const consumerPath = join(consumerDir, 'package.json')
    await writeFile(
      consumerPath,
      `${JSON.stringify({
        name: '@deepseek-ai/dsh-consumer',
        dependencies: {
          '@deepseek-ai/dsh-present': 'workspace:*',
          '@deepseek-ai/dsh-experimental-missing': 'workspace:*',
          'regular-dep': '^1.0.0',
        },
        optionalDependencies: { '@deepseek-ai/dsh-experimental-optional-missing': 'workspace:*' },
        peerDependencies: { '@deepseek-ai/dsh-experimental-peer-missing': 'workspace:*' },
      }, null, 2)}\n`,
    )
    await writeFile(
      join(cliDir, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh-cli', dependencies: { '@deepseek-ai/dsh-present': 'workspace:*' } }, null, 2)}\n`,
    )

    stripUnbundledWorkspaceDependencies(root)

    const stripped = JSON.parse(await readFile(consumerPath, 'utf8'))
    assert.deepEqual(stripped.dependencies, {
      '@deepseek-ai/dsh-present': 'workspace:*',
      'regular-dep': '^1.0.0',
    })
    assert.equal(stripped.optionalDependencies, undefined)
    assert.equal(stripped.peerDependencies, undefined)
    const cli = JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8'))
    assert.deepEqual(cli.dependencies, { '@deepseek-ai/dsh-present': 'workspace:*' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
