/**
 * lib/replies.mjs —— 「谁回了我的评论」的**扫描 + 打分**（2026-10-19 加）
 * ============================================================================
 * 为什么改成这样：
 *   原来是"让模型自己翻判重表里的最近 5~8 条评论、再去热门评论/楼中楼里找回复"——
 *   翻页翻不到、每轮白扫、还漏人。
 *   现在改成：**宿主按天数窗口全量扫**自己发过的评论 → 拉到回复 → 用一套**规则打分**
 *   → 只有分数够的才进"待回复清单"，模型只负责写正文。
 *
 * 打分规则（可解释、可调，别让模型凭感觉）：
 *   +3  像提问（？/?/怎么/为什么/在哪/能不能/求/有没有/如何/吗）
 *   +2  提到本插件 / 这一轮（插件 / 刷B站 / 大肥鱼 / 主人 / 报告 / 三连）
 *   +1  轻互动（谢谢/感谢/支持/厉害/牛逼/哈哈/可爱/笑死）
 *   -5  带联系方式或外链（http / qq / 微信 / vx / 加我）
 *   -5  明显敌意（骗子/垃圾/滚/傻/杠精/举报）
 *   -3  超长（> 200 字，多半是吵架或小作文）
 *   -2  纯表情/纯标点
 *   ≥ minScore（默认 3）才进清单。
 * ============================================================================
 */

import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCredential, parseSeen } from './verify.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const headersFor = (cred) => ({
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
})

async function jget(url, headers) {
  try {
    const r = await fetch(url, { headers })
    const t = await r.text()
    try { return JSON.parse(t) } catch { return { code: -999, message: 'not json' } }
  } catch (e) { return { code: -998, message: String(e?.message ?? e) } }
}

/** 判重表那一行的「时间」列 → 毫秒时间戳（解析不出来就返回 0 = 当作"在窗口内"） */
export function parseWhen(line) {
  const cells = String(line).split('|').map((s) => s.trim())
  const cell = cells[4] || ''
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(cell) || /(\d{4})-(\d{2})-(\d{2})/.exec(line)
  if (!m) return 0
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`)
  return Number.isNaN(t) ? 0 : t
}

// ⚠️ 2026-10-19 修：原来只认带问号的问句，口语问句（"会自动重连不"、"还是得手动重启"）全被漏了
const ASK = /[?？]|怎么|为什么|为啥|咋|在哪|哪里|能不能|可不可以|会不会|有没有|是不是|要不要|如何|求|吗|呢|是吧|还是|不$|不，|不。|没$|么$/
const ABOUT = /插件|刷B站|大肥鱼|主人|报告|三连|一键三连|判重|up主|UP主/
const NICE = /谢谢|感谢|支持|厉害|牛|牛逼|哈哈|可爱|笑死|有意思|学到了/
const BAD = /骗子|垃圾|滚|傻|杠精|举报|割韭菜|恰烂钱/
const CONTACT = /https?:\/\/|qq|QQ|微信|vx|VX|加我|私聊我/

/**
 * 给一条回复打分。返回 `{ score, why[] }`，`why` 是给人看的理由（会进提示词和日志）。
 */
export function scoreReply(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  let score = 0
  const why = []
  if (!s) return { score: -99, why: ['空内容'] }
  if (ASK.test(s)) { score += 3; why.push('像提问') }
  if (ABOUT.test(s)) { score += 2; why.push('跟这个号/插件有关') }
  if (NICE.test(s)) { score += 1; why.push('轻互动') }
  if (CONTACT.test(s)) { score -= 5; why.push('带联系方式/外链') }
  if (BAD.test(s)) { score -= 5; why.push('有敌意') }
  if (s.length > 200) { score -= 3; why.push('太长') }
  if (!/[\p{L}\p{N}]/u.test(s)) { score -= 2; why.push('纯表情/标点') }
  return { score, why }
}

/** 已经回过的那些（(root, source) 二元组），防止同一楼回两次 */
const repliedFile = (stateDir) => join(stateDir, 'replied.jsonl')
export function readReplied(stateDir) {
  const f = repliedFile(stateDir)
  const set = new Set()
  if (!existsSync(f)) return set
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s)
      if (r?.root && r?.source) set.add(`${r.root}:${r.source}`)
    } catch { /* 坏行跳过 */ }
  }
  return set
}
export function recordReplied(stateDir, { root, source, bv }) {
  try {
    appendFileSync(repliedFile(stateDir), JSON.stringify({ root, source, bv, at: new Date().toISOString() }) + '\n', 'utf8')
    return true
  } catch { return false }
}

/**
 * 扫「窗口内自己发过的评论」下面收到的回复，打分后返回待回复清单。
 * @returns {{items:Array, scanned:number, fetched:number, errors:string[], at:number}}
 */
export async function scanReplies(stateDir, { lookbackDays = 7, minScore = 3, maxItems = 12, log = () => {} } = {}) {
  const out = { items: [], scanned: 0, fetched: 0, errors: [], at: Date.now() }
  const seenFile = join(stateDir, 'seen.md')
  if (!existsSync(seenFile)) { out.errors.push('判重表还没生成'); return out }
  const cred = loadCredential(stateDir)
  if (!cred) { out.errors.push('还没扫码登录'); return out }
  const headers = headersFor(cred)
  const selfMid = Number(cred.dedeuserid) || 0
  const replied = readReplied(stateDir)
  const since = Date.now() - Math.max(1, Number(lookbackDays) || 7) * 864e5

  const rows = parseSeen(readFileSync(seenFile, 'utf8'))
  const aidCache = new Map()
  const seenRoots = new Set()
  const seenPairs = new Set()
  for (const row of rows) {
    const when = parseWhen(row.line)
    if (when && when < since) continue          // 窗口外的老评论不扫
    out.scanned += 1
    if (!aidCache.has(row.bv)) {
      const v = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${row.bv}`, headers)
      aidCache.set(row.bv, v?.code === 0 ? Number(v.data.aid) : 0)
      await sleep(250)
    }
    const aid = aidCache.get(row.bv)
    if (!aid) { out.errors.push(`${row.bv} 取不到 aid`); continue }
    // 我们的评论可能是顶层，也可能是楼中楼 ⇒ 回复都挂在「线程根」下面
    // ⚠️ 2026-10-19 修：判重表里"我们自己那条顶层评论"和"我们自己那条回复"会指向**同一个 root**
    //    ⇒ 以前会把同一串楼中楼查两遍、把同一个人列两次。现在按 root 去重，只查一次。
    const root = row.root || row.rpid
    if (seenRoots.has(root)) continue
    seenRoots.add(root)
    for (let pn = 1; pn <= 2; pn += 1) {
      const d = await jget(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${root}&ps=20&pn=${pn}`, headers)
      const list = d?.data?.replies || []
      out.fetched += list.length
      for (const r of list) {
        const source = Number(r.rpid) || 0
        const mid = Number(r.mid) || 0
        if (!source || mid === selfMid) continue                    // 自己的回复不算
        if (replied.has(`${root}:${source}`)) continue              // 回过了（replied.jsonl）
        if (seenPairs.has(`${root}:${source}`)) continue            // 同一条别列两次
        seenPairs.add(`${root}:${source}`)
        const text = String(r?.content?.message ?? '')
        const { score, why } = scoreReply(text)
        if (score < minScore) continue
        out.items.push({
          bv: row.bv, aid, root, source,
          mid, nickname: String(r?.member?.uname ?? ''),
          text: text.slice(0, 160), at: Number(r.ctime) || 0,
          score, why,
          ourLine: row.line.slice(0, 120),
        })
      }
      if (list.length < 20) break
      await sleep(350)
    }
    await sleep(250)
  }
  out.items.sort((a, b) => (b.score - a.score) || (b.at - a.at))
  out.items = out.items.slice(0, Math.max(1, Math.min(Number(maxItems) || 12, 30)))
  log(`扫回复：看了 ${out.scanned} 条自己的评论、拉到 ${out.fetched} 条回复 ⇒ 待回 ${out.items.length} 条`)
  return out
}
