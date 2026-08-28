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
| `client.js` | 浏览器端零依赖脚本（IIFE）。WS 连接+自动重连(1s→2s→5s→10s)、pageId 存 sessionStorage、捕获 console/未捕获异常(500ms 节流批量上报)、执行 eval 并安全序列化结果回传、右上角可拖拽连接状态气泡（绿=已连接/黄=连接中/红=已断开，位置记忆到 sessionStorage，SPA 清 body 后自动挂回）、双击气泡弹出「MCP 对本页的操作记录」对话框（每条操作的自然语言说明（AI 经 note 参数提供）+ 代码 + 成功/失败 + 耗时，sessionStorage 按页面加载分组，刷新隔开）。server 下发时会在文件头注入 `window.__WEB_BRIDGE__ = {wsUrl, token}` 配置。eval 预置快捷函数：`$`/`$$`（普通查询）、`$deep`/`$$deep`（递归穿入所有已打开 shadowRoot 的深度查询）、`$import`（以页面 URL 为 base 的动态 import——eval 经 `new Function` 跨域注入，裸写 `import('/x.js')` 的 base 不是页面地址） |
| `lib/registry.mjs` | **核心共用模块**：页面注册表（hello 校验/重复 pageId 顶替）、console 环形缓冲(每页 500 条，断连保留)、eval 路由与超时(默认 30s 上限 120s)、eval 调用历史(环形 200 条，管理后台审计用)。单实例与分组模式共用 |
| `lib/hub.mjs` | 单实例模式的 HTTP+WS 宿主：`/client.js` 下发(注入 wsUrl，支持 CORS 与 Chrome Local Network Access 预检)、`/` 状态页、`/mcp` 转发、WS upgrade、30s 心跳清死连接、按 `X-Forwarded-*` 推断对外 wss 地址（反代 TLS 终止场景） |
| `lib/mcp.mjs` | MCP 工具层。`createMcpServer(hub)` 注册 6 个工具（stdio/http 两模式共用）；`registerTools(hub)` 为 stdio 模式接 StdioServerTransport。hub 需要 `introScript` 字段（分组模式提供分组专属脚本地址） |
| `lib/mcp-http.mjs` | MCP Streamable HTTP 传输（stateless，`enableJsonResponse`）。token 鉴权支持三种：`Authorization: Bearer`、`X-Web-Bridge-MCP-Token` 头、`?token=` 查询参数；CORS 全开 |
| `lib/group-server.mjs` | 分组模式（`--transport http --admin <密码>`）：一个进程托管多组互相隔离的 registry。路由：`/admin`(管理后台)、`/admin/api/*`(wb_session cookie 会话鉴权)、`/g/<token>/{client.js,mcp,ws}`(分组专属入口，token 在路径中即鉴权)。分组持久化到 `data/groups.json`（含 token，已 gitignore） |
| `lib/admin/` | 管理后台前端（index.html + admin.css + admin.js，无框架无构建，启动时读入内存缓存；admin.js 内置 zh-CN/en/ja 三语言 i18n） |
| `test/run-tests.mjs` | Node e2e（`npm test`）：自实现极简 MCP stdio 客户端 + FakePage 模拟页面 + DOM shim，覆盖 5 个实例场景（默认/令牌/HTTP 传输/HTTP+令牌/分组模式） |
| `test/browser.spec.mjs` + `playwright.config.mjs` | Playwright 真实浏览器 e2e（`npm run test:browser`，需先 `npx playwright install chromium`）：真实 Chromium 加载 `test/test-page.html`，经真实 WS 验证 6 个工具 + 分组模式全流程。两个独立实例用专用端口 3399/3398，避免与 3210 冲突；workers=1 串行 |
| `static/` | 手动测试静态页（`npm run test-static` 用 http-server 起在 127.0.0.1:4321，`-c-1` 禁缓存）：`test-a.html` 交互验证（click/type/计数）、`test-b.html` 控制台与文本验证（多级别日志/未捕获异常/get_text）。均引入 `http://127.0.0.1:3210/client.js`，两页同开可验证 `list_pages` 多页选择 |
| `mcp.json` | 编辑器配置模板（http/stdio/远程三种示例） |
| `.agents/skills/web-bridge-mcp/SKILL.md` | 面向 AI 的使用 skill：6 个 MCP 工具的参数、标准工作流（list_pages → 操作 → get_console 验证）、eval_js 写法、note 参数、常见报错排查 |

## 6 个 MCP 工具（lib/mcp.mjs）

`list_pages`（列页面）、`eval_js`（执行任意 JS，支持 await/多语句，最后一句表达式自动 return，预置 `$`/`$$`/`$deep`/`$$deep`/`$import`）、`get_console`（读日志，支持 `since` 增量拉取）、`click`、`type`、`get_text`（后三个都是生成 JS 代码走 eval 通道的预设，超时 10s）。执行类工具（eval_js/click/type/get_text）均有可选 `note` 参数：AI 填写的自然语言操作说明，随 eval 消息下发给页面（页面气泡操作记录里加粗显示）；预设漏填时服务端回退为 `click #btn` 这类短标签。

**pageId 规则**：省略且恰好单页时自动选中；0 页或多页时报错并附页面清单引导 AI 重试。pageId 必须完整输出（AI 要原样回传）。

## WebSocket 消息协议（JSON 文本帧）

| 方向 | type | 说明 |
| --- | --- | --- |
| page→server | `hello` | 连接后首包（含 pageId/url/title/ua/token?），5s 未收到则断开；错误 token → `error` + close(4003)；复制标签页致 pageId 重复 → 新连接顶替旧连接 |
| page→server | `page-info` | DOMContentLoaded/load/popstate/hashchange 及每 5s 轮询（SPA 兜底）更新 url/title |
| page→server | `console` | 节流批量上报 console 与未捕获异常 |
| page→server | `eval-result` | `reqId/ok/value?/error?/durationMs`；迟到的超时回包被忽略 |
| server→page | `welcome` / `eval` / `error` | hello 应答 / 下发代码（可带 `note` 自然语言操作说明，页面用户可见）/ 错误（如无效 token） |

eval 执行约定（client.js `compile`）：三级包装——先按表达式 `async () => ( code )`；失败则语句块 `async () => { code }`，且若最后一句是表达式语句（尾部行不以 return/if/for/const 等开头的保守正则判断）自动补 `return`（转换后编译不过则退回原始语句块）；结果经 `preview()` 安全序列化为字符串（Error→stack、DOM→outerHTML 摘录、循环引用标记、深度≤6、≤50k 字符）。`get_console` 的 `since`（毫秒时间戳）在 registry 侧过滤，返回只含该时间之后的日志。

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
- 状态气泡的 connected 以收到服务端 `welcome` 为准（而非 WS onopen），token 错误被拒时不会短暂误绿；气泡用 Shadow DOM + CSSOM 内联样式实现，页面 CSS 无法侵入，禁内联 style 的严格 CSP 下也能显示。
- 双击气泡的操作记录：服务端对本页只有 eval 一个指令通道（click/type/get_text 等都生成 JS 走 eval），收到即记录、`eval-result` 回包按 reqId 回填 ok/耗时；eval 消息可带 `note`（AI 经工具 note 参数提供、mcp.mjs 预设漏填时回退 label），说明文字在对话框里作为加粗主行、代码降为次要小字。存 sessionStorage（key `__web_bridge_op_log__`，上限：最近 5 次加载 × 每次 100 条 × 单条代码截断 2000 字符）；脚本初始化 push 新分组后**立即落盘**，否则无操作的加载刷新后不会留下分组。双击用 pointerdown 手动判定（350ms 内两次按下），不依赖 click 兼容事件；对话框与气泡同套 Shadow DOM + CSSOM 隔离。

## 常用命令

```bash
npm install
npm start                # stdio 单实例（默认 3210）
npm run serve            # http 单实例
npm run serve:groups     # http + 分组模式（密码默认 123456，ADMIN_PASSWORD 可覆盖）
npm test                 # Node e2e 全量
npm run test:browser     # Playwright 真实浏览器 e2e
npm run test-static      # 静态测试页服务（http-server，127.0.0.1:4321，根目录 static/）
```

## 踩坑记录

- eval 里的动态 `import('/x.js')` 报 `Failed to resolve module specifier`：eval 代码经 `new Function` 在 client.js（由 127.0.0.1:3210 跨域注入）里编译，动态 import 的 base 不是页面地址而是 `about:blank`。已内置 `$import(path)`（内部 `import(new URL(s, location.href).href)`），代码里一律用它代替裸 `import`。
- Web Components 页面（如 ofa.js / senti-ui 项目）元素全在嵌套 shadow root 里，`$`/`$$` 只查 light DOM 会「明明在页面上却查不到」。用 `$deep`/`$$deep` 递归穿入所有已打开的 shadowRoot 查询。
- 语句块代码之前不会隐式返回最后一句表达式的值（返回 `undefined` 让 AI 误判执行失败）；现已改为最后一句是表达式语句时自动补 `return`（正则保守判断，转换编译失败退回原行为）。
- 直调 HTTP `/mcp` 接口做验证时：POST 必须带 `Accept: application/json, text/event-stream` 头（缺了返回 406）；从浏览器页面内 fetch 还会叠加跨域问题，建议从 Node 侧直调。多页面连接时 `eval_js` 必须显式传 `pageId`（省略仅恰好单页时自动选中）——残留的旧测试标签页同样算已连接页面，会让无 pageId 调用报错。
- 后台 `npm run test-static` 用 TaskStop 终止时，只杀了 npm 外壳，http-server 子进程可能存活并残留占用端口（下次启动 EADDRINUSE）；排查用 `lsof -nP -iTCP:<port> -sTCP:LISTEN`，确认是 http-server 后按 PID kill。
