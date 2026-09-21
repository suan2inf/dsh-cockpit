/**
 * dsh-cockpit 核心检查模块（零依赖纯 Node ESM）。
 *
 * 同时被三个入口复用：
 *   - cli.mjs（独立命令行，DSH 挂了也能跑）
 *   - index.js（DSH host 插件，HTTP API）
 *   - update-dsh.ps1（更新前门禁 + 更新后验证）
 *
 * 设计原则：
 *   - 不 import 任何 DSH 包 —— 本模块正是为了在 DSH 双包加载出问题时还能运行。
 *   - 每项检查独立 fail-soft：单项报错降级为 warn，绝不让整个报告崩掉。
 *   - 网络检查只在 options.online = true 时执行。
 */
import { execFile } from 'node:child_process'
import { promises as fs, existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get as httpsGet } from 'node:https'
import net from 'node:net'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 定位 deepseek-harness 源码检出。插件被装进 profile 的 node_modules 后，
 * 模块相对路径不再指向仓库，所以按优先级探测：显式环境变量 → 宿主进程 cwd
 * （`pnpm dsh web` 从仓库根启动）→ 模块向上最多三级（开发期仓库内布局）。
 */
function detectRepo() {
  const candidates = [
    process.env.DSH_REPO,
    process.cwd(),
    join(HERE, '..'),
    join(HERE, '..', '..'),
    join(HERE, '..', '..', '..'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(join(c, 'packages', 'core', 'tools', 'package.json'))) return c
  }
  return process.cwd()
}

/** deepseek-harness 仓库根目录。 */
export const REPO = detectRepo()
export const DSH_HOME = join(os.homedir(), '.dsh')
export const PROFILE_WEB = join(DSH_HOME, 'profiles', 'web')

/** 已知的本地修复文件：脏文件出现在这里属于预期，不属于"来路不明的改动"。 */
const KNOWN_LOCAL_FIXES = new Set([
  'packages/core/tools/src/index.ts',
  'packages/core/agent-loop/src/tool-calls.ts',
  'pnpm-workspace.yaml',
])

/** 构建新鲜度抽查的关键包。 */
const FRESHNESS_PACKAGES = [
  'packages/core/tools',
  'packages/core/agent-loop',
  'packages/bundle/web-app',
  'packages/bundle/base',
  'apps/cli',
]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function ok(id, title, detail) { return { id, level: 'ok', title, ...(detail ? { detail } : {}) } }
function warn(id, title, detail, remedy) { return { id, level: 'warn', title, ...(detail ? { detail } : {}), ...(remedy ? { remedy } : {}) } }
function err(id, title, detail, remedy) { return { id, level: 'error', title, ...(detail ? { detail } : {}), ...(remedy ? { remedy } : {}) } }

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    // Windows 上 .cmd 不能直接 execFile（Node >= 20 安全限制），走 cmd /c。
    const isWin = process.platform === 'win32'
    const exe = isWin && !/\.(exe|com)$/i.test(cmd) ? (opts.shellExe ?? 'cmd.exe') : cmd
    const argv = exe === cmd ? args : ['/c', cmd, ...args]
    try {
      execFile(exe, argv, { timeout: opts.timeout ?? 15000, windowsHide: true, cwd: opts.cwd ?? REPO, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: String(stdout ?? ''), err: String(stderr ?? '') + (error && typeof error.code !== 'number' ? ` ${error.message}` : '') })
      })
    } catch (e) {
      // 受限环境（如 agent 沙箱）里 spawn 会同步抛 EPERM —— 降级而不是炸掉整个报告。
      resolve({ code: -1, out: '', err: `spawn 被阻止：${e?.message ?? e}` })
    }
  })
}

async function readText(path) {
  try { return await fs.readFile(path, 'utf8') } catch { return null }
}

async function readJson(path) {
  const text = await readText(path)
  if (text === null) return null
  try { return JSON.parse(text) } catch { return null }
}

// ---------------------------------------------------------------------------
// 迷你 semver：只支持本场景出现的范围形式（^、>=、>、<=、<、=、*、|| 组合）
// 遵循 npm 预发布规则：带预发布号的版本，只有当某个比较器带相同 [major,minor,patch]
// 的预发布号时才算满足。
// ---------------------------------------------------------------------------

function parseVer(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

function cmpVer(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const n = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < n; i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? +x : NaN
    const ny = /^\d+$/.test(y) ? +y : NaN
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx < ny ? -1 : 1; continue }
    if (!Number.isNaN(nx)) return -1
    if (!Number.isNaN(ny)) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function cmpOne(ver, op, cv) {
  const c = cmpVer(ver, cv)
  switch (op) {
    case '>=': return c >= 0
    case '<=': return c <= 0
    case '>': return c > 0
    case '<': return c < 0
    default: return c === 0
  }
}

/** 判断 version 是否满足 range（npm 语义的子集）。 */
export function satisfies(version, range) {
  const ver = parseVer(version)
  if (!ver) return false
  const text = String(range ?? '').trim()
  if (!text) return true
  return text.split('||').some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0 || parts.includes('*')) return true
    let hasPreComparator = false
    const allMatch = parts.every((part) => {
      let m = part.match(/^(\^|>=?|<=?|=)?(.+)$/)
      if (!m) return false
      const op = m[1] ?? '='
      const cv = parseVer(m[2])
      if (!cv) return false
      if (cv.pre.length > 0) hasPreComparator = hasPreComparator || (cv.major === ver.major && cv.minor === ver.minor && cv.patch === ver.patch)
      if (op === '^') {
        if (cmpVer(ver, cv) < 0) return false
        // ^0.x.y：上限看第一个非零位
        const upper = cv.major > 0 ? { major: cv.major + 1, minor: 0, patch: 0, pre: [] }
          : cv.minor > 0 ? { major: 0, minor: cv.minor + 1, patch: 0, pre: [] }
          : { major: 0, minor: 0, patch: cv.patch + 1, pre: [] }
        return cmpVer(ver, upper) < 0
      }
      return cmpOne(ver, op, cv)
    })
    if (!allMatch) return false
    if (ver.pre.length > 0 && !hasPreComparator) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// 各项检查
// ---------------------------------------------------------------------------

async function checkEnv() {
  const out = []
  const [maj, min] = process.versions.node.split('.').map(Number)
  if (maj > 22 || (maj === 22 && min >= 19)) out.push(ok('env.node', `Node 版本 ${process.versions.node}`))
  else out.push(err('env.node', `Node ${process.versions.node} 过旧`, 'DSH 要求 Node 22.19+ 或 24+。', '升级 Node.js 后重试。'))

  const pnpm = await run('pnpm', ['--version'], { timeout: 8000 })
  if (pnpm.code === 0) out.push(ok('env.pnpm', `pnpm ${pnpm.out.trim()} 可用`))
  else if (pnpm.code === -1) out.push({ id: 'env.pnpm', level: 'info', title: 'pnpm 检查跳过（当前环境禁止 spawn）' })
  else out.push(err('env.pnpm', 'pnpm 不可用', pnpm.err.trim() || '未找到 pnpm 命令。', 'npm i -g pnpm'))

  const portState = await new Promise((resolve) => {
    try {
      const sock = net.connect({ port: 3080, host: '127.0.0.1' })
      sock.once('connect', () => { sock.destroy(); resolve('busy') })
      sock.once('error', (e) => resolve(e?.code === 'ECONNREFUSED' ? 'free' : 'unknown'))
      sock.setTimeout(1500, () => { sock.destroy(); resolve('free') })
    } catch { resolve('unknown') }
  })
  out.push(portState === 'free'
    ? ok('env.port', '端口 3080 空闲（DSH Web 未在运行）')
    : portState === 'busy'
      ? { id: 'env.port', level: 'info', title: '端口 3080 占用中（DSH Web 正在运行）', detail: '更新前需要先关闭。' }
      : { id: 'env.port', level: 'info', title: '端口 3080 状态无法探测' })
  return out
}

async function checkGit(online) {
  const out = []
  const head = await run('git', ['log', '-1', '--format=%h %ci %s'])
  if (head.code === -1) return [{ id: 'git.head', level: 'info', title: 'git 检查跳过（当前环境禁止 spawn）' }]
  if (head.code !== 0) return [err('git.head', 'git 仓库不可用', head.err.trim())]
  out.push({ id: 'git.head', level: 'info', title: `当前提交 ${head.out.trim()}` })

  const status = await run('git', ['status', '--porcelain'])
  const lines = status.out.split('\n').filter(Boolean)
  const dirtyKnown = []
  const dirtyUnknown = []
  for (const line of lines) {
    const flag = line.slice(0, 2)
    const file = line.slice(3).replace(/^"|"$/g, '')
    if (flag.includes('?')) continue // 未跟踪文件不碍事
    if (/[MADRC]/.test(flag)) {
      ;(KNOWN_LOCAL_FIXES.has(file) ? dirtyKnown : dirtyUnknown).push(file)
    }
  }
  if (dirtyKnown.length > 0) {
    out.push({
      id: 'git.fixes', level: 'info', title: `本地修复在位（${dirtyKnown.length} 个文件）`,
      detail: dirtyKnown.join('\n'),
      remedy: '这些是 Symbol.for 修复等本地补丁。update-dsh v8 会在更新时自动备份并重放它们；不要手动 git checkout 丢弃。',
    })
  }
  if (dirtyUnknown.length > 0) {
    out.push(warn('git.dirty', `存在 ${dirtyUnknown.length} 个未识别的本地修改`, dirtyUnknown.join('\n'),
      '更新脚本会因此拒绝运行。先 git diff 确认内容，commit、stash 或丢弃后再更新。'))
  } else if (dirtyKnown.length >= 0) {
    out.push(ok('git.dirty', '没有未识别的本地修改'))
  }

  const remote = await run('git', ['remote', 'get-url', 'origin'])
  out.push({ id: 'git.remote', level: 'info', title: `origin = ${remote.out.trim() || '(未配置)'}` })

  if (online) {
    const fetch = await run('git', ['fetch', 'origin', 'master'], { timeout: 45000 })
    if (fetch.code === 0) {
      const behind = await run('git', ['rev-list', '--count', 'HEAD..origin/master'])
      const n = parseInt(behind.out.trim(), 10)
      out.push(n > 0
        ? { id: 'git.behind', level: 'info', title: `落后上游 ${n} 个提交`, remedy: '想更新时运行 update-dsh.cmd。' }
        : ok('git.behind', '与上游 master 同步'))
    } else {
      out.push(warn('git.behind', 'git fetch 失败（网络或镜像问题）', fetch.err.trim().split('\n')[0]))
    }
  }
  return out
}

/** THE 回归检测：Symbol.for 修复是否还在 src 和 lib 里。 */
async function checkSymbolFix() {
  const out = []
  const src = await readText(join(REPO, 'packages/core/tools/src/index.ts'))
  const lib = await readText(join(REPO, 'packages/core/tools/lib/index.js'))
  const reFor = /TOOL_RUNTIME_SCHEDULER[^\n]*Symbol\.for/
  const rePlain = /TOOL_RUNTIME_SCHEDULER[^\n]*= Symbol\(/
  const rePlainLib = /TOOL_RUNTIME_SCHEDULER = Symbol\(/

  if (src === null) out.push(err('fix.symbolSrc', '找不到 tools/src/index.ts', null, '确认当前目录是 deepseek-harness 仓库。'))
  else if (reFor.test(src)) out.push(ok('fix.symbolSrc', '源码侧 Symbol.for 修复在位'))
  else if (rePlain.test(src)) out.push(err('fix.symbolSrc', '源码侧 Symbol 修复丢失！',
    'packages/core/tools/src/index.ts 又回到了 Symbol()。这就是"所有工具调用 Interrupted"的根因。',
    '重新应用修复：把 Symbol(\'@deepseek-ai/dsh-tools.scheduler\') 改为 Symbol.for(...)，然后 pnpm run build。'))
  else out.push(warn('fix.symbolSrc', '源码侧找不到 TOOL_RUNTIME_SCHEDULER 声明', '上游可能重构了这个文件，需要人工确认。'))

  if (lib === null) out.push(warn('fix.symbolLib', '找不到 tools/lib/index.js（未构建？）', '运行 pnpm run build。'))
  else if (reFor.test(lib)) out.push(ok('fix.symbolLib', '编译产物侧 Symbol.for 修复在位'))
  else if (rePlainLib.test(lib)) out.push(err('fix.symbolLib', '编译产物侧 Symbol 修复丢失！',
    'packages/core/tools/lib/index.js 还是旧的 Symbol()。运行时用的就是它——工具调用会全部中断。',
    '若源码侧已是 Symbol.for：pnpm run build 重建即可。否则先修源码侧。'))
  else out.push(warn('fix.symbolLib', '编译产物里找不到 TOOL_RUNTIME_SCHEDULER', '上游可能重构了，需要人工确认。'))
  return out
}

async function checkSentinel() {
  const file = await readText(join(REPO, 'packages/core/agent-loop/src/tool-calls.ts'))
  if (file === null) return [warn('fix.sentinel', '找不到 agent-loop/tool-calls.ts')]
  if (file.includes('MISSING SCHEDULER')) {
    return [ok('fix.sentinel', '调度器哨兵日志在位', '若 Symbol 问题复发，控制台会直接打出 [dsh:tool-scheduler] MISSING SCHEDULER。')]
  }
  return [{ id: 'fix.sentinel', level: 'info', title: '调度器哨兵日志不在（上游版本已变更）' }]
}

async function checkFreshness() {
  const out = []
  const stale = []
  for (const pkg of FRESHNESS_PACKAGES) {
    const srcEntry = join(REPO, pkg, 'src', 'index.ts')
    const libEntryJs = join(REPO, pkg, 'lib', 'index.js')
    try {
      const s = await fs.stat(srcEntry)
      const l = await fs.stat(libEntryJs).catch(() => null)
      if (!l) { stale.push(`${pkg}（缺 lib）`); continue }
      if (s.mtimeMs > l.mtimeMs + 5000) stale.push(`${pkg}（src 比 lib 新 ${Math.round((s.mtimeMs - l.mtimeMs) / 60000)} 分钟）`)
    } catch { /* 入口文件命名不同，跳过 */ }
  }
  out.push(stale.length === 0
    ? ok('build.fresh', '关键包构建产物与源码同步')
    : warn('build.fresh', `${stale.length} 个关键包的构建产物可能过期`, stale.join('\n'), '运行 pnpm run build 重建。'))
  return out
}

/** 回归雷达：扫描全仓库新出现的导出级跨包 Symbol() 键。 */
async function checkSymbolRadar() {
  const out = []
  const hits = []
  const skip = (p) => /[\\/](node_modules|lib|dist|\.git)[\\/]/.test(p)
  async function walk(dir, depth) {
    if (depth > 5) return
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (['node_modules', 'lib', 'dist', '.git'].includes(e.name)) continue
        await walk(p, depth + 1)
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !skip(p)) {
        const text = await readText(p)
        if (!text) continue
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (/^export const \w+[^=]*=\s*Symbol\('/.test(lines[i])) {
            hits.push(`${p.slice(REPO.length + 1)}:${i + 1}  ${lines[i].trim()}`)
          }
        }
      }
    }
  }
  await walk(join(REPO, 'packages'), 0)
  out.push(hits.length === 0
    ? ok('radar.symbols', '未发现新的导出级 Symbol() 键', '双包加载下这类键会和 TOOL_RUNTIME_SCHEDULER 一样错位。')
    : warn('radar.symbols', `发现 ${hits.length} 个导出级 Symbol() 键（双包加载隐患）`, hits.join('\n'),
      '更新后出现"引用相等失效"类怪问题时优先怀疑它们；上游应改为 Symbol.for。'))
  return out
}

/** 解析 cordis.patch.yml 的扁平结构（- id: X / disabled: bool），查重复与冲突。 */
async function checkPatch() {
  const out = []
  const path = join(PROFILE_WEB, 'cordis.patch.yml')
  const text = await readText(path)
  if (text === null) return [warn('plugins.patch', '找不到 profile 的 cordis.patch.yml', path)]
  const entries = []
  let cur = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const idM = line.match(/^- id:\s*(.+)$/)
    if (idM) { cur = { id: idM[1].trim() }; entries.push(cur); continue }
    const dM = line.match(/^disabled:\s*(.+)$/)
    if (dM && cur) cur.disabled = dM[1].trim() !== 'false'
  }
  const byId = new Map()
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, [])
    byId.get(e.id).push(e)
  }
  const conflicts = []
  for (const [id, list] of byId) {
    if (list.length > 1) {
      const states = list.map((e) => (e.disabled ? 'disabled' : 'enabled')).join(' → ')
      conflicts.push(`${id}（出现 ${list.length} 次：${states}）`)
    }
  }
  out.push(conflicts.length === 0
    ? ok('plugins.patch', `patch 条目无重复（共 ${entries.length} 条）`)
    : warn('plugins.patch', `patch 里 ${conflicts.length} 个插件有重复条目`, conflicts.join('\n'),
      '插件管理器开关时会追加而非覆盖。手动编辑 cordis.patch.yml，每个 id 只保留一条。'))
  return { out, entries }
}

async function checkPlugins(patchEntries) {
  const out = []
  const manifest = await readJson(join(PROFILE_WEB, 'package.json'))
  if (!manifest) return [warn('plugins.manifest', '找不到 profile 的 package.json', PROFILE_WEB)]
  const deps = manifest.dependencies ?? {}
  const disabledBy = new Map()
  for (const e of patchEntries) disabledBy.set(e.id, e.disabled)

  const dshVersion = await currentDshVersion()
  // 不同产品线的包要对照各自的版本：cordis/schemastery 走 vendor 里的实际版本，
  // @deepseek-ai/dsh-* 才对照 DSH 发布版本。
  const versionFor = new Map()
  const cordisV = (await readJson(join(REPO, 'vendor/cordis/package.json')))?.version
  const schemasteryV = (await readJson(join(REPO, 'vendor/schemastery/package.json')))?.version
  if (cordisV) versionFor.set('@deepseek-ai/cordis', cordisV)
  if (schemasteryV) versionFor.set('@deepseek-ai/schemastery', schemasteryV)
  const versionOf = (pkg) => versionFor.get(pkg) ?? (pkg.startsWith('@deepseek-ai/dsh-') ? dshVersion : null)
  const rows = []
  const problems = []
  for (const [name, spec] of Object.entries(deps)) {
    if (name.startsWith('@deepseek-ai/')) continue
    const pj = await readJson(join(PROFILE_WEB, 'node_modules', name, 'package.json'))
    const installed = pj?.version ?? '(未安装)'
    const row = { name, spec, installed, enabled: null, peerIssues: [], compatNote: null }
    // enabled 状态：patch 里的插件 id 与包名不完全一致，做宽松匹配
    for (const [id, disabled] of disabledBy) {
      if (id === name || id.includes(name.replace(/^@.*\//, '').replace(/^dsh-/, '')) || name.includes(id)) {
        row.enabled = !disabled
        break
      }
    }
    if (typeof spec === 'string' && spec.startsWith('link:')) {
      const target = spec.slice(5)
      if (!existsSync(target)) {
        row.peerIssues.push('link 目标不存在')
        problems.push(`${name}: link 目标 ${target} 不存在，profile 安装会直接失败`)
      }
    }
    const peers = Object.entries(pj?.peerDependencies ?? {}).filter(([p]) => p.startsWith('@deepseek-ai/'))
    if (peers.length > 0) {
      const uncovered = peers.filter(([p, range]) => {
        const v = versionOf(p)
        return v !== null && v !== undefined && !satisfies(v, range)
      })
      if (uncovered.length > 0) {
        row.peerIssues.push(...uncovered.map(([p, r]) => `${p} ${r} 不含 ${versionOf(p)}`))
      }
    }
    const compat = pj?.dsh?.compatibility?.dshReleases
    if (compat && dshVersion && !(dshVersion in compat)) {
      row.compatNote = `作者未声明对 ${dshVersion} 的兼容性`
    } else if (compat && dshVersion) {
      row.compatNote = `${dshVersion}: ${compat[dshVersion]}`
    }
    rows.push(row)
  }
  const peerBad = rows.filter((r) => r.peerIssues.length > 0)
  if (peerBad.length > 0) {
    out.push(warn('plugins.compat', `${peerBad.length} 个插件的兼容声明未覆盖当前 DSH ${dshVersion ?? '?'}`,
      peerBad.map((r) => `${r.name}@${r.installed}: ${r.peerIssues.join('; ')}${r.compatNote ? `（${r.compatNote}）` : ''}`).join('\n'),
      '不兼容声明不等于一定坏，但更新后出问题先怀疑它们。重新启用插件时逐个开，别开一串。'))
  } else {
    out.push(ok('plugins.compat', `${rows.length} 个第三方插件的兼容声明均覆盖当前版本`))
  }
  for (const p of problems) out.push(err('plugins.link', '插件 link 依赖失效', p))
  return { out, rows, dshVersion }
}

/** 每个第三方 bundle 必须能在 profile node_modules 里解析到——否则启动直接崩。 */
async function checkBundlesResolvable() {
  const manifest = await readJson(join(PROFILE_WEB, 'package.json'))
  if (!manifest) return []
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const missing = []
  for (const b of bundles) {
    if (typeof b !== 'string' || b.startsWith('@deepseek-ai/')) continue // 内置 bundle 走仓库自身解析
    if (!existsSync(join(PROFILE_WEB, 'node_modules', b, 'package.json'))) missing.push(b)
  }
  return [missing.length === 0
    ? ok('plugins.bundles', `全部 ${bundles.length} 个 bundle 均可解析`)
    : err('plugins.bundles', `${missing.length} 个 bundle 无法解析——现在重启 DSH 会直接启动失败！`,
      missing.map((b) => `${b}：profile 的 package.json 声明了它，但 node_modules/${b} 不存在`).join('\n'),
      '二选一：从 dsh.profile.bundles 里移除这些名字；或在 profile 目录跑 pnpm install 让链接落地。改完再重启。')]
}

async function checkJunctions() {
  const out = []
  const nmDir = join(DSH_HOME, 'profiles', 'node_modules')
  if (!existsSync(nmDir)) return [warn('plugins.junctions', 'profiles/node_modules 不存在')]
  let broken = []
  let total = 0
  try {
    for (const name of await fs.readdir(nmDir)) {
      const p = join(nmDir, name)
      try {
        if (lstatSync(p).isSymbolicLink()) {
          total++
          realpathSync(p)
        }
      } catch { broken.push(name) }
    }
  } catch { return [warn('plugins.junctions', '无法读取 profiles/node_modules')] }
  out.push(broken.length === 0
    ? ok('plugins.junctions', `profiles/node_modules 的 ${total} 个 junction 均有效`)
    : warn('plugins.junctions', `${broken.length} 个 junction 指向失效（旧版解析器残留）`, broken.join('\n'),
      '当前版本运行不依赖它们（GUI 正常即证明）。若以后出现模块加载异常，可删除这些失效 junction 后重启。'))
  return out
}

async function checkBackups() {
  const home = os.homedir()
  let entries
  try { entries = await fs.readdir(home) } catch { return [] }
  const backups = []
  for (const name of entries) {
    if (!name.startsWith('.dsh-backup-')) continue
    try {
      const s = await fs.stat(join(home, name))
      backups.push({ name, mtime: s.mtimeMs })
    } catch { /* ignore */ }
  }
  backups.sort((a, b) => b.mtime - a.mtime)
  if (backups.length === 0) {
    return [warn('data.backup', '没有任何 .dsh 备份', null, 'update-dsh 默认会自动备份；若用过 -SkipBackup，建议别再用。')]
  }
  const ageDays = Math.floor((Date.now() - backups[0].mtime) / 86400000)
  return [ageDays <= 7
    ? ok('data.backup', `最近备份 ${backups[0].name}（${ageDays} 天前），共 ${backups.length} 份`)
    : warn('data.backup', `最近备份已是 ${ageDays} 天前（${backups[0].name}）`, null, '下次更新不要加 -SkipBackup。')]
}

async function currentDshVersion() {
  for (const p of ['apps/cli/package.json', 'packages/core/tools/package.json']) {
    const j = await readJson(join(REPO, p))
    if (j?.version) return j.version
  }
  return null
}

/** 拉取上游最新 release（GitHub API，失败返回 null——境内直连常常不可达）。 */
export async function fetchLatestRelease() {
  return new Promise((resolve) => {
    const req = httpsGet({
      host: 'api.github.com',
      path: '/repos/deepseek-ai/deepseek-harness/releases/latest',
      headers: { 'user-agent': 'dsh-cockpit', accept: 'application/vnd.github+json' },
      timeout: 10000,
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/** 通过 git 远端 tag 拿最新发布版本号——走用户自己配置的 origin（镜像），不依赖 GitHub API 可达性。 */
export async function fetchLatestTag() {
  const r = await run('git', ['ls-remote', '--tags', 'origin'], { timeout: 30000 })
  if (r.code !== 0) return null
  const tags = [...new Set(
    [...r.out.matchAll(/refs\/tags\/dsh-v([^\s^]+)$/gm)].map((m) => m[1]).filter((t) => parseVer(t)),
  )]
  if (tags.length === 0) return null
  tags.sort((a, b) => cmpVer(parseVer(a), parseVer(b)))
  return tags[tags.length - 1]
}

const BREAKING_RE = /移除|不再兼容|需.*更新|需更新|弃用|调整为|破坏性|breaking|rename|改名/i

/** 更新预览：当前版本 vs 最新发布 + 提交差 + 发布说明里挑出的注意事项。 */
export async function getUpdatePreview() {
  const current = await currentDshVersion()
  const head = await run('git', ['log', '-1', '--format=%h %ci %s'])
  const result = {
    current,
    head: head.code === 0 ? head.out.trim() : null,
    behind: null,
    latest: null,
    error: null,
  }
  const gitOk = head.code !== -1
  if (gitOk) {
    const fetch = await run('git', ['fetch', 'origin', 'master'], { timeout: 45000 })
    if (fetch.code === 0) {
      const behind = await run('git', ['rev-list', '--count', 'HEAD..origin/master'])
      const n = parseInt(behind.out.trim(), 10)
      if (!Number.isNaN(n)) result.behind = n
    } else {
      result.error = `git fetch 失败：${fetch.err.trim().split('\n')[0] || '网络或镜像不可达'}`
    }
  } else {
    result.error = '当前环境禁止 spawn，git 检查不可用'
  }

  // 版本号以 git tag 为准（走用户配置的镜像）；发布说明是可选增强（GitHub API 直连，常不可达）。
  const latestTag = gitOk ? await fetchLatestTag() : null
  const release = await fetchLatestRelease()
  const version = release?.tag_name?.replace(/^dsh-v/, '') ?? latestTag
  if (!version) {
    result.error = [result.error, '无法获取最新版本（git 镜像与 GitHub API 均不可达）'].filter(Boolean).join('；')
    return result
  }
  const body = String(release?.body ?? '')
  const bullets = body.split('\n').filter((l) => l.trim().startsWith('- '))
  result.latest = {
    version,
    name: release?.name ?? `dsh-v${version}`,
    publishedAt: release?.published_at ?? null,
    url: `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${version}`,
    bullets: bullets.slice(0, 40),
    breaking: bullets.filter((l) => BREAKING_RE.test(l)).slice(0, 20),
    notesUnavailable: !release,
  }
  return result
}

async function checkLatestRelease(online) {
  if (!online) return []
  const latestTag = await fetchLatestTag()
  const release = await fetchLatestRelease()
  const latest = release?.tag_name?.replace(/^dsh-v/, '') ?? latestTag
  if (!latest) return [warn('release.latest', '无法查询上游最新版本（git 镜像与 GitHub API 均不可达）')]
  const current = await currentDshVersion()
  if (current === latest) return [ok('release.latest', `已是最新发布 ${latest}`)]
  return [{
    id: 'release.latest', level: 'info',
    title: `上游最新发布 ${latest}（当前 ${current ?? '?'}）`,
    detail: release
      ? (release.body ?? '').split('\n').filter((l) => l.trim().startsWith('-')).slice(0, 12).join('\n')
      : '发布说明未能拉取（GitHub API 不可达），可在浏览器打开发布页面查看。',
    remedy: '更新前重点看发布说明里的「其他变更」——破坏性改动都列在那里。',
  }]
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 跑完整体检。
 * @param {{ online?: boolean }} options online=true 时额外做 git fetch / GitHub release 查询
 * @returns 结构化报告
 */
export async function runCockpit(options = {}) {
  const startedAt = new Date().toISOString()
  const checks = []
  const push = (items) => { checks.push(...items) }
  const guard = async (fn) => {
    try { return await fn() } catch (e) {
      return [warn('cockpit.internal', `检查项异常：${e?.message ?? e}`)]
    }
  }

  const patch = await guard(checkPatch)
  push(patch.out ?? patch)
  const plugins = await guard(() => checkPlugins(patch.entries ?? []))
  push(plugins.out ?? plugins)
  push(await guard(checkEnv))
  push(await guard(() => checkGit(!!options.online)))
  push(await guard(checkSymbolFix))
  push(await guard(checkSentinel))
  push(await guard(checkFreshness))
  push(await guard(checkSymbolRadar))
  push(await guard(checkBundlesResolvable))
  push(await guard(checkJunctions))
  push(await guard(checkBackups))
  push(await guard(() => checkLatestRelease(!!options.online)))

  // 综合「现在更新是否安全」门禁
  const gateReasons = []
  const symbolLost = checks.some((c) => (c.id === 'fix.symbolSrc' || c.id === 'fix.symbolLib') && c.level === 'error')
  const dirtyUnknown = checks.find((c) => c.id === 'git.dirty' && c.level === 'warn')
  if (symbolLost) gateReasons.push('Symbol 修复丢失：现在更新后工具调用必然全部中断，先修复。')
  if (dirtyUnknown) gateReasons.push('有未识别的本地修改，更新脚本会拒绝；先处理。')
  const gate = gateReasons.length === 0
    ? { level: 'ok', title: '当前状态可以安全更新', detail: '跑 update-dsh.cmd 即可；它会自动备份本地修复并在更新后重放。' }
    : { level: 'error', title: '现在更新有风险', detail: gateReasons.join('\n') }

  const summary = {
    ok: checks.filter((c) => c.level === 'ok').length,
    info: checks.filter((c) => c.level === 'info').length,
    warn: checks.filter((c) => c.level === 'warn').length,
    error: checks.filter((c) => c.level === 'error').length,
  }
  return {
    schema: 'dsh-cockpit/v1',
    startedAt,
    repo: REPO,
    dshHome: DSH_HOME,
    dshVersion: plugins.dshVersion ?? (await currentDshVersion()),
    gate,
    summary,
    checks,
    plugins: plugins.rows ?? [],
  }
}
