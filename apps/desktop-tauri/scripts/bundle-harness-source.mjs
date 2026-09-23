/**
 * Bundle a trimmed harness monorepo slice for the Tauri installer.
 *
 * Ships source + pre-built lib/dist artifacts, never node_modules.
 * First-run provisioning runs `pnpm install --prod` against this tree.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(desktopRoot, '..', '..')
const outRoot = join(desktopRoot, 'bundled', 'harness')

const skipDirNames = new Set([
  'node_modules', '.git', '.turbo', 'coverage', 'release', '.stage', '.cache',
  'tests', 'test', '__tests__', 'dist-test',
])

const trimmedPackages = [
  'vendor/*',
  'packages/*/*',
  'native/system',
  'native/system/packages/*',
  'apps/cli',
  'apps/web',
]

const skipPackageGroups = new Set(['examples', 'test-support', 'experimental'])

const skipFileSuffixes = ['.spec.ts', '.e2e.ts', '.snapshot.ts']

/**
 * 从仓库配置裁剪工作区成员，允许生产包未使用的开发依赖补丁。
 * 保留补丁、构建许可和 overrides；实际补丁应用失败仍阻止安装。
 *
 * @param {string} sourceYaml
 * @returns {string}
 */
export function buildTrimmedWorkspaceYaml(sourceYaml) {
  const lines = sourceYaml.split(/\r?\n/)
  const packagesIndex = lines.findIndex(line => /^packages:\s*$/.test(line))
  if (packagesIndex === -1) {
    throw new Error('pnpm-workspace.yaml has no packages: block to trim')
  }
  let end = packagesIndex + 1
  while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) {
    end += 1
  }
  const trimmedBlock = [
    'packages:',
    ...trimmedPackages.map(name => `  - ${name}`),
    '',
  ]
  // 裁剪树不含开发工具，允许其补丁未使用；已安装依赖的补丁应用失败仍由 pnpm 报错。
  return [...lines.slice(0, packagesIndex), ...trimmedBlock, ...lines.slice(end)]
    .filter(line => !/^allowUnusedPatches:/.test(line))
    .join('\n').trimEnd() + '\n\nallowUnusedPatches: true\n'
}

/** @param {string} sourceRoot @param {string} source */
function shouldCopyEntry(sourceRoot, source) {
  const rel = relative(sourceRoot, source)
  if (rel === '') return true
  const parts = rel.split(sep)
  if (parts.some(part => skipDirNames.has(part))) return false
  const base = parts[parts.length - 1]
  if (skipFileSuffixes.some(suffix => base.endsWith(suffix))) return false
  if (base.startsWith('README') && parts.length > 2) return false
  return true
}

/** @param {string} sourceRoot @param {string} current @param {import('node:crypto').Hash} hasher @param {string} relPrefix */
function hashSourceWalk(sourceRoot, current, hasher, relPrefix) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (!shouldCopyEntry(sourceRoot, path)) continue
    if (entry.isDirectory()) {
      const dirRel = relPrefix ? `${relPrefix}/${entry.name}`.replaceAll('\\', '/') : entry.name.replaceAll('\\', '/')
      hashSourceWalk(sourceRoot, path, hasher, dirRel)
      continue
    }
    if (!entry.isFile()) continue
    const rel = relPrefix ? `${relPrefix}/${entry.name}`.replaceAll('\\', '/') : entry.name.replaceAll('\\', '/')
    hasher.update(rel)
    if (entry.name === 'package.json') {
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      delete pkg.devDependencies
      hasher.update(JSON.stringify(pkg, null, 2))
    }
    else {
      hasher.update(readFileSync(path))
    }
  }
}

/** Hash the same source slices we copy into the installer bundle. */
function hashBundledContent(trimmedWorkspace, bundlePkg) {
  const hasher = createHash('sha256')

  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const path = join(repoRoot, name)
    if (!existsSync(path)) continue
    hasher.update(name)
    if (name === 'package.json') {
      hasher.update(JSON.stringify(bundlePkg, null, 2))
    }
    else {
      hasher.update(readFileSync(path))
    }
  }

  for (const rel of ['patches', 'vendor', join('native', 'system'), join('apps', 'cli'), join('apps', 'web')]) {
    const path = join(repoRoot, rel)
    if (existsSync(path)) {
      hashSourceWalk(path, path, hasher, rel.replaceAll('\\', '/'))
    }
  }

  const packagesRoot = join(repoRoot, 'packages')
  for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory() || skipPackageGroups.has(group.name)) continue
    const groupPath = join(packagesRoot, group.name)
    for (const pkg of readdirSync(groupPath, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const rel = `packages/${group.name}/${pkg.name}`
      hashSourceWalk(join(groupPath, pkg.name), join(groupPath, pkg.name), hasher, rel)
    }
  }

  hasher.update(trimmedWorkspace)
  return hasher.digest('hex')
}

/**
 * @param {string} src
 * @param {string} dest
 */
function copyTree(src, dest) {
  if (!existsSync(src)) return
  if (statSync(src).isFile()) {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    return
  }
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: candidate => shouldCopyEntry(src, candidate),
  })
}

function assertBuiltArtifacts() {
  const cliBin = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
  const webIndex = join(repoRoot, 'apps', 'web', 'dist', 'index.html')
  const systemEntry = join(repoRoot, 'native', 'system', 'packages', 'entry', 'lib', 'index.js')
  if (!existsSync(cliBin) || !existsSync(webIndex)) {
    throw new Error(
      'Harness build artifacts missing. From repo root run: pnpm run build',
    )
  }
  if (!existsSync(systemEntry)) {
    throw new Error(
      'system entry lib missing. From native/system run: pnpm run build:ts',
    )
  }
}

/** Strip devDependencies so first-run `pnpm install --prod` never resolves demo/test-only workspace refs. */
function stripDevDependencies(root) {
  /** @param {string} dir */
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) continue
        walk(path)
        continue
      }
      if (entry.name !== 'package.json') continue
      if (!existsSync(path)) continue
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      if (!pkg.devDependencies) continue
      delete pkg.devDependencies
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
    }
  }
  walk(root)
}

/**
 * Collect the `name` of every workspace member copied into the bundle.
 * @param {string} root
 * @returns {Set<string>}
 */
function collectBundledPackageNames(root) {
  const names = new Set()
  /** @param {string} dir */
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) continue
        walk(path)
        continue
      }
      if (entry.name !== 'package.json') continue
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof pkg.name === 'string') names.add(pkg.name)
    }
  }
  walk(root)
  return names
}

/**
 * Drop dependency entries that use the workspace protocol but name a package
 * the trimmed tree does not contain (skipped groups such as `experimental`).
 * pnpm refuses `workspace:*` specs whose target is absent, so first-run
 * `pnpm install --prod` would otherwise fail on upstream manifests that
 * reference packages the desktop bundle deliberately leaves out.
 * @param {string} root
 */
export function stripUnbundledWorkspaceDependencies(root) {
  const present = collectBundledPackageNames(root)
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies']
  /** @param {string} dir */
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) continue
        walk(path)
        continue
      }
      if (entry.name !== 'package.json') continue
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      let changed = false
      for (const section of sections) {
        const deps = pkg[section]
        if (deps === undefined) continue
        for (const [name, spec] of Object.entries(deps)) {
          if (spec.startsWith('workspace:') && !present.has(name)) {
            delete deps[name]
            changed = true
          }
        }
        if (Object.keys(deps).length === 0) delete pkg[section]
      }
      if (changed) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
    }
  }
  walk(root)
}

function main() {
assertBuiltArtifacts()
rmSync(outRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
mkdirSync(outRoot, { recursive: true })

for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  copyTree(join(repoRoot, name), join(outRoot, name))
}

if (existsSync(join(repoRoot, 'patches'))) {
  copyTree(join(repoRoot, 'patches'), join(outRoot, 'patches'))
}

copyTree(join(repoRoot, 'vendor'), join(outRoot, 'vendor'))
copyTree(join(repoRoot, 'native', 'system'), join(outRoot, 'native', 'system'))
copyTree(join(repoRoot, 'apps', 'cli'), join(outRoot, 'apps', 'cli'))
copyTree(join(repoRoot, 'apps', 'web'), join(outRoot, 'apps', 'web'))

const packagesRoot = join(repoRoot, 'packages')
for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  if (skipPackageGroups.has(group.name)) continue
  const groupPath = join(packagesRoot, group.name)
  for (const pkg of readdirSync(groupPath, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    copyTree(join(groupPath, pkg.name), join(outRoot, 'packages', group.name, pkg.name))
  }
}

const trimmedWorkspace = buildTrimmedWorkspaceYaml(
  readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
)
writeFileSync(join(outRoot, 'pnpm-workspace.yaml'), trimmedWorkspace)

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const bundlePkg = {
  name: '@deepseek-ai/dsh-desktop-bundle',
  private: true,
  version: rootPkg.version,
  packageManager: rootPkg.packageManager ?? 'pnpm@11.7.0',
}
writeFileSync(join(outRoot, 'package.json'), `${JSON.stringify(bundlePkg, null, 2)}\n`)

stripDevDependencies(outRoot)
stripUnbundledWorkspaceDependencies(outRoot)

const manifest = {
  harnessVersion: rootPkg.version,
  bundledAt: new Date().toISOString(),
  contentSha256: hashBundledContent(trimmedWorkspace, bundlePkg),
  method: 'trimmed-monorepo-source',
}
writeFileSync(join(outRoot, '.bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`bundle-harness-source: wrote ${outRoot}`)
console.log(`bundle-harness-source: sha256=${manifest.contentSha256}`)
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main()
}
