// browser.spec.mjs — Playwright 真实浏览器链路测试
// 与 run-tests.mjs（Node 模拟页面）互补：这里用真实 Chromium 加载 test-page.html，
// 经真实 WebSocket 连到 web-bridge，再通过 MCP HTTP 接口调用 6 个工具做端到端验证。
// 运行：npm run test:browser（首次前执行 npx playwright install chromium）

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.WB_TEST_PORT) || 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_PAGE_URL = "file://" + path.join(path.dirname(fileURLToPath(import.meta.url)), "test-page.html");

/** MCP Streamable HTTP（stateless）工具调用，语义与 run-tests.mjs 的 McpClient.callTool 一致 */
async function callTool(name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = await res.json();
  if (data.error) return { isError: true, text: data.error.message };
  return { isError: !!data.result?.isError, text: data.result?.content?.map((c) => c.text).join("\n") ?? "" };
}

/** 解析 list_pages 文本 → [{ pageId, title }] */
async function listPages() {
  const r = await callTool("list_pages");
  return [...r.text.matchAll(/^- (\S+) \| (.+?) \| \S+ \| 连接于/gm)].map((m) => ({ pageId: m[1], title: m[2] }));
}

const openContexts = [];
test.afterEach(async () => {
  for (const ctx of openContexts.splice(0)) await ctx.close().catch(() => {});
});

/**
 * 打开真实页面并接入 hub，等 hello 注册完成后返回 { context, page, pageId }。
 * - 默认加载 test-page.html；传 html 则用 setContent（多页用例需不同标题来区分 pageId）
 * - 屏蔽测试页里写死的 3210 端口脚本，避免连到编辑器经 mcp.json 拉起的实例
 */
async function openPage(browser, { html, title = "web-bridge 测试页" } = {}) {
  const context = await browser.newContext();
  openContexts.push(context);
  await context.route("http://127.0.0.1:3210/**", (route) => route.abort());
  const page = await context.newPage();
  if (html) await page.setContent(html);
  else await page.goto(TEST_PAGE_URL);
  await page.addScriptTag({ url: `${BASE}/client.js` });
  // hello 是页面加载 client.js 后异步发出的，轮询 hub 直到出现该页
  await expect.poll(async () => (await listPages()).some((p) => p.title === title), {
    timeout: 10_000,
  }).toBe(true);
  const entry = (await listPages()).find((p) => p.title === title);
  return { context, page, pageId: entry.pageId };
}

test.describe.serial("web-bridge 真实浏览器链路", () => {
  test("页面经 client.js 注册到 hub，list_pages 可见", async ({ browser }) => {
    const { pageId } = await openPage(browser);
    expect(pageId).toBeTruthy();
    const r = await callTool("list_pages");
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("共 1 个页面");
    expect(r.text).toContain("web-bridge 测试页");
    expect(r.text).toContain("test-page.html");
  });

  test("eval_js 在真实页面执行：表达式 / 语句 / await / $ 预设 / 错误", async ({ browser }) => {
    await openPage(browser);
    expect((await callTool("eval_js", { code: "1 + 1" })).text).toContain("2");
    expect((await callTool("eval_js", { code: "let a = 40; return a + 2;" })).text).toContain("42");
    expect((await callTool("eval_js", { code: "await new Promise(r => setTimeout(() => r('async-ok'), 50))" })).text).toContain("async-ok");
    expect((await callTool("eval_js", { code: "document.title" })).text).toContain("web-bridge 测试页");
    expect((await callTool("eval_js", { code: '$("#count").textContent' })).text).toContain("0");
    const err = await callTool("eval_js", { code: "throw new Error('boom')" });
    expect(err.isError).toBe(true);
    expect(err.text).toContain("boom");
  });

  test("click 触发真实 DOM 事件，get_console 读到页面日志", async ({ browser }) => {
    const { page } = await openPage(browser);
    const r1 = await callTool("click", { selector: "#btn" });
    expect(r1.text).toContain("#btn");
    // 页面自己的 click 监听器把计数 +1，证明事件真实派发
    await expect(page.locator("#count")).toHaveText("1");
    await callTool("click", { selector: "#btn" });
    await expect(page.locator("#count")).toHaveText("2");
    // console 上报有 500ms 节流，轮询直到读到
    await expect.poll(async () => (await callTool("get_console", { limit: 10 })).text, {
      timeout: 5_000,
    }).toContain("按钮被点击，当前计数: 2");
  });

  test("type 写入输入框并触发 input 事件", async ({ browser }) => {
    const { page } = await openPage(browser);
    const r = await callTool("type", { selector: "#name", text: "Playwright" });
    expect(r.text).toContain("Playwright");
    await expect(page.locator("#name")).toHaveValue("Playwright");
    // 页面自己的 input 监听器更新问候语，证明 input 事件真实派发
    await expect(page.locator("#greet")).toHaveText("你好，Playwright！");
  });

  test("get_text 读取页面文本", async ({ browser }) => {
    await openPage(browser);
    const body = await callTool("get_text", {});
    expect(body.text).toContain("点击次数");
    expect(body.text).toContain("点我 +1");
    const h2 = await callTool("get_text", { selector: "h2" });
    expect(h2.text).toContain("web-bridge 测试页");
  });

  test("多页 pageId 选择与断开清理", async ({ browser }) => {
    const a = await openPage(browser);
    const b = await openPage(browser, {
      html: "<!doctype html><html><head><title>第二页</title></head><body><h1>two</h1></body></html>",
      title: "第二页",
    });
    // 两页在线时不指定 pageId → 报错并列出两页
    const err = await callTool("eval_js", { code: "document.title" });
    expect(err.isError).toBe(true);
    expect(err.text).toContain("已连接多个页面");
    expect(err.text).toContain(a.pageId);
    expect(err.text).toContain(b.pageId);
    // 指定 pageId 后正常执行
    const rb = await callTool("eval_js", { code: "document.title", pageId: b.pageId });
    expect(rb.text).toContain("第二页");
    // 不存在的 pageId 报错
    const bad = await callTool("eval_js", { code: "1", pageId: "page-not-exist" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("page-not-exist");
    // 关闭第二页：hub 及时移除，随后恢复单页免 pageId 调用
    await b.context.close();
    await expect.poll(async () => (await listPages()).some((p) => p.pageId === b.pageId), {
      timeout: 5_000,
    }).toBe(false);
    const ra = await callTool("eval_js", { code: "document.title" });
    expect(ra.text).toContain("web-bridge 测试页");
  });
});
