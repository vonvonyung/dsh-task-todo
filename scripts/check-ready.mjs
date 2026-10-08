/**
 * The delivery gate: run every check this package has, in order, and report one
 * verdict.
 *
 * Child processes use `stdio: 'inherit'`. Under the DSH file sandbox a child
 * whose stdio is piped cannot open the pipe (EPERM), so capturing output here
 * would make the gate fail for a reason that has nothing to do with the plugin.
 * Each script prints its own summary and owns its own exit code.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const pkgRoot = path.join(here, '..')

const GATES = [
  ['form audit (bundle vs dynamic API, injection, plain JS)', 'audit-shape.mjs'],
  ['stylesheet covers every class the JSX uses', 'audit-css.mjs'],
  ['recurrence engine', 'test-recurrence.mjs'],
  ['store, filters and view payloads', 'test-store.mjs'],
  ['markdown todo import (mapping, idempotency, dry run)', 'test-import-markdown.mjs'],
  ['lossless JSON over every tool / HTTP / command surface', 'test-json-gate.mjs'],
  ['client render, registration and interactions', 'verify-client-render.mjs'],
]

console.log('dsh-task-todo delivery gate')
console.log('='.repeat(72))

const results = []
for (const [label, script] of GATES) {
  const file = path.join(here, script)
  if (!fs.existsSync(file)) {
    results.push({ label, script, status: 'missing', code: -1 })
    continue
  }
  console.log(`\n### ${label}  (${script})`)
  const started = Date.now()
  const run = spawnSync(process.execPath, [file], { cwd: pkgRoot, stdio: 'inherit' })
  results.push({
    label,
    script,
    code: run.status ?? 1,
    ms: Date.now() - started,
  })
}

console.log('\n' + '='.repeat(72))
console.log('summary')
for (const result of results) {
  const mark = result.code === 0 ? 'ok  ' : 'FAIL'
  console.log(`  ${mark} ${String(result.script).padEnd(28)} ${result.ms === undefined ? '' : result.ms + 'ms'}  ${result.label}`)
}

// A package that passes every gate but cannot be installed is not ready.
console.log('\ninstall readiness')
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))

// ---------------------------------------------------------------------------
// The desktop question, answered from facts rather than folklore.
//
// DSH desktop's client loader only accepts `dsh.client.platform === "web"`
// (@deepseek-ai/dsh-client-modules ignores every other value), and the
// desktop profile runs the same @deepseek-ai/dsh line as `dsh web`. So
// "installable in the desktop profile" reduces to three things: the package
// shape is complete, the client stays declared as a web client, and the
// declared peer range still covers the host line the user actually runs. The
// last one is the dependency limit this check exists to keep removed.
// ---------------------------------------------------------------------------
const HOST_PACKAGE = '@deepseek-ai/dsh'
const PEER_PACKAGE = '@deepseek-ai/dsh-tools'
// 2026-10-09, this machine: the desktop profile and the global `dsh` install
// both sit on this line. Used only when the host package cannot be located.
const RECORDED_HOST_LINE = '0.2.0-rc.2'

const readVersion = (file) => {
  try {
    const version = JSON.parse(fs.readFileSync(file, 'utf8')).version
    return typeof version === 'string' ? version : null
  } catch { return null }
}

/** Where @deepseek-ai/dsh actually lives, in the order a normal run finds it. */
const locateHost = () => {
  const candidates = []
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0 && !candidates.includes(value)) candidates.push(value)
  }
  // 1. whatever `npm install ... @deepseek-ai/dsh` put next to this package.
  try {
    add(createRequire(path.join(pkgRoot, 'package.json')).resolve(`${HOST_PACKAGE}/package.json`))
  } catch { /* not installed here */ }
  // 2. the running host: its profile, DSH_HOME's shared profiles, the Node that
  //    launches it, and the global npm prefix.
  for (const base of [
    process.env.DSH_PROFILE_DIR && path.join(process.env.DSH_PROFILE_DIR, 'node_modules'),
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'profiles', 'node_modules'),
    path.join(path.dirname(process.execPath), 'node_modules'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    process.env.HOME && path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules'),
  ]) add(base && path.join(base, ...HOST_PACKAGE.split('/'), 'package.json'))
  for (const file of candidates) {
    const version = readVersion(file)
    if (version !== null) return { version, file }
  }
  return { version: null, file: null }
}

// A deliberately small semver. This file only has to judge the one peer range
// declared in package.json against the one version the host reports, so caret,
// tilde, comparator sets, `||` and exact versions are enough. It DOES reproduce
// node-semver's prerelease rule -- a prerelease version may only satisfy a
// comparator set when some comparator in that set carries a prerelease on the
// SAME [major.minor.patch] tuple. Without that rule `>=0.1.0-rc.1 <0.3.0-0`
// would look like it covers `0.2.0-rc.2`, while npm says it does not.
const parseVersion = (text) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text).trim())
  return m === null
    ? null
    : { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] === undefined ? [] : m[4].split('.') }
}

const comparePre = (a, b) => {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : (a.length === 0 ? 1 : -1)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const an = /^\d+$/.test(a[i])
    const bn = /^\d+$/.test(b[i])
    const cmp = an && bn ? +a[i] - +b[i] : an ? -1 : bn ? 1 : a[i] < b[i] ? -1 : a[i] > b[i] ? 1 : 0
    if (cmp !== 0) return cmp
  }
  return 0
}

const compareVersions = (a, b) => {
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] - b[key]
  return comparePre(a.pre, b.pre)
}

const sameTuple = (a, b) => a.major === b.major && a.minor === b.minor && a.patch === b.patch

const caretUpperBound = (base) => base.major > 0
  ? { major: base.major + 1, minor: 0, patch: 0, pre: ['0'] }
  : base.minor > 0
    ? { major: 0, minor: base.minor + 1, patch: 0, pre: ['0'] }
    : { major: 0, minor: 0, patch: base.patch + 1, pre: ['0'] }

/** One comparator token -> its numeric test plus the bounds it expanded to.
 *  `null` for anything unparseable, which fails the whole alternative.
 *  `*` / `x` / `X` means "any version" (still not a prerelease, per semver);
 *  partial wildcards such as `1.x` are reported as not covering rather than
 *  silently accepted. */
const parseComparator = (comparator) => {
  const token = comparator.trim()
  if (token === '' || token === '*' || token === 'x' || token === 'X') {
    return { test: () => true, target: parseVersion('0.0.0'), upper: null }
  }
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token)
  if (m === null) return null
  const op = m[1] ?? '='
  const caret = op === '=' && m[2].startsWith('^')
  const tilde = op === '=' && m[2].startsWith('~')
  const target = parseVersion(caret || tilde ? m[2].slice(1) : m[2])
  if (target === null) return null
  const upper = caret
    ? caretUpperBound(target)
    : tilde
      ? { major: target.major, minor: target.minor + 1, patch: 0, pre: ['0'] }
      : null
  const test = (version) => {
    if (upper !== null) {
      return compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0
    }
    const cmp = compareVersions(version, target)
    switch (op) {
      case '>=': return cmp >= 0
      case '<=': return cmp <= 0
      case '>': return cmp > 0
      case '<': return cmp < 0
      default: return cmp === 0
    }
  }
  return { test, target, upper }
}

/** null when the version itself is unparseable. */
const satisfies = (version, range) => {
  const parsedVersion = parseVersion(version)
  if (parsedVersion === null) return null
  const alternatives = String(range).split('||').map((part) => part.trim()).filter((part) => part.length > 0)
  if (alternatives.length === 0) return false
  return alternatives.some((alternative) => {
    const comparators = alternative.split(/\s+/).map(parseComparator)
    if (comparators.some((comparator) => comparator === null)) return false
    if (!comparators.every((comparator) => comparator.test(parsedVersion))) return false
    if (parsedVersion.pre.length === 0) return true
    return comparators.some((comparator) =>
      (comparator.target.pre.length > 0 && sameTuple(comparator.target, parsedVersion)) ||
      (comparator.upper !== null && comparator.upper.pre.length > 0 && sameTuple(comparator.upper, parsedVersion)))
  })
}

const host = locateHost()
const hostVersion = host.version ?? RECORDED_HOST_LINE
const peerRange = pkg.peerDependencies?.[PEER_PACKAGE]
const peerCovers = typeof peerRange === 'string' && satisfies(hostVersion, peerRange) === true

console.log(`  host line  ${HOST_PACKAGE}@${hostVersion}` +
  (host.version === null
    ? '  (recorded; the host package was not found on this machine)'
    : `  (${host.file})`))
console.log(`  peer range ${PEER_PACKAGE} "${peerRange ?? '(none declared)'}" ` +
  `${peerCovers ? 'covers' : 'does NOT cover'} ${hostVersion}`)

const checks = [
  ['package.json declares dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string'],
  ['package.json declares a web client', pkg.dsh?.client?.platform === 'web'],
  ['package.json exports ./client', pkg.exports?.['./client'] !== undefined],
  ['the host entry exists', fs.existsSync(path.join(pkgRoot, String(pkg.main).replace(/^\.\//, '')))],
  ['the client entry exists', fs.existsSync(path.join(pkgRoot, String(pkg.exports?.['./client'] ?? '').replace(/^\.\//, '')))],
  ['the patch file exists', fs.existsSync(path.join(pkgRoot, String(pkg.dsh?.bundle?.patch ?? '').replace(/^\.\//, '')))],
  // The row `name` is the resolvable package; the row `id` is the short Cordis
  // identity (the sibling plugin uses `knowledge-base` for `dsh-knowledge-base`).
  ['the patch mounts this package by name',
    fs.readFileSync(path.join(pkgRoot, 'cordis.patch.yml'), 'utf8').includes(`name: '${pkg.name}'`)],
  // The dependency limit: the declared peer range must still cover the host
  // line, or `dsh plugin add` in the desktop profile installs a plugin whose
  // optional peer is "not satisfied" by the very runtime hosting it.
  [`the ${PEER_PACKAGE} peer range covers the host line`, peerCovers],
]
let ready = true
for (const [label, condition] of checks) {
  if (!condition) ready = false
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
}

// The one line a desktop user is looking for.
console.log(`\n  桌面 profile 可安装: ${ready ? 'YES' : 'NO'}` +
  '   (client 仍是 platform "web"：DSH 桌面版的客户端加载器只认该值)')

const failed = results.filter((result) => result.code !== 0)
console.log('\n' + '='.repeat(72))
if (failed.length === 0 && ready) {
  console.log('READY: all gates pass and the package is installable (web + desktop).')
  console.log('Install with:')
  console.log('  dsh plugin --profile desktop add "' + pkgRoot + '"')
  console.log('  dsh plugin --profile web     add "' + pkgRoot + '"')
  console.log('Then restart DSH (the desktop app, or `dsh web`); the bundle layer is only read at startup.')
  process.exit(0)
}
console.log(`NOT READY: ${failed.length} gate(s) failing; package shape ready: ${ready}`)
process.exit(1)
