/**
 * dsh-bili-scroll —— 浏览器半端（**侧栏里的独立一页**，在「记忆系统」下面）
 * ============================================================================
 * ⭐ **client bundle 不是 ESM，是自注册脚本**（2026-10-14 从官方包里挖到的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ **怎么进侧栏**（2026-10-19 从「设置」搬过来，抄官方 `dsh-client-ui-plugin-manager`）：
 *
 *     // ① 页面内容挂主区（key = 面板 id）
 *     slots.inject('main', () => slots.register({ name: 'main', key: 'bili-scroll' }, Page))
 *     // ② 侧栏图标挂 sidebar.panellist（order 决定上下顺序）
 *     slots.inject('sidebar.panellist', () => slots.register(
 *       { name: 'sidebar.panellist', id: 'bili-scroll', order: 40, label: () => '刷B站' }, Icon))
 *
 *   · 点图标时宿主自己调 `ctx.layout.selectPanel(id)` ⇒ **① 必须先注册**，否则报
 *     `layout.selectPanel: main panel "…" is not registered`
 *   · 顺序：`dsh-context`=20、`dsh-mnemon`（记忆系统）=30 ⇒ 我们用 **40**，正好落在它下面
 *   · 图标组件只拿 `{ size, active }`，底色/按钮/文字都由宿主的 Sidebar 负责
 *
 * 这一页要满足使用者 2026-10-14 说的形状：
 *   · **总开关 → 打开之后下面才展开子开关**（峰谷自动刷 → 中午 / 晚上）
 *   · **数字项要能自己填**（每天几条 / 每轮几条）
 *   · **账号绑定必须在这一页里**（扫码登录 + 二维码直接显示）
 *   · 会发东西出去的（自动评论）、要下大模型的（本地转写）**默认关**
 *   · 2026-10-19 使用者要求"按审美优化布局" ⇒ 页头（标题+状态胶囊+主按钮）+ 卡片网格
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-duty'
    /* ⚠️ 原来 jget/jpost 直接 .json()、从不看 res.ok ⇒ HTTP 500 的 {ok:false,error}
     *    会被调用方当成「已保存 / 成功」，绿色提示把故障盖掉。（2026-10-16 审查修） */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
/* ══════════════ 页面骨架（2026-10-19：从"设置里的一栏"改成"侧栏里的独立页"） ══════════════
 * 🔴 用户反馈「没有滚动条，展示不完整」：宿主主区 centerCol 是
 *    display:flex; flex-direction:column; overflow:hidden ⇒ **面板自己不管滚动就会被裁掉** ✗
 * ⭐ 官方插件页（plugin-manager）就是这么做的：
 *    .page{height:100%; display:flex; flex-direction:column; overflow:auto}
 *    ⇒ 这里照抄：height:100% + overflow-y:auto（直接挂在 centerCol 子节点上才生效，别套 wrapper）。
 * ⚠️ 这条注释里**不能出现反引号** —— CSS 是模板字符串，反引号会把它提前截断（踩过一次）。 */
[data-bd-page]{box-sizing:border-box;width:100%;max-width:1080px;margin:0 auto;height:100%;
  display:flex;flex-direction:column;overflow:hidden;color:inherit;}
/* ⭐ 页头置顶：自己不滚，滚动交给下面的 data-bd-scroll（2026-10-19 用户要求"置顶，其余只在下半滚动"） */
[data-bd-head]{flex:none;display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;
  padding:24px clamp(16px,3.4vw,36px) 14px;
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));
  background:var(--dsw-alias-bg-base,transparent);}
[data-bd-scroll]{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  scrollbar-gutter:stable;padding:16px clamp(16px,3.4vw,36px) 56px;}
/* ⭐ 日志区：钉在页头下面，和页头一起固定（用户 2026-10-19："日志没有置顶"） */
[data-bd-pinned]{flex:none;padding:12px clamp(16px,3.4vw,36px) 0;
  background:var(--dsw-alias-bg-base,transparent);}
[data-bd-pinned] [data-bd-log]{margin-bottom:6px;}
[data-bd-headtext]{flex:1;min-width:250px;display:flex;flex-direction:column;gap:6px;}
[data-bd-eyebrow]{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
  color:var(--dsw-alias-brand-primary,#4d6bfe);}
[data-bd-title]{font-size:26px;font-weight:650;line-height:1.2;letter-spacing:-.01em;}
[data-bd-lede]{font-size:12.5px;line-height:20px;max-width:62ch;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-chips]{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
[data-bd-chip]{font-size:11px;line-height:16px;padding:3px 9px;border-radius:999px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-chip][data-tone=good]{color:#22c55e;border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.1);}
[data-bd-chip][data-tone=warn]{color:#f59e0b;border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.1);}
[data-bd-chip][data-tone=brand]{color:var(--dsw-alias-brand-primary,#4d6bfe);
  border-color:rgba(77,107,254,.38);background:rgba(77,107,254,.1);}
[data-bd-actions]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px;}
/* ══════════════ 卡片区（2026-10-21：瀑布流 → 分组栅格） ══════════════
 * 为什么不再用 column-count：
 *   · 瀑布流是「先填满第一列再填第二列」⇒ 阅读顺序跟视觉顺序对不上，找设置靠猜
 *   · 分组标题没法横跨两列（它只能挤成第 N 列的一个格子）
 * ⇒ 改成两列栅格 + 每组一个横跨整行的标题：顺序 = DOM 顺序，扫读线性。
 *   （align-items:start 让每张卡按自身高度排，不会被同排最高的撑出空洞） */
[data-bd-grid]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start;}
@media (max-width:860px){[data-bd-grid]{grid-template-columns:minmax(0,1fr);}}
/* 分组标题：横跨两列，一条淡分割线把它和上一组隔开 */
[data-bd-group]{grid-column:1/-1;min-width:0;}
[data-bd-group-h]{display:flex;align-items:baseline;gap:8px;
  margin:10px 0 -4px;padding:0 2px 7px;font-size:13px;font-weight:650;letter-spacing:.02em;
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));}
[data-bd-group]:first-child > [data-bd-group-h]{margin-top:0;}
[data-bd-group-sub]{font-size:11.5px;font-weight:400;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-sec]{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:100%;
  margin:0;
  padding:16px 18px 18px;border-radius:14px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,.05));}
[data-bd-h]{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;letter-spacing:.02em;}
[data-bd-h]:before{content:"";flex:none;width:3px;height:13px;border-radius:2px;
  background:var(--dsw-alias-brand-primary,#4d6bfe);opacity:.9;}
/* ══════════════ 行 / 字 ══════════════ */
[data-bd-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-bd-grow]{flex:1;min-width:0;}
[data-bd-label]{font-size:13px;line-height:20px;}
[data-bd-note]{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-kv]{font-size:11.5px;line-height:18px;word-break:break-all;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
/* ══════════════ 开关 ══════════════ */
[data-bd-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-bd-sw][data-on]{background-color:#4d6bfe;background-image:none;}
[data-bd-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-bd-sw][data-on] i{left:19px;}
[data-bd-sw][disabled]{opacity:.45;cursor:default;}
[data-bd-sub]{margin-left:2px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));
  display:flex;flex-direction:column;gap:10px;}
/* ══════════════ 输入 ══════════════ */
[data-bd-input]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:9px;font-size:12.5px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:inherit;font-family:inherit;
  transition:border-color .15s,background .15s;}
[data-bd-input]:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe);
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-bd-num]{width:92px;flex:none;text-align:center;}
/* ══════════════ 按钮 ══════════════ */
[data-bd-btn]{padding:7px 12px;border-radius:9px;font-size:12.5px;cursor:pointer;font-family:inherit;line-height:18px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));
  background-color:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));background-image:none;color:inherit;
  transition:background-color .15s,border-color .15s,opacity .15s;}
[data-bd-btn]:hover{background-color:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.22));}
/* ⭐ 主按钮用**写死的品牌蓝**：主题里 「--dsw-alias-brand-primary」 在暗色下可能是一枚浅色 token，
 *   白字压上去就"看不见字"（用户截图里那个空白方块就是这个）✗ */
[data-bd-btn][data-primary]{background-color:#4d6bfe;background-image:none;border-color:transparent;
  color:#fff;font-weight:600;}
[data-bd-btn][data-primary]:hover{background-color:#4159e0;filter:none;}
[data-bd-btn][data-lg]{padding:10px 18px;font-size:13.5px;}
[data-bd-btn][disabled]{opacity:.5;cursor:default;}
/* ══════════════ 提示 / 二维码 / 代码块 ══════════════ */
[data-bd-msg]{font-size:11.5px;line-height:17px;padding:8px 10px;border-radius:9px;word-break:break-word;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-msg][data-warn]{color:#f59e0b;background:rgba(245,158,11,.08);}
[data-bd-msg][data-good]{color:#22c55e;background:rgba(34,197,94,.08);}
[data-bd-qr]{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;}
[data-bd-qr] img{width:158px;height:158px;border-radius:10px;background:#fff;padding:7px;}
[data-bd-pre]{margin:4px 0 0;padding:10px 11px;border-radius:10px;max-height:180px;overflow:auto;
  font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.22));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-badge]{font-size:11px;padding:2px 8px;border-radius:999px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
/* ══════════════ 实时日志（2026-10-19 加，钉在页头下面） ══════════════ */
[data-bd-log]{width:100%;}
[data-bd-loghead]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-bd-logpre]{height:190px;max-height:32vh;overflow:auto;margin:0;tab-size:2;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;
  font-size:11.5px;line-height:17px;}
[data-bd-log][data-collapsed]{gap:0;padding-bottom:14px;}
[data-bd-btn][data-on]{border-color:#4d6bfe;color:#4d6bfe;background-color:rgba(77,107,254,.1);}
/* ══════════════ 总开关（服务电源 · 绿灯/红灯） ══════════════ */
[data-bd-master]{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:9px;
  font-size:12.5px;line-height:18px;cursor:pointer;font-family:inherit;color:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));
  background-color:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));
  background-image:none;transition:border-color .15s,background-color .15s;}
[data-bd-master][data-on]{border-color:rgba(34,197,94,.45);background-color:rgba(34,197,94,.08);}
[data-bd-dot]{flex:none;width:8px;height:8px;border-radius:50%;background:#ef4444;
  box-shadow:0 0 0 2px rgba(239,68,68,.18);}
[data-bd-master][data-on] [data-bd-dot]{background:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,.18);}
[data-bd-master-state]{font-size:11px;opacity:.75;}
/* ══════════════ 窄屏 ══════════════ */
@media (max-width:560px){
  [data-bd-head]{padding:18px 14px 12px;}
  [data-bd-scroll]{padding:12px 14px 40px;}
  [data-bd-title]{font-size:22px;}
  [data-bd-actions]{width:100%;}
  [data-bd-actions] [data-bd-btn]{flex:1;}
}
/* ══════════════ 宽屏：卡片再松一点 ══════════════ */
@media (min-width:1400px){
  [data-bd-page]{max-width:1240px;}
  [data-bd-grid]{column-gap:18px;}
}
`

    // ⚠️ 与 lib/state.mjs 的 WINDOWS 保持一致（官方口径：工作日 9–12、14–18 是高峰，其余都是谷时）
    const DEFAULT_WINDOWS = {
      noon: { label: '中午谷时', start: '12:00', end: '14:00' },
      night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
    }

    /* ────────────── 小组件 ────────────── */

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bd-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-bd-row': '' },
        h('div', { 'data-bd-grow': '' },
          h('div', { 'data-bd-label': '' }, label),
          note ? h('div', { 'data-bd-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    /**
     * ⭐ 侧栏那盏灯：每 10 秒问一次 /status，看「刷B站服务」总开关是开还是关。
     *   开 = 绿点，关 = 红点（用户 2026-10-19 要的）。抖动/断网就保持上一次的样子。
     */
    function useServiceOn() {
      const [on, setOn] = React.useState(true)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const r = await fetch(API + '/status', { credentials: 'same-origin' })
            if (!r.ok) return
            const d = await r.json()
            if (alive && d?.ok) setOn(d.serviceOn !== false)
          } catch { /* 抖动就下次 */ }
        }
        tick()
        const t = setInterval(tick, 10000)
        return () => { alive = false; clearInterval(t) }
      }, [])
      return on
    }

    /**
     * ⭐ 侧栏图标（2026-10-19 加）：一条圆滚滚的小鲸鱼 + 头顶一柱水花。
     *   侧栏会把它塞进 `<span data-dsh-part="sidebar-icon">` 里，传 `{ size, active }`；
     *   所以只用 `currentColor` 描边，别自带底色 —— 跟着宿主的主题走。
     *   右下角那盏小灯 = 服务总开关（绿 = 开 · 红 = 关）。
     */
    function BiliIcon({ size = 18, active }) {
      const on = useServiceOn()
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
      },
        h('g', { fill: 'currentColor', fillOpacity: active ? 0.16 : 0, opacity: on ? 1 : 0.55 },
          h('ellipse', { cx: 11, cy: 13.4, rx: 6.3, ry: 5.1 }),
          h('path', { d: 'M17 12.2 21 9.8v7.2l-4-2.4' })),
        h('circle', { cx: 8.4, cy: 12.2, r: 0.95, fill: 'currentColor', stroke: 'none', opacity: on ? 1 : 0.55 }),
        h('path', { d: 'M10.1 6.6c0-1.1.7-2 1.8-2.4', opacity: on ? 1 : 0.55 }),
        h('path', { d: 'M12.3 6.3c.2-.9.9-1.6 1.8-1.9', opacity: on ? 1 : 0.55 }),
        // ⭐ 服务指示灯
        h('circle', {
          cx: 19.2, cy: 19.2, r: 3.2,
          fill: on ? '#22c55e' : '#ef4444',
          stroke: 'var(--dsw-alias-bg-base, #16181c)', strokeWidth: 1.2,
        }),
      )
    }

    /** ⭐ 多 @：一行一个（也认逗号/顿号/分号/空格），去掉手打的 `@`，去重（不区分大小写），最多 8 个 —— 和 index.js 的 clampPatch 一个口径 */
    function parseMentions(text) {
      const seen = new Set(); const out = []
      for (const raw of String(text || '').split(/[\n\r,，、;；\s]+/)) {
        const n = raw.trim().replace(/^@+/, '')
        if (!n) continue
        const k = n.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k); out.push(n)
      }
      return out.slice(0, 8)
    }

    /**
     * 5 秒轮询一次 /status。
     * ⚠️ 2026-10-19 修（用户："开关打开后自动关闭了"）：
     *   轮询和"写设置"是两条线 —— 如果一次 /status **在写入之前发出、在写入之后才回来**，
     *   它带的是旧值，会把刚刚写好的开关刷回旧状态（看起来就是"自己关掉了"）✗
     *   ⇒ `writeSeq` 是写入代次：请求发出时记下它，回来时若代次变了（期间发生过写入）就**丢弃这次结果**。
     *   （这是**兜底**：真正让开关弹回去的根因是宿主那份 config 快照读不出新值，见 index.js 的 hostCfg 注释）
     */
    function useStatus(intervalMs, writeSeq) {
      const [st, setSt] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          const seq = writeSeq ? writeSeq.current : 0
          try {
            const d = await jget('/status')
            if (!alive || !d?.ok) return
            if (writeSeq && writeSeq.current !== seq) return   // 期间写过 ⇒ 这份是旧的，丢掉
            setSt(d)
          } catch { /* 网络抖动就下次再问 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt]
    }

    /**
     * ⭐ 实时日志（2026-10-19 加）：轮询 /log 拿 duty.log 的尾部。
     *   跑着的时候 1.5 秒刷一次（能看见它一步步在干嘛），空闲时 6 秒。
     *   `nonce` 变一下就立刻重取（「刷新」按钮）。
     */
    function useLog(intervalMs, nonce) {
      const [d, setD] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const r = await jget('/log?lines=300')
            if (!alive || !r?.ok) return
            setD(r)
          } catch { /* 抖动就下次再问 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 6000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs, nonce])
      return d
    }

    /* ────────────── 设置页正文 ────────────── */

    function Panel() {
      /* ⭐ 写入代次：每次写设置 +1；轮询回来时代次变了就把那份旧结果丢掉（见 useStatus 的注释） */
      const writeSeq = React.useRef(0)
      const [st, setSt] = useStatus(5000, writeSeq)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [kws, setKws] = React.useState(null)
      const [ws, setWs] = React.useState(null)
      const [rl, setRl] = React.useState(null)
      const [newVer, setNewVer] = React.useState('')       // 发现的新版本号（空 = 没发现）          // 日报形态：full / brief / off
      // ⚠️ 输入框必须绑"本地草稿"：页面每 5 秒轮询 /status，服务端那份会把 config 盖掉
      //    ⇒ 直接绑 cfg 的话，用户打字打到一半就被冲没了 ✗（2026-10-14 陌生人验收时抓到）
      const [perDay, setPerDay] = React.useState(null)
      const [perRoundDraft, setPerRoundDraft] = React.useState(null)   // ⭐ 单轮挑几条
      const [perRound, setPerRound] = React.useState(null)             // 每轮评论条数（commentPerRound）
      const [replyPer, setReplyPer] = React.useState(null)
      const [dmUid, setDmUid] = React.useState(null)        // 私信收件人 UID（本地草稿）
      /* ⭐ 顺手三连（2026-10-19）：投币数 / 每天上限 / 收藏夹（本地草稿 + 收藏夹列表） */
      const [tripleCoin, setTripleCoin] = React.useState(null)
      const [triplePerDayDraft, setTriplePerDayDraft] = React.useState(null)
      const [tripleFav, setTripleFav] = React.useState(null)
      const [favFolders, setFavFolders] = React.useState(null)
      const [favErr, setFavErr] = React.useState('')
      /* ⭐ 标签规则草稿（2026-10-19） */
      const [allowTagsDraft, setAllowTagsDraft] = React.useState(null)
      const [blockTagsDraft, setBlockTagsDraft] = React.useState(null)
      /* ⭐ 挑片来源 / 收藏夹画像（2026-10-20） */
      const [uidDraft, setUidDraft] = React.useState(null)
      const [favInfo, setFavInfo] = React.useState(null)
      const [favBusy, setFavBusy] = React.useState(false)
      const [favMsg, setFavMsg] = React.useState('')
      /* ⭐ 回复窗口 / 回复线 / dsh 路径（2026-10-20 补：这三项以前只能在 config.json 里改） */
      const [lookbackDraft, setLookbackDraft] = React.useState(null)
      const [minScoreDraft, setMinScoreDraft] = React.useState(null)
      const [dshBinDraft, setDshBinDraft] = React.useState(null)
      const [dmMode, setDmMode] = React.useState(null)      // 投递方式：off / only / both
      const [mention, setMention] = React.useState(null)
      /* ⭐ 多 @（一行一个昵称）+ 模型选择（2026-10-19 加） */
      const [mentionsDraft, setMentionsDraft] = React.useState(null)
      const [modelDraft, setModelDraft] = React.useState(null)      // "provider\u0000model"（空 = 跟 profile 默认）
      const [catalog, setCatalog] = React.useState(null)            // /models 的结果
      /* ⭐ 「地盘」（数据目录）草稿 —— 跟 ws 一样是本地草稿，点「应用」才提交（会动文件的操作不能边打边执行）
       * ⚠️ 2026-10-19 补：草稿只在 `null` 时初始化，而设置页**切走再回来不一定重新挂载** ⇒
       *    地盘在别处改了（比如原生设置页、或上一次会话），这里还显示旧地址（用户："重新打开设置地址还是没有变"）✗
       *    ⇒ 用一个 dirty 标记：用户没动过输入框时，服务端说变了就跟着变；动过就不抢他的字。 */
      const [homeDraft, setHomeDraft] = React.useState(null)
      const homeDirty = React.useRef(false)
      const [login, setLogin] = React.useState(null)
      const [runNote, setRunNote] = React.useState(null)
      const [report, setReport] = React.useState(null)        // 非 null = 报告已展开   // 顶部那行状态（跑一轮/装依赖的反馈原来在最底下，看不见）
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')
      /* ⚠️ 扫码轮询的 timer 必须能停：切走设置页后还在跑的话会在已卸载的组件上 setState，
       *    重复点「扫码登录」还会叠出第二个 timer。（2026-10-16 审查修） */
      const loginTimer = React.useRef(null)
      const alive = React.useRef(true)
      React.useEffect(() => () => {
        alive.current = false
        if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }
      }, [])

      const cfg = st?.config
      /* ⭐ 实时日志块（2026-10-19 加）：跑着时 1.5s 刷、空闲 6s；「跟随最新」开着就自动滚到底 */
      const [logNonce, setLogNonce] = React.useState(0)
      const [follow, setFollow] = React.useState(true)
      /* ⭐ 2026-10-21：日志默认收起 —— 平时不看，却占着首屏最贵的位置 */
      const [logOpen, setLogOpen] = React.useState(false)   // 日志展开/收起
      const logRef = React.useRef(null)
      const logData = useLog(st?.running ? 1500 : 6000, logNonce)
      React.useEffect(() => {
        const el = logRef.current
        if (el && follow) el.scrollTop = el.scrollHeight
      }, [logData?.text, follow])
      /* ⭐ 收藏夹列表：开三连时才去拉（一次就够，失败给个错误串） */
      React.useEffect(() => {
        if (!cfg?.tripleOn || favFolders !== null) return
        let alive = true
        jget('/favorites')
          .then((d) => { if (!alive) return; setFavFolders(Array.isArray(d?.folders) ? d.folders : []); setFavErr(d?.ok === false ? String(d?.error || '') : '') })
          .catch((e) => { if (alive) { setFavFolders([]); setFavErr(String(e?.message ?? e)) } })
        return () => { alive = false }
      }, [cfg?.tripleOn, favFolders])
      React.useEffect(() => {
        if (cfg && kws === null) setKws((cfg.keywords || []).join('\n'))
        if (cfg && ws === null) setWs(cfg.workspace || '')
        if (cfg && rl === null) setRl(cfg.reportLevel || 'full')
        if (cfg && perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (cfg && perRoundDraft === null) setPerRoundDraft(String(cfg.perRound ?? 0))
        if (cfg && perRound === null) setPerRound(String(cfg.commentPerRound ?? 1))
        if (cfg && replyPer === null) setReplyPer(String(cfg.replyPerRound ?? 1))
        if (cfg && tripleCoin === null) setTripleCoin(String(cfg.tripleCoin ?? 1))
        if (cfg && triplePerDayDraft === null) setTriplePerDayDraft(String(cfg.triplePerDay ?? 5))
        if (cfg && tripleFav === null) setTripleFav(String(cfg.tripleFavMediaId ?? 0))
        if (cfg && allowTagsDraft === null) setAllowTagsDraft((cfg.funTagsAllow || []).join('\n'))
        if (cfg && blockTagsDraft === null) setBlockTagsDraft((cfg.funTagsBlock || []).join('\n'))
        if (cfg && uidDraft === null) setUidDraft(String(cfg.biliUid ?? 0))
        if (cfg && lookbackDraft === null) setLookbackDraft(String(cfg.replyLookbackDays ?? 7))
        if (cfg && minScoreDraft === null) setMinScoreDraft(String(cfg.replyMinScore ?? 3))
        if (cfg && dshBinDraft === null) setDshBinDraft(String(cfg.dshBin || ''))
        if (cfg && mention === null) setMention(cfg.mentionName || '')
        if (cfg && mentionsDraft === null) {
          const list = Array.isArray(cfg.mentionNames) && cfg.mentionNames.length
            ? cfg.mentionNames
            : (cfg.mentionName ? [cfg.mentionName] : [])
          setMentionsDraft(list.join('\n'))
        }
        if (cfg && modelDraft === null) {
          setModelDraft(cfg.modelProvider && cfg.modelName ? cfg.modelProvider + '\u0000' + cfg.modelName : '')
        }
        if (cfg && dmUid === null) setDmUid(cfg.dmUid ? String(cfg.dmUid) : '')
        if (cfg && dmMode === null) setDmMode(cfg.dmMode || 'off')
        if (st) {
          const serverHome = st.home || ''
          if (homeDraft === null) setHomeDraft(serverHome)
          else if (!homeDirty.current && homeDraft !== serverHome) setHomeDraft(serverHome)   // ⭐ 没动过就跟着服务端走
        }
      }, [cfg, st?.home])

      /* ⭐ 模型目录：只在挂载时拉一次（拿不到就退回手填，别让设置页转圈） */
      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try { const d = await jget('/models'); if (alive && d?.ok) setCatalog(d) } catch { /* 拿不到就手填 */ }
        })()
        return () => { alive = false }
      }, [])

      const win = { ...DEFAULT_WINDOWS, ...(st?.windows || {}) }

      const say = (text, tone) => {
        setMsg(text); setMsgTone(tone || '')
        setRunNote(text ? { t: text, tone: tone || '' } : null)   // ⭐ 同时镜像到顶部，免得提示掉到页面最底下看不见
      }

      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        writeSeq.current += 1          // ⭐ 让"写入前发出"的轮询结果作废
        try {
          const r = await jpost('/config', p)
          if (r?.config) setSt((old) => ({ ...old, config: r.config }))
          // ⭐ DSH 原生设置页里显式设过的键由宿主说了算 ⇒ 我们这份也得写进去；写失败要说出来，别假装"已保存"
          if (r?.ok === false) say(`${what || '设置'}：没存进去（${r.error || '未知原因'}）`, 'warn')
          else if (r?.host && r.host.ok === false) say(`${what || '设置'}：插件自己那份存了，但 DSH 设置页那份没写进去（${r.host.error}）`, 'warn')
          else say(what ? `${what}：已保存` : '已保存', 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onShowReport = async () => {
        if (report !== null) { setReport(null); return }       // 再点一次收起
        setBusy('report')
        try {
          const r = await jget('/report')
          setReport(r && r.exists ? (r.text || '（报告是空的）') : '今天还没有报告 —— 跑一轮之后就有了')
        } catch (e) { setReport('读不到报告：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      // ⭐ 复核评论：接口回"发送成功"≠ 公开可见（新号/风控会进审核，那时候连 @ 都不会推）
      //    所以让宿主真去拉一次评论列表 / 楼中楼，确认那条到底在不在。
      const onVerify = async () => {
        setBusy('verify')
        try {
          const r = await jpost('/verify', {})
          if (!r || !r.ok) { say('复核没跑成：' + ((r && r.error) || '未知原因'), 'warn'); return }
          const n = (r.checked || []).length
          const vis = (r.checked || []).filter((c) => c.visible === true).length
          if (!n) say(r.text || '没有需要复核的记录', 'good')
          else say(`复核完 ${n} 条：公开可见 ${vis} 条，其余「没查到」（可能还在审核 —— 看不到不等于没发出去）。结果也追加到今天的报告末尾了。`, vis ? 'good' : 'warn')
          if (r.report) setReport(null)
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const copyText = async (text) => {
        const v = String(text || '')
        try {
          await navigator.clipboard.writeText(v)
          say('已复制：' + v, 'good')
        } catch {
          say('复制失败 —— 路径是：' + v)       // 兜底：至少把路径显示出来，手动选中也能复制
        }
      }

      const onOpenFolder = async (what) => {
        try {
          const r = await jpost('/open', { what })
          if (r && r.ok) say('已请系统打开：' + (r.opened || '') + '（要是没看到窗口，用旁边的「复制报告路径」——那个一定成）', 'good')
          else say('打不开（' + ((r && r.error) || '未知原因') + '）—— 你可以手动打开这个路径：' + ((r && r.dir) || ''))
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      const onUpgrade = async () => {
        setBusy('upgrade')
        try {
          const r = await jpost('/upgrade', {})
          // 原来这两句分两次 say，第二句把服务端的 hint 冲掉了 —— 合成一句。（2026-10-16 审查修）
          say(((r && r.hint) || '正在升级') + ' —— 升级过程写在下面的「主依赖的日志」里；完了记得重启一次 dsh（不重启还是旧版）', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheckUpdate = async () => {
        setBusy('update')
        try {
          const r = await jget('/update')
          if (r && r.ok && r.latest) {
            if (r.hasNew) {
              setNewVer(r.latest)
              say('有新版 v' + r.latest + '（你的是 v' + r.current + '）—— 点右边的「一键升级」，完了重启一次 dsh', 'warn')
            } else say('已经是最新版 v' + r.current, 'good')
          } else {
            say('查不到最新版（可能网络不通）—— 你现在的版本是 v' + ((r && r.current) || '?'))
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheck = async () => {
        setBusy('check')
        say('')
        try {
          const r = await jpost('/check', {})
          if (r && r.ok) say('能用！' + (r.steps || []).join('、'))
          else say('还不能用：' + (r && r.error ? r.error : '没拿到结果'))
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      /* ⭐ 换「地盘」（数据目录）—— 2026-10-19 用户要求
       * 这是个**会动文件**的操作（把凭证/报告/日志复制到新家），所以要：
       *   ① 用户在输入框里填好、显式点「应用」才执行；② 结果说清楚（搬了几项 / venv 要重建）。 */
      const onApplyHome = async () => {
        const want = String(homeDraft ?? '').trim()
        const cur = String(st?.home || '')
        if (!want) { setHomeDraft(cur); homeDirty.current = false; say('要填一个绝对路径（比如 D:\\bili-duty）；想回默认就点「恢复默认」', 'warn'); return }
        if (want.toLowerCase() === cur.toLowerCase()) { homeDirty.current = false; say('跟现在的一样，没动', ''); return }
        setBusy('home')
        writeSeq.current += 1
        try {
          const r = await jpost('/home', { home: want, migrate: true })
          if (!r || !r.ok) { say('没换成：' + ((r && r.error) || '未知原因'), 'warn'); return }
          setHomeDraft(r.home); homeDirty.current = false
          setSt((old) => ({ ...old, home: r.home, defaultHome: r.defaultHome, venvReady: r.venvReady }))
          say('已换到 ' + r.home + '（复制了 ' + ((r.copied || []).length) + ' 项）—— ' + (r.note || ''), r.venvReady ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onResetHome = async () => {
        setBusy('home')
        writeSeq.current += 1
        try {
          const r = await jpost('/home', { home: '', migrate: false })
          if (!r || !r.ok) { say('没换回默认：' + ((r && r.error) || '未知原因'), 'warn'); return }
          setHomeDraft(r.home); homeDirty.current = false
          setSt((old) => ({ ...old, home: r.home, venvReady: r.venvReady }))
          say('已回到默认地盘：' + r.home + '（老目录里的东西没删，你自己看着清理）', 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstallAsr = async () => {
        setBusy('asr')
        say('')
        try {
          const r = await jpost('/install-asr', {})
          say(r?.started ? '开始装转写依赖 —— 进度显示在下面（要下模型，慢一点正常）' : (r?.hint || '没起来'),
            r?.started ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstall = async () => {
        setBusy('install')
        say('')
        try {
          const r = await jpost('/install', {})
          say(r?.hint || '已经在后台开始装了', '')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onRun = async () => {
        setBusy('run')
        try {
          const r = await jpost('/run', {})
          if (r?.busy) say(r?.hint || '上一轮还在跑，等它结束再点', 'warn')
          else say(r?.started ? '已经在后台跑一轮了（通常几分钟，报告写在 out/）' : '没起来，看 duty.log', r?.started ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onLoginStart = async () => {
        setBusy('login')
        setLoginTone('')
        setLoginState('正在出码…')
        try {
          const r = await jpost('/login/start', {})
          if (!r?.ok) { setLoginTone('warn'); setLoginState(r?.error || '出码失败'); return }
          setLogin({ key: r.key, qr: r.qr })
          // ⭐ 现在服务端拿不到码会回 ok:false + 真实原因（上面那条分支），走到这儿说明码有了；
          //    这里只留一句兜底，别再猜"是不是没装 qrcode"来误导人。
          if (!r.qr) { setLoginTone('warn'); setLoginState('服务端说画好了，但图没回来 —— 看下面「主依赖的日志」') }
          else setLoginState('用手机 B站 扫这张码' + (r.via ? `（${r.via}）` : ''))
          if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }   // 重复点：先把上一轮停掉
          let n = 0
          const stop = () => { clearInterval(timer); if (loginTimer.current === timer) loginTimer.current = null }
          const timer = setInterval(async () => {
            if (!alive.current) { stop(); return }        // 已经切走设置页了：别再问、别再 setState
            n += 1
            try {
              const p = await jpost('/login/poll', { key: r.key })
              if (p?.state === 'ok') {
                stop(); setLogin(null)
                setLoginTone('good'); setLoginState('登录成功')
                setSt((old) => ({ ...old, loggedIn: true }))
              } else if (p?.state === 'scanned') { setLoginTone(''); setLoginState('扫到了，请在手机上确认') }
              else if (p?.state === 'expired') { stop(); setLogin(null); setLoginTone('warn'); setLoginState('二维码过期了，再点一次「扫码登录」') }
              // ⚠️ 扫码成功但响应里没有 SESSDATA 时服务端回 state='unknown'：原来没这个分支
              //    ⇒ 界面一直显示「等扫码…」，用户白等 3 分钟才超时。（2026-10-16 审查修）
              else if (p?.state === 'unknown') {
                stop(); setLogin(null); setLoginTone('warn')
                setLoginState('没登上：' + (p?.message || '响应里没有 SESSDATA —— 再点一次「扫码登录」'))
              }
              else { setLoginTone(''); setLoginState('等扫码…') }
            } catch { /* 抖动就下次再问 */ }
            if (n > 90) { stop(); setLogin(null); setLoginTone('warn'); setLoginState('超时了，再点一次「扫码登录」') }
          }, 2000)
          loginTimer.current = timer
        } catch (e) { setLoginTone('warn'); setLoginState(String(e?.message ?? e)) }
        finally { setBusy('') }
      }

      const onSaveText = async () => {
        const list = String(kws || '').split('\n').map((s) => s.trim()).filter(Boolean)
        await patch({ keywords: list, workspace: String(ws || '').trim() }, '关键词与工作区')
      }

      /* ⭐ 标签白/黑名单保存（一行一个，顺手去掉 # 和前导空格） */
      const saveTagList = async (key, draft, label) => {
        const list = String(draft || '')
          .split(/[\n,，]/).map((s) => s.trim().replace(/^#+/, '')).filter(Boolean)
        await patch({ [key]: list }, label)
      }

      if (!cfg) {
        return h('div', { 'data-bd-page': '' }, h('div', { 'data-bd-note': '' }, '读设置中…'))
      }

      const sw = (k) => Boolean(cfg[k])

      const pickedToday = st.pickedToday ?? st.ranToday ?? 0
      const serviceOn = cfg.serviceOn !== false
      return h('div', { 'data-bd-page': '' },

        /* ══ 页头（置顶，不跟着滚）：它在干嘛 + 状态 + 主操作 ══ */
        h('header', { 'data-bd-head': '' },
          h('div', { 'data-bd-headtext': '' },
            h('div', { 'data-bd-eyebrow': '' }, 'B站 值班'),
            h('div', { 'data-bd-title': '' }, '刷B站'),
            h('div', { 'data-bd-lede': '' }, '挑几条值得看的，替你在下面说句话 —— 一轮跑完给你一份日报。'),
            h('div', { 'data-bd-chips': '' },
              h('span', { 'data-bd-chip': '', 'data-tone': serviceOn ? 'good' : 'warn' },
                serviceOn ? '服务运行中' : '服务已停止'),
              h('span', { 'data-bd-chip': '', 'data-tone': 'brand' }, `今天 ${pickedToday} / ${cfg.perDay} 条`),
              cfg.tripleOn ? h('span', { 'data-bd-chip': '' }, `三连 ${st.tripledToday ?? 0} / ${cfg.triplePerDay}`) : null,
              (cfg.replyToComments && Number(st.repliesPending) > 0)
                ? h('span', { 'data-bd-chip': '', 'data-tone': 'warn' }, `待回复 ${st.repliesPending}`)
                : null,
              h('span', { 'data-bd-chip': '', 'data-tone': st.venvReady ? 'good' : 'warn' },
                st.venvReady ? '环境就绪' : (st.installing ? '正在装环境' : '环境未装')),
              h('span', { 'data-bd-chip': '', 'data-tone': st.loggedIn ? 'good' : 'warn' },
                st.loggedIn ? 'B站已登录' : 'B站未登录'),
              st.running ? h('span', { 'data-bd-chip': '', 'data-tone': 'warn' },
                '跑着' + (st.runningSince ? `（${Math.max(1, Math.round((Date.now() - st.runningSince) / 60000))} 分钟）` : '')) : null,
              h('span', { 'data-bd-chip': '' }, 'v' + (st.version || '?')))),
          h('div', { 'data-bd-actions': '' },
            /* ⭐ 总开关：整个「刷B站服务」的电源（侧栏那盏灯跟着它变绿 / 变红） */
            h('button', {
              'data-bd-master': '', 'data-on': serviceOn ? '' : undefined,
              title: serviceOn ? '点一下停机（自动轮 / 手动轮 / 发评论全停）' : '点一下开机',
              onClick: () => patch({ serviceOn: !serviceOn }, '总开关'),
            },
              h('span', { 'data-bd-dot': '' }),
              h('span', null, '刷B站服务'),
              h('span', { 'data-bd-master-state': '' }, serviceOn ? '开' : '关')),
            h('button', {
              'data-bd-btn': '', 'data-primary': '', 'data-lg': '',
              disabled: !serviceOn || busy === 'run' || Boolean(st.running), onClick: onRun,
            }, !serviceOn ? '服务已关' : (st.running ? '正在跑一轮…' : '现在跑一轮')),
            h('button', { 'data-bd-btn': '', 'data-lg': '', disabled: busy === 'verify', onClick: onVerify }, '复核评论')),
          runNote ? h('div', { 'data-bd-msg': '', 'data-good': runNote.tone === 'good' ? '' : undefined,
            'data-warn': runNote.tone === 'warn' ? '' : undefined }, runNote.t) : null),

        /* ══ 实时日志：和页头一起钉在顶部（2026-10-19 用户："日志没有置顶"） ══ */
        h('div', { 'data-bd-pinned': '' },
          h('div', { 'data-bd-sec': '', 'data-bd-log': '', 'data-collapsed': logOpen ? undefined : '' },
            h('div', { 'data-bd-loghead': '' },
              h('div', { 'data-bd-h': '' }, '实时日志'),
              h('span', { 'data-bd-chip': '', 'data-tone': st.running ? 'warn' : '' }, st.running ? '正在跑' : '空闲'),
              h('span', { 'data-bd-chip': '' }, `${logData?.lines?.length ?? 0} 行`),
              h('div', { 'data-bd-grow': '' }),
              h('button', {
                'data-bd-btn': '', 'data-on': follow ? '' : undefined,
                title: '开着就自动滚到最新一行',
                onClick: () => setFollow((v) => !v),
              }, follow ? '跟随最新 · 开' : '跟随最新 · 关'),
              h('button', { 'data-bd-btn': '', onClick: () => setLogNonce((n) => n + 1) }, '刷新'),
              h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('home') }, '打开日志文件'),
              h('button', {
                'data-bd-btn': '', title: logOpen ? '把日志收起来，给设置腾地方' : '展开日志',
                onClick: () => setLogOpen((v) => !v),
              }, logOpen ? '收起' : '展开')),
            logOpen ? h('pre', { 'data-bd-pre': '', 'data-bd-logpre': '', ref: logRef },
              logData ? (logData.text || '（日志是空的）') : '正在读日志…') : null,
            logOpen ? h('div', { 'data-bd-note': '' },
              logData
                ? `最后 ${logData.lines.length} 行 · 文件 ${Math.max(1, Math.round((logData.total || 0) / 1024))} KB`
                  + ` · 更新于 ${new Date(logData.at || Date.now()).toLocaleTimeString('zh-CN')}`
                  + (logData.truncated ? ' · 太长，只取了尾部' : '')
                  + (st.running ? ' · 跑着时每 1.5 秒刷' : ' · 空闲时每 6 秒刷')
                : '正在读日志…') : null)),

        /* ══ 滚动区：只有设置卡片在这里滚 ══ */
        h('div', { 'data-bd-scroll': '' },

        /* ══ 卡片区 ══ */
        h('div', { 'data-bd-grid': '' },

        /* ══ 运行 ══ */
        h('div', { 'data-bd-group': '' },
          h('div', { 'data-bd-group-h': '' }, '运行', h('span', { 'data-bd-group-sub': '' }, '什么时候跑、跑多少'))),

        /* ── 定时 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '什么时候自己跑'),
          h(ToggleRow, {
            label: '峰谷时段自动刷',
            note: '只在谷时跑 —— 工作日 12:00–14:00 与 18:00 之后（整个周末也算谷时）；关了就只能手动跑',
            on: sw('peakValley'),
            onChange: (v) => patch({ peakValley: v }, '峰谷时段自动刷'),
          }),
          sw('peakValley') ? h('div', { 'data-bd-sub': '' },
            ...['noon', 'night'].map((k) => h(ToggleRow, {
              key: k,
              label: win[k].label,
              note: `${win[k].start} – ${win[k].end}`,
              on: sw(k),
              onChange: (v) => patch({ [k]: v }, win[k].label),
            }))) : null),
        /* ── 一轮挑几条 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '一轮挑几条'),
          h('div', { 'data-bd-row': '' },
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-label': '' }, '每天最多挑几条（全天总量）'),
              h('div', { 'data-bd-note': '' }, '填 0 = 不自动刷（还是能手动跑）')),
            h('input', {
              'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: 50,
              value: perDay ?? '',
              onChange: (e) => setPerDay(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(perDay) || 0, 50)); setPerDay(String(n)); patch({ perDay: n }, '每天挑几条') },
            })),
          /* ⭐ 2026-10-19：单轮上限单独配。自动轮跑得勤的时候，用它控"每轮别一次挑太多"
           *    （比如一天 20 条、每轮 5 条）；填 0 = 不单独限制，用当天剩余额度。 */
          h('div', { 'data-bd-row': '' },
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-label': '' }, '一轮最多挑几条（单轮上限）'),
              h('div', { 'data-bd-note': '' }, '填 0 = 不单独限制（用当天剩余额度）；不会超过「每天」那个数')),
            h('input', {
              'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: 50,
              value: perRoundDraft ?? '',
              onChange: (e) => setPerRoundDraft(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(perRoundDraft) || 0, 50)); setPerRoundDraft(String(n)); patch({ perRound: n }, '一轮挑几条') },
            })),
          st.lastRunAt ? h('div', { 'data-bd-note': '' }, `上次跑：${new Date(st.lastRunAt).toLocaleString('zh-CN')}`) : null),

        /* ══ 内容 ══ */
        h('div', { 'data-bd-group': '' },
          h('div', { 'data-bd-group-h': '' }, '内容', h('span', { 'data-bd-group-sub': '' }, '挑什么、说什么'))),

        /* ── 关注什么 / 在哪儿刷 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '关注什么'),
          /* ⭐ 挑片来源二选一（2026-10-20）：关键词 / 收藏夹口味画像 */
          h('div', { 'data-bd-row': '' },
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-label': '' }, '怎么决定挑哪些视频'),
              h('div', { 'data-bd-note': '' }, '二选一：用关键词搜，或者分析你的收藏夹照着口味挑')),
            h('select', {
              'data-bd-input': '', value: (cfg.pickSource === 'favorites') ? 'favorites' : 'keywords',
              onChange: (e) => patch({ pickSource: e.target.value }, '挑片来源'),
            },
              h('option', { value: 'keywords' }, '按关键词'),
              h('option', { value: 'favorites' }, '按我的收藏夹口味'))),
          (cfg.pickSource === 'favorites') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, 'B站 UID'),
                h('div', { 'data-bd-note': '' }, '要分析谁的口味；留 0 = 用当前登录的这个号')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0,
                value: uidDraft ?? '', placeholder: '0',
                onChange: (e) => setUidDraft(e.target.value),
                onBlur: () => { const n = Math.max(0, Number(uidDraft) || 0); setUidDraft(String(n)); patch({ biliUid: n }, 'B站 UID') },
              })),
            h('div', { 'data-bd-row': '' },
              h('button', {
                'data-bd-btn': '', disabled: favBusy,
                onClick: async () => {
                  setFavBusy(true); setFavMsg('正在分析收藏夹…（每个视频要一次接口，大约 30 秒）')
                  try {
                    const d = await jget('/fav-profile?force=1')
                    setFavInfo(d)
                    setFavMsg(d.ok
                      ? `分析了 ${d.videos} 个收藏视频：${(d.topTags || []).slice(0, 6).map((x) => x.tag).join('、') || '（无标签）'}`
                      : `没分析成功：${d.error || '原因不明'}`)
                  } catch (e) { setFavMsg('分析失败：' + String(e?.message ?? e)) } finally { setFavBusy(false) }
                },
              }, favBusy ? '分析中…' : '分析收藏夹'),
              h('div', { 'data-bd-note': '' }, favMsg || '分析结果 7 天内复用；改了收藏夹可以再点一次')),
            (favInfo?.ok && (favInfo.topTags || []).length) ? h('div', { 'data-bd-note': '' },
              '🎯 口味画像：' + (favInfo.topTags || []).slice(0, 12).map((x) => `${x.tag}(${x.count})`).join('、')
              + ((favInfo.topZones || []).length ? ` ｜ 常看分区：${favInfo.topZones.map((z) => z.zone).join('、')}` : '')) : null,
            h('div', { 'data-bd-note': '' }, '⚠️ 选了「按收藏夹口味」就不再使用下面的关键词；画像拿不到时会自动退回关键词')) : null,
          h('div', { 'data-bd-label': '' }, '关键词（只在上面选「按关键词」时用）'),
          h('textarea', {
            'data-bd-input': '', rows: 5, placeholder: '一行一个关键词；留空用内置那几组',
            value: kws ?? '', onChange: (e) => setKws(e.target.value),
          }),
          h('div', { 'data-bd-label': '' }, '工作区（它按这里的 AGENTS.md 认设定）'),
          h('input', {
            'data-bd-input': '', value: ws ?? '',
            placeholder: '填你自己的工作区路径（留空 = 不读人设，按中性说话）',
            onChange: (e) => setWs(e.target.value),
          }),
          h('div', { 'data-bd-note': '' },
            '⭐ 想让它按你的设定说话，这里要填你自己平时用的那个工作区（放 AGENTS.md 的那个目录）；',
            h('br'),
            '留空不等于"用你的工作区" —— 那是不读设定、按中性说话（以前会去猜 dsh 进程自己的目录，容易读错人设）。'),
          h('div', { 'data-bd-label': '' }, '日报写多细'),
          h('select', {
            'data-bd-input': '', value: rl ?? 'full',
            onChange: (e) => { setRl(e.target.value); patch({ reportLevel: e.target.value }, '日报形态') },
          },
            h('option', { value: 'full' }, '完整 —— 每条：标题 / UP / 为什么值得（默认）'),
            h('option', { value: 'brief' }, '薄 —— 每条一两行，只留值不值得 + 链接'),
            h('option', { value: 'off' }, '不写 —— 只发评论，不生成日报文件')),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onSaveText }, '保存'),
            msg ? h('div', { 'data-bd-msg': '', 'data-good': msgTone === 'good' ? '' : undefined, 'data-warn': msgTone === 'warn' ? '' : undefined }, msg) : null)),
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '评论'),
          h(ToggleRow, {
            label: '自动发评论',
            note: '默认关；开了之后会在挑中的视频下面留一条评论（写「看完的观点」）。要不要 @ 你，看上面的「评论里 @ 我」',
            on: sw('autoComment'),
            onChange: (v) => patch({ autoComment: v }, '自动评论'),
          }),
          sw('autoComment') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每轮最多发几条评论'),
                h('div', { 'data-bd-note': '' }, '填 0 = 这一轮不发评论')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: 20,
                value: perRound ?? '',
                onChange: (e) => setPerRound(e.target.value),
                // ⭐ 0 是合法值（= 这一轮不发评论）；范围与 index.js 的 clampPatch 一致（0–20）
                onBlur: () => { const n = Math.max(0, Math.min(Number(perRound) || 0, 20)); setPerRound(String(n)); patch({ commentPerRound: n }, '每轮几条评论') },
              })),
            h('div', { 'data-bd-label': '' }, '要 @ 谁（B站 昵称，可多个）· 只在「评论里 @ 我」开着时用'),
            h('textarea', {
              'data-bd-input': '', rows: 3,
              value: mentionsDraft ?? '',
              placeholder: '一行一个昵称（也可以逗号/顿号分隔）；留空 = 只写报告、不发评论',
              onChange: (e) => setMentionsDraft(e.target.value),
              onBlur: () => {
                const list = parseMentions(mentionsDraft)
                setMentionsDraft(list.join('\n'))
                // ⭐ 同时写老字段 mentionName（= 第一个），旧配置/旧前端也能读懂
                patch({ mentionNames: list, mentionName: list[0] || '' }, '要 @ 谁')
              },
            }),
            h('div', { 'data-bd-note': '' },
              (st.mentions && st.mentions.length)
                ? `这一轮会分别 @：${st.mentions.map((n) => '@' + n).join(' ')}`
                : '留空 = 不 @ 任何人（评论照样发）'),
            h('div', { 'data-bd-note': '' }, 'B站 的 @ 是纯文本：正文里写 `@昵称` 才会真的圈到人；多个就写多个，最多 8 个')) : null,
          /* ⭐ 评论里 @ 不 @ 你（2026-10-20）：默认关 —— 评论就是"人设看完的观点"，不是来喊你的 */
          h(ToggleRow, {
            label: '评论里 @ 我',
            note: '默认关：评论写成「看完的观点」，不 @ 任何人；打开才回到"喊你来看 + 求夸/求摸头"',
            on: cfg.commentAtOwner === true,
            onChange: (v) => patch({ commentAtOwner: v }, '评论里 @ 我'),
          }),
          h('div', { 'data-bd-label': '' }, '投递方式（评论 还是 私信）'),
          h('select', {
            'data-bd-input': '', value: dmMode ?? 'off',
            onChange: (e) => { setDmMode(e.target.value); patch({ dmMode: e.target.value }, '投递方式') },
          },
            h('option', { value: 'off' }, '只发评论 —— 在视频下面留言（默认）'),
            h('option', { value: 'only' }, '只私信 —— 一条公开评论都不发，最不打扰别人'),
            h('option', { value: 'both' }, '评论 + 私信 —— 两边都发')),
          (dmMode && dmMode !== 'off') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-label': '' }, '私信发给谁（B站 UID，数字）'),
            h('input', {
              'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, value: dmUid ?? '',
              placeholder: '对方的数字 UID；比如你自己的另一个号',
              onChange: (e) => setDmUid(e.target.value),
              onBlur: () => { const n = Math.max(0, Number(dmUid) || 0); setDmUid(n ? String(n) : ''); patch({ dmUid: n }, '私信收件人') },
            }),
            h('div', { 'data-bd-note': '' }, '私信内容 = 本轮每条的「标题 + 链接 + 一句话」，一轮合并成一条发（不受 150 字限制）'),
            h('div', { 'data-bd-note': '' }, '⚠️ 建议先让这个号和收件人互关：B站 对「陌生人私信」会限流，还可能不弹提醒')) : null,
        ),

        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '回复评论'),
          h(ToggleRow, {
            label: '回复评论（回你评论区里的回复）',
            note: '默认关；开了之后宿主会按「最近 N 天」扫自己发过的评论、拉到别人给我的回复并按规则打分，够分的才交给这一轮去回（模型不再自己翻楼）',
            on: sw('replyToComments'),
            onChange: (v) => patch({ replyToComments: v }, '回复评论'),
          }),
          sw('replyToComments') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每轮最多回几条'),
                h('div', { 'data-bd-note': '' }, '只回直接回在你那条评论下面的人')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 1, max: 10,
                value: replyPer ?? '',
                onChange: (e) => setReplyPer(e.target.value),
                onBlur: () => { const n = Math.max(1, Math.min(Number(replyPer) || 1, 10)); setReplyPer(String(n)); patch({ replyPerRound: n }, '每轮几条回复') },
              })),
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '回看几天'),
                h('div', { 'data-bd-note': '' }, '只扫最近这些天自己发过的评论（1–30）')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 1, max: 30,
                value: lookbackDraft ?? '',
                onChange: (e) => setLookbackDraft(e.target.value),
                onBlur: () => { const v = Math.max(1, Math.min(Number(lookbackDraft) || 7, 30)); setLookbackDraft(String(v)); patch({ replyLookbackDays: v }, '回看几天') },
              })),
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '回复线（分数）'),
                h('div', { 'data-bd-note': '' }, '低于这个分数的不回；3 = 至少「像提问」或「相关 + 轻互动」')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: 20,
                value: minScoreDraft ?? '',
                onChange: (e) => setMinScoreDraft(e.target.value),
                onBlur: () => { const v = Math.max(0, Math.min(Number(minScoreDraft) || 0, 20)); setMinScoreDraft(String(v)); patch({ replyMinScore: v }, '回复线') },
              }))) : null,
        ),

        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '只评论娱乐视频'),
h(ToggleRow, {
            label: '只评论娱乐视频',
            note: '默认开；学习/技术/教程/科普/评测类只写进报告，不发评论（也不三连）',
            on: sw('funOnly'),
            onChange: (v) => patch({ funOnly: v }, '只评论娱乐视频'),
          }),
          /* ⭐ 标签规则（2026-10-19）：白名单命中 = 一定评论；黑名单命中 = 一定不评论。都比分区优先 */
          sw('funOnly') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '标签白名单（一行一个）'),
                h('div', { 'data-bd-note': '' }, '命中就一定评论 —— 哪怕分区是「知识 / 科技」。例如：梗、小剧场、大肥鱼')),
              h('textarea', {
                'data-bd-input': '', 'data-bd-area': '', rows: 3,
                placeholder: '梗\n小剧场\n大肥鱼',
                value: allowTagsDraft ?? '',
                onChange: (e) => setAllowTagsDraft(e.target.value),
                onBlur: () => saveTagList('funTagsAllow', allowTagsDraft, '标签白名单'),
              })),
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '标签黑名单（一行一个）'),
                h('div', { 'data-bd-note': '' }, '命中就一条都不发、也不三连 —— 哪怕分区是「动画 / 搞笑」。例如：教程、科普、编程')),
              h('textarea', {
                'data-bd-input': '', 'data-bd-area': '', rows: 3,
                placeholder: '教程\n科普\n编程',
                value: blockTagsDraft ?? '',
                onChange: (e) => setBlockTagsDraft(e.target.value),
                onBlur: () => saveTagList('funTagsBlock', blockTagsDraft, '标签黑名单'),
              }))) : null,
          h(ToggleRow, {
            label: '本地转写没字幕的视频',
            note: '默认关；开了以后，没字幕的视频会在本机转写一遍（不花 API 钱）',
            on: sw('transcribe'),
            onChange: (v) => patch({ transcribe: v }, '本地转写'),
          }),
          sw('transcribe') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('button', { 'data-bd-btn': '', disabled: busy === 'asr', onClick: onInstallAsr },
                st.asrReady ? '重装转写依赖' : '装转写依赖'),
              h('div', { 'data-bd-note': '' },
                !st.asrReady ? '还没装 —— 现在开着也没用：没字幕的视频会被跳过（报告里会写"因无字幕跳过 N 条"）'
                  : (st.asrModelReady ? '环境和模型都好了' : '环境好了；模型会在第一次转写时自动下（几百 MB）'))),
            h('div', { 'data-bd-note': '' },
              '点一下就好：建一个独立环境、装 faster-whisper + yt-dlp，并把 Whisper 模型也下好',
              h('br'),
              '（模型默认 small，几百 MB，走国内镜像；装一次就够了）'),
            st.asrTail ? h('div', null,
              h('div', { 'data-bd-note': '' }, st.asrInstalling ? '正在装转写依赖（进度）：' : '转写依赖的日志（末尾）—— 只有「没字幕的视频」用得到它：'),
              h('pre', { 'data-bd-pre': '' }, st.asrTail)) : null) : null,
        ),

        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '顺手三连'),
          /* ⭐ 顺手三连（2026-10-19）：默认关。关着时下面全收起 —— 它不是"额度 0"，是根本没这功能 */
          h(ToggleRow, {
            label: '顺手三连（点赞 + 投币 + 收藏）',
            note: '默认关；开着之后只给「这一轮挑中、要发评论」的那几条三连，并受每天上限约束',
            on: sw('tripleOn'),
            onChange: (v) => patch({ tripleOn: v }, '顺手三连'),
          }),
          sw('tripleOn') ? h('div', { 'data-bd-sub': '' },
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每条投几枚币'),
                h('div', { 'data-bd-note': '' }, '硬币是钱；默认 1 枚')),
              h('select', {
                'data-bd-input': '', value: String(tripleCoin ?? '1'),
                onChange: (e) => { setTripleCoin(e.target.value); patch({ tripleCoin: Number(e.target.value) }, '投币数') },
              },
                h('option', { value: '1' }, '1 枚'),
                h('option', { value: '2' }, '2 枚'))),
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '每天最多三连几条'),
                h('div', { 'data-bd-note': '' }, '**独立配置**（不跟「每天挑几条」联动）；填 0 = 不三连')),
              h('input', {
                'data-bd-input': '', 'data-bd-num': '', type: 'number', min: 0, max: 50,
                value: triplePerDayDraft ?? '',
                onChange: (e) => setTriplePerDayDraft(e.target.value),
                onBlur: () => { const n = Math.max(0, Math.min(Number(triplePerDayDraft) || 0, 50)); setTriplePerDayDraft(String(n)); patch({ triplePerDay: n }, '每天三连上限') },
              })),
            h('div', { 'data-bd-row': '' },
              h('div', { 'data-bd-grow': '' },
                h('div', { 'data-bd-label': '' }, '收藏到哪个收藏夹'),
                h('div', { 'data-bd-note': '' },
                  favErr ? `拉收藏夹失败：${favErr}` : '选具体收藏夹会改走「点赞 + 投币 + 收藏」分步（官方三连只能进默认夹）')),
              h('select', {
                'data-bd-input': '', style: { maxWidth: '220px' },
                value: String(tripleFav ?? '0'),
                onChange: (e) => { setTripleFav(e.target.value); patch({ tripleFavMediaId: Number(e.target.value) }, '收藏夹') },
              },
                h('option', { value: '0' }, '默认收藏夹'),
                ...(favFolders || []).map((f) => h('option', { key: String(f.id), value: String(f.id) },
                  `${f.title}${f.private ? '（私密）' : ''} · ${f.count} 个`)))),
            h(ToggleRow, {
              label: '评论里说明「已三连」',
              note: '只在三连真的成功时才说；失败就一个字都不提',
              on: sw('tripleSay'),
              onChange: (v) => patch({ tripleSay: v }, '三连说明'),
            }),
            h('div', { 'data-bd-note': '' }, `今天已经三连 ${st.tripledToday ?? 0} 条`)) : null,
        ),


        /* ══ 环境 ══ */
        h('div', { 'data-bd-group': '' },
          h('div', { 'data-bd-group-h': '' }, '环境', h('span', { 'data-bd-group-sub': '' }, '用哪个模型、装在哪'))),

        /* ── 这一轮用哪个模型 ── */
        (() => {
          /* ⭐ 2026-10-19 加：给「刷B站那一轮」单独指定模型（只影响 headless 那一轮，不动你平时的对话模型）。
           *    实现：overlay 里覆盖 `agent-default-model`（见 index.js 的 ensureOverlay）。
           *    ⚠️ 模型列表来自宿主 llm 服务；拿不到就退回两个手填框，**不能因为列表拿不到就卡住**。 */
          const cur = modelDraft || ''
          const opts = []
          for (const p of (catalog?.providers || [])) {
            // ⭐ 宿主标了 usable:false 的通道（比如没配 Key 的 deepseek-official）后面挂个「缺 Key」
            const bad = p.usable === false
            for (const m of (p.models || [])) {
              opts.push({
                v: p.provider + '\u0000' + m.id,
                label: `${p.name || p.provider} · ${m.name || m.id}${bad ? '（缺 Key）' : ''}`,
              })
            }
          }
          const curProv = (catalog?.providers || []).find((p) => p.provider === (modelDraft || '').split('\u0000')[0])
          if (cur && !opts.some((o) => o.v === cur)) {
            const [p, m] = cur.split('\u0000')
            opts.unshift({ v: cur, label: `${p} / ${m}（当前）` })
          }
          const [curP, curM] = cur ? cur.split('\u0000') : ['', '']
          return h('div', { 'data-bd-sec': '' },
            h('div', { 'data-bd-h': '' }, '这一轮用哪个模型'),
            h('select', {
              'data-bd-input': '', value: cur,
              onChange: (e) => {
                const v = e.target.value
                setModelDraft(v)
                if (!v) patch({ modelProvider: '', modelName: '' }, '模型')
                else { const [p, m] = v.split('\u0000'); patch({ modelProvider: p, modelName: m }, '模型') }
              },
            },
              h('option', { value: '' }, '跟 profile 默认（不改）'),
              ...opts.map((o) => h('option', { key: o.v, value: o.v }, o.label))),
            curProv && curProv.usable === false
              ? h('div', { 'data-bd-msg': '', 'data-warn': '' }, curProv.note || '这个通道现在跑不了')
              : (curProv && curProv.note ? h('div', { 'data-bd-msg': '' }, curProv.note) : null),
            catalog === null ? h('div', { 'data-bd-note': '' }, '正在读宿主的模型列表…') : null,
            (catalog && !opts.length) ? h('div', { 'data-bd-note': '' }, '拿不到模型列表（宿主没报错误就手填）：') : null,
            h('div', { 'data-bd-label': '' }, '或者手填（provider / model）'),
            h('div', { 'data-bd-row': '' },
              h('input', {
                'data-bd-input': '', value: curP, placeholder: 'provider（如 deepseek-official）',
                onChange: (e) => setModelDraft(e.target.value + '\u0000' + curM),
                onBlur: () => { const p = String(curP || '').trim(); if (p) patch({ modelProvider: p, modelName: curM }, '模型'); else patch({ modelProvider: '', modelName: '' }, '模型') },
              }),
              h('input', {
                'data-bd-input': '', value: curM, placeholder: 'model（如 deepseek-flash）',
                onChange: (e) => setModelDraft(curP + '\u0000' + e.target.value),
                onBlur: () => { const m = String(curM || '').trim(); if (m) patch({ modelProvider: curP, modelName: m }, '模型'); else patch({ modelProvider: '', modelName: '' }, '模型') },
              })),
            h('div', { 'data-bd-note': '' },
              st.model ? `这一轮跑：${st.model.provider} / ${st.model.model}` : '这一轮跑：跟 profile 默认'),
            h('div', { 'data-bd-note': '' }, '⚠️ 只影响「刷B站那一轮」用的模型，不改你平时的对话模型；换贵的模型会把那一轮的成本抬上去。'),
            h('div', { 'data-bd-note': '' },
              '⭐ 桌面端的 provider（比如 qodercn）默认不在 headless 里 —— 插件会自动把本机对应的 provider 插件挂进那一轮，不用你装东西。'))
        })(),
        /* ── 环境与账号 ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '环境与账号'),
          h('div', { 'data-bd-row': '' },
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-label': '' }, 'dsh 路径（找不到 dsh 时才用）'),
              h('div', { 'data-bd-note': '' }, '桌面版一般能自动找到；实在找不到时，填 dsh 的 bin.js 或 dsh.cmd 绝对路径')),
            h('input', {
              'data-bd-input': '', value: dshBinDraft ?? '', placeholder: '留空 = 自动找',
              onChange: (e) => setDshBinDraft(e.target.value),
              onBlur: () => patch({ dshBin: String(dshBinDraft || '').trim() }, 'dsh 路径'),
            })),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'install', onClick: onInstall },
              st.venvReady ? '重装主依赖' : '装主依赖（建 venv）'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'check', onClick: onCheck }, '测一下'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'update', onClick: onCheckUpdate }, '检查更新'),
            newVer ? h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: busy === 'upgrade', onClick: onUpgrade }, '一键升级到 v' + newVer) : null,
            h('button', { 'data-bd-btn': '', disabled: busy === 'login', onClick: onLoginStart }, '扫码登录'),
            h('div', { 'data-bd-note': '' },
              !st.venvReady ? (st.installFailed ? '上次没装成 → 看下面日志' : '还没装 → 先点「装主依赖」')
                : (st.loggedIn ? '装好了 → 下一步「扫码登录」' : '环境好了 → 点「扫码登录」'))),
          loginState ? h('div', { 'data-bd-msg': '', 'data-good': loginTone === 'good' ? '' : undefined, 'data-warn': loginTone === 'warn' ? '' : undefined }, loginState) : null,
          st.installTail ? h('div', null,
            h('div', { 'data-bd-note': '' }, st.installing ? '正在装主依赖（进度）：' : '主依赖的日志（B站 搜索 / 字幕 / 评论 用得到，末尾）：'),
            h('pre', { 'data-bd-pre': '' }, st.installTail)) : null,
          login?.qr ? h('div', { 'data-bd-qr': '' },
            h('img', { src: login.qr, alt: 'B站登录二维码' }),
            h('div', { 'data-bd-note': '' },
              '手机 B站 → 我的 → 扫一扫。',
              h('br'),
              '确认时选「记住我 / 长期」那张 —— 选 24 小时的话，明天就得重扫。')) : null),
        /* ── 它是怎么干活的（给他看的） ── */
        h('div', { 'data-bd-sec': '' },
          h('div', { 'data-bd-h': '' }, '它的地盘'),
          h('div', { 'data-bd-kv': '' },
            `家目录：${st.home}`,
            h('br'),
            `今天的报告：${st.report}`),
          /* ⭐ 换「地盘」：默认目录写死在 $DSH_HOME 下，想挪到别的盘就填这里。
           * 只有点「应用」才动文件 —— 输入框边打字边搬家是灾难 ✗ */
          h('div', { 'data-bd-label': '' }, '换一个数据目录（它的"地盘"）'),
          h('input', {
            'data-bd-input': '', value: homeDraft ?? '',
            placeholder: st.defaultHome || 'D:\\bili-duty',
            onChange: (e) => { homeDirty.current = true; setHomeDraft(e.target.value) },
            onKeyDown: (e) => { if (e.key === 'Enter' && busy !== 'home') onApplyHome() },
          }),
          h('div', { 'data-bd-note': '' },
            '放登录凭证 / 报告 / 日志 / 判重表（venv 留在原地也能继续用）。填**绝对路径**（比如 D:\\bili-duty）。',
            h('br'),
            '⭐ 点「应用新目录」会把凭证、报告、日志、判重表**复制**到新家（老家不删）；',
            h('br'),
            '想连 venv 一起重建到新家，就再点一次「装主依赖」（几十秒，走国内镜像）。'),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: busy === 'home', onClick: onApplyHome }, '应用新目录'),
            h('button', { 'data-bd-btn': '', disabled: busy === 'home', onClick: onResetHome }, '恢复默认'),
            st.homeCustom ? h('span', { 'data-bd-badge': '' }, '当前：自定义') : h('span', { 'data-bd-badge': '' }, '当前：默认')),
          h('div', { 'data-bd-row': '' },
            h('button', { 'data-bd-btn': '', disabled: busy === 'report', onClick: onShowReport },
              report !== null ? '收起报告' : '看今天的报告'),
            h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('out') }, '打开报告文件夹'),
            h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('home') }, '打开家目录'),
            h('button', { 'data-bd-btn': '', onClick: () => copyText(st.report) }, '复制报告路径')),
          report !== null ? h('pre', { 'data-bd-pre': '' }, report) : null),
        )   /* ← 卡片区结束 */
        )   /* ← 滚动区结束 */
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-scroll: 页面样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        /* ⭐ 2026-10-19：从「设置」搬到**侧栏**（放在「记忆系统」下面）。
         * 形状抄官方插件（dsh-client-ui-plugin-manager）：
         *   ① 内容挂在主区：slots.register({ name:'main', key: PAGE_ID }, Page)
         *   ② 图标挂在侧栏：slots.register({ name:'sidebar.panellist', id: PAGE_ID, order, label }, Icon)
         *   ③ 点图标时宿主自己调 ctx.layout.selectPanel(id) —— 所以 ① 必须先注册好，否则它报
         *      `layout.selectPanel: main panel "…" is not registered`。
         * order：dsh-context=20、dsh-mnemon(记忆系统)=30 ⇒ 我们用 **40**，正好在它下面。
         */
        const PAGE_ID = 'bili-scroll'
        try {
          slots.inject('main', () => slots.inject('sidebar.panellist', () => {
            const stopPage = slots.register({ name: 'main', key: PAGE_ID }, () => h(Panel))
            let stopIcon
            try {
              stopIcon = slots.register(
                { name: 'sidebar.panellist', id: PAGE_ID, order: 40, label: () => '刷B站' },
                BiliIcon,
              )
            } catch (e) { stopIcon?.(); stopPage(); throw e }
            return () => { stopIcon?.(); stopPage() }
          }))
        } catch (e) {
          // ⭐ 老版本宿主没有侧栏插槽时，退回「设置」里那一页（至少还能调）
          try {
            slots.inject('settings.section', () => slots.register(
              { name: 'settings.section', id: PAGE_ID, order: 30, label: '刷B站' },
              () => h(Panel),
            ))
          } catch { /* 两边都不行就算了 */ }
        }
      },
    }
  },
})
