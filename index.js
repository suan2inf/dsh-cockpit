/**
 * dsh-cockpit host 插件：体检 + 修复 + 更新三合一管理中心的宿主侧。
 *
 *   GET  /dsh-cockpit                       → 独立仪表盘页面（不依赖客户端槽位 API）
 *   GET  /dsh-cockpit/api/report[?online=1] → 结构化体检报告
 *   GET  /dsh-cockpit/api/fixes             → 全部修复项及是否需要修
 *   POST /dsh-cockpit/api/fix/<id>          → 执行一个修复（要求同源）
 *   GET  /dsh-cockpit/api/update-preview    → 在线更新预览（fetch + 最新发布说明）
 *   POST /dsh-cockpit/api/update/launch     → 启动延迟更新助手（等 DSH 关闭后自动更新并重启）
 *
 * 修复/更新是写操作，一律要求浏览器同源（Origin/Referer 为本机服务）。
 * core/ 两个模块不 import 任何 DSH 包，双包加载问题影响不到它们。
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCockpit, getUpdatePreview, REPO } from './core/cockpit-core.mjs'
import { assessAllFixes, applyFix, getFixMeta } from './core/cockpit-fixes.mjs'

export const name = 'dsh-cockpit'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_PATH = join(HERE, 'page.html')
const DEFERRED_UPDATER = join(HERE, 'scripts', 'update-deferred.ps1')

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/** 同源检查：浏览器的跨站 POST 一定带异源 Origin；本机 curl/node 不带 Origin，直接放行。 */
function isLocalRequest(request) {
  const source = request.headers?.origin ?? request.headers?.referer
  if (!source) return true
  try {
    const url = new URL(source)
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

function methodGuard(request, response, want) {
  if (request.method === want) return true
  response.writeHead(405, { allow: want })
  response.end()
  return false
}

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = [
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-cockpit/api/report',
          handler: async (request, response) => {
            if (!methodGuard(request, response, 'GET')) return
            try {
              const online = new URL(request.url ?? '', 'http://localhost').searchParams.get('online') === '1'
              sendJson(response, 200, await runCockpit({ online }))
            } catch (e) {
              sendJson(response, 500, { schema: 'dsh-cockpit/v1', error: String(e?.message ?? e) })
            }
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-cockpit/api/fixes',
          handler: async (request, response) => {
            if (!methodGuard(request, response, 'GET')) return
            sendJson(response, 200, { schema: 'dsh-cockpit/v1', fixes: await assessAllFixes() })
          },
        }),
        host.webServer.register({
          kind: 'prefix',
          path: '/dsh-cockpit/api/fix/',
          handler: async (request, response) => {
            if (!methodGuard(request, response, 'POST')) return
            if (!isLocalRequest(request)) {
              sendJson(response, 403, { schema: 'dsh-cockpit/v1', error: 'cross-origin write rejected' })
              return
            }
            const id = decodeURIComponent((request.url ?? '').split('/dsh-cockpit/api/fix/')[1] ?? '').split('?')[0]
            if (!getFixMeta(id)) {
              sendJson(response, 404, { schema: 'dsh-cockpit/v1', error: `unknown fix: ${id}` })
              return
            }
            sendJson(response, 200, { schema: 'dsh-cockpit/v1', id, result: await applyFix(id) })
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-cockpit/api/update-preview',
          handler: async (request, response) => {
            if (!methodGuard(request, response, 'GET')) return
            try {
              sendJson(response, 200, { schema: 'dsh-cockpit/v1', preview: await getUpdatePreview() })
            } catch (e) {
              sendJson(response, 500, { schema: 'dsh-cockpit/v1', error: String(e?.message ?? e) })
            }
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-cockpit/api/update/launch',
          handler: async (request, response) => {
            if (!methodGuard(request, response, 'POST')) return
            if (!isLocalRequest(request)) {
              sendJson(response, 403, { schema: 'dsh-cockpit/v1', error: 'cross-origin write rejected' })
              return
            }
            try {
              const ps = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
              const child = spawn('cmd.exe', ['/c', 'start', '"DSH 更新助手"', ps, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DEFERRED_UPDATER, '-Repo', REPO], { detached: true, stdio: 'ignore' })
              child.unref()
              sendJson(response, 200, { schema: 'dsh-cockpit/v1', launched: true, hint: '更新助手窗口已打开，等待 DSH Web 关闭。' })
            } catch (e) {
              sendJson(response, 500, { schema: 'dsh-cockpit/v1', launched: false, error: String(e?.message ?? e) })
            }
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-cockpit',
          handler: async (request, response) => {
            if (!methodGuard(request, response, 'GET')) return
            try {
              response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              response.end(await readFile(PAGE_PATH, 'utf8'))
            } catch (e) {
              response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              response.end(`page.html unreadable: ${e?.message ?? e}`)
            }
          },
        }),
      ]
      return () => { for (const d of disposers) d?.() }
    }, 'dsh-cockpit: http routes')
  })
}
