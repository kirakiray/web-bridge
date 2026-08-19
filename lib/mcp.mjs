// mcp.mjs — 接口 B：MCP stdio 工具层
// 把 hub 能力暴露为 6 个 MCP 工具；AI 编辑器只到这里，间接经 hub 的 WS 操纵浏览器页面

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// 分组模式下由 group-server 提供 hub.introScript（该分组专属的脚本地址）
const INTRO_SNIPPET = (hub) =>
  hub.introScript || `<script src="http://${hub.host}:${hub.port}/client.js"></script>`;

/** pageId 省略时：单页自动选中；0 页/多页时返回错误并附页面清单，便于 AI 自行修正 */
function selectPage(hub, pageId) {
  const pages = hub.listPages();
  if (pageId) {
    const hit = pages.find((p) => p.pageId === pageId);
    if (hit) return { pageId: hit.pageId };
    return { error: `pageId 不存在或已断开: ${pageId}`, pages };
  }
  if (pages.length === 0) {
    return { error: `当前没有已连接的页面。请先在目标静态网页中加入 ${INTRO_SNIPPET(hub)} 并刷新，然后重试。`, pages };
  }
  if (pages.length === 1) return { pageId: pages[0].pageId };
  return { error: "已连接多个页面，请指定 pageId 后重试", pages };
}

function pagesText(pages) {
  // 完整输出 pageId（AI 需要原样回传给工具参数，截断会导致查找失败）
  return pages.map((p) =>
    `- ${p.pageId} | ${p.title || "(无标题)"} | ${p.url} | 连接于 ${new Date(p.connectedAt).toLocaleTimeString()}`
  ).join("\n");
}

/** hub.evalJs 结果 → MCP 工具返回值 */
function toMcpResult(result) {
  if (result.ok) {
    return {
      content: [{ type: "text", text: `[ok] ${result.durationMs != null ? `${result.durationMs}ms | ` : ""}${result.value ?? "(undefined)"}` }],
    };
  }
  return {
    content: [{ type: "text", text: `[error] ${result.error}` }],
    isError: true,
  };
}

function runPreset(hub, pageId, code, label, note) {
  return hub.evalJs({ pageId, code, timeoutMs: 10_000, label, note: note || label }); // 预设漏填 note 时回退到短标签，页面端始终有可读说明
}

/** note 参数的统一描述：AI 填写后页面用户能在气泡操作记录里看到自然语言说明 */
const NOTE_DESC = "操作说明：展示给页面用户的自然语言描述（用户会在页面气泡的操作记录里看到），用用户的语言填写，建议始终提供";

/** 创建一个注册好全部工具的 McpServer 实例（不连接传输；stdio 与 HTTP 两种模式共用） */
export function createMcpServer(hub) {
  const server = new McpServer({
    name: "web-bridge-mcp",
    version: "0.1.0",
    instructions:
      "在任意静态网页中引入 web-bridge-mcp 的 client.js 后，即可用这些工具在该页面里执行 JS、读取控制台、模拟点击/输入。" +
      `引入方式：${INTRO_SNIPPET(hub)}（hub 状态页：http://${hub.host}:${hub.port}/）。` +
      "eval_js 的 code 最后一句若是表达式会被自动返回；也可以写语句块并用 return。" +
      "代码里预置了 $ 与 $$（querySelector / querySelectorAll）快捷函数。",
  });

  server.registerTool("list_pages", {
    title: "列出已连接页面",
    description: "列出当前通过 client.js 连接到 web-bridge-mcp 的所有浏览器页面（pageId、标题、URL、连接时间）。",
    inputSchema: {},
  }, async () => {
    const pages = hub.listPages();
    const text = pages.length
      ? `共 ${pages.length} 个页面：\n${pagesText(pages)}`
      : `当前没有已连接的页面。请先在目标静态网页中加入 ${INTRO_SNIPPET(hub)} 并刷新。`;
    return { content: [{ type: "text", text }] };
  });

  server.registerTool("eval_js", {
    title: "在页面执行 JavaScript",
    description:
      "在指定页面（pageId 省略且只连了一页时自动选中）执行任意 JavaScript 并返回序列化结果。" +
      "支持 await；最后一句表达式会被返回，语句块可用 return。预置 $ / $$ 快捷查询函数。",
    inputSchema: {
      code: z.string().describe("要执行的 JS 代码"),
      pageId: z.string().optional().describe("目标页面 id（可从 list_pages 获取；单页时可省略）"),
      timeoutMs: z.number().int().positive().max(120_000).optional().describe("超时毫秒数，默认 30000，上限 120000"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ code, pageId, timeoutMs, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    return toMcpResult(await hub.evalJs({ pageId: sel.pageId, code, timeoutMs, label: "eval_js", note }));
  });

  server.registerTool("get_console", {
    title: "读取页面控制台日志",
    description: "读取页面最近的 console 输出与未捕获异常（client.js 会自动捕获上报）。limit 为返回条数，默认 50。",
    inputSchema: {
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      limit: z.number().int().positive().max(500).optional().describe("返回最近多少条，默认 50"),
    },
  }, async ({ pageId, limit }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const entries = hub.getConsole({ pageId: sel.pageId, limit });
    if (!entries.length) return { content: [{ type: "text", text: "（该页面暂无日志）" }] };
    const text = entries.map((e) => {
      const t = new Date(e.ts);
      const hh = String(t.getHours()).padStart(2, "0"), mm = String(t.getMinutes()).padStart(2, "0"), ss = String(t.getSeconds()).padStart(2, "0");
      return `[${hh}:${mm}:${ss}] [${e.level}] ${e.text}`;
    }).join("\n");
    return { content: [{ type: "text", text: `最近 ${entries.length} 条：\n${text}` }] };
  });

  server.registerTool("click", {
    title: "点击页面元素",
    description: "通过 CSS 选择器找到元素并触发 click()（会先 scrollIntoView）。找不到元素时返回错误。",
    inputSchema: {
      selector: z.string().describe("CSS 选择器"),
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ selector, pageId, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: "center" });
      el.click();
      return { clicked: ${JSON.stringify(selector)}, tag: el.tagName, text: (el.innerText || "").slice(0, 100) };
    })()`;
    return toMcpResult(await runPreset(hub, sel.pageId, code, `click ${selector}`, note));
  });

  server.registerTool("type", {
    title: "向输入框输入文本",
    description: "通过 CSS 选择器找到输入元素，聚焦并写入文本，随后派发 input / change 事件（兼容 contenteditable）。",
    inputSchema: {
      selector: z.string().describe("CSS 选择器"),
      text: z.string().describe("要输入的文本"),
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ selector, text, pageId, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(selector)});
      el.focus();
      if ("value" in el) el.value = ${JSON.stringify(text)};
      else el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { typed: ${JSON.stringify(text)}, tag: el.tagName };
    })()`;
    return toMcpResult(await runPreset(hub, sel.pageId, code, `type ${selector}`, note));
  });

  server.registerTool("get_text", {
    title: "读取页面文本",
    description: "读取匹配 CSS 选择器元素的 innerText；selector 省略时读取整个 body。",
    inputSchema: {
      selector: z.string().optional().describe("CSS 选择器，默认 body"),
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ selector, pageId, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const target = selector || "body";
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(target)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(target)});
      return el.innerText;
    })()`;
    return toMcpResult(await runPreset(hub, sel.pageId, code, `get_text ${target}`, note));
  });

  return server;
}

/** stdio 模式：AI 编辑器本地拉起进程时使用 */
export async function registerTools(hub) {
  const server = createMcpServer(hub);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
