// browser.spec.mjs — Playwright 真实浏览器链路测试
// 与 run-tests.mjs（Node 模拟页面）互补：这里用真实 Chromium 加载 test-page.html，
// 经真实 WebSocket 连到 web-bridge-mcp，再通过 MCP HTTP 接口调用 6 个工具做端到端验证。
// 最后一个用例覆盖分组模式：登录管理后台 → 建分组 → 复制专属配置 → 页面接入 → 人与 AI 共同观察。
// 运行：npm run test:browser（首次前执行 npx playwright install chromium）

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.WB_TEST_PORT) || 3399;
const GPORT = Number(process.env.WB_TEST_GPORT) || 3398;
const ADMIN_PW = "admin-test-pw";
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_BASE = `http://127.0.0.1:${GPORT}`;
const TEST_PAGE_URL = "file://" + path.join(path.dirname(fileURLToPath(import.meta.url)), "test-page.html");

/** MCP Streamable HTTP（stateless）工具调用，语义与 run-tests.mjs 的 McpClient.callTool 一致 */
async function callTool(name, args = {}, base = BASE) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = await res.json();
  if (data.error) return { isError: true, text: data.error.message };
  const contents = data.result?.content ?? [];
  const image = contents.find((c) => c.type === "image");
  return { isError: !!data.result?.isError, text: contents.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "", image };
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
async function openPage(browser, { html, title = "web-bridge-mcp 测试页" } = {}) {
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

test.describe.serial("web-bridge-mcp 真实浏览器链路", () => {
  test("页面经 client.js 注册到 hub，list_pages 可见", async ({ browser }) => {
    const { pageId } = await openPage(browser);
    expect(pageId).toBeTruthy();
    const r = await callTool("list_pages");
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("共 1 个页面");
    expect(r.text).toContain("web-bridge-mcp 测试页");
    expect(r.text).toContain("test-page.html");
  });

  test("eval_js 在真实页面执行：表达式 / 语句 / await / $ 预设 / 错误", async ({ browser }) => {
    await openPage(browser);
    expect((await callTool("eval_js", { code: "1 + 1" })).text).toContain("2");
    expect((await callTool("eval_js", { code: "let a = 40; return a + 2;" })).text).toContain("42");
    expect((await callTool("eval_js", { code: "await new Promise(r => setTimeout(() => r('async-ok'), 50))" })).text).toContain("async-ok");
    expect((await callTool("eval_js", { code: "document.title" })).text).toContain("web-bridge-mcp 测试页");
    expect((await callTool("eval_js", { code: '$("#count").textContent' })).text).toContain("0");
    const err = await callTool("eval_js", { code: "throw new Error('boom')" });
    expect(err.isError).toBe(true);
    expect(err.text).toContain("boom");
  });

  test("eval_js 语句块自动 return / $deep 穿 shadow / $import 以页面为 base", async ({ browser }) => {
    // 页面里造一个 shadow DOM 宿主，供 $deep 验证
    await openPage(browser, {
      html: `<!doctype html><html><head><title>深度查询页</title></head><body>
        <div id="host"></div>
        <script>
          document.getElementById("host").attachShadow({ mode: "open" })
            .innerHTML = '<button id="deep-btn">藏在 shadow 里</button>';
        </script>
      </body></html>`,
      title: "深度查询页",
    });
    // 多语句代码的最后一句表达式被自动 return（无需显式 return）
    expect((await callTool("eval_js", { code: "let x = 1;\n" +
      "// 注释行不算表达式\n" +
      "x + 41" })).text).toContain("42");
    // 语句块以 return/声明结尾时不误加 return，也不报错
    expect((await callTool("eval_js", { code: "let y = 2;\nreturn y * 21;" })).text).toContain("42");
    // $$ 查不到 shadow 里的元素，$deep / $$deep 能查到
    expect((await callTool("eval_js", { code: "$$('#deep-btn').length" })).text).toContain("0");
    expect((await callTool("eval_js", { code: "$deep('#deep-btn').textContent" })).text).toContain("藏在 shadow 里");
    expect((await callTool("eval_js", { code: "$$deep('#deep-btn').length" })).text).toContain("1");
    // $import 的 base 是页面地址而非跨域注入脚本：不存在模块报「找不到」，而非 base 解析失败
    const imp = await callTool("eval_js", { code: "await $import('/no-such-module.js').then(() => 'ok', e => e.message)" });
    expect(imp.text).not.toContain("Failed to resolve module specifier");
  });

  test("get_console since 增量拉取", async ({ browser }) => {
    await openPage(browser);
    await callTool("eval_js", { code: "console.log('before-since-entry')" });
    await expect.poll(async () => (await callTool("get_console", { limit: 500 })).text, {
      timeout: 5_000,
    }).toContain("before-since-entry"); // console 上报有 500ms 节流
    const full = await callTool("get_console", { limit: 500 });
    const tsMatch = full.text.match(/最新 ts: (\d+)/);
    expect(tsMatch).toBeTruthy();
    const since = Number(tsMatch[1]);
    await callTool("eval_js", { code: "console.log('after-since-entry')" });
    await expect.poll(async () => (await callTool("get_console", { since, limit: 500 })).text, {
      timeout: 5_000,
    }).toContain("after-since-entry");
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
    expect(h2.text).toContain("web-bridge-mcp 测试页");
  });

  test("深度选择器预设 / wait_for / hover / focus / scroll_to", async ({ browser }) => {
    await openPage(browser, {
      html: `<!doctype html><html><head><title>新工具页</title></head><body style="height:3000px">
        <div id="host"></div>
        <div id="late" style="display:none">迟到的元素</div>
        <input id="target-input" />
        <script>
          const root = document.getElementById("host").attachShadow({ mode: "open" });
          root.innerHTML = '<button id="deep-btn">藏在 shadow 里</button><input id="deep-input" />';
          root.getElementById("deep-btn").addEventListener("click", () => { document.title = "deep-clicked"; });
          setTimeout(() => { document.getElementById("late").style.display = "block"; }, 600);
        </script>
      </body></html>`,
      title: "新工具页",
    });
    // 深度选择器：click / type / get_text 在 light DOM 查不到时回退 $deep 穿 shadow
    const rc = await callTool("click", { selector: "#deep-btn" });
    expect(rc.isError).toBeFalsy();
    await expect.poll(async () => (await callTool("eval_js", { code: "document.title" })).text).toContain("deep-clicked");
    const rt = await callTool("type", { selector: "#deep-input", text: "shadow输入" });
    expect(rt.isError).toBeFalsy();
    const rv = await callTool("eval_js", { code: "$deep('#deep-input').value" });
    expect(rv.text).toContain("shadow输入");
    // 普通元素不受影响（先走 light DOM）
    expect((await callTool("get_text", { selector: "#late" })).text).toContain("迟到的元素");
    // 找不到元素仍报错
    const miss = await callTool("click", { selector: "#no-such-el" });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain("找不到元素");

    // wait_for：等元素出现（页面 600ms 后才显示 #late）
    const rw = await callTool("wait_for", { selector: "#late" });
    expect(rw.text).toContain("satisfied");
    // 等元素消失：#late 目前可见，先隐藏再等
    await callTool("eval_js", { code: "setTimeout(() => document.getElementById('late').remove(), 300)" });
    const rw2 = await callTool("wait_for", { selector: "#late", absent: true });
    expect(rw2.text).toContain("satisfied");
    // 谓词模式（支持 await）
    const rw3 = await callTool("wait_for", { code: "document.title === 'deep-clicked'" });
    expect(rw3.text).toContain("satisfied");
    // 超时报错
    const rto = await callTool("wait_for", { selector: "#never-appears", timeoutMs: 500 });
    expect(rto.isError).toBe(true);
    expect(rto.text).toContain("超时");
    // 参数校验：都没填 / 都填
    expect((await callTool("wait_for", {})).isError).toBe(true);
    expect((await callTool("wait_for", { selector: "#late", code: "true" })).isError).toBe(true);

    // hover：派发 mouseover/mouseenter（单行多语句 eval 同时回归验证自动 return 不吞语句）
    await callTool("eval_js", {
      code: "window.__hovered = 0; $deep('#deep-btn').addEventListener('mouseover', () => window.__hovered++)",
    });
    const rhov = await callTool("hover", { selector: "#deep-btn" });
    expect(rhov.isError, rhov.text).toBeFalsy();
    expect((await callTool("eval_js", { code: "window.__hovered" })).text).toContain("1");
    // focus：聚焦后 activeElement 生效
    const rf = await callTool("focus", { selector: "#target-input" });
    expect(rf.text).toContain("focused");
    const active = await callTool("eval_js", { code: "document.activeElement.id" });
    expect(active.text).toContain("target-input");
    // scroll_to：长页面底部元素滚入视口
    await callTool("eval_js", {
      code: "const b = document.createElement('div'); b.id = 'bottom-el'; b.style.marginTop = '2800px'; b.textContent = '页底'; document.body.appendChild(b)",
    });
    const rs = await callTool("scroll_to", { selector: "#bottom-el" });
    expect(rs.text).toContain("visible");
    expect(rs.text).not.toContain("false");
  });

  test("eval 预置 $wait / $frame / $rect / $css", async ({ browser }) => {
    await openPage(browser, {
      html: `<!doctype html><html><head><title>预置函数页</title></head><body>
        <div id="host"></div>
        <iframe id="frm" srcdoc="<button id='in-frame'>框内按钮</button><div id='fhost'></div><script>
          document.getElementById('fhost').attachShadow({mode:'open'}).innerHTML='<span id=fdeep>框内shadow</span>';
        <\/script>"></iframe>
        <div id="mover">样式目标</div>
        <script>
          const root = document.getElementById("host").attachShadow({ mode: "open" });
          root.innerHTML = '<p id="late-p">迟到</p>';
        </script>
      </body></html>`,
      title: "预置函数页",
    });
    // $wait：函数条件（等文本变化）；选择器条件只看元素是否存在，元素已在时立即返回
    await callTool("eval_js", { code: "setTimeout(() => { $deep('#late-p').textContent = '出现了'; }, 400)" });
    const rw = await callTool("eval_js", { code: "(await $wait(() => $deep('#late-p').textContent === '出现了')) ? 'wait-ok' : 'no'" });
    expect(rw.text).toContain("wait-ok");
    const rw2 = await callTool("eval_js", { code: "(await $wait(() => document.title === '预置函数页')) ? 'fn-ok' : 'no'" });
    expect(rw2.text).toContain("fn-ok");
    const rto = await callTool("eval_js", { code: "$wait('#never', 300)" });
    expect(rto.isError).toBe(true);
    expect(rto.text).toContain("超时");
    // $frame：同源 iframe 内查询（含穿其内部 shadow）
    expect((await callTool("eval_js", { code: "$frame('#frm').$('#in-frame').textContent" })).text).toContain("框内按钮");
    expect((await callTool("eval_js", { code: "$frame('#frm').$deep('#fdeep').textContent" })).text).toContain("框内shadow");
    // $frame 操作框内元素：点击后改框内文本
    await callTool("eval_js", {
      code: "const f = $frame('#frm'); f.$('#in-frame').addEventListener('click', () => { f.$('#in-frame').textContent = 'clicked-in-frame'; }); f.$('#in-frame').click(); f.$('#in-frame').textContent",
    });
    // $rect / $css
    const rr = await callTool("eval_js", { code: "JSON.stringify($rect($('#mover')))" });
    expect(rr.text).toContain('"visible":true');
    await callTool("eval_js", { code: "$css($('#mover'), { color: 'rgb(255, 0, 0)' }).id" });
    expect((await callTool("eval_js", { code: "getComputedStyle($('#mover')).color" })).text).toContain("rgb(255, 0, 0)");
  });

  test("预设返回值附带几何与状态（rect / disabled）", async ({ browser }) => {
    await openPage(browser, {
      html: `<!doctype html><html><head><title>返回值页</title></head><body>
        <button id="ok-btn">可点</button>
        <button id="dis-btn" disabled>禁用</button>
      </body></html>`,
      title: "返回值页",
    });
    const rc = await callTool("click", { selector: "#dis-btn" });
    expect(rc.text).toContain("disabled: true");
    expect(rc.text).toContain("rect: {");
    expect(rc.text).toContain("visible: true");
    const rt = await callTool("type", { selector: "input", text: "" });
    expect(rt.isError).toBe(true); // 页面无输入框，确认错误路径仍工作
    const rh = await callTool("hover", { selector: "#ok-btn" });
    expect(rh.text).toContain("rect: {");
    expect(rh.text).toContain("visible: true");
    const rs = await callTool("scroll_to", { selector: "#ok-btn" });
    expect(rs.text).toContain("rect: {");
    expect(rs.text).toContain("visible: true");
  });

  test("get_dom_snapshot 样式快照 / get_screenshot 真实截图", async ({ browser }) => {
    await openPage(browser, {
      html: `<!doctype html><html><head><title>快照页</title></head><body>
        <div id="host"></div>
        <div id="card" style="background-color: rgb(255, 0, 0); border: 2px solid black; padding: 4px">卡片 <span id="inner">内文</span></div>
        <script>
          document.getElementById("host").attachShadow({ mode: "open" })
            .innerHTML = '<div id="deep-card" style="color: rgb(0, 128, 0)">shadow卡片</div>';
        </script>
      </body></html>`,
      title: "快照页",
    });
    // 样式快照：computed style + 几何 + 文本，穿 shadow
    const rs = await callTool("get_dom_snapshot", { selector: "#card" });
    expect(rs.isError).toBeFalsy();
    expect(rs.text).toContain('div#card>');
    expect(rs.text).toContain("background-color=rgb(255, 0, 0)");
    expect(rs.text).toContain('<span#inner>');
    expect(rs.text).toContain('文本:"内文"');
    const rs2 = await callTool("get_dom_snapshot", { selector: "#deep-card" });
    expect(rs2.text).toContain("color=rgb(0, 128, 0)");
    // 找不到元素报错
    const miss = await callTool("get_dom_snapshot", { selector: "#nope" });
    expect(miss.isError).toBe(true);
    // 真实截图：无头环境无法弹授权框，stub getDisplayMedia 返回 canvas 画出的流，验证完整回传链路
    const rstub = await callTool("eval_js", {
      code: `const c = document.createElement('canvas'); c.width = 80; c.height = 40;
        const ctx = c.getContext('2d'); ctx.fillStyle = 'rgb(0, 0, 255)'; ctx.fillRect(0, 0, 80, 40);
        let dpErr = '';
        try { Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true }); } catch (e) { dpErr = e.name + ':' + e.message; }
        const dpAfter = typeof navigator.mediaDevices;
        navigator.mediaDevices.getDisplayMedia = () => Promise.resolve(c.captureStream(30));
        [dpErr, dpAfter, typeof navigator.mediaDevices.getDisplayMedia]`,
    });
    expect(rstub.isError, rstub.text).toBeFalsy();
    const shot = await callTool("get_screenshot", { timeoutMs: 10000 });
    expect(shot.isError, shot.text).toBeFalsy();
    // MCP image content：base64 PNG + 说明文本
    expect(shot.image).toBeTruthy();
    expect(shot.image.mimeType).toBe("image/png");
    expect(shot.image.data.length).toBeGreaterThan(100);
    expect(shot.text).toContain("截图");
    // 第二次调用复用已授权的 stream，无需再弹框
    const shot2 = await callTool("get_screenshot", { timeoutMs: 10000 });
    expect(shot2.isError, shot2.text).toBeFalsy();
    // 元素裁剪路径
    const shot3 = await callTool("get_screenshot", { selector: "#card", timeoutMs: 10000 });
    expect(shot3.isError, shot3.text).toBeFalsy();
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
    expect(ra.text).toContain("web-bridge-mcp 测试页");
  });

  test("管理后台：创建分组并接入专属页面（AI 与人共同观察）", async ({ browser }) => {
    const gname = `E2E分组-${Date.now() % 100000}`;

    // 1. 登录管理后台
    const ctx = await browser.newContext();
    openContexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`${ADMIN_BASE}/admin`);
    await page.fill("#pw", ADMIN_PW);
    await page.click("#login-btn");
    await expect(page.locator("#app-view")).toBeVisible();

    // 2. 创建分组并打开详情
    await page.fill("#group-name", gname);
    await page.click("#create-btn");
    const row = page.locator("#groups-table tbody tr", { hasText: gname });
    await expect(row).toBeVisible();
    await row.locator(".detail-btn").click();
    await expect(page.locator("#detail")).toBeVisible();

    // 3. 两段专属配置就绪（MCP JSON + 联动脚本，从脚本里取出分组 token）
    await expect(page.locator("#mcp-snippet")).toContainText("/g/");
    await expect(page.locator("#mcp-snippet")).toContainText("/mcp");
    const scriptText = await page.locator("#script-snippet").textContent();
    const token = scriptText.match(/\/g\/(wbg_[0-9a-f]+)\/client\.js/)?.[1];
    expect(token).toBeTruthy();

    // 4. 用该分组的专属脚本接入一个真实页面
    const pctx = await browser.newContext();
    openContexts.push(pctx);
    const p2 = await pctx.newPage();
    await p2.setContent(`<!doctype html><title>${gname}页面</title><h1>分组接入</h1>`);
    await p2.addScriptTag({ url: `${ADMIN_BASE}/g/${token}/client.js` });

    // 5. AI 视角：经该分组的 MCP 可见并可操控该页面（base 传分组根路径，callTool 会拼 /mcp）
    const gbase = `${ADMIN_BASE}/g/${token}`;
    await expect.poll(async () => (await callTool("list_pages", {}, gbase)).text).toContain(`${gname}页面`);
    const r = await callTool("eval_js", { code: "document.title" }, gbase);
    expect(r.text).toContain(`${gname}页面`);

    // 6. 人类视角：后台的在线页面表与 AI 调用记录同步出现
    await expect(page.locator("#pages-table")).toContainText(`${gname}页面`);
    await expect(page.locator("#evals-table")).toContainText("eval_js");

    // 7. 路由保持：进入详情后刷新页面，仍停在 #/group/<id> 详情视图（hash 路由 + 会话持久化）
    await expect(page.locator("#detail")).toBeVisible();
    const detailHash = new URL(page.url()).hash;
    expect(detailHash).toMatch(/^#\/group\//);
    await page.reload();
    await expect(page.locator("#detail")).toBeVisible();
    expect(new URL(page.url()).hash).toBe(detailHash);
    // 返回列表 → hash 回到 #/groups
    await page.click("#back-btn");
    await expect(page.locator("#groups-section")).toBeVisible();
    expect(new URL(page.url()).hash).toBe("#/groups");

    // 8. 清理本次创建的分组（复用浏览器里的登录会话）
    const gid = await row.locator(".detail-btn").getAttribute("data-id");
    await page.evaluate((id) => fetch(`/admin/api/groups/${id}`, { method: "DELETE" }), gid);
  });
});
