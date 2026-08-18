# web-bridge-mcp — 让 AI 编辑器操纵任意静态网页的 MCP 工具

**web-bridge-mcp** 是一个 MCP Server（Node 单进程，双接口），让 AI 编辑器在引入了 `client.js` 的静态网页上执行 JavaScript、读取控制台、模拟点击 / 输入。适用于跨浏览器、多标签页的本地联调，也支持部署到外网服务器。

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

AI 编辑器与浏览器**互不直连**：两条连接都终止于 MCP Server（`server.js`，即中转服务器），AI 通过工具调用间接操纵页面。

## 使用教程（三步）

无论本机还是外网服务器，用法都是同一套三步：**① 用 node 启动中转服务器 → ② 编辑器里配置它的 http/https 地址 → ③ 静态网页里塞入 `<script>` 脚本**。

### 第 1 步：用 node 启动 MCP 中转服务器

```bash
# npm 包：web-bridge-mcp —— 可直接 npx 运行；clone 本仓库的话先 npm install

# 本机使用（默认只监听 127.0.0.1）
npx web-bridge-mcp --transport http        # 仓库内等价于 npm run serve

# 部署到外网服务器（公网必须开令牌；建议 systemd / pm2 托管常驻）
npx web-bridge-mcp --transport http --host 0.0.0.0 --port 3210 --token <secret>
```

启动成功后有三个入口（以本机 3210 为例）：

| 入口 | 地址 | 给谁用 |
| --- | --- | --- |
| MCP 接入地址 | `http://127.0.0.1:3210/mcp` | 填进编辑器（第 2 步） |
| 页面脚本 | `http://127.0.0.1:3210/client.js` | 塞进网页（第 3 步） |
| 状态页 | `http://127.0.0.1:3210/` | 浏览器打开，查看已连接页面 |

命令行参数也可用环境变量 `PORT` / `HOST` / `TOKEN` / `TRANSPORT` 代替。

### 第 2 步：在编辑器中配置中转服务器的地址

**ZCode / Claude Code**（项目根 `.mcp.json`，或 `claude mcp add`）、**Cursor**（`.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "web-bridge-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3210/mcp"
    }
  }
}
```

部署在服务器上（开启令牌）时，url 换成对外地址并附带鉴权头：

```json
{
  "mcpServers": {
    "web-bridge-mcp": {
      "type": "http",
      "url": "https://your-domain.com/mcp",
      "headers": { "Authorization": "Bearer <secret>" }
    }
  }
}
```

> 注：Claude Desktop 不支持 http url 接入，只能用下文的 [stdio 模式](#另一种方式本地-stdio-模式编辑器代为启动服务器)。

### 第 3 步：在静态网页中塞入脚本

任意网页、任意端口均可（跨源已放行）：

```html
<script src="http://127.0.0.1:3210/client.js"></script>
```

服务器部署时脚本改为指向服务器（令牌模式必须带 `?token=`）：

```html
<script src="https://your-domain.com/client.js?token=<secret>"></script>
```

### 验证

对 AI 说："用 web-bridge-mcp 的 list_pages 看看连了哪些页面，然后 eval_js 帮我点一下 #btn、读一下控制台"。能列出你的页面，即三步全部打通。

> 引入顺序说明：页面先引入也没关系，client.js 会自动重连（1s→2s→5s→10s 退避），服务器启动后页面自动挂回。

## 另一种方式：本地 stdio 模式（编辑器代为启动服务器）

只在本地用、不想手动执行第 1 步的话，可以把 server.js 的路径直接配进编辑器：编辑器会自动把它作为子进程拉起，MCP 走进程的 stdin/stdout 管道（无需填 url），中转服务随之就绪；编辑器关闭时进程自动退出，不会残留。

```json
{
  "mcpServers": {
    "web-bridge-mcp": {
      "command": "npx",
      "args": ["-y", "web-bridge-mcp"],
      "env": { "PORT": "3210" }
    }
  }
}
```

（Cursor / Claude Desktop 同格式；clone 本仓库使用的话改为 `"command": "node", "args": ["/path/to/web-bridge/server.js"]`，配置模板见 [mcp.json](mcp.json)。）

两种模式怎么选：

| | HTTP 模式（上面的三步教程） | stdio 模式 |
| --- | --- | --- |
| 谁启动 server.js | 你手动启动，可常驻在服务器上 | 编辑器自动拉起 / 关闭时退出 |
| 编辑器配置项 | 只填 url | 填 command + args |
| 适用场景 | 服务器部署、多设备 / 多人共用、远程接入 | 本地即开即用；Claude Desktop 唯一可用的模式 |

两种模式下，浏览器页面侧的接法完全一致（都是第 3 步的 `<script>`）。

## 管理后台与分组（多项目 / 多人共用）

需要同时服务多个项目、或想让不同的人/编辑器拿到各自独立的接入点时，用**分组模式**启动：

```bash
npx web-bridge-mcp --transport http --port 3210 --admin <管理密码>

# 仓库内：npm run serve:groups（管理密码默认 123456，可用 ADMIN_PASSWORD 环境变量覆盖）
```

打开 `http://127.0.0.1:3210/admin`，用管理密码登录后即可：

- **创建分组**：每个分组自动生成专属密钥（token），并得到两段可直接复制的内容——
  - 编辑器用的 **MCP JSON**（url 指向该分组专属的 `/g/<token>/mcp`）
  - 网页用的 **联动 `<script>` 标签**（指向该分组专属的 `/g/<token>/client.js`）
- **人类观察窗口**（1.5s 自动刷新，让 AI 和人看到同一份现场）：
  - 在线页面列表（标题 / pageId / URL / 连接时间）
  - 任意页面的 console 输出流
  - **AI 调用记录**——AI 经 MCP 在分组页面里执行过的每条操作（工具、代码、耗时、结果），人可以逐条核对 AI 到底做了什么

分组之间完全隔离：A 分组的编辑器看不到、也操作不了 B 分组的页面。分组数据持久化在 `data/groups.json`（可用 `--data <路径>` 自定义；文件含 token，勿提交仓库，`data/` 已在 .gitignore）。

> 安全与限制：分组 token 等同于该分组的完整控制权（可在其页面执行任意 JS），请像密码一样保管；管理密码建议用 `openssl rand -hex 32` 生成；公网部署务必 TLS；分组模式下编辑器只支持 HTTP url 接入（stdio 不可用）。

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

## 公网部署要点

- **HTTPS 页面只能连 `https/wss`**（混合内容限制）。推荐用 nginx / caddy 等反向代理做 TLS 终止并转发到本服务；client.js 下发时会自动识别 `X-Forwarded-Proto` / `X-Forwarded-Host`，生成正确的 `wss://` 连接地址，无需额外配置。caddy 示例（自动签证书）：

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
