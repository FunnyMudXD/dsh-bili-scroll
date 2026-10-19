/**
 * lib/qr.mjs —— 画登录二维码（**不再依赖用户机器上的 Python**）
 * ============================================================================
 * 🔴 2026-10-19 真机 bug（"点扫码登录不出二维码"）：
 *    原实现只走 `renderQrPng(cfg.pythonPath, …)` —— 用 Python 的 `qrcode` 包画 PNG。
 *    而**生效的 `pythonPath` 可能是系统那个 python**（本机实测：配置里写着 venv 的 exe，
 *    但宿主设置页那份把人话覆盖成了 `python`），系统 python 里没有 `qrcode`
 *    ⇒ Python 退出码非 0 ⇒ 函数返回 null ⇒ 设置页永远显示「没画出二维码」✗
 *    （duty.log 里那串「没画出 PNG —— venv 里大概还没有 qrcode」正是这条死路）
 *
 * 现在的顺序（每一层都自己带错误原因，全挂时把真话带回去）：
 *   ① **Node 侧 `qrcode` 包**（纯 JS、无子进程、profile 的 node_modules 里本来就有）
 *   ② Python 兜底：**venv 里那个 python 优先**（依赖是插件自己装的，一定有 qrcode），
 *      最后才用配置里那个；并**保留 stderr**，别再把真实报错吞掉
 *   ③ 都失败 ⇒ 返回 `errors`，界面照实显示（而不是让用户去猜"是不是没装 qrcode"）
 *
 * ⚠️ 另一个老坑一并修了：Python 那条路原来**不删旧 PNG** ⇒ 上一次成功留下的
 *    `qrcode_login.png` 还在，这次哪怕画失败也会 `existsSync` 命中、把**过期二维码**发出去 ✗
 *    ⇒ 每次动手前先删掉目标文件。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 单文件产物名（present / 设置页都认它） */
export const QR_PNG_NAME = 'qrcode_login.png'

const rmQuiet = (f) => { try { rmSync(f, { force: true }) } catch { /* 删不掉就算了，下面的写会覆盖 */ } }

/**
 * 找 `qrcode` 包的入口。
 * ⚠️ 为什么不能只写 `await import('qrcode')`：这是 pnpm 的 profile 树 —— `qrcode` 现在是**别的插件**
 *    带进来的传递依赖，能解析到纯属运气；哪天那个插件被卸了，这行就炸 ⇒ 二维码又不出 ✗。
 *    所以：先按正常解析试；再**显式**去几棵树里找（插件自己 / profile 根 / 各个 profile）；
 *    实在没有还有 Python 兜底（见下面 viaPython）。都不行才报错（并把原因带回去）。
 */
async function loadQrcode() {
  try {
    const m = await import('qrcode')
    const q = m?.default ?? m
    if (typeof q?.toBuffer === 'function') return q
  } catch { /* 继续显式找 */ }

  const here = dirname(fileURLToPath(import.meta.url))
  const dirs = [
    join(here, '..', 'node_modules', 'qrcode'),          // 插件自己装的
    join(here, '..', '..', 'qrcode'),                    // profile 根的 node_modules/qrcode
  ]
  // 各 profile 的 node_modules 里也可能有（多 profile 的机器）
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(home, 'profiles'))) dirs.push(join(home, 'profiles', p, 'node_modules', 'qrcode'))
  } catch { /* 没有就算了 */ }

  for (const dir of dirs) {
    const entry = join(dir, 'lib', 'index.js')
    if (!existsSync(entry)) continue
    try {
      const m = await import(pathToFileURL(entry).href)
      const q = m?.default ?? m
      if (typeof q?.toBuffer === 'function') return q
    } catch { /* 这个也不成，接着找 */ }
  }
  throw new Error('找不到 qrcode 包（Node 侧）')
}

/** ① Node 的 qrcode（最快、最稳；拿不到就抛，交给 ② ） */
async function viaNodeQrcode(url, png) {
  const qr = await loadQrcode()
  const buf = await qr.toBuffer(url, { type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M' })
  if (!buf || !buf.length) throw new Error('toBuffer 返回空')
  writeFileSync(png, buf)
  return buf
}

/** ② Python 兜底：跑 `qrcode.make(url).save(png)`，超时/非 0 都算失败并带回 stderr */
function viaPython(py, url, png, stateDir) {
  return new Promise((resolve) => {
    const code = 'import sys, qrcode; qrcode.make(sys.argv[1]).save(sys.argv[2])'
    let child
    try {
      child = spawn(py, ['-c', code, url, png], { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { resolve({ ok: false, error: '起不来：' + (e?.message ?? e) }); return }
    let err = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已经退了 */ } }, 20000)
    child.stdout?.on('data', () => { /* 正常不输出 */ })
    child.stderr?.on('data', (b) => { if (err.length < 1200) err += String(b) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: '起不来：' + (e?.message ?? e) }) })
    child.on('exit', (c) => {
      clearTimeout(timer)
      if (c === 0 && existsSync(png)) { resolve({ ok: true }); return }
      resolve({ ok: false, error: `exit ${c}${err ? '：' + err.trim().split('\n').slice(-2).join(' ') : ''}` })
    })
  })
}

/**
 * 画二维码。
 * @param {object} o
 * @param {string} o.url              二维码内容（B站 passport 给的登录 url）
 * @param {string} o.stateDir         插件家目录（PNG 落这儿）
 * @param {string[]} [o.pythonCandidates] 兜底用的 python，按优先级排（已去重）
 * @param {(s:string)=>void} [o.log]
 * @returns {Promise<{png:string|null, dataUrl:string|null, via:string, errors:string[]}>}
 */
export async function renderQr({ url, stateDir, pythonCandidates = [], log = () => {} }) {
  const errors = []
  if (!url) return { png: null, dataUrl: null, via: '', errors: ['没有可编码的 url'] }
  try { mkdirSync(stateDir, { recursive: true }) } catch { /* 建不了的话下面写会报错，逐层兜 */ }
  const png = join(stateDir, QR_PNG_NAME)
  rmQuiet(png)                                     // ⭐ 先删旧的，绝不让过期码冒充新码

  // ① Node 侧（`BILI_DUTY_QR=python` 可以强制走 Python 兜底 —— 排查用）
  const forced = String(process.env.BILI_DUTY_QR || '').toLowerCase()
  if (forced !== 'python') {
    try {
      const buf = await viaNodeQrcode(url, png)
      return { png, dataUrl: 'data:image/png;base64,' + buf.toString('base64'), via: 'node-qrcode', errors }
    } catch (e) {
      errors.push('node qrcode: ' + (e?.message ?? e))
      log(`二维码：Node 侧 qrcode 不可用（${e?.message ?? e}），改用 Python 兜底`)
    }
  } else {
    log('二维码：按 BILI_DUTY_QR=python 强制走 Python 兜底')
  }

  // ② Python 兜底
  const tried = new Set()
  for (const py of pythonCandidates) {
    const x = String(py || '').trim()
    if (!x || tried.has(x.toLowerCase())) continue
    tried.add(x.toLowerCase())
    // 指到具体文件时先看存在不存在，省得白起一个进程
    if ((x.includes('\\') || x.includes('/')) && !existsSync(x)) { errors.push(`${x}：文件不存在`); continue }
    const r = await viaPython(x, url, png, stateDir)
    if (r.ok) {
      try {
        const buf = readFileSync(png)
        return { png, dataUrl: 'data:image/png;base64,' + buf.toString('base64'), via: 'python:' + x, errors }
      } catch (e) { errors.push(`${x}：画出来了但读不回（${e?.message ?? e}）`) }
    } else {
      errors.push(`${x}：${r.error}`)
      log(`二维码：${x} 画不出来 —— ${r.error}`)
    }
  }

  rmQuiet(png)
  return { png: null, dataUrl: null, via: '', errors: errors.length ? errors : ['没有可用的渲染方式'] }
}
