/**
 * dsh-cockpit 修复执行模块：每个修复都是幂等的、可重复执行的、返回结构化结果。
 *
 * 与 cockpit-core.mjs（只读诊断）分离：诊断绝不出错，修复明确改动什么。
 * 同一套实现同时服务三个入口：CLI（DSH 死了也能修）、host 插件 HTTP 路由、更新脚本。
 */
import { promises as fs, existsSync, lstatSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import os from 'node:os'
import { REPO, DSH_HOME, PROFILE_WEB } from './cockpit-core.mjs'

const ok = (message, details) => ({ ok: true, message, ...(details ? { details } : {}) })
const fail = (message, details) => ({ ok: false, message, ...(details ? { details } : {}) })

// ---------------------------------------------------------------------------
// 修复目录：assess() 判断"是否需要修"，apply() 执行
// ---------------------------------------------------------------------------

export const FIXES = [
  {
    id: 'dedupe-patch',
    title: '清理 cordis.patch.yml 重复条目',
    description: '插件管理器开关插件时会往 patch 文件追加新行而不是覆盖旧行，同一个插件可能既有 enabled 又有 disabled。此修复按「最后一条为准」去重，并保留原文件备份。',
    risk: 'low',
  },
  {
    id: 'prune-junctions',
    title: '清理失效 junction',
    description: 'profiles/node_modules 里旧版解析器留下的失效链接（pnpm 重装后目标已不存在）。当前版本不依赖它们，删掉避免干扰。',
    risk: 'low',
  },
  {
    id: 'prune-backups',
    title: '清理旧 .dsh 备份',
    description: '每次更新都会整份备份 ~/.dsh，长期累积占磁盘。保留最近 3 份，删除更早的。',
    risk: 'moderate',
  },
  {
    id: 'resymbol',
    title: '重新应用 Symbol.for 修复',
    description: '工具调度器的 Symbol 身份修复（src + lib 双侧原位修改，不用全量 build）。这就是「所有工具调用 Interrupted」的根因修复，更新后若被上游覆盖可一键恢复。',
    risk: 'low',
  },
  {
    id: 'relink-bundles',
    title: '重建缺失的插件链接',
    description: 'profile 的 bundles 里声明了、但 node_modules 里不存在的 link: 类插件——这会让 DSH 启动直接失败。此修复按 manifest 里的 link: 目标重建目录联接（junction）。',
    risk: 'low',
  },
]

export function getFixMeta(id) {
  return FIXES.find((f) => f.id === id)
}

// ---------------------------------------------------------------------------
// dedupe-patch
// ---------------------------------------------------------------------------

function parsePatchBlocks(text) {
  // 按 "- id:" 切块；块内只允许出现 disabled:（出现其它键则不是安全块）
  const lines = text.split('\n')
  const head = []
  const blocks = []
  let cur = null
  for (const line of lines) {
    if (/^\s*- id:/.test(line)) {
      cur = { lines: [line], id: line.replace(/^\s*- id:\s*/, '').trim(), safe: true }
      blocks.push(cur)
      continue
    }
    if (cur === null) { head.push(line); continue }
    cur.lines.push(line)
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    if (/^disabled:\s*(true|false)\s*$/.test(t)) continue
    cur.safe = false // 有其它配置键，不碰这个块
  }
  return { head, blocks }
}

async function assessDedupePatch() {
  const path = join(PROFILE_WEB, 'cordis.patch.yml')
  if (!existsSync(path)) return { needed: false, note: 'patch 文件不存在' }
  const text = await fs.readFile(path, 'utf8')
  const { blocks } = parsePatchBlocks(text)
  const seen = new Map()
  let dupes = 0
  for (const b of blocks) {
    if (!b.safe) continue
    if (seen.has(b.id)) dupes++
    seen.set(b.id, b)
  }
  return dupes > 0
    ? { needed: true, note: `${dupes} 个插件有重复条目` }
    : { needed: false, note: '无重复条目' }
}

async function applyDedupePatch() {
  const path = join(PROFILE_WEB, 'cordis.patch.yml')
  if (!existsSync(path)) return fail('cordis.patch.yml 不存在')
  const text = await fs.readFile(path, 'utf8')
  const { head, blocks } = parsePatchBlocks(text)
  const lastById = new Map()
  const order = []
  const skipped = []
  for (const b of blocks) {
    if (!b.safe) { skipped.push(b); continue }
    if (!lastById.has(b.id)) order.push(b.id)
    lastById.set(b.id, b)
  }
  const dupes = blocks.filter((b) => b.safe).length - lastById.size
  if (dupes === 0 && skipped.length === blocks.length) return ok('无需清理')
  if (dupes === 0) return ok('无需清理（存在含额外配置的条目，保持原样）')

  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`
  await fs.writeFile(backup, text, 'utf8')
  const kept = order.map((id) => lastById.get(id).lines.join('\n').trimEnd())
  const out = [...head.join('\n').trimEnd().split('\n'), ...kept, ...skipped.map((b) => b.lines.join('\n').trimEnd())]
    .filter((s, i) => !(s === '' && i === 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  await fs.writeFile(path, out.endsWith('\n') ? out : out + '\n', 'utf8')
  return ok(`已按「最后一条为准」去掉 ${dupes} 条重复`, `原文件备份：${backup}\n需要重启 DSH Web 生效。`)
}

// ---------------------------------------------------------------------------
// prune-junctions
// ---------------------------------------------------------------------------

async function listBrokenJunctions() {
  const nmDir = join(DSH_HOME, 'profiles', 'node_modules')
  if (!existsSync(nmDir)) return []
  const broken = []
  for (const name of await fs.readdir(nmDir)) {
    const p = join(nmDir, name)
    try {
      if (lstatSync(p).isSymbolicLink()) {
        try { realpathSync(p) } catch { broken.push(p) }
      }
    } catch { /* 读不到的条目跳过 */ }
  }
  return broken
}

async function assessPruneJunctions() {
  const broken = await listBrokenJunctions()
  return broken.length > 0
    ? { needed: true, note: `${broken.length} 个失效 junction` }
    : { needed: false, note: '没有失效 junction' }
}

async function applyPruneJunctions() {
  const broken = await listBrokenJunctions()
  if (broken.length === 0) return ok('没有失效 junction')
  const removed = []
  const failed = []
  for (const p of broken) {
    try { await fs.unlink(p); removed.push(p) } catch (e) { failed.push(`${p}: ${e.message}`) }
  }
  if (failed.length > 0) return fail(`删除失败 ${failed.length} 个`, failed.join('\n'))
  return ok(`已删除 ${removed.length} 个失效 junction`, removed.join('\n'))
}

// ---------------------------------------------------------------------------
// prune-backups
// ---------------------------------------------------------------------------

async function listBackups() {
  const home = os.homedir()
  const dirs = []
  for (const name of await fs.readdir(home).catch(() => [])) {
    if (!name.startsWith('.dsh-backup-')) continue
    try {
      const s = await fs.stat(join(home, name))
      if (s.isDirectory()) dirs.push({ name, path: join(home, name), mtime: s.mtimeMs })
    } catch { /* 跳过 */ }
  }
  return dirs.sort((a, b) => b.mtime - a.mtime)
}

const KEEP_BACKUPS = 3

async function assessPruneBackups() {
  const backups = await listBackups()
  return backups.length > KEEP_BACKUPS
    ? { needed: true, note: `共 ${backups.length} 份备份，可清理 ${backups.length - KEEP_BACKUPS} 份` }
    : { needed: false, note: `共 ${backups.length} 份备份，无需清理` }
}

async function applyPruneBackups() {
  const backups = await listBackups()
  const doomed = backups.slice(KEEP_BACKUPS)
  if (doomed.length === 0) return ok(`只有 ${backups.length} 份备份，无需清理`)
  const removed = []
  const failed = []
  for (const b of doomed) {
    try { await fs.rm(b.path, { recursive: true, force: true }); removed.push(b.name) }
    catch (e) { failed.push(`${b.name}: ${e.message}`) }
  }
  const kept = backups.slice(0, KEEP_BACKUPS).map((b) => b.name).join('\n')
  if (failed.length > 0) return fail(`${failed.length} 份删除失败`, failed.join('\n'))
  return ok(`已删除 ${removed.length} 份旧备份，保留最近 ${Math.min(KEEP_BACKUPS, backups.length)} 份`, `保留：\n${kept}`)
}

// ---------------------------------------------------------------------------
// resymbol（src + lib 双侧原位修复，免全量 build）
// ---------------------------------------------------------------------------

const SYMBOL_KEY = '@deepseek-ai/dsh-tools.scheduler'

async function resymbolFile(path, isSrc) {
  if (!existsSync(path)) return { file: path, state: 'missing' }
  const text = await fs.readFile(path, 'utf8')
  if (text.includes(`Symbol.for('${SYMBOL_KEY}')`) || text.includes(`Symbol.for("${SYMBOL_KEY}")`)) {
    return { file: path, state: 'already' }
  }
  for (const quote of ["'", '"']) {
    const needle = `Symbol(${quote}${SYMBOL_KEY}${quote})`
    if (text.includes(needle)) {
      const replacement = isSrc ? `Symbol.for(${quote}${SYMBOL_KEY}${quote}) as any` : `Symbol.for(${quote}${SYMBOL_KEY}${quote})`
      await fs.writeFile(path, text.replace(needle, replacement), 'utf8')
      return { file: path, state: 'fixed' }
    }
  }
  return { file: path, state: 'unknown' }
}

async function assessResymbol() {
  const src = join(REPO, 'packages/core/tools/src/index.ts')
  const lib = join(REPO, 'packages/core/tools/lib/index.js')
  const states = [await resymbolFileProbe(src), await resymbolFileProbe(lib)]
  async function resymbolFileProbe(p) {
    if (!existsSync(p)) return 'missing'
    const text = await fs.readFile(p, 'utf8')
    if (text.includes(`Symbol.for('${SYMBOL_KEY}')`) || text.includes(`Symbol.for("${SYMBOL_KEY}")`)) return 'ok'
    if (text.includes(`Symbol('${SYMBOL_KEY}')`) || text.includes(`Symbol("${SYMBOL_KEY}")`)) return 'broken'
    return 'unknown'
  }
  if (states.includes('broken')) {
    return { needed: true, note: `src=${states[0]} lib=${states[1]}——工具调用处于中断风险/已中断` }
  }
  if (states.includes('unknown')) return { needed: false, note: '声明形态无法识别（上游可能已重构）' }
  return { needed: false, note: '修复在位' }
}

async function applyResymbol() {
  const src = join(REPO, 'packages/core/tools/src/index.ts')
  const lib = join(REPO, 'packages/core/tools/lib/index.js')
  const r1 = await resymbolFile(src, true)
  const r2 = await resymbolFile(lib, false)
  const lines = [
    `src: ${r1.state}（${r1.file}）`,
    `lib: ${r2.state}（${r2.file}）`,
  ]
  if (r1.state === 'unknown' || r2.state === 'unknown') {
    return fail('未找到可修复的 Symbol 声明，上游可能已重构，需要人工核对', lines.join('\n'))
  }
  if (r1.state === 'missing' || r2.state === 'missing') {
    return fail('文件缺失', lines.join('\n'))
  }
  const fixed = [r1, r2].filter((r) => r.state === 'fixed').length
  if (fixed === 0) return ok('修复已在位，无需处理', lines.join('\n'))
  return ok(`已重新应用 Symbol.for 修复（${fixed} 个文件）`, lines.join('\n') + '\n重启 DSH Web 后生效。')
}

// ---------------------------------------------------------------------------
// relink-bundles（把 Claude Code 的手工修复自动化）
// ---------------------------------------------------------------------------

async function findMissingBundles() {
  const manifestPath = join(PROFILE_WEB, 'package.json')
  if (!existsSync(manifestPath)) return { manifest: null, missing: [] }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const deps = manifest?.dependencies ?? {}
  const missing = []
  for (const b of bundles) {
    if (typeof b !== 'string' || b.startsWith('@deepseek-ai/')) continue
    if (!existsSync(join(PROFILE_WEB, 'node_modules', b, 'package.json'))) {
      missing.push({ name: b, spec: deps[b] })
    }
  }
  return { manifest, missing }
}

async function assessRelinkBundles() {
  const { missing } = await findMissingBundles()
  return missing.length > 0
    ? { needed: true, note: `${missing.length} 个 bundle 无法解析：${missing.map((m) => m.name).join(', ')}` }
    : { needed: false, note: '全部 bundle 可解析' }
}

async function applyRelinkBundles() {
  const { manifest, missing } = await findMissingBundles()
  if (!manifest) return fail('profile package.json 不存在')
  if (missing.length === 0) return ok('全部 bundle 可解析，无需处理')
  const lines = []
  let failed = 0
  for (const m of missing) {
    if (typeof m.spec === 'string' && m.spec.startsWith('link:')) {
      const target = resolve(m.spec.slice(5))
      if (!existsSync(target)) {
        lines.push(`✗ ${m.name}: link 目标不存在 ${target}`)
        failed++
        continue
      }
      const linkPath = join(PROFILE_WEB, 'node_modules', ...m.name.split('/'))
      try {
        await fs.mkdir(join(PROFILE_WEB, 'node_modules', ...m.name.split('/').slice(0, -1)), { recursive: true })
        await fs.symlink(target, linkPath, 'junction')
        lines.push(`✓ ${m.name} -> ${target}`)
      } catch (e) {
        lines.push(`✗ ${m.name}: ${e.message}`)
        failed++
      }
    } else {
      lines.push(`✗ ${m.name}: 不是 link: 依赖（${m.spec ?? '未声明'}），需要在 profile 目录跑 pnpm install`)
      failed++
    }
  }
  if (failed > 0) return fail(`${failed} 个 bundle 未能修复`, lines.join('\n'))
  return ok(`已重建 ${missing.length} 个插件链接`, lines.join('\n'))
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

const IMPL = {
  'dedupe-patch': { assess: assessDedupePatch, apply: applyDedupePatch },
  'prune-junctions': { assess: assessPruneJunctions, apply: applyPruneJunctions },
  'prune-backups': { assess: assessPruneBackups, apply: applyPruneBackups },
  'resymbol': { assess: assessResymbol, apply: applyResymbol },
  'relink-bundles': { assess: assessRelinkBundles, apply: applyRelinkBundles },
}

/** 所有修复项及其当前状态（是否需要修）。 */
export async function assessAllFixes() {
  const out = []
  for (const f of FIXES) {
    try {
      const a = await IMPL[f.id].assess()
      out.push({ ...f, ...a })
    } catch (e) {
      out.push({ ...f, needed: false, note: `评估失败：${e?.message ?? e}` })
    }
  }
  return out
}

/** 执行一个修复。 */
export async function applyFix(id) {
  const impl = IMPL[id]
  if (!impl) return fail(`未知修复项: ${id}`)
  try {
    return await impl.apply()
  } catch (e) {
    return fail(`修复执行异常：${e?.message ?? e}`)
  }
}
