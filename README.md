# web-bridge — 让 AI 编辑器操纵任意静态网页的 MCP 工具

web-bridge 是一个 MCP Server（Node 单进程，双接口），让 AI 编辑器在引入了 `client.js` 的静态网页上执行 JavaScript、读取控制台、模拟点击 / 输入。适用于跨浏览器、多标签页的本地联调，也支持部署到外网服务器（`--transport http`，见下文"远程部署"）。

```
   AI 编辑器                ┌───────────────────┐              浏览器页面
┌──────────────┐           │    MCP Server     │           ┌──────────────────┐
│  MCP Client  │           │  （Node 单进程）    │           │ <script src=     │
│              │ stdio 或   │ · 接口B: MCP       │  WebSocket │  :3210/client.js">│
│  AI 只到这里  │◄─────────►│   (stdio / http)  │◄──────────►│  client.js       │
└──────────────┘  Streamable│ · 接口A: WebSocket │  接口A     │  （eval 执行/     │
      HTTP(远程)           │ · HTTP /client.js │            │   console 捕获）  │
                           └───────────────────┘            └──────────────────┘
```

AI 编辑器与浏览器**互不直连**：两条连接都终止于 MCP Server（`server.js`），AI 通过工具调用间接操纵页面。

## 快速开始

```bash
cd web-bridge
npm install          # 首次
```

1. **在静态网页中引入脚本**（任意网页、任意端口均可，跨源已放行）：

   ```html
   <script src="http://127.0.0.1:3210/client.js"></script>
   ```

2. **把 MCP 服务配置进 AI 编辑器**：把 [mcp.json](mcp.json) 里的 `<REPO>/server.js` 替换为本仓库的绝对路径，按下面对应编辑器的方式粘贴。编辑器拉起 `server.js` 的同时，WebSocket 服务（默认 `127.0.0.1:3210`）即就绪。

3. **对 AI 说**："用 web-bridge 的 list_pages 看看连了哪些页面，然后 eval_js 帮我点一下 #btn、读一下控制台"。

> 引入顺序说明：页面先引入也没关系，client.js 会自动重连（1s→2s→5s→10s 退避），编辑器启动后页面自动挂回。hub 状态页：http://127.0.0.1:3210/

## MCP 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `list_pages` | — | 列出已连接页面（pageId、标题、URL、连接时间） |
| `eval_js` | `code`，可选 `pageId` / `timeoutMs` | 在页面执行任意 JS 并返回序列化结果；支持 `await`；最后一句表达式自动返回，语句块可用 `return`；预置 `$` / `$$`（querySelector / querySelectorAll） |
| `get_console` | 可选 `pageId` / `limit` | 读取页面最近的 console 输出与未捕获异常 |
| `click` | `selector`，可选 `pageId` | 查找元素并触发 click()（先 scrollIntoView） |
| `type` | `selector` / `text`，可选 `pageId` | 聚焦、写入文本、派发 input / change 事件（兼容 contenteditable） |
| `get_text` | 可选 `selector`（默认 body）、`pageId` | 读取元素 innerText |

`pageId` 规则：只连了一个页面时可省略；连了多个页面而不指定时，工具会返回错误和页面清单，AI 会自行补上 `pageId` 重试。

## 各编辑器接入

以下示例都假设仓库绝对路径为 `/path/to/web-bridge`，请按需替换。

**ZCode / Claude Code**（项目根 `.mcp.json`，或 `claude mcp add`）：

```json
{
  "mcpServers": {
    "web-bridge": {
      "command": "node",
      "args": ["/path/to/web-bridge/server.js"],
      "env": { "PORT": "3210" }
    }
  }
}
```

**Cursor**（`.cursor/mcp.json`）：格式同上。

**Claude Desktop**（`claude_desktop_config.json`）：格式同上。

命令行参数：`node server.js --port 3210 --host 127.0.0.1 --token <secret>`（也可用环境变量 `PORT` / `HOST` / `TOKEN`）。

## 远程部署（外网服务器）

默认的 stdio 模式要求编辑器本地拉起进程；把 web-bridge 部署到外网服务器时，改用 HTTP 传输模式，编辑器**只需在 MCP 配置里填一个 url**：

**1. 在服务器上启动**（建议 systemd / pm2 托管，公网必须开令牌）：

```bash
node server.js --transport http --host 0.0.0.0 --port 3210 --token <secret>
```

**2. 编辑器配置**（Claude Code / Cursor / ZCode 等，在原配置位置粘贴）：

```json
{
  "mcpServers": {
    "web-bridge": {
      "type": "http",
      "url": "https://your-domain.com/mcp",
      "headers": { "Authorization": "Bearer <secret>" }
    }
  }
}
```

直连（无反代/TLS）时 url 填 `http://<服务器IP>:3210/mcp`。注：Claude Desktop 仅支持本地 stdio 模式，不支持远程 url。

**3. 页面侧脚本**改为指向服务器：

```html
<script src="https://your-domain.com/client.js?token=<secret>"></script>
```

说明：

- **HTTPS 页面**只能连 `https/wss`（混合内容限制）。推荐用 nginx / caddy 等反向代理做 TLS 终止并转发到本服务；client.js 下发时会自动识别 `X-Forwarded-Proto` / `X-Forwarded-Host`，生成正确的 `wss://` 连接地址，无需额外配置。caddy 示例（自动签证书）：

  ```
  your-domain.com {
    reverse_proxy 127.0.0.1:3210
  }
  ```

- `/mcp` 端点开启令牌后支持三种鉴权写法：`Authorization: Bearer <secret>`（推荐，编辑器配置里填 headers）、`X-Web-Bridge-Token: <secret>`、url 参数 `?token=`。
- HTTP 传输为官方 **Streamable HTTP** 协议（stateless 模式），每个请求独立处理、共享同一个 hub，多个编辑器可同时连接。
- 公网部署务必：设置 `--token`、用 TLS、防火墙只放行需要的端口。

## 安全说明

- 默认只监听 `127.0.0.1`。本机任何打开的网页（包括你浏览的第三方网站）都可以尝试连接本地端口——默认无令牌模式下，它们能收到 AI 发来的代码、也能伪造结果。
- 在不可信网络环境，或想让手机等局域网设备接入（`--host 0.0.0.0`）时，**务必开启 `--token`**：此时获取 client.js 需带 `?token=<secret>`，WebSocket 首包也会校验令牌。

## WebSocket 消息协议（内部参考）

浏览器与 MCP Server 之间的 WS 消息均为 JSON 文本帧，维护 `lib/hub.mjs` / `client.js` 时参考：

| 方向 | 消息 | 字段 | 说明 |
| --- | --- | --- | --- |
| 页面→服务端 | `hello` | `role:"page"`, `pageId`, `url`, `title`, `ua`, `token?` | 连接后首包；5 秒内未收到则断开；pageId 重复（复制标签页）时新连接替换旧连接 |
| 页面→服务端 | `page-info` | `url`, `title` | 连接后、DOMContentLoaded/load/popstate/hashchange 及每 5s 轮询上报（SPA 轮询兜底） |
| 页面→服务端 | `console` | `level`, `text`, `ts` | console 包装与未捕获异常捕获，500ms 节流批量上报；hub 按页环形缓冲 500 条（断连后保留） |
| 页面→服务端 | `eval-result` | `reqId`, `ok`, `value?`, `error?`, `durationMs` | 迟到的回包（已超时）被忽略 |
| 服务端→页面 | `welcome` | `pageId` | hello 校验通过 |
| 服务端→页面 | `eval` | `reqId`, `code`, `timeoutMs` | 待执行代码 |
| 服务端→页面 | `error` | `error` | 如令牌错误 |

eval 执行约定（client.js）：先按表达式包装 `async () => ( code )`，SyntaxError 时退回语句块（可用 `return`）；预置 `$` / `$$`；超时由 hub 侧计时（默认 30s，上限 120s）；结果安全序列化为字符串预览（Error→stack、DOM→outerHTML 摘要、循环引用标记、深度 ≤ 6、≤ 50k 字符）。

## 开发

- 测试：`npm test`（Node e2e：起进程 + 模拟页面 + stdio/HTTP 双传输调工具）；`npm run test:browser`（Playwright 真实浏览器链路：Chromium 加载 [test/test-page.html](test/test-page.html)，经真实 WebSocket 验证 6 个工具，首次前执行 `npx playwright install chromium`）。真实浏览器链路也可打开测试页手动验证。
- 依赖：`ws`（WebSocket）、`@modelcontextprotocol/sdk`（MCP）、`zod`（参数校验）；开发依赖 `@playwright/test`。Node ≥ 18。
