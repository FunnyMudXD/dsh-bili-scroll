/**
 * 自检：宿主半端 + 浏览器半端（全部离线，不联网、不碰 B站、不发评论）
 *
 * 用法：
 *   node scripts/selfcheck.mjs                                  # 测本仓库
 *   $env:PLUGIN_DIR="...\\node_modules\\dsh-bili-scroll"; node scripts/selfcheck.mjs   # 测装好的那份
 */
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/* ⭐ 默认测**本仓库**；想看装好的那份就设 PLUGIN_DIR：
 *    $env:PLUGIN_DIR="C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-bili-scroll"
 *
 *  2026-10-21 起从"写死路径"改成可移植的，别人 clone 下来也能直接跑。 */
const R = ((process.env.PLUGIN_DIR || fileURLToPath(new URL('..', import.meta.url)))
  .replace(/\\/g, '/').replace(/\/+$/, '')) + '/'
const TMP = join(tmpdir(), 'dsh-bili-selfcheck')
const BOOT = join(TMP, 'bili-duty')
const got = join(TMP, 'got.txt')
const outs = []
const ok = (name, cond, extra = '') => { outs.push(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`) }

// ── 1) 浏览器半端 ───────────────────────────────────────────────
const csrc = readFileSync(R + 'client.js', 'utf8')
let reg = null
globalThis.window = { __ModuleLoader__: { load: (m) => { reg = m } } }
globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }), head: { appendChild() {} } }
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
globalThis.setInterval = () => 0; globalThis.clearInterval = () => {}
const st = { ok: true, home: 'D:/x', defaultHome: 'D:/x', homeCustom: false, mentions: ['甲', '乙'], model: { provider: 'qodercn', model: 'dfmodel' },
  config: { perDay: 50, perRound: 5, commentPerRound: 5, replyPerRound: 5, mentionName: '甲', mentionNames: ['甲', '乙'], modelProvider: 'qodercn', modelName: 'dfmodel', dmMode: 'off', dmUid: 0, workspace: '', reportLevel: 'full', keywords: [], autoComment: true,
  commentAtOwner: true, replyToComments: true, transcribe: false, peakValley: false, noon: true, night: true },
  windows: {}, venvReady: true, loggedIn: true, installing: false, asrReady: false, asrInstalling: false, version: '0.1.7', report: 'r', log: 'l', installTail: '', asrTail: '' }
let hookIdx = 0, store = {}, effects = []
const fns = new Map()
const h = (t, p, ...k) => { if (typeof t === 'function') { fns.set(t.name, t); return { type: t.name || 'C', props: { ...(p || {}), kids: k.flat() } } }; return { type: t, props: { ...(p || {}), kids: k.flat() } } }
const React = { createElement: h,
  useState: (i) => { const n = hookIdx++; if (!(n in store)) store[n] = typeof i === 'function' ? i() : i; return [store[n], (v) => { store[n] = typeof v === 'function' ? v(store[n]) : v }] },
  useEffect: (f) => effects.push(f), useRef: (v) => ({ current: v }) }
try {
  new Function('window', 'document', 'require', 'fetch', csrc)(globalThis.window, globalThis.document, (n) => (n === 'react' ? React : {}), globalThis.fetch)
  ok('client bundle 能执行（自注册）', true)
} catch (e) { ok('client bundle 能执行（自注册）', false, String(e.message)) }

const api = reg.factory((n) => (n === 'react' ? React : {}))
const regs = [], injected = []
api.apply({ effect: (f) => { try { f() } catch {} }, get: (k) => (k === 'slots' ? { inject: (n, cb) => { injected.push(n); return cb() }, register: (o, c) => { regs.push({ o, c }); return () => {} } } : undefined) })
ok('侧栏注册顺序 main → sidebar.panellist', injected.join('>') === 'main>sidebar.panellist', injected.join('>'))
const page = regs.find((r) => r.o.name === 'main'); const icon = regs.find((r) => r.o.name === 'sidebar.panellist')
ok('main 面板 key=bili-scroll', page?.o.key === 'bili-scroll')
ok('侧栏 order=40（记忆系统=30 后面）', icon?.o.order === 40, 'order=' + icon?.o.order)
ok('侧栏 label=刷B站', typeof icon?.o.label === 'function' && icon.o.label() === '刷B站')
ok('不再注册到设置里', !regs.some((r) => r.o.name === 'settings.section'))
const iconTree = icon.c({ size: 18, active: true })
ok('图标是 svg 且用 currentColor', iconTree.type === 'svg' && JSON.stringify(iconTree.props).includes('currentColor'))

const Panel = (() => { page.c({}); return fns.get('Panel') })()
const render = () => { hookIdx = 0; effects.length = 0; store = { 0: st }; const t = Panel({}); for (const f of [...effects]) { try { f() } catch {} } return t }
render()
const tree = render()
const flat = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v))
for (const s of ['B站 值班', '现在跑一轮', '复核评论', 'data-bd-head', 'data-bd-grid']) ok('页面含 ' + s, flat.includes(s))
ok('卡片 10 张（都用可折叠的 Card 包着）+ 日志单独一张',
  (csrc.match(/h\(Card, \{ title:/g) || []).length === 10 && (csrc.match(/'data-bd-log'/g) || []).length >= 1,
  'Card ' + (csrc.match(/h\(Card, \{ title:/g) || []).length + ' 张')
for (const s of ['什么时候自己跑', '一轮挑几条', '关注什么', '评论', '回复评论', '只评论娱乐视频', '顺手三连', '这一轮用哪个模型', '环境与账号', '它的地盘']) ok('卡片：' + s, flat.includes(s))
ok('实时日志块存在', flat.includes('data-bd-log') && flat.includes('实时日志'))
ok('日志的 <pre> 在源码里（收起着所以没渲染）', csrc.includes('data-bd-logpre'))
ok('折叠卡片：有摘要 chip + caret + localStorage 记忆',
  csrc.includes("'data-bd-cardhead'") && csrc.includes("'data-bd-caret'") && csrc.includes('localStorage.setItem'))
ok('折叠卡片：默认收起（open 初值是 false）', /localStorage.getItem\(KEY\) === '1'/.test(csrc))

// ── 14) 字段顺序 / 联动显隐（2026-10-21） ──
ok('关键词：按收藏夹时不显示', csrc.includes("cfg.pickSource === 'favorites' ? null : h(React.Fragment"))
ok('「要 @ 谁」在「评论里 @ 我」之后', csrc.indexOf("'要 @ 谁") > csrc.indexOf("'评论里 @ 我'"))
ok('「要 @ 谁」只在 @ 模式显示', /cfg\.commentAtOwner === true \? h\('div', \{ 'data-bd-sub': '' \},[\s\S]{0,80}'要 @ 谁/.test(csrc))
ok('保存按钮在工作区下面、日报上面',
  csrc.indexOf('保存关键词 / 工作区') > csrc.indexOf('工作区（它按这里的 AGENTS.md 认设定）')
  && csrc.indexOf('保存关键词 / 工作区') < csrc.indexOf("'日报写多细'"))
// ── 15) 卡片边界（2026-10-21：上一版把日报甩到卡片外面了） ──
{
  const i = flat.indexOf('关注什么')
  const j = flat.indexOf('评论', i + 5)
  const seg = flat.slice(i, j > i ? j : i + 4000)
  ok('「日报写多细」还在「关注什么」卡里', seg.includes('日报写多细'), '片段长度 ' + seg.length)
  ok('保存按钮也在卡里，且排在日报之前',
    seg.includes('保存') && seg.indexOf('保存') < seg.indexOf('日报写多细'))
  ok('关键词/工作区/保存/日报 的顺序',
    seg.indexOf('工作区') < seg.indexOf('保存') && seg.indexOf('保存') < seg.indexOf('日报写多细'))
}
// ── 16) 复核：手动查最近 N 条 + 放弃机制不再重查（2026-10-21） ──
ok('verifyRecent 支持 force（手动复核不吃 7 天缓存）', /force = false/.test(csrc.includes('verifyRecent') ? csrc : '') || readFileSync(R + 'lib/verify.mjs', 'utf8').includes('force = false'))
{
  const vm = readFileSync(R + 'lib/verify.mjs', 'utf8')
  ok('手动复核走 force（取最近 N 条）', /if \(!force\)/.test(vm))
  ok('标记为 gone 的评论记成 visible:false', /visible: res\.gone \? false : res\.visible/.test(vm))
  ok('已知 gone 的直接跳过（不再每轮重查）', /prev\?\.gone === true/.test(vm))
  ok('宿主把手动复核标成 force',
    /verifyRecent\(stateDir, \{ log, force: why === 'manual' \}\)/.test(readFileSync(R + 'index.js', 'utf8')))
}
ok('三个分组标题都在', ['运行', '内容', '环境'].every((x) => flat.includes(x)))
ok('分组标题横跨两列（栅格 + group-h）', /data-bd-group-h/.test(csrc) && /grid-column:1\/-1/.test(csrc))
ok('日志块三个按钮（跟随/刷新/打开）', flat.includes('跟随最新') && flat.includes('刷新') && flat.includes('打开日志文件'))
const isrc = readFileSync('C:/Users/yyj/.dsh/profiles/desktop/node_modules/dsh-bili-scroll/index.js', 'utf8')
ok('宿主有 /log 接口', /path === '\/api\/bili-duty\/log'/.test(isrc))
ok('/log 返回尾部且丢掉半截行', /if \(cut\) lines = lines\.slice\(1\)/.test(isrc) && /MAXC = 160_000/.test(isrc))
ok('客户端轮询 /log', /jget\('\/log\?lines=300'\)/.test(csrc))
ok('跑着时 1.5s、空闲 6s', /st\?\.running \? 1500 : 6000/.test(csrc))

// CSS 体检
const BT = String.fromCharCode(96)
const cssText = (() => {
  const startMark = 'const CSS = ' + BT
  const a = csrc.indexOf(startMark) + startMark.length
  const rest = csrc.slice(a)
  const end = rest.search(/\r?\n[\t ]*`\r?\n/)
  return end >= 0 ? rest.slice(0, end) : rest
})()
ok('CSS 模板里没有反引号', !cssText.includes(BT))
ok('CSS 页面根 height:100% + overflow-y:auto', /\[data-bd-page\]\{[^}]*height:100%[^}]*overflow-y:auto/s.test(csrc) || (/\[data-bd-page\]\{[^}]*height:100%/s.test(csrc) && /overflow-y:auto/s.test(csrc)))
ok('卡片区是两列栅格（不再瀑布流）', /grid-template-columns:repeat\(2/.test(csrc) && !/column-count:2/.test(csrc))
ok('CSS 主按钮写死品牌蓝', /\[data-bd-btn\]\[data-primary\]\{background-color:#4d6bfe/.test(csrc))
ok('CSS 开关 ON 写死品牌蓝', /\[data-bd-sw\]\[data-on\]\{background-color:#4d6bfe/.test(csrc))
ok('CSS 大括号配平', (cssText.match(/\{/g) || []).length === (cssText.match(/\}/g) || []).length, (cssText.match(/\{/g) || []).length + '/' + (cssText.match(/\}/g) || []).length)

// ── 2) 宿主半端 ─────────────────────────────────────────────────
const mod = await import('file:///C:/Users/yyj/.dsh/profiles/desktop/node_modules/dsh-bili-scroll/index.js')
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(BOOT, 'out'), { recursive: true })
const fake = join(TMP, 'fake.mjs')
writeFileSync(fake, `
import { writeFileSync } from 'node:fs'
let s = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { s += d })
process.stdin.on('end', () => { writeFileSync(${JSON.stringify(got)}, s, 'utf8'); process.exit(0) })
setTimeout(() => process.exit(3), 8000)
`, 'utf8')
writeFileSync(join(BOOT, 'config.json'), JSON.stringify({
  perDay: 50, perRound: 5, commentPerRound: 5, replyPerRound: 5,
  mentionName: '甲', mentionNames: ['甲', '乙', '丙'], dmMode: 'off', dmUid: 0,
  keywords: ['蓝色大肥鱼', '大肥鱼'], pythonPath: 'python', dshBin: fake, headlessProfile: 'headless',
  overlayMcp: true, workspace: '', reportLevel: 'full', replyToComments: true, home: '',
  autoComment: true, transcribe: false, asrModel: 'small', peakValley: false, noon: true, night: true,
  modelProvider: 'our-free-model', modelName: 'deepseek-v4.1-flash-free',
}, null, 2), 'utf8')
const day = new Date().toISOString().slice(0, 10)
writeFileSync(join(BOOT, 'out', `${day}.md`), '# 刷B站 · ' + day + ' —— 这一轮没写出报告\n\n占位\n', 'utf8')
writeFileSync(join(BOOT, 'seen.md'), ['# 判重表', '', '| BV | rpid | root | 时间 | 正文前 20 字 |', '| --- | --- | --- | --- | --- |', '| BV1aaaaaaaaa | 317000000001 | | 2026-10-19 | @甲 主人 |', ''].join('\n'), 'utf8')

const tools = []
process.env.DSH_PROFILE_DIR = 'C:\\Users\\yyj\\.dsh\\profiles\\desktop'
mod.apply({
  logger: { info: () => {} },
  get: (k) => (k === 'dshHomePath' ? (seg) => join(TMP, seg) : undefined),
  effect: (fn) => { try { return fn() } catch { return undefined } },
  tools: { register: (t) => tools.push(t) },
  webServer: { register: () => () => {} },
  settings: { describe: () => [], update: async () => { throw new Error('no form') } },
}, {})
ok('工具注册齐全', ['bili_run', 'bili_config', 'bili_status', 'bili_reply', 'bili_search', 'bili_subtitle', 'bili_comments', 'bili_whoami', 'bili_login_start', 'bili_login_poll', 'bili_setup'].every((n) => tools.some((t) => t.name === n)),
  tools.map((t) => t.name).join(','))

const run = tools.find((t) => t.name === 'bili_run')
const r1 = await run.execute({}, {})
ok('跑一轮：先返回 started', r1.started === true, JSON.stringify(r1).slice(0, 80))
const r2 = await run.execute({}, {})
ok('连点：单飞锁拦住', r2.busy === true && r2.started === false, r2.hint || '')
await new Promise((r) => setTimeout(r, 1200))
const prompt = existsSync(got) ? readFileSync(got, 'utf8') : ''
ok('提示词经 stdin 送达', prompt.length > 500, prompt.length + ' 字')
ok('提示词含单轮上限', /这一轮最多挑 5 条/.test(prompt))
ok('提示词含每天总量', /全天总共上限 50 条/.test(prompt))
ok('评论规则里说明了称呼方式（@ 叫主人 / 不 @ 就不叫）', /称呼一声「主人」/.test(prompt) || /不要 @ 任何人/.test(prompt))
ok('提示词给的是绝对时间（不让它开 shell）', /现在是 \d{4}\//.test(prompt) && !/自己看一眼系统时间/.test(prompt))
ok('@ 名单进了提示词（或明确说不 @）', (/@甲/.test(prompt) && /@乙/.test(prompt)) || /不要 @ 任何人/.test(prompt))
ok('提示词含 AGENTS.md 人设', /人设|设定/.test(prompt))
ok('提示词含「只评论娱乐视频」', /只评论娱乐视频/.test(prompt))
ok('三连默认关着 ⇒ 提示词里根本没有三连规则', !/bili_triple/.test(prompt) && !/顺手三连/.test(prompt))

const ov = join(BOOT, 'headless-overlay.yml')
const ovt = existsSync(ov) ? readFileSync(ov, 'utf8') : ''
ok('overlay 覆盖了 agent-default-model', /agent-default-model/.test(ovt))
ok('overlay 写的是 our-free-model', /provider: 'our-free-model'/.test(ovt))
ok('overlay 自动挂了 provider 插件', /dsh-our-free-model|file:\/\/\//.test(ovt))
ok('overlay 放开了 credentials', /id: credentials/.test(ovt))
ok('overlay 搬入了桌面 profile 的 llm-pi-ai 路由（你自己加的供应商）', /id: llm-pi-ai/.test(ovt) && /providers:/.test(ovt))
ok('占位报告被收走', readdirSync(join(BOOT, 'out')).some((f) => f.includes('.failed-')))

const reply = tools.find((t) => t.name === 'bili_reply')
const d1 = await reply.execute({ bvid: 'BV1aaaaaaaaa', text: '@甲 主人 值得' }, {})
ok('去重闸：已评论过的视频被拦', d1.blocked === true && d1.duplicate === true, String(d1.hint || '').slice(0, 60))
let d2 = null
try { d2 = await reply.execute({ bvid: 'BV1bbbbbbbbb', text: '@甲 主人' }, {}) } catch (e) { d2 = { error: String(e?.message ?? e) } }
ok('去重闸：新视频不拦（这一步会去连 MCP，报错属正常）', d2?.blocked !== true)

const cfgTool = tools.find((t) => t.name === 'bili_config')
const c1 = await cfgTool.execute({ patch: { perRound: 2, perDay: 99 } }, {})
ok('bili_config 能改 perRound/perDay', c1?.ok === true && c1?.config?.perRound === 2)
const c2 = await cfgTool.execute({ patch: { perRound: 999 } }, {})
ok('perRound 被钳到 50 以内', Number(c2?.config?.perRound) <= 50, String(c2?.config?.perRound))

// ── 3) 总开关 & 置顶布局 ────────────────────────────────────────
ok('页头置顶：有 data-bd-scroll 滚动区', flat.includes('data-bd-scroll'))
ok('日志置顶：在 data-bd-pinned 里、且在滚动区之前',
  flat.includes('"data-bd-pinned"')
  && flat.indexOf('"data-bd-head"') < flat.indexOf('"data-bd-pinned"')
  && flat.indexOf('"data-bd-pinned"') < flat.indexOf('"data-bd-scroll"')
  && flat.indexOf('"data-bd-log"') < flat.indexOf('"data-bd-scroll"'))
ok('日志有收起/展开按钮', flat.includes('收起') || flat.includes('展开'))
ok('日志默认收起（首屏显示「展开」而不是日志正文）', flat.includes('展开') && !flat.includes('收起'))
ok('页头里有总开关按钮', flat.includes('data-bd-master') && flat.includes('刷B站服务'))
ok('总开关带指示灯', flat.includes('data-bd-dot'))

const icon2 = regs.find((r) => r.o.name === 'sidebar.panellist').c({ size: 18, active: false })
const iconJson = JSON.stringify(icon2)
ok('侧栏图标有指示灯（绿/红）', iconJson.includes('#22c55e') || iconJson.includes('#ef4444'), iconJson.includes('#22c55e') ? '绿' : '红')

const st1 = await tools.find((t) => t.name === 'bili_status').execute({}, {})
ok('/status 暴露 serviceOn', st1?.serviceOn === true || st1?.config?.serviceOn === true, JSON.stringify(st1?.serviceOn ?? st1?.config?.serviceOn))

const cOff = await cfgTool.execute({ patch: { serviceOn: false } }, {})
ok('bili_config 能关总开关', cOff?.config?.serviceOn === false)
const rOff = await run.execute({}, {})
ok('总开关关着 → 手动跑被拒', rOff.started === false && rOff.disabled === true, rOff.hint || '')
const dOff = await reply.execute({ bvid: 'BV1ccccccccc', text: '@甲 主人' }, {})
ok('总开关关着 → 发评论被拒', dOff.blocked === true && /总开关/.test(String(dOff.hint || '')), String(dOff.hint || '').slice(0, 50))
const st2 = await tools.find((t) => t.name === 'bili_status').execute({}, {})
ok('关掉后 /status.serviceOn=false', st2?.serviceOn === false)
const cOn = await cfgTool.execute({ patch: { serviceOn: true } }, {})
ok('能再打开', cOn?.config?.serviceOn === true)

// ── 4) deepseek-official 的 Key 检查（本机凭据库里那把是 ark-，应被判定为"不能用"） ──
await cfgTool.execute({ patch: { modelProvider: 'deepseek-official', modelName: 'deepseek-v4.1-flash' } }, {})
const rKey = await run.execute({}, {})
ok('选 deepseek-official 但 Key 不对 → 当场拦下', rKey.started === false && rKey.needKey === true, String(rKey.hint || '').slice(0, 70))
ok('拦下时说清了原因（Ark / 没配）', /Ark|没配|凭据库/.test(String(rKey.hint || '')))
await cfgTool.execute({ patch: { modelProvider: 'our-free-model', modelName: 'deepseek-v4.1-flash-free' } }, {})
const rFree = await run.execute({}, {})
ok('换回免费通道 → 能起跑', rFree.started === true, JSON.stringify(rFree).slice(0, 60))

// ── 6) 顺手三连（开关 / 独立日上限 / 闸门下发给那一轮 / 记账） ──
const inter = tools.find((t) => t.name === 'bili_interact')
ok('bili_interact 工具存在（桌面端可直接用）', Boolean(inter))
ok('bili_video_kind 工具存在', tools.some((t) => t.name === 'bili_video_kind'))
await new Promise((r) => setTimeout(r, 1500))
const iOff = await inter.execute({ bvid: 'BV1aaaaaaaaa' }, {})
ok('三连关着 → bili_interact 直接拒绝', iOff.blocked === true && /三连/.test(String(iOff.hint || '')), String(iOff.hint || '').slice(0, 40))

await cfgTool.execute({ patch: { tripleOn: true, triplePerDay: 3, tripleCoin: 1, tripleFavMediaId: 0 } }, {})
rmSync(got, { force: true })
await new Promise((r) => setTimeout(r, 1500))
const rTrip = await run.execute({}, {})
ok('三连开着 → 能起跑', rTrip.started === true, JSON.stringify(rTrip).slice(0, 50))
await new Promise((r) => setTimeout(r, 1300))
const promptTrip = existsSync(got) ? readFileSync(got, 'utf8') : ''
ok('提示词含三连规则（先 bili_triple 再 bili_reply）', /bili_triple/.test(promptTrip) && /先 .*三连/.test(promptTrip))
ok('提示词把正文预算降到 135 字', /135 字/.test(promptTrip))
ok('提示词给了轮换话术（三选一）', /顺手三连了/.test(promptTrip) || /币投了/.test(promptTrip))
const ovTrip = existsSync(ov) ? readFileSync(ov, 'utf8') : ''
ok('overlay 下发了三连闸门', /BILI_TRIPLE: '1'/.test(ovTrip) && /BILI_TRIPLE_LEFT: '3'/.test(ovTrip))
ok('overlay 下发了记账文件', /BILI_TRIPLE_STATE: /.test(ovTrip) && /interacted\.jsonl/.test(ovTrip))
ok('白名单里出现 bili_triple', /BILI_MCP_TOOLS: '[^']*bili_triple/.test(ovTrip))
const stTrip = await tools.find((t) => t.name === 'bili_status').execute({}, {})
ok('/status 暴露 tripledToday', stTrip?.tripledToday === 0 || stTrip?.tripledToday >= 0, String(stTrip?.tripledToday))

// ── 7) 判重表解析（2026-10-19 修：备注里的 id 被当成 root） ──
const { parseSeen } = await import('file:///C:/Users/yyj/.dsh/profiles/desktop/node_modules/dsh-bili-scroll/lib/verify.mjs')
const rRow = parseSeen('| BV1sunn6nEGz | 317542849953 | | 2026-10-19 约 17:00（与 317542914689 同一批） | @甲 正文 |')[0]
ok('解析：表格列优先，备注里的 id 不当 root', rRow?.rpid === 317542849953 && rRow?.root === 0, JSON.stringify(rRow))
const rBad = parseSeen('| BV1aaaaaaaaa | 317542849953 | 317542914689 | t | x |')[0]
ok('解析：root >= rpid 视为记错 → 按顶层查', rBad?.root === 0, JSON.stringify(rBad))
const rGood = parseSeen('| BV1bbbbbbbbb | 317552924465 | 317542914689 | t | x |')[0]
ok('解析：正常楼中楼 root 保留', rGood?.root === 317542914689, JSON.stringify(rGood))

// ── 8) 回复：窗口内全量扫 + 打分（2026-10-19 改） ──
const { scoreReply, parseWhen, readReplied, recordReplied } = await import('file:///C:/Users/yyj/.dsh/profiles/desktop/node_modules/dsh-bili-scroll/lib/replies.mjs')
const sAsk = scoreReply('这个插件怎么装？')
ok('打分：提问 + 相关 ⇒ 高分', sAsk.score >= 5, `${sAsk.score} ${sAsk.why.join('/')}`)
const sNice = scoreReply('哈哈哈哈太可爱了')
ok('打分：轻互动 ⇒ 低分但正', sNice.score === 1, `${sNice.score} ${sNice.why.join('/')}`)
const sBad = scoreReply('这就是骗子吧，滚')
ok('打分：口语问句（无问号）也算提问', scoreReply('本地服务挂了会自动重连不，还是得手动重启').score >= 3, String(scoreReply('本地服务挂了会自动重连不，还是得手动重启').score))
const sNice2 = scoreReply('哈哈哈哈太可爱了')
ok('打分：敌意 ⇒ 负分', sBad.score < 0, `${sBad.score} ${sBad.why.join('/')}`)
const sContact = scoreReply('加我微信 vx123 聊')
ok('打分：带联系方式 ⇒ 负分', sContact.score < 0, `${sContact.score} ${sContact.why.join('/')}`)
const sEmpty = scoreReply('？？？')
ok('打分：纯标点 ⇒ 不进清单', scoreReply('...').score < 3 && scoreReply('？？？').score < 3)
const whenOld = parseWhen('| BV1aaaaaaaaa | 317542849953 | | 2026-10-01 | x |')
const wd = new Date(whenOld)
ok('解析时间列：能取出 2026-10-01', whenOld > 0 && wd.getFullYear() === 2026 && wd.getMonth() === 9 && wd.getDate() === 1, String(whenOld))
ok('判重表时间解析不出来的当作窗口内', parseWhen('| BV1aaaaaaaaa | 317542849953 | | 本轮 | x |') === 0)
// 回过的不再进清单
recordReplied(BOOT, { root: 111111111, source: 222222222, bv: 'BV1aaaaaaaaa' })
ok('回复记账：replied.jsonl 记下 (root, source)', readReplied(BOOT).has('111111111:222222222'))
ok('/status 暴露 repliesPending 字段', 'repliesPending' in (stTrip || {}))
await cfgTool.execute({ patch: { replyToComments: true, replyMinScore: 3, replyLookbackDays: 7 } }, {})
await new Promise((r) => setTimeout(r, 1500))
const rReply = await run.execute({}, {})
ok('回复开着 + 清单为空 ⇒ 能起跑', rReply.started === true, JSON.stringify(rReply).slice(0, 50))
await new Promise((r) => setTimeout(r, 1300))
const promptReply = existsSync(got) ? readFileSync(got, 'utf8') : ''
ok('提示词：清单为空时明确"不用回任何人"', /不用回任何人/.test(promptReply))
ok('提示词：禁止自己翻评论', /别自己去翻评论/.test(promptReply))
await cfgTool.execute({ patch: { replyToComments: false } }, {})

// ── 8.5) 娱乐 / 技术 分类器（2026-10-19） ──
const { classifyVideo } = await import('file:///C:/Users/yyj/.dsh/profiles/desktop/node_modules/dsh-bili-scroll/lib/classify.mjs')
ok('分类：知识区 ⇒ tech', classifyVideo({ tname: '知识', title: '梗知识', tags: [] }).kind === 'tech')
ok('分类：科技区 ⇒ tech', classifyVideo({ tname: '科技', title: '插件实测', tags: [] }).kind === 'tech')
ok('分类：动画区 ⇒ fun', classifyVideo({ tname: '动画', title: '小剧场', tags: [] }).kind === 'fun')
ok('分类：搞笑区 ⇒ fun', classifyVideo({ tname: '搞笑', title: '找爸爸', tags: [] }).kind === 'fun')
ok('分类：无分区但标题带"教程" ⇒ tech', classifyVideo({ tname: '', title: '奶蛙替换教程', tags: ['教程'] }).kind === 'tech')
ok('分类：技术词+娱乐词都有 ⇒ fun（宁可放过）', classifyVideo({ tname: '', title: 'AI 小剧场 教程', tags: [] }).kind === 'fun')
ok('分类：无信号 ⇒ unknown（放行）', classifyVideo({ tname: '', title: '一段影像', tags: [] }).kind === 'unknown')
// ⭐ 标签规则（比分区优先）
ok('标签白名单：知识区 + 标签"梗" ⇒ fun', classifyVideo({ tname: '知识', title: '梗知识', tags: ['梗'], allowTags: ['梗'] }).kind === 'fun')
ok('标签黑名单：动画区 + 标签"教程" ⇒ tech', classifyVideo({ tname: '动画', title: '小剧场', tags: ['教程'], blockTags: ['教程'] }).kind === 'tech')
ok('标签匹配是包含：规则"编程"命中标签"编程入门"', classifyVideo({ tname: '', title: 'x', tags: ['编程入门'], blockTags: ['编程'] }).kind === 'tech')
ok('标签列表为空时不干扰分类', classifyVideo({ tname: '动画', title: 'x', tags: ['教程'], allowTags: [], blockTags: [] }).kind === 'fun')
const pTags = await cfgTool.execute({ patch: { funTagsAllow: ['梗'], funTagsBlock: '教程,科普' } }, {})
const cfgAfter = (await cfgTool.execute({}, {})).config || {}
ok('bili_config 能存标签白名单', Array.isArray(cfgAfter.funTagsAllow) && cfgAfter.funTagsAllow[0] === '梗', JSON.stringify(cfgAfter.funTagsAllow))
ok('标签黑名单支持逗号串 → 数组', Array.isArray(cfgAfter.funTagsBlock) && cfgAfter.funTagsBlock.length === 2, JSON.stringify(cfgAfter.funTagsBlock))

// 上限 0 = 不三连
await cfgTool.execute({ patch: { triplePerDay: 0 } }, {})
await new Promise((r) => setTimeout(r, 1500))
const iCap0 = await inter.execute({ bvid: 'BV1bbbbbbbbb' }, {})
ok('日上限 0 → 拒绝三连', iCap0.blocked === true, String(iCap0.hint || '').slice(0, 40))
// ── 9) 语气人设 + 挑片来源（2026-10-20） ──
ok('评论语气规则在（撒娇求夸 或 观点+热梗）', /求夸奖|求摸摸头|热梗/.test(promptTrip))
ok('默认不 @ 使用者 ⇒ 提示词明说「不要 @ 任何人」', /不要 @ 任何人/.test(prompt) || /不 @ 任何人/.test(prompt))
ok('默认模式 ⇒ 写人设自己的观点', /写你自己的想法|自己的观点/.test(prompt))
ok('默认模式 ⇒ 允许带网络热梗', /热梗/.test(prompt))
ok('提示词要求加颜文字', /颜文字/.test(promptTrip))
ok('提示词禁止概括视频内容', /不要概括视频内容/.test(promptTrip))
const stPick = await tools.find((t) => t.name === 'bili_status').execute({}, {})
ok('/status 暴露 pickSource', stPick?.pickSource === 'keywords' || stPick?.pickSource === 'favorites', String(stPick?.pickSource))
await cfgTool.execute({ patch: { pickSource: 'favorites', biliUid: 334952458 } }, {})
await new Promise((r) => setTimeout(r, 1500))
rmSync(got, { force: true })
const rFav = await run.execute({}, {})
ok('收藏夹模式 → 能起跑', rFav.started === true, JSON.stringify(rFav).slice(0, 50))
await new Promise((r) => setTimeout(r, 1300))
const promptFav = existsSync(got) ? readFileSync(got, 'utf8') : ''
ok('提示词切到「按收藏夹偏好」', /收藏夹偏好/.test(promptFav))
ok('画像拿不到时会退回关键词', /没拿到画像|退回用关键词|不用关键词/.test(promptFav))
await cfgTool.execute({ patch: { pickSource: 'keywords', biliUid: 0 } }, {})
await cfgTool.execute({ patch: { tripleOn: false, triplePerDay: 5 } }, {})

// ── 11) 私信：白名单要给到 bili_send_message（2026-10-20 修） ──
await cfgTool.execute({ patch: { dmMode: 'both', dmUid: 22302917 } }, {})
await new Promise((r) => setTimeout(r, 1500))
await run.execute({}, {})
await new Promise((r) => setTimeout(r, 1200))
const ovDm = existsSync(ov) ? readFileSync(ov, 'utf8') : ''

// ── 12) 不 @ 模式 + @ 名单为空 ⇒ 评论照发（只验提示词，不联网） ──
await cfgTool.execute({ patch: { commentAtOwner: false, autoComment: true, mentionNames: [], mentionName: '', dmMode: 'off' } }, {})
// 等上一轮彻底退出（单飞锁），否则这次 run 会被拒
for (let i = 0; i < 12; i += 1) {
  const stx = await tools.find((x) => x.name === 'bili_status').execute({}, {})
  if (!stx || !stx.running) break
  await new Promise((r) => setTimeout(r, 800))
}
rmSync(got, { force: true })
const rNoName = await run.execute({}, {})
ok('不 @ + 名单为空 ⇒ 这一轮能起跑', rNoName.started === true, JSON.stringify(rNoName).slice(0, 60))
await new Promise((r) => setTimeout(r, 1400))
const promptNoName = existsSync(got) ? readFileSync(got, 'utf8') : ''
ok('不 @ 模式 + 名单为空 ⇒ 评论仍开着', promptNoName.includes('不 @ 任何人'), promptNoName.slice(0, 40))
await cfgTool.execute({ patch: { mentionNames: ['甲', '乙', '丙'], mentionName: '甲' } }, {})

// ── 13) 复核探针 + 放弃机制（2026-10-20） ──
const vm = await import('file:///' + R + 'lib/verify.mjs')
ok('verify.mjs 导出了 verifyOne', typeof vm.verifyOne === 'function')
ok('verify.mjs 导出了 verifyRecent', typeof vm.verifyRecent === 'function')
{
  // 造一个假 fetch：顶层翻页查不到，但 root 探针 code=0 ⇒ 应当判"可见"
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => ({
    text: async () => JSON.stringify(
      String(url).includes('/x/web-interface/view')
        ? { code: 0, data: { aid: 1, title: 'x', owner: { mid: 2 } } }
        : String(url).includes('/x/v2/reply/reply')
          ? { code: 0, data: { replies: [{ rpid: 3 }] } }
          : { code: 0, data: { replies: [], cursor: {} } }
    ),
  })
  const r1 = await vm.verifyOne({ bv: 'BV1zzzzzzzzz', rpid: 999, root: 0 }, { cred: {}, aidCache: new Map(), headers: {} })
  ok('翻页找不到但 root 探针命中 ⇒ 判公开可见', r1.visible === true && /root 直查/.test(r1.how), r1.how)

  globalThis.fetch = async (url) => ({
    text: async () => JSON.stringify(
      String(url).includes('/x/web-interface/view')
        ? { code: 0, data: { aid: 1, title: 'x', owner: { mid: 2 } } }
        : String(url).includes('/x/v2/reply/reply')
          ? { code: 12006, message: '评论不存在' }
          : { code: 0, data: { replies: [], cursor: {} } }
    ),
  })
  const r2 = await vm.verifyOne({ bv: 'BV1zzzzzzzzz', rpid: 998, root: 0 }, { cred: {}, aidCache: new Map(), headers: {} })
  ok('B站 说评论不存在 ⇒ 标记 gone', r2.gone === true, r2.note.slice(0, 30))
  globalThis.fetch = realFetch
}

ok('开了「评论+私信」⇒ 白名单里有 bili_send_message', /BILI_MCP_TOOLS: '[^']*bili_send_message/.test(ovDm))
await cfgTool.execute({ patch: { dmMode: 'off', dmUid: 0 } }, {})

try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 子进程还开着就下次再清 */ }
process.env.DSH_PROFILE_DIR = undefined
// ── 10) 不 @ 模式（2026-10-20 用户最终要求：评论 = 人设自己的观点） ──
//    注：自检里 config.json 不带 commentAtOwner ⇒ 默认就是「不 @」模式，直接看第一轮那份提示词
ok('不 @ 模式 ⇒ 明说「不要 @ 任何人」', /不要 @ 任何人/.test(prompt))
ok('不 @ 模式 ⇒ 写人设自己的观点', /写你自己的想法/.test(prompt))
ok('不 @ 模式 ⇒ 允许热梗但要贴切', /热梗/.test(prompt) && /贴切/.test(prompt))
ok('不 @ 模式 ⇒ 不复述视频内容', /不要复述/.test(prompt) || /不要概括视频内容/.test(prompt))

ok('不 @ 模式 ⇒ 不叫「主人」', /不叫「主人」/.test(prompt))

console.log(outs.join('\n'))
const bad = outs.filter((x) => x.includes('❌')).length
console.log('\n合计 ' + outs.length + ' 项，失败 ' + bad + ' 项')
