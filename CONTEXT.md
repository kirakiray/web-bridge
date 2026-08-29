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
| `client.js` | 浏览器端零依赖脚本（IIFE）。WS 连接+自动重连(1s→2s→5s→10s)、pageId 存 sessionStorage、捕获 console/未捕获异常(500ms 节流批量上报)、执行 eval 并安全序列化结果回传、右上角可拖拽连接状态气泡（绿=已连接/黄=连接中/红=已断开，白色脉冲折线（activity）SVG 图标居中寓意实时桥接活动，位置记忆到 sessionStorage，SPA 清 body 后自动挂回）、双击气泡弹出「MCP 对本页的操作记录」对话框（每条操作的自然语言说明（AI 经 note 参数提供）+ 代码 + 成功/失败 + 耗时，sessionStorage 按页面加载分组，刷新隔开）。server 下发时会在文件头注入 `window.__WEB_BRIDGE__ = {wsUrl, token}` 配置。eval 预置快捷函数：`$`/`$$`（普通查询）、`$deep`/`$$deep`（递归穿入所有已打开 shadowRoot 的深度查询）、`$import`（以页面 URL 为 base 的动态 import——eval 经 `new Function` 跨域注入，裸写 `import('/x.js')` 的 base 不是页面地址）、`$wait`（轮询等条件：函数返回真值或选择器字符串存在，100ms 间隔默认 10s 超时）、`$frame`（同源 iframe 查询辅助，跨域抛可读错误）、`$rect`（元素几何+是否在视口内可见）、`$css`（批量写行内样式） |
| `lib/registry.mjs` | **核心共用模块**：页面注册表（hello 校验/重复 pageId 顶替）、console 环形缓冲(每页 500 条，断连保留)、eval 路由与超时(默认 30s 上限 120s)、eval 调用历史(环形 200 条，管理后台审计用)。单实例与分组模式共用 |
| `lib/hub.mjs` | 单实例模式的 HTTP+WS 宿主：`/client.js` 下发(注入 wsUrl，支持 CORS 与 Chrome Local Network Access 预检)、`/` 状态页、`/mcp` 转发、WS upgrade、30s 心跳清死连接、按 `X-Forwarded-*` 推断对外 wss 地址（反代 TLS 终止场景） |
| `lib/mcp.mjs` | MCP 工具层。`createMcpServer(hub)` 注册 13 个工具（stdio/http 两模式共用；`get_guide` 每次调用现读 SKILL.md，指南更新即时生效）；`registerTools(hub)` 为 stdio 模式接 StdioServerTransport。hub 需要 `introScript` 字段（分组模式提供分组专属脚本地址） |
| `lib/mcp-http.mjs` | MCP Streamable HTTP 传输（stateless，`enableJsonResponse`）。token 鉴权支持三种：`Authorization: Bearer`、`X-Web-Bridge-MCP-Token` 头、`?token=` 查询参数；CORS 全开 |
| `lib/group-server.mjs` | 分组模式（`--transport http --admin <密码>`）：一个进程托管多组互相隔离的 registry。路由：`/admin`(管理后台)、`/admin/api/*`(wb_session cookie 会话鉴权)、`/g/<token>/{client.js,mcp,ws}`(分组专属入口，token 在路径中即鉴权)。分组持久化到 `data/groups.json`（含 token，已 gitignore）；管理会话持久化到 `data/sessions.json`（同步写、登录/登出/过期清理时落盘、启动时加载并剔除过期条目）——服务器重启/更新后登录态保留，cookie 有效期即会话 TTL。加载后台静态资源时把 index.html 里的 `__VERSION__` 占位符替换为 package.json 版本号 |
| `lib/admin/` | 管理后台前端（index.html + admin.css + admin.js，无框架无构建，启动时读入内存缓存；admin.js 内置 zh-CN/en/ja 三语言 i18n）。**hash 应用路由**：`#/groups` 列表、`#/group/<id>` 详情，hashchange 驱动 `route()` 渲染；未登录时任何 hash 都渲染登录页，登录成功按当前 hash 恢复视图——刷新/直达不掉路由。详情页操作记录表 `detail-btn` → `navigate("#/group/<id>")`，返回 → `#/groups`。登录页与顶栏品牌处显示版本号（index.html 的 `__VERSION__` 占位符由 group-server 注入）。分组详情的 MCP 配置片段，server 名随分组名走：`web-bridge-mcp-<分组名slug>`（小写、非文字/数字压成 `-`、中日文等文字与数字保留；slug 为空回退 `web-bridge-mcp`），多分组接入同一编辑器时可在 mcpServers 里区分 |
| `lib/version.mjs` | 唯一版本来源：读 package.json 的 version，导出 `VERSION`。`lib/mcp.mjs`（MCP serverInfo）与 `lib/group-server.mjs`（后台版本注入）共用 |
| `lib/name.mjs` | 分组 → MCP server 命名规则（唯一服务端实现）：`web-bridge-mcp-<分组名slug>`（小写、非文字/数字压成 `-`、中日文等文字与数字保留，slug 空回退 `web-bridge-mcp`）。分组模式下 serverInfo 自报名随此规则；`lib/admin/admin.js` 前端有一份等价实现用于配置片段，改规则两处同步 |
| `test/run-tests.mjs` | Node e2e（`npm test`）：自实现极简 MCP stdio 客户端 + FakePage 模拟页面 + DOM shim，覆盖 5 个实例场景（默认/令牌/HTTP 传输/HTTP+令牌/分组模式） |
| `test/browser.spec.mjs` + `playwright.config.mjs` | Playwright 真实浏览器 e2e（`npm run test:browser`，需先 `npx playwright install chromium`）：真实 Chromium 加载 `test/test-page.html`，经真实 WS 验证全部工具（深度选择器预设 / wait_for / hover / focus / scroll_to 等）+ 分组模式全流程。两个独立实例用专用端口 3399/3398，避免与 3210 冲突；workers=1 串行 |
| `.github/workflows/ci.yml` | GitHub Actions CI：push / PR 到 main 时，Node 20 与 22 两个版本各跑一遍 `npm test`（Node e2e）+ `npm run test:browser`（Playwright，`npx playwright install --with-deps chromium` 装浏览器），失败时上传 test-results 产物 |
| `static/` | 手动测试静态页（`npm run test-static` 用 http-server 起在 127.0.0.1:4321，`-c-1` 禁缓存）：`test-a.html` 交互验证（click/type/计数）、`test-b.html` 控制台与文本验证（多级别日志/未捕获异常/get_text）。均引入 `http://127.0.0.1:3210/client.js`，两页同开可验证 `list_pages` 多页选择 |
| `mcp.json` | 编辑器配置模板（http/stdio/远程三种示例） |
| `.agents/skills/web-bridge-mcp/SKILL.md` | 面向 AI 的使用 skill：frontmatter 带 `version` 字段（与 package.json 同步）；7 个 MCP 工具的参数（`get_guide` 工具每次现读本文件下发，所以 skill 更新对所有 MCP 客户端即时可见，装不装 skill 都能拿到）、标准工作流（list_pages → 操作 → get_console 验证）、eval_js 写法、note 参数、常见报错排查 |
| `scripts/bump.mjs` | 升版脚本（`npm run bump [major\|minor\|patch\|x.y.z]`，默认 patch）：同步更新 package.json 与 SKILL.md frontmatter 的 version |

## 13 个 MCP 工具（lib/mcp.mjs）

`get_guide`（返回 SKILL.md 全文——完整使用指南与踩坑经验；每次调用现读文件、更新即时生效，AI 首次使用前可先调用）、`list_pages`（列页面）、`eval_js`（执行任意 JS，支持 await/多语句，最后一句表达式自动 return，预置 `$`/`$$`/`$deep`/`$$deep`/`$import`/`$wait`（轮询等条件，函数或选择器字符串，100ms 间隔默认 10s 超时）/`$frame`（同源 iframe 查询辅助，返回 `{$,$$,$deep,$$deep,document,window}`）/`$rect`（元素几何+可见性）/`$css`（批量写样式））、`get_console`（读日志，支持 `since` 增量拉取）、`click`、`type`、`get_text`、`wait_for`（轮询等待元素出现/消失或谓词成立，200ms 间隔，超时报错）、`hover`（派发 mouseover/mouseenter）、`focus`（focus+focusin）、`scroll_to`（scrollIntoView 后返回位置与可见性）、`get_dom_snapshot`（对元素子树生成文本样式快照：每可见节点一行几何+关键 computed style+文本，穿 shadow，client 端实现在 `window.__wbSnapshot`）、`get_screenshot`（getDisplayMedia 真实截图返回 MCP image content，首次调用需用户在浏览器授权一次（preferCurrentTab 预选当前标签页）、授权后 stream 存活期内免打扰、页面刷新失效，selector 可按元素矩形裁剪，client 端实现在 `window.__wbCapture`，截图走 eval-result 的专用 `shot` 字段回传不受 50k 序列化截断（server 端 registry 透传）；这些预设都生成 JS 代码走 eval 通道的预设，超时 10s；**所有预设 selector 均为深度选择器**：light DOM 查不到时回退 `$deep` 穿已打开 shadowRoot；click/type/hover/scroll_to 返回值自带 `rect` 几何与可见性、click 另带 `disabled`，AI 无需再 eval 一轮验证）。执行类工具均有可选 `note` 参数：AI 填写的自然语言操作说明，随 eval 消息下发给页面（页面气泡操作记录里加粗显示）；预设漏填时服务端回退为 `click #btn` 这类短标签。

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
- 管理后台登录失败延迟 300ms 拖慢暴力破解；会话 TTL 7 天，持久化到 `data/sessions.json`（已 gitignore）——重启/更新服务器后登录态保留。
- npm 包 `files` 发布 `server.js client.js lib/ mcp.json .agents/skills/`（SKILL.md 随包发布，npx 安装也能用 `get_guide`）；Node ≥20（engines 与 CI 矩阵 20/22 对齐）；依赖仅 `ws`、`@modelcontextprotocol/sdk`、`zod`。
- 状态气泡的 connected 以收到服务端 `welcome` 为准（而非 WS onopen），token 错误被拒时不会短暂误绿；气泡用 Shadow DOM + CSSOM 内联样式实现，页面 CSS 无法侵入，禁内联 style 的严格 CSP 下也能显示。
- 双击气泡的操作记录：服务端对本页只有 eval 一个指令通道（click/type/get_text 等都生成 JS 走 eval），收到即记录、`eval-result` 回包按 reqId 回填 ok/耗时；eval 消息可带 `note`（AI 经工具 note 参数提供、mcp.mjs 预设漏填时回退 label），说明文字在对话框里作为加粗主行、代码降为次要小字。存 sessionStorage（key `__web_bridge_op_log__`，上限：最近 5 次加载 × 每次 100 条 × 单条代码截断 2000 字符）；脚本初始化 push 新分组后**立即落盘**，否则无操作的加载刷新后不会留下分组。双击用 pointerdown 手动判定（350ms 内两次按下），不依赖 click 兼容事件；对话框与气泡同套 Shadow DOM + CSSOM 隔离。
- **踩坑：弹窗内部滚不动**。现象：双击气泡打开操作记录对话框后滚轮滚不动内容。根因有两层：① 部分页面（fullpage 整页滚动库、地图等）在 window/document 上用捕获阶段 `wheel` 监听并 `preventDefault` 劫持滚动，Shadow DOM 不隔离事件流，弹窗内部的滚动被页面吞掉——解法：client.js 的 `hookWheel()` 对对话框 body 和每条代码 `pre` 非被动接管 `wheel`/`touchmove`（触摸滚动手势不发 wheel，另走 touchmove 接管），可滚空间 >0 时 `preventDefault` + `stopPropagation` 并手动驱动 `scrollTop`（处理 deltaMode 行/页模式），无空间时放行给页面；滚轮落在标题栏/遮罩上时目标不在 body 内、原生滚动无处可去，panel 上另有 capture 转发监听（`composedPath` 判断避免与 body 的 hookWheel 重复滚动）。② **页面浏览器缓存旧版 client.js**：server 端文件已更新但页面普通刷新仍命中 HTTP 缓存，造成"明明改了还是不滚"的假象——排查时先 `fetch(client.js 的 URL, {cache:'no-store'})` 对比确认 server 版本，再用 CDP `Network.setCacheDisabled` 强刷验证。验证方式：Playwright 开真实浏览器访问接入页，`page.mouse.wheel` 真实滚轮实测（合成 `dispatchEvent` 的 WheelEvent 不能代表真实滚轮行为）。
- **踩坑：eval 单行多语句被自动 return 吞成死代码**。现象：`window.x = 0; el.addEventListener(...)` 这样的**单行**多语句 eval 报成功但监听没挂上（返回值是第一个语句的结果）。根因：client.js `compile()` 的语句块自动 return 变换对最后一**行**整体补 `return`，单行多语句时变成 `return 第一句; 后续语句`——编译通过但后续全部执行不到，且无任何报错。解法：同一行含 `;` 时只对最后一个 `;` 之后的语句补 return（`let a = 1; a + 2` 依然返回 2），补不出合法变换就放弃自动 return（宁可不返回值，不可吞语句）。AI 使用侧规避：多语句 eval 尽量换行写，最后一句独占一行。
- **踩坑：`video.play()` 的 promise 在部分环境永不 settle**。现象：无头/后台标签页里 `await video.play()` 永不 resolve 也不 reject，导致截图流程超时，但此时视频帧其实已可画（`videoWidth` 可用、`drawImage` 正常）。解法：`__wbCapture` 不裸 await play()——监听 `loadeddata` + 3s 超时兜底，之后以 `video.videoWidth || settings.width` 判定是否可用帧。另：非安全上下文（如 about:blank）`navigator.mediaDevices` 为 undefined（[SecureContext] 特性），`__wbCapture` 会抛可读错误引导改用样式快照；e2e 测试无头环境无法弹授权框，用 `canvas.captureStream(30)` stub `getDisplayMedia` 验证链路（必须传 30 帧率参数，默认按需出帧在无头下不产帧）。

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
