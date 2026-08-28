---
name: "web-bridge-mcp"
description: "Guide to web-bridge-mcp MCP tools (list_pages, eval_js, get_console, click, type, get_text). Invoke when running JS in, reading console of, or clicking/typing on web pages that include client.js — i.e. whenever testing, debugging, inspecting or operating the connected browser pages."
---

# web-bridge-mcp 使用指南

web-bridge-mcp 是一个 MCP 中转服务（服务器已部署）。目标网页只要引入了它的 `client.js`（当前已有页面接入），AI 就能通过以下 6 个 MCP 工具在**用户真实浏览器页面**里执行 JS、读控制台、模拟点击/输入。页面右上角有连接状态气泡：绿 = 已连接。

## 工具总览

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `list_pages` | 列出所有已连接页面（pageId / 标题 / URL / 连接时间） | 无 |
| `eval_js` | 在页面执行任意 JS 并返回序列化结果 | `code`（必填）、`pageId`、`timeoutMs`（默认 30000，上限 120000）、`note` |
| `get_console` | 读页面最近的 console 输出与未捕获异常 | `pageId`、`limit`（默认 50，上限 500） |
| `click` | 按 CSS 选择器点击元素（先 scrollIntoView） | `selector`（必填）、`pageId`、`note` |
| `type` | 向输入框写入文本并派发 input / change 事件（兼容 contenteditable） | `selector`、`text`（必填）、`pageId`、`note` |
| `get_text` | 读元素 innerText，selector 省略时读整个 body | `selector`（可选，默认 body）、`pageId`、`note` |

## 标准工作流

1. 先调 `list_pages` 查看当前已连接的页面，拿到 pageId。
2. pageId 规则：
   - 恰好只有一个页面连接时可省略；
   - 0 页或多页时报错并附带页面清单，从清单选一个 pageId **完整原样回传**（不可截断、改写，截断会导致查找失败）。
3. 操作 → 验证：`click` / `type` 后用 `get_console` 看有无报错，用 `get_text` / `eval_js` 验证页面状态。
4. 复杂逻辑一律用 `eval_js`（click / type / get_text 本质也是生成 JS 走 eval 通道，预设固定 10s 超时）。

## eval_js 写法要点

- 代码先按表达式包装 `async () => ( code )`，最后一句是表达式则自动返回；有语法错误时退回语句块 `async () => { code }`，可用 `return`。
- 天然支持 `await`（如 `await fetch(...)`）。
- 预置 `$` / `$$`（= `document.querySelector` / `querySelectorAll`）。
- 返回值会被安全序列化为字符串：Error → stack、DOM 节点 → outerHTML 摘录、嵌套深度 ≤ 6、总长 ≤ 50k 字符。
- 工具返回格式：成功 `[ok] 42ms | 结果`；失败 `[error] 错误信息`（isError=true）。

示例：

```js
// 读取按钮状态
$('#submit-btn').disabled

// 查询所有列表项文本
[...$$('.item')].map(el => el.textContent.trim())

// 异步请求
await fetch('/api/status').then(r => r.json())
```

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
- 不要试图通过本工具去操作未接入 client.js 的页面。
