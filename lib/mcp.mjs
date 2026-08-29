// mcp.mjs — 接口 B：MCP stdio 工具层
// 把 hub 能力暴露为 6 个 MCP 工具；AI 编辑器只到这里，间接经 hub 的 WS 操纵浏览器页面

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { VERSION } from "./version.mjs";
import { mcpServerName } from "./name.mjs";

// SKILL.md 的仓库内位置：get_guide 工具每次调用现读，skill 更新即时生效（无需重启 server）
const SKILL_PATH = fileURLToPath(new URL("../.agents/skills/web-bridge-mcp/SKILL.md", import.meta.url));

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
    // 分组模式下 hub 带 name：server 自报名随分组名走（客户端如显示 serverInfo.name 能区分多个分组）
    name: hub.name ? mcpServerName(hub.name) : "web-bridge-mcp",
    version: VERSION,
    instructions:
      "在任意静态网页中引入 web-bridge-mcp 的 client.js 后，即可用这些工具在该页面里执行 JS、读取控制台、模拟点击/输入。" +
      `引入方式：${INTRO_SNIPPET(hub)}（hub 状态页：http://${hub.host}:${hub.port}/）。` +
      "eval_js 支持写语句块（多句代码），最后一句若是表达式会被自动 return，也可以显式 return。" +
      "代码里预置了快捷函数：$ / $$（querySelectorAll 系）、$deep / $$deep（递归穿入 shadow DOM 的深度查询，Web Components 页面用这个）、$import（以页面 URL 为 base 的动态 import，代码里直接写 import('/x.js') 的 base 不是页面地址）。" +
      "首次使用前可调用 get_guide 工具获取完整使用指南与踩坑经验（内容随指南文件更新，无需重启）。",
  });

  server.registerTool("get_guide", {
    title: "获取本工具完整使用指南",
    description:
      "返回 web-bridge-mcp 的完整使用指南（SKILL.md 全文，含标准工作流、eval_js 写法、预置函数、排错表与踩坑经验）。" +
      "首次使用本 MCP 的工具前建议先调用它；指南文件更新后无需重启，再次调用即读到最新版。",
    inputSchema: {},
  }, async () => {
    try {
      const text = await readFile(SKILL_PATH, "utf8");
      return { content: [{ type: "text", text }] };
    } catch {
      return { content: [{ type: "text", text: "指南文件缺失（安装包未包含 .agents/skills/ 或文件被移动）。核心用法见各工具的 description。" }] };
    }
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
      "支持 await 与多语句；最后一句表达式会被自动 return，也可显式 return。" +
      "预置 $ / $$（普通查询）、$deep / $$deep（穿 shadow DOM 深度查询）、$import（页面路径动态 import）、" +
      "$wait（轮询等条件，函数或选择器字符串，第二参为超时 ms）、$frame（同源 iframe 查询辅助，返回 {$,$$,$deep,$$deep,document,window}）、" +
      "$rect（元素几何+可见性）、$css（批量写样式）。",
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
    description:
      "读取页面最近的 console 输出与未捕获异常（client.js 会自动捕获上报）。" +
      "limit 为返回条数（默认 50）；传 since（毫秒时间戳）则只返回该时间之后的日志（增量拉取），" +
      "返回末尾会附上最新一条的 ts，可作为下次调用的 since 继续拉取，用于区分修改代码前后的日志。",
    inputSchema: {
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      limit: z.number().int().positive().max(500).optional().describe("返回最近多少条，默认 50"),
      since: z.number().int().positive().optional().describe("只返回该毫秒时间戳之后的日志（增量拉取，配合返回值末尾的 ts 使用）"),
    },
  }, async ({ pageId, limit, since }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const entries = hub.getConsole({ pageId: sel.pageId, limit, since });
    if (!entries.length) return { content: [{ type: "text", text: "（该页面暂无日志）" }] };
    const text = entries.map((e) => {
      const t = new Date(e.ts);
      const hh = String(t.getHours()).padStart(2, "0"), mm = String(t.getMinutes()).padStart(2, "0"), ss = String(t.getSeconds()).padStart(2, "0");
      return `[${hh}:${mm}:${ss}] [${e.level}] ${e.text}`;
    }).join("\n");
    const latest = entries[entries.length - 1].ts;
    return { content: [{ type: "text", text: `${since ? "增量" : "最近"} ${entries.length} 条（最新 ts: ${latest}，可作 since 继续增量拉取）：\n${text}` }] };
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
      const el = document.querySelector(${JSON.stringify(selector)}) || $deep(${JSON.stringify(selector)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: "center" });
      el.click();
      return { clicked: ${JSON.stringify(selector)}, tag: el.tagName, text: (el.innerText || "").slice(0, 100), rect: $rect(el), disabled: "disabled" in el ? el.disabled : undefined };
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
      const el = document.querySelector(${JSON.stringify(selector)}) || $deep(${JSON.stringify(selector)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(selector)});
      el.focus();
      if ("value" in el) el.value = ${JSON.stringify(text)};
      else el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { typed: ${JSON.stringify(text)}, tag: el.tagName, value: "value" in el ? el.value : undefined, rect: $rect(el) };
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
      const el = document.querySelector(${JSON.stringify(target)}) || $deep(${JSON.stringify(target)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(target)});
      return el.innerText;
    })()`;
    return toMcpResult(await runPreset(hub, sel.pageId, code, `get_text ${target}`, note));
  });

  server.registerTool("wait_for", {
    title: "等待页面条件成立",
    description:
      "在页面上轮询等待条件成立后再返回，避免 SPA 异步渲染导致「元素还没出来就操作」。" +
      "两种条件二选一：selector（元素出现；absent=true 时改为等待其消失）或 code（返回真值的 JS 表达式，支持 await）。" +
      "超时仍未满足则报错。轮询间隔 200ms。",
    inputSchema: {
      selector: z.string().optional().describe("要等待的 CSS 选择器（深度查询，穿 shadow DOM）；absent=true 时等待其消失"),
      absent: z.boolean().optional().describe("配合 selector：true 表示等待元素消失（默认 false 等待出现）"),
      code: z.string().optional().describe("与 selector 二选一：返回真值即认为条件成立的 JS 表达式（如 `fetch('/api').then(r=>r.data)`），支持 await"),
      timeoutMs: z.number().int().positive().max(120_000).optional().describe("超时毫秒数，默认 10000，上限 120000"),
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ selector, absent, code, timeoutMs, pageId, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    if (!selector && !code) return { content: [{ type: "text", text: "[error] selector 与 code 至少提供一个" }], isError: true };
    if (selector && code) return { content: [{ type: "text", text: "[error] selector 与 code 只能二选一" }], isError: true };
    const pollMs = 200, limit = timeoutMs || 10_000;
    const genCode = selector
      ? `(async () => {
      const t0 = Date.now();
      for (;;) {
        const found = document.querySelector(${JSON.stringify(selector)}) || $deep(${JSON.stringify(selector)});
        const ok = ${absent ? "!found" : "found"};
        if (ok) return { satisfied: true, elapsedMs: Date.now() - t0, found: ${absent ? "false" : "Boolean(found)"} };
        if (Date.now() - t0 > ${limit}) throw new Error("等待超时（" + ${JSON.stringify(absent ? "元素未消失: " : "元素未出现: ")} + ${JSON.stringify(selector)} + "，${limit}ms）");
        await new Promise(r => setTimeout(r, ${pollMs}));
      }
    })()`
      : `(async () => {
      const t0 = Date.now();
      for (;;) {
        let ok = false;
        try { ok = Boolean(await (${code})); } catch (e) { ok = false; } // 谓词抛错视为未成立，继续轮询
        if (ok) return { satisfied: true, elapsedMs: Date.now() - t0 };
        if (Date.now() - t0 > ${limit}) throw new Error("等待超时（谓词未成立，${limit}ms）: " + ${JSON.stringify(code.slice(0, 200))});
        await new Promise(r => setTimeout(r, ${pollMs}));
      }
    })()`;
    return toMcpResult(await runPreset(hub, sel.pageId, genCode, `wait_for ${selector || code.slice(0, 40)}`, note));
  });

  server.registerTool("hover", {
    title: "悬停页面元素",
    description: "通过 CSS 选择器找到元素并派发 mouseover / mouseenter（可触发菜单、tooltip 等悬停行为），会先 scrollIntoView。",
    inputSchema: {
      selector: z.string().describe("CSS 选择器"),
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ selector, pageId, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)}) || $deep(${JSON.stringify(selector)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      el.dispatchEvent(new MouseEvent("mouseover", opts));
      el.dispatchEvent(new MouseEvent("mouseenter", opts));
      return { hovered: ${JSON.stringify(selector)}, tag: el.tagName, rect: $rect(el) };
    })()`;
    return toMcpResult(await runPreset(hub, sel.pageId, code, `hover ${selector}`, note));
  });

  server.registerTool("focus", {
    title: "聚焦页面元素",
    description: "通过 CSS 选择器找到元素并聚焦（focus + focusin），适合输入前把焦点放到指定输入框。",
    inputSchema: {
      selector: z.string().describe("CSS 选择器"),
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ selector, pageId, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)}) || $deep(${JSON.stringify(selector)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: "center" });
      el.focus();
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      return { focused: ${JSON.stringify(selector)}, tag: el.tagName, activeElement: document.activeElement && document.activeElement.tagName };
    })()`;
    return toMcpResult(await runPreset(hub, sel.pageId, code, `focus ${selector}`, note));
  });

  server.registerTool("scroll_to", {
    title: "滚动到页面元素",
    description: "通过 CSS 选择器找到元素并滚动到可视区域中央（scrollIntoView），返回滚动后的位置信息。",
    inputSchema: {
      selector: z.string().describe("CSS 选择器"),
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ selector, pageId, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)}) || $deep(${JSON.stringify(selector)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: "center" });
      return new Promise(resolve => setTimeout(() => {
        resolve({ scrolledTo: ${JSON.stringify(selector)}, rect: $rect(el), scrollY: window.scrollY });
      }, 400));
    })()`;
    return toMcpResult(await runPreset(hub, sel.pageId, code, `scroll_to ${selector}`, note));
  });

  server.registerTool("get_dom_snapshot", {
    title: "获取 DOM 样式快照",
    description:
      "对指定元素的子树生成「虚拟截图」：每个可见节点一行，含几何（rect）、关键 computed style（颜色/背景/字号/边框/圆角/阴影/透明度/z-index/溢出）、文本，穿 shadow DOM。" +
      "纯文本、无需任何授权，是验证颜色、布局、定位的首选；需要真实渲染像素（canvas 内容、图片、遮挡观感）时再用 get_screenshot。",
    inputSchema: {
      selector: z.string().describe("CSS 选择器（深度查询，穿 shadow DOM），对其子树生成快照"),
      depth: z.number().int().positive().max(8).optional().describe("最大递归深度，默认 4，上限 8"),
      maxNodes: z.number().int().positive().max(300).optional().describe("最多输出的节点数，默认 60，上限 300"),
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ selector, depth, maxNodes, pageId, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)}) || $deep(${JSON.stringify(selector)});
      if (!el) throw new Error("找不到元素: " + ${JSON.stringify(selector)});
      return window.__wbSnapshot(el, { depth: ${depth || 4}, maxNodes: ${maxNodes || 60} });
    })()`;
    return toMcpResult(await runPreset(hub, sel.pageId, code, `get_dom_snapshot ${selector}`, note));
  });

  server.registerTool("get_screenshot", {
    title: "真实截图（需用户授权一次）",
    description:
      "通过浏览器屏幕捕获（getDisplayMedia）截取真实渲染像素并返回图片。" +
      "首次调用会在用户浏览器弹出原生授权框（预选当前标签页），用户授权一次后本次页面生命周期内免打扰；页面刷新后需重新授权。" +
      "传 selector 时按该元素矩形裁剪（深度查询，穿 shadow DOM）。" +
      "验证颜色/布局/定位请优先用 get_dom_snapshot（文本、免授权、精确到值）；本工具用于需要真实像素的场景（canvas、图片、遮挡观感）。",
    inputSchema: {
      selector: z.string().optional().describe("可选：只截取该元素（深度查询），不传则截整个视口"),
      pageId: z.string().optional().describe("目标页面 id（单页时可省略）"),
      timeoutMs: z.number().int().positive().max(120_000).optional().describe("超时毫秒数，默认 60000（首次调用要等用户在浏览器里点授权）"),
      note: z.string().optional().describe(NOTE_DESC),
    },
  }, async ({ selector, pageId, timeoutMs, note }) => {
    const sel = selectPage(hub, pageId);
    if (sel.error) return { content: [{ type: "text", text: `[error] ${sel.error}${sel.pages?.length ? "\n" + pagesText(sel.pages) : ""}` }], isError: true };
    const code = `(async () => window.__wbCapture(${selector ? `(document.querySelector(${JSON.stringify(selector)}) || $deep(${JSON.stringify(selector)}))` : "undefined"}))()`;
    const result = await hub.evalJs({
      pageId: sel.pageId, code, timeoutMs: timeoutMs || 60_000,
      label: `get_screenshot${selector ? ` ${selector}` : ""}`, note,
    });
    if (result.ok && result.shot) {
      return {
        content: [
          { type: "image", data: result.shot.base64, mimeType: "image/png" },
          { type: "text", text: `[ok] ${result.durationMs}ms | 截图 ${result.shot.w}x${result.shot.h}${selector ? `，已按 ${selector} 裁剪` : "（整个视口）"}` },
        ],
      };
    }
    return toMcpResult(result);
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
