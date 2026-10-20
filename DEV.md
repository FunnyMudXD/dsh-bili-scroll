# 开发工作区（dsh-bili-scroll 个人 fork）

这是这个插件的**开发仓库**。改完代码 → 自检 → 部署 → 重启 dsh。

```
dsh-bili-scroll/
├─ index.js            宿主半端（工具、定时器、HTTP、配置、overlay）
├─ client.js           浏览器半端（侧栏面板）
├─ lib/                小模块：state / mcp / login / qr / verify / replies / classify / interact / uvfetc
├─ prompts/duty.md     一轮要做的事（用户可以改；升级会被保留）
├─ vendor/bilibili-mcp 内置 Python MCP（B站接口都在这里）
├─ docs/CHANGES.md     相对上游改了什么（现象 → 根因 → 改法 → 验证）
└─ scripts/            开发脚本（deploy / selfcheck / push）
```

## 三条命令

```powershell
# ① 自检（离线，不联网、不碰 B站、不发评论）
node scripts/selfcheck.mjs

# ② 部署到桌面 profile（会先备份，然后**提醒你重启 dsh**）
node scripts/deploy.mjs

# ③ 推到 GitHub（走 REST API，不吃 git 通道）
node scripts/push.mjs "fix: 说明"
```

> `selfcheck.mjs` 默认测**本仓库**；想测装好的那份：
> `$env:PLUGIN_DIR="C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-bili-scroll"; node scripts/selfcheck.mjs`

## 改完之后的标准流程

1. `node --check index.js`（或 `client.js`）—— 语法
2. `node scripts/selfcheck.mjs` —— 110 项断言，全绿再往下
3. `node scripts/deploy.mjs` —— 铺到 profile
4. **重启 dsh**（宿主半端 + client bundle 都要重新组装；只刷页面没用）
5. 手动点一次「现在跑一轮」，看 `duty.log`

## 为什么不用 `git push`

这台机器上 `github.com` 的 git 通道被挡（TLS 重置），但 `api.github.com` 通。
`scripts/push.mjs` 用 Git Data API 建 blob/tree/commit，再 force 更新 `main`。
token 从 Windows 凭据管理器里的 GitHub 登录拿（`git credential fill`），也可以设 `GH_TOK`。

## 踩过的坑（改代码前先看）

| 坑 | 说明 |
|---|---|
| **BOM** | Windows PowerShell 5.1 的 `-Encoding UTF8` **会加 BOM**。`package.json` 一带 BOM，Volta / `node` 就报 `Could not parse project manifest`。用 Node 或 `-Encoding utf8NoBOM` 写 |
| **反引号** | PowerShell 双引号里 `` ` `` 是转义符（`` `f `` = 换页）。往 JS 里塞模板字符串请用编辑工具，别用 `-replace` |
| **面板要自己滚** | 宿主区是 `flex column + overflow:hidden` ⇒ 面板必须 `height:100%` + `overflow-y:auto` |
| **round 的工具来自 MCP** | 「跑一轮」那进程只拿到 MCP 白名单里的工具，**拿不到宿主的 dsh 工具**。要在轮里给模型用的能力，得做成 MCP 工具（或走 env 下发闸门） |
| **配置回弹** | DSH 0.2.x 写设置可能"不报错也不生效" ⇒ `config.json._set` 记面板存过的键，本地优先 |
| **投币风控** | B站 只对投币要人机验证（`-401 / verify_captcha`）。别连点：两次三连间隔 8~20 秒，命中就停手 3 小时 |
| **venv 不能搬** | Windows 的 venv 里钉着绝对路径；换数据目录后要重建 |

## 数据在哪

运行时数据**不在这个仓库**里，都在插件的家目录（默认 `%USERPROFILE%\.dsh\bili-duty`，本机改到了
`D:\AAA_Wrok\AiCoder\Harness\dsh_config\bili-duty`）：

```
config.json  seen.md  replied.jsonl  interacted.jsonl  state.json
duty.log  out/（日报）  bili_credential.json  headless-overlay.yml  .venv/
```
