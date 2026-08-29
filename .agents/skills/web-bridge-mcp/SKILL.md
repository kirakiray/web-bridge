---
name: "web-bridge-mcp"
version: "1.0.3"
description: "Guide to web-bridge-mcp MCP tools (list_pages, eval_js, get_console, click, type, get_text, wait_for, hover, focus, scroll_to). Invoke when running JS in, reading console of, or clicking/typing on web pages that include client.js — i.e. whenever testing, debugging, inspecting or operating the connected browser pages."
---

# web-bridge-mcp 使用指南

web-bridge-mcp 是一个 MCP 中转服务（服务器已部署）。目标网页只要引入了它的 `client.js`（当前已有页面接入），AI 就能通过以下 13 个 MCP 工具在**用户真实浏览器页面**里执行 JS、读控制台、模拟点击/输入。页面右上角有连接状态气泡：绿 = 已连接。

> 本文件同时是 `get_guide` MCP 工具的下发内容（server 每次调用现读本文件），所以更新这里的经验后，任何 MCP 客户端无需安装 skill、无需重启 server 都能即时读到最新版。

## 工具总览

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `get_guide` | 返回本指南全文（现读文件，更新即时生效） | 无 |
| `list_pages` | 列出所有已连接页面（pageId / 标题 / URL / 连接时间） | 无 |
| `eval_js` | 在页面执行任意 JS 并返回序列化结果 | `code`（必填）、`pageId`、`timeoutMs`（默认 30000，上限 120000）、`note` |
| `get_console` | 读页面最近的 console 输出与未捕获异常 | `pageId`、`limit`（默认 50，上限 500）、`since`（毫秒时间戳，只返回该时间之后的日志，增量拉取） |
| `click` | 按 CSS 选择器点击元素（先 scrollIntoView） | `selector`（必填）、`pageId`、`note` |
| `type` | 向输入框写入文本并派发 input / change 事件（兼容 contenteditable） | `selector`、`text`（必填）、`pageId`、`note` |
| `get_text` | 读元素 innerText，selector 省略时读整个 body | `selector`（可选，默认 body）、`pageId`、`note` |
| `wait_for` | 轮询等待条件成立（SPA 异步渲染必备用） | `selector`（等元素出现，配 `absent: true` 等消失）或 `code`（返回真值的 JS 表达式，二选一）、`timeoutMs`（默认 10000）、`pageId`、`note` |
| `hover` | 悬停元素，派发 mouseover / mouseenter（触发菜单、tooltip） | `selector`（必填）、`pageId`、`note` |
| `focus` | 聚焦元素（focus + focusin） | `selector`（必填）、`pageId`、`note` |
| `scroll_to` | 滚动到元素（返回位置与是否可见） | `selector`（必填）、`pageId`、`note` |
| `get_dom_snapshot` | 对元素子树生成「虚拟截图」：每节点一行几何 + 关键 computed style + 文本，穿 shadow DOM，免授权 | `selector`（必填）、`depth`（默认4）、`maxNodes`（默认60）、`pageId`、`note` |
| `get_screenshot` | 真实截图返回 PNG 图片（getDisplayMedia 屏幕捕获） | `selector`（可选，按元素裁剪）、`timeoutMs`（默认 60000，首次要等用户授权）、`pageId`、`note` |

> 截图三层策略：验颜色/布局/定位用 `get_dom_snapshot`（文本、精确到值、免授权）；需要真实像素（canvas/图片/遮挡观感）用 `get_screenshot`——**首次调用用户浏览器会弹原生授权框，须提示用户选择"当前标签页"并授权**，一次授权页面存续期内免打扰，页面刷新后失效需重新授权。`get_screenshot` 失败（拒绝/不支持）时退回 `get_dom_snapshot`。

> click / type / get_text / wait_for / hover / focus / scroll_to 的 `selector` 均为**深度选择器**：light DOM 查不到时自动穿入所有已打开 shadowRoot（`$deep` 逻辑），Web Components 页面直接用即可。

## 标准工作流

1. 先调 `list_pages` 查看当前已连接的页面，拿到 pageId。
2. pageId 规则：
   - 恰好只有一个页面连接时可省略；
   - 0 页或多页时报错并附带页面清单，从清单选一个 pageId **完整原样回传**（不可截断、改写，截断会导致查找失败）。
3. 操作 → 验证：SPA 页面元素可能异步出现，操作前可 `wait_for {selector}`；`click` / `type` 后用 `get_console` 看有无报错，用 `get_text` / `eval_js` 验证页面状态。
4. 复杂逻辑一律用 `eval_js`（所有预设本质也是生成 JS 走 eval 通道，预设固定 10s 超时）。

## eval_js 写法要点

- 支持多语句代码，最后一句若是表达式会被**自动 return**（写 `let a = 1; a + 2` 也能拿到 2），也可以显式 `return`。
- 天然支持 `await`（如 `await fetch(...)`）。
- 预置快捷函数：
  - `$` / `$$`：`querySelector` / `querySelectorAll`（只查 light DOM）
  - `$deep` / `$$deep`：递归穿入所有已打开 shadowRoot 的深度查询。**Web Components 页面（ofa.js / senti-ui 等）元素在嵌套 shadow 里，一律用这两个**，`$`/`$$` 会查不到
  - `$import`：以页面 URL 为 base 的动态 `import`。**不要在代码里裸写 `import('/x.js')`**——eval 的 base 不是页面地址，会报 `Failed to resolve module specifier`
  - `$wait(cond, timeoutMs?)`：轮询等待条件成立（100ms 间隔，默认超时 10s）。`cond` 可以是**返回真值的函数**（如 `() => $deep('#btn') && $deep('#btn').offsetWidth > 0`）或**选择器字符串**（只看元素是否存在，穿 shadow）；成立返回 cond 的真值，超时抛错。SPA 异步渲染必备用
  - `$frame(selector)`：同源 iframe 内的查询辅助，返回 `{$, $$, $deep, $$deep, document, window}`；跨域 iframe 会抛可读错误
  - `$rect(el)`：返回 `{x, y, w, h, visible}`（取整几何 + 是否在视口内可见）
  - `$css(el, styles)`：批量写行内样式（CSSOM 属性名），返回 el
- click / type / get_text / wait_for / hover / focus / scroll_to 的 `selector` 都是**深度选择器**（light DOM 查不到自动穿 shadow），且 click/type/hover/scroll_to 的返回值自带 `rect`（几何+可见性）、click 还带 `disabled` 状态，无需再 eval 一轮判断。
- 返回值会被安全序列化为字符串：Error → stack、DOM 节点 → outerHTML 摘录、嵌套深度 ≤ 6、总长 ≤ 50k 字符。
- 工具返回格式：成功 `[ok] 42ms | 结果`；失败 `[error] 错误信息`（isError=true）。

示例：

```js
// 读取按钮状态
$('#submit-btn').disabled

// 穿 shadow DOM 深度查询（组件库页面常用）
$deep('st-button').textContent

// 动态 import 页面内的模块
const lv = await $import('/official-apps/cred-manager/lib/live-share.js')

// 等 SPA 异步渲染出按钮再操作
await $wait(() => $deep('st-button').textContent.includes('提交'))

// 操作同源 iframe 里的元素
$frame('#editor-iframe').$deep('textarea').value

// 异步请求
await fetch('/api/status').then(r => r.json())
```

## get_console 增量拉取

返回末尾带「最新 ts: <毫秒时间戳>」。需要区分「改代码前 vs 改代码后」的日志、或只看新产生的日志时：先读一次拿到 ts，之后每次调用把上次的 ts 传给 `since`，即只返回之后的日志。页面刷新会清空页面侧缓冲，断连后 server 侧缓冲仍保留。

## note 参数（建议始终填写）

执行类工具（eval_js / click / type / get_text）都有可选 `note`：自然语言操作说明，用户会在页面气泡的「操作记录」里看到（双击气泡可查看）。**始终用用户的语言填写**，如 `note: "点击提交按钮"`。漏填时服务端回退为 `click #btn` 这类短标签。

## 排错

| 现象 | 处理 |
| --- | --- |
| 「当前没有已连接的页面」 | 目标页面未引入 client.js 或已断开；让用户刷新页面后重试 |
| 「pageId 不存在或已断开」 | 页面已关闭；重新 `list_pages` 获取。注意：同一标签页刷新后 pageId 不变（存 sessionStorage），残留的旧标签页同样算已连接页面，会让无 pageId 的调用报「多个页面」错 |
| 「已连接多个页面，请指定 pageId」 | 从报错附带的清单中选择目标页面的 pageId 传入 |
| 执行超时（默认 30s） | 检查代码是否死循环 / 等待未完成；确需更久可传 `timeoutMs`（上限 120000） |
| 页面行为与预期不符 | 先 `get_console` 看报错与日志，再 `eval_js` 检查 DOM / 状态 |

## 注意

- 这是用户真实浏览器环境，不是无头浏览器：操作对用户可见（页面会滚动、气泡会记录）。不要执行破坏性操作（删除数据、跳转导致表单丢失等）。
- 修改了被页面对应仓库的代码后，要让改动生效需 `eval_js` 执行 `location.reload()` 刷新页面（用户开着多个联动页面时每个都要刷新）再验证，否则会在旧代码上误判。
- 不要试图通过本工具去操作未接入 client.js 的页面。
