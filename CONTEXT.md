# web-bridge-mcp 项目上下文

> 供 AI 快速理解本项目的导读。详细用户文档见 `README.md`（英文）/ `README.zh-CN.md`（中文）。

## 一句话概括

MCP Server（单 Node 进程）：AI 编辑器通过 MCP 工具调用，间接在任意引入了 `client.js` 的静态网页上执行 JS、读控制台、模拟点击/输入。AI 与浏览器**互不直连**，一切经本进程中转。

## 核心架构（双接口中转模型）

```
AI 编辑器(MCP客户端) ←stdio 或 HTTP→ [server.js 中转进程] ←WebSocket→ 浏览器页面(client.js)
```

- **接口 B（MCP，面向 AI 编辑器）**：`--transport stdio`（默认，编辑器本地拉起）或 `http`（Streamable HTTP，端点 `/mcp`，可部署公网）。
- **接口 A（WebSocket + HTTP，面向浏览器页面）**：页面引入 `<script src=".../client.js">` 后长连到本进程。默认监听 `127.0.0.1:3210`。
- HTTP 传输为官方 **stateless** 模式：每个 POST 请求独立的 transport + McpServer 实例，共享同一个 hub，支持多编辑器并发接入。

## 文件地图

| 文件 | 职责 |
| --- | --- |
| `server.js` | 入口。解析 `--port/--host/--token/--transport/--admin/--data`（或环境变量 PORT/HOST/TOKEN/TRANSPORT/ADMIN_PASSWORD）；有 `--admin` 走分组模式，否则单实例模式；stdio 模式下监听 stdin 关闭退出 |
| `client.js` | 浏览器端零依赖脚本（IIFE）。WS 连接+自动重连(1s→2s→5s→10s)、pageId 存 sessionStorage、捕获 console/未捕获异常(500ms 节流批量上报)、执行 eval 并安全序列化结果回传。server 下发时会在文件头注入 `window.__WEB_BRIDGE__ = {wsUrl, token}` 配置 |
| `lib/registry.mjs` | **核心共用模块**：页面注册表（hello 校验/重复 pageId 顶替）、console 环形缓冲(每页 500 条，断连保留)、eval 路由与超时(默认 30s 上限 120s)、eval 调用历史(环形 200 条，管理后台审计用)。单实例与分组模式共用 |
| `lib/hub.mjs` | 单实例模式的 HTTP+WS 宿主：`/client.js` 下发(注入 wsUrl，支持 CORS 与 Chrome Local Network Access 预检)、`/` 状态页、`/mcp` 转发、WS upgrade、30s 心跳清死连接、按 `X-Forwarded-*` 推断对外 wss 地址（反代 TLS 终止场景） |
| `lib/mcp.mjs` | MCP 工具层。`createMcpServer(hub)` 注册 6 个工具（stdio/http 两模式共用）；`registerTools(hub)` 为 stdio 模式接 StdioServerTransport。hub 需要 `introScript` 字段（分组模式提供分组专属脚本地址） |
| `lib/mcp-http.mjs` | MCP Streamable HTTP 传输（stateless，`enableJsonResponse`）。token 鉴权支持三种：`Authorization: Bearer`、`X-Web-Bridge-MCP-Token` 头、`?token=` 查询参数；CORS 全开 |
| `lib/group-server.mjs` | 分组模式（`--transport http --admin <密码>`）：一个进程托管多组互相隔离的 registry。路由：`/admin`(管理后台)、`/admin/api/*`(wb_session cookie 会话鉴权)、`/g/<token>/{client.js,mcp,ws}`(分组专属入口，token 在路径中即鉴权)。分组持久化到 `data/groups.json`（含 token，已 gitignore） |
| `lib/admin/` | 管理后台前端（index.html + admin.css + admin.js，无框架无构建，启动时读入内存缓存；admin.js 内置 zh-CN/en/ja 三语言 i18n） |
| `test/run-tests.mjs` | Node e2e（`npm test`）：自实现极简 MCP stdio 客户端 + FakePage 模拟页面 + DOM shim，覆盖 5 个实例场景（默认/令牌/HTTP 传输/HTTP+令牌/分组模式） |
| `test/browser.spec.mjs` + `playwright.config.mjs` | Playwright 真实浏览器 e2e（`npm run test:browser`，需先 `npx playwright install chromium`）：真实 Chromium 加载 `test/test-page.html`，经真实 WS 验证 6 个工具 + 分组模式全流程。两个独立实例用专用端口 3399/3398，避免与 3210 冲突；workers=1 串行 |
| `mcp.json` | 编辑器配置模板（http/stdio/远程三种示例） |

## 6 个 MCP 工具（lib/mcp.mjs）

`list_pages`（列页面）、`eval_js`（执行任意 JS，支持 await/return，预置 `$`/`$$`）、`get_console`（读日志）、`click`、`type`、`get_text`（后三个都是生成 JS 代码走 eval 通道的预设，超时 10s）。

**pageId 规则**：省略且恰好单页时自动选中；0 页或多页时报错并附页面清单引导 AI 重试。pageId 必须完整输出（AI 要原样回传）。

## WebSocket 消息协议（JSON 文本帧）

| 方向 | type | 说明 |
| --- | --- | --- |
| page→server | `hello` | 连接后首包（含 pageId/url/title/ua/token?），5s 未收到则断开；错误 token → `error` + close(4003)；复制标签页致 pageId 重复 → 新连接顶替旧连接 |
| page→server | `page-info` | DOMContentLoaded/load/popstate/hashchange 及每 5s 轮询（SPA 兜底）更新 url/title |
| page→server | `console` | 节流批量上报 console 与未捕获异常 |
| page→server | `eval-result` | `reqId/ok/value?/error?/durationMs`；迟到的超时回包被忽略 |
| server→page | `welcome` / `eval` / `error` | hello 应答 / 下发代码 / 错误（如无效 token） |

eval 执行约定（client.js `compile`）：代码先按表达式包装 `async () => ( code )`，SyntaxError 则退回语句块 `async () => { code }`（可用 return）；结果经 `preview()` 安全序列化为字符串（Error→stack、DOM→outerHTML 摘录、循环引用标记、深度≤6、≤50k 字符）。

## 三种运行模式

1. **单实例 + stdio**（默认）：编辑器拉起进程，MCP 走 stdin/stdout，hub 起在 3210。
2. **单实例 + http**：`--transport http`，编辑器只配 URL（`/mcp`），适合公网部署；公网务必加 `--token` 并套 TLS 反代（caddy/nginx）。
3. **分组模式**：`--admin <密码>`（强制 http），多个项目/人各自拿到隔离的 `/g/<token>/mcp` 与 `/g/<token>/client.js`，管理后台可建组、复制配置、实时观察页面/console/AI 调用记录。

## 关键实现细节（改动时注意）

- server.js 中 hub 的 `mcpHttpHandler` 用闭包转发，因为 handler 需要 hub 实例化后才能创建（见 server.js 注释）。
- registry 的 `evalJs()` 所有回包路径（结果/超时/断连/关闭）都会 `finish()` 记入 eval 历史。
- WS 协议层心跳 ping/pong（30s）清死连接；client.js 断线自动重连。
- 反代场景：hub 与 group-server 各有一份相同的 `publicWsUrl()`，按 `X-Forwarded-Proto/Host` 生成正确的 ws/wss 地址注入 client.js。
- 分组模式下各分组独立 registry（页面池/console/eval 历史互不可见），分组删除时 `registry.close()` 断开该组所有页面。
- 管理后台登录失败延迟 300ms 拖慢暴力破解；会话仅存内存（重启失效），TTL 7 天。
- npm 包 `files` 只发布 `server.js client.js lib/ mcp.json`；Node ≥18；依赖仅 `ws`、`@modelcontextprotocol/sdk`、`zod`。

## 常用命令

```bash
npm install
npm start                # stdio 单实例（默认 3210）
npm run serve            # http 单实例
npm run serve:groups     # http + 分组模式（密码默认 123456，ADMIN_PASSWORD 可覆盖）
npm test                 # Node e2e 全量
npm run test:browser     # Playwright 真实浏览器 e2e
```
