// run-tests.mjs — web-bridge-mcp e2e 测试
// 覆盖：client.js 注入下发、页面注册、list_pages、eval_js（表达式/语句/async/错误/超时）、
//       get_console、click/type/get_text 预设、多页 pageId 选择、令牌模式、进程随 stdin 关闭退出、
//       分组模式（--admin 管理后台：登录/建组/专属入口/分组隔离/调用记录/删除）
// 运行：node test/run-tests.mjs（或 npm test）

import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { readFile as fsReadFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server.js");

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitForHttp(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url); if (res.ok || res.status === 403) return res; } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`HTTP 服务超时未就绪: ${url}`);
}

/** 极简 MCP stdio 客户端：一行一个 JSON-RPC 消息 */
class McpClient {
  constructor(child) {
    this.child = child;
    this.seq = 0;
    this.pending = new Map();
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* 忽略非 JSON 行 */ }
      }
    });
  }
  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, 15_000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }
  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "web-bridge-mcp-test", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }
  async callTool(name, args = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res.error) return { isError: true, text: res.error.message };
    return { isError: !!res.result?.isError, text: res.result?.content?.map((c) => c.text).join("\n") ?? "" };
  }
}

/** 模拟浏览器页面：实现 hello 与迷你版 eval 执行器（与 client.js 同构的表达式/语句回退 + await） */
class FakePage {
  constructor(port, pageId, { url = "http://test.local/page.html", title = "测试页", token = "", wsPath = "" } = {}) {
    this.pageId = pageId;
    this.evalMsgs = []; // 收到的 eval 下发消息（含 note 字段），供断言透传链路
    this.welcome = new Promise((resolve, reject) => {
      this._resolveWelcome = resolve;
      setTimeout(() => reject(new Error("未收到 welcome")), 5000);
    });
    this.welcome.catch(() => {}); // 未被 await 时（如超时竞赛）避免 unhandledRejection
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    this.ws.on("open", () => {
      this.ws.send(JSON.stringify({ type: "hello", role: "page", pageId, url, title, ua: "fake-page", token }));
    });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "welcome") this._resolveWelcome(msg.pageId);
      if (msg.type === "eval") { this.evalMsgs.push(msg); this.handleEval(msg); }
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  console(level, text) { this.send({ type: "console", level, text, ts: Date.now() }); }
  async handleEval(msg) {
    const started = Date.now();
    const res = { type: "eval-result", reqId: msg.reqId, durationMs: Date.now() - started };
    try {
      let fn;
      try { fn = new Function('"use strict"; return (async () => (\n' + msg.code + '\n))();'); }
      catch { fn = new Function('"use strict"; return (async () => {\n' + msg.code + '\n})();'); }
      const value = await fn();
      this.send({ ...res, ok: true, value: typeof value === "object" && value !== null ? JSON.stringify(value) : String(value) });
    } catch (e) {
      this.send({ ...res, ok: false, error: `${e.name}: ${e.message}` });
    }
  }
  close() { this.ws.close(); }
}

/** 给 click/type/get_text 等预设用的极简 DOM shim */
function installDomShim() {
  const el = {
    tagName: "BUTTON",
    innerText: "点我",
    value: "",
    scrollIntoView() {},
    click() { el.clicked = true; },
    focus() {},
    dispatchEvent() { return true; },
    getBoundingClientRect() { return { x: 1, y: 2, width: 30, height: 20, top: 2, bottom: 22, left: 1, right: 31 }; },
  };
  globalThis.document = { querySelector: (sel) => (sel === "#btn" || sel === "body" ? el : null) };
  globalThis.window = { innerHeight: 800, innerWidth: 600 };
  globalThis.Event = class Event { constructor(type) { this.type = type; } };
  // 预设生成代码引用的预置辅助（与 client.js PROLOGUE 对应的最小实现）
  globalThis.$rect = (e) => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth };
  };
  return el;
}

async function main() {
  console.log("web-bridge-mcp e2e 测试\n");

  // ---------- 实例 1：默认模式 ----------
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, "--port", String(port)], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.env.WB_DEBUG && console.error("[server]", d.toString().trim()));
  const mcp = new McpClient(child);

  console.log("— HTTP 下发 —");
  const clientJs = await waitForHttp(`http://127.0.0.1:${port}/client.js`);
  const clientSrc = await clientJs.text();
  check("client.js 可获取且注入了 wsUrl 配置", clientSrc.includes(`window.__WEB_BRIDGE__ = { wsUrl: "ws://127.0.0.1:${port}"`));
  check("client.js 允许跨源", clientJs.headers.get("access-control-allow-origin") === "*");

  console.log("— MCP 握手 —");
  const init = await mcp.initialize();
  check("initialize 返回 serverInfo", init.result?.serverInfo?.name === "web-bridge-mcp");

  console.log("— 页面注册与工具往返 —");
  const page = new FakePage(port, "page-aaaa-1111");
  await page.welcome;
  await sleep(100);

  const pages1 = await mcp.callTool("list_pages");
  check("list_pages 含已注册页面", pages1.text.includes("page-aaaa-1111") && pages1.text.includes("page.html"), pages1.text);

  const r1 = await mcp.callTool("eval_js", { code: "1 + 1" });
  check("eval_js 表达式求值", !r1.isError && r1.text.includes("2"), r1.text);

  const r2 = await mcp.callTool("eval_js", { code: "let a = 2; return a * 3;" });
  check("eval_js 语句块 + return", !r2.isError && r2.text.includes("6"), r2.text);

  const r3 = await mcp.callTool("eval_js", { code: "await new Promise(r => setTimeout(() => r('async-ok'), 30))" });
  check("eval_js 支持 await", !r3.isError && r3.text.includes("async-ok"), r3.text);

  const r4 = await mcp.callTool("eval_js", { code: "throw new Error('boom')" });
  check("eval_js 错误回传", r4.isError && r4.text.includes("boom"), r4.text);

  const r5 = await mcp.callTool("eval_js", { code: "await new Promise(() => {})", timeoutMs: 300 });
  check("eval_js 超时", r5.isError && r5.text.includes("超时"), r5.text);

  page.console("log", "hello from fake page");
  await sleep(100);
  const r6 = await mcp.callTool("get_console", {});
  check("get_console 读到日志", !r6.isError && r6.text.includes("hello from fake page"), r6.text);

  // since 增量拉取：带自定义 ts 的日志做 before/after 过滤
  const sinceTs = Date.now() - 1000;
  page.send({ type: "console", level: "log", text: "old-entry", ts: sinceTs });
  page.send({ type: "console", level: "error", text: "new-entry", ts: Date.now() + 5000 });
  await sleep(100);
  const r6a = await mcp.callTool("get_console", { since: Date.now() });
  check("get_console since 过滤旧日志", !r6a.isError && r6a.text.includes("new-entry") && !r6a.text.includes("old-entry"), r6a.text);
  check("get_console 返回最新 ts 供链式增量", /最新 ts: \d+/.test(r6a.text), r6a.text);
  const r6b = await mcp.callTool("get_console", { since: sinceTs - 1 }); // ts 严格大于 since 才保留
  check("get_console since 保留窗口内日志", !r6b.isError && r6b.text.includes("old-entry") && r6b.text.includes("new-entry"), r6b.text);

  console.log("— 高层操作预设（DOM shim） —");
  const el = installDomShim();
  const r7 = await mcp.callTool("click", { selector: "#btn" });
  check("click 预设", !r7.isError && r7.text.includes("#btn") && el.clicked === true, r7.text);
  const r8 = await mcp.callTool("type", { selector: "#btn", text: "你好" });
  check("type 预设", !r8.isError && el.value === "你好", r8.text);
  const r9 = await mcp.callTool("get_text", {});
  check("get_text 默认 body", !r9.isError && r9.text.includes("点我"), r9.text);

  console.log("— note 操作说明透传 —");
  const r9n = await mcp.callTool("eval_js", { code: "'with-note'", note: "测试操作说明" });
  check("eval_js 的 note 随 eval 消息下发到页面", !r9n.isError && page.evalMsgs.some((m) => m.note === "测试操作说明" && m.code.includes("with-note")), r9n.text);
  check("预设工具缺省 note 时回退短标签", page.evalMsgs.some((m) => m.note === "click #btn"));

  console.log("— 多页 pageId 选择 —");
  const page2 = new FakePage(port, "page-bbbb-2222", { url: "http://test.local/other.html", title: "第二页" });
  await page2.welcome;
  await sleep(100);
  const r10 = await mcp.callTool("eval_js", { code: "'which-page?'" });
  check("多页未指定 pageId 时报错并列出页面", r10.isError && r10.text.includes("page-aaaa-1111") && r10.text.includes("page-bbbb-2222"), r10.text);
  const r11 = await mcp.callTool("eval_js", { code: "'which-page?'", pageId: "page-bbbb-2222" });
  check("指定 pageId 后正常执行", !r11.isError && r11.text.includes("which-page?"), r11.text);
  const r12 = await mcp.callTool("eval_js", { code: "1", pageId: "page-not-exist" });
  check("不存在的 pageId 报错", r12.isError && r12.text.includes("不存在"), r12.text);

  console.log("— 进程生命周期 —");
  page.close();
  page2.close();
  await sleep(100);
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.stdin.end(); // 模拟编辑器关闭 stdio
  const exitCode = await Promise.race([exited, sleep(2000).then(() => "timeout")]);
  check("stdin 关闭后进程退出", exitCode !== "timeout", `exit=${exitCode}`);
  if (exitCode === "timeout") child.kill("SIGKILL");

  // ---------- 实例 2：令牌模式 ----------
  console.log("— 令牌模式 —");
  const port2 = await freePort();
  const child2 = spawn(process.execPath, [SERVER, "--port", String(port2), "--token", "s3cret"], { stdio: ["pipe", "pipe", "pipe"] });
  child2.stderr.on("data", (d) => process.env.WB_DEBUG && console.error("[server2]", d.toString().trim()));
  try {
    await waitForHttp(`http://127.0.0.1:${port2}/client.js`);
    const noToken = await fetch(`http://127.0.0.1:${port2}/client.js`);
    check("无令牌获取 client.js 被拒（403）", noToken.status === 403, `status=${noToken.status}`);
    const withToken = await fetch(`http://127.0.0.1:${port2}/client.js?token=s3cret`);
    const src2 = await withToken.text();
    check("带令牌获取 client.js 成功且注入 token", withToken.status === 200 && src2.includes('token: "s3cret"'), src2.slice(0, 80));

    const badPage = new FakePage(port2, "page-tok-bad", { token: "wrong" });
    const badMsg = await new Promise((resolve) => {
      badPage.ws.on("message", (d) => resolve(JSON.parse(d.toString())));
      badPage.ws.on("close", () => resolve({ type: "closed" }));
      setTimeout(() => resolve({ type: "timeout" }), 5000);
    });
    check("错误令牌的 WS hello 被拒", badMsg.type === "error" || badMsg.type === "closed", JSON.stringify(badMsg));

    const goodPage = new FakePage(port2, "page-tok-good", { token: "s3cret" });
    const okWelcome = await Promise.race([goodPage.welcome, sleep(3000).then(() => null)]);
    check("正确令牌的 WS hello 通过", okWelcome === "page-tok-good");
    goodPage.close();
  } finally {
    child2.kill("SIGKILL");
  }

  // ---------- 实例 3：HTTP 传输（远程部署模式） ----------
  console.log("— HTTP 传输（远程部署模式） —");
  const port3 = await freePort();
  const child3 = spawn(process.execPath, [SERVER, "--transport", "http", "--port", String(port3)], { stdio: ["pipe", "pipe", "pipe"] });
  child3.stderr.on("data", (d) => process.env.WB_DEBUG && console.error("[server3]", d.toString().trim()));
  try {
    await waitForHttp(`http://127.0.0.1:${port3}/client.js`);
    const page3 = new FakePage(port3, "page-http-1111", { url: "http://test.local/http.html", title: "HTTP 页" });
    await page3.welcome;
    await sleep(100);

    const httpCall = (body, headers = {}) =>
      fetch(`http://127.0.0.1:${port3}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(body),
      });

    const init3 = await httpCall({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    check("HTTP initialize", init3.status === 200 && (await init3.json()).result?.serverInfo?.name === "web-bridge-mcp");

    const eval3 = await httpCall({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "eval_js", arguments: { code: "6 * 7" } } });
    const eval3json = await eval3.json();
    check("HTTP eval_js 往返", eval3json.result?.content?.[0]?.text?.includes("42"), JSON.stringify(eval3json).slice(0, 120));

    const pages3 = await httpCall({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_pages", arguments: {} } });
    check("HTTP list_pages 含页面", (await pages3.json()).result?.content?.[0]?.text?.includes("page-http-1111"));

    const get3 = await fetch(`http://127.0.0.1:${port3}/mcp`);
    check("HTTP GET /mcp 返回 405（stateless）", get3.status === 405, `status=${get3.status}`);
    page3.close();
  } finally {
    child3.kill("SIGKILL");
  }

  // ---------- 实例 4：HTTP 传输 + 令牌 ----------
  console.log("— HTTP 传输 + 令牌 —");
  const port4 = await freePort();
  const child4 = spawn(process.execPath, [SERVER, "--transport", "http", "--port", String(port4), "--token", "tok-http"], { stdio: ["pipe", "pipe", "pipe"] });
  child4.stderr.on("data", (d) => process.env.WB_DEBUG && console.error("[server4]", d.toString().trim()));
  try {
    await waitForHttp(`http://127.0.0.1:${port4}/client.js`);
    const post = (headers) =>
      fetch(`http://127.0.0.1:${port4}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const noAuth = await post({});
    check("HTTP 无令牌调用被拒（401）", noAuth.status === 401, `status=${noAuth.status}`);
    const bearer = await post({ Authorization: "Bearer tok-http" });
    check("HTTP Bearer 令牌通过", bearer.status === 200);
    const custom = await post({ "X-Web-Bridge-MCP-Token": "tok-http" });
    check("HTTP X-Web-Bridge-MCP-Token 令牌通过", custom.status === 200);
    const wrong = await post({ Authorization: "Bearer wrong" });
    check("HTTP 错误令牌被拒（401）", wrong.status === 401, `status=${wrong.status}`);
  } finally {
    child4.kill("SIGKILL");
  }

  // ---------- 实例 5：分组模式（--admin 管理后台 + 多分组隔离） ----------
  console.log("— 分组模式（--admin） —");
  const port5 = await freePort();
  const dataFile5 = path.join(os.tmpdir(), `wb-groups-test-${port5}.json`);
  const child5 = spawn(process.execPath, [SERVER, "--transport", "http", "--admin", "admin-pw", "--data", dataFile5, "--port", String(port5)], { stdio: ["pipe", "pipe", "pipe"] });
  child5.stderr.on("data", (d) => process.env.WB_DEBUG && console.error("[server5]", d.toString().trim()));
  try {
    await waitForHttp(`http://127.0.0.1:${port5}/`);

    const api = (p, opt = {}) => fetch(`http://127.0.0.1:${port5}${p}`, opt);
    check("未登录访问管理 API 被拒（401）", (await api("/admin/api/groups")).status === 401);
    check("错误密码登录被拒（401）", (await api("/admin/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }),
    })).status === 401);

    const loginRes = await api("/admin/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "admin-pw" }),
    });
    const cookie5 = (loginRes.headers.getSetCookie()[0] || "").split(";")[0];
    check("正确密码登录成功并下发会话 cookie", loginRes.status === 200 && cookie5.startsWith("wb_session="));

    const auth = { "Content-Type": "application/json", Cookie: cookie5 };
    const mkGroup = async (name) => {
      const r = await api("/admin/api/groups", { method: "POST", headers: auth, body: JSON.stringify({ name }) });
      return (await r.json()).group;
    };
    const gA = await mkGroup("组A");
    const gB = await mkGroup("组B");
    check("创建分组并返回 wbg_ 前缀专属 token", gA?.token?.startsWith("wbg_") && gB?.token?.startsWith("wbg_"));

    const jsRes = await api(`/g/${gA.token}/client.js`);
    const jsSrc = await jsRes.text();
    check("分组专属 client.js 注入分组 ws 地址", jsRes.status === 200 && jsSrc.includes(`wsUrl: "ws://127.0.0.1:${port5}/g/${gA.token}/ws"`), jsSrc.slice(0, 80));
    check("未知 token 的分组入口 404", (await api("/g/wbg_notexist/client.js")).status === 404);

    const gp = new FakePage(port5, "page-group-1111", { url: "http://test.local/group.html", title: "分组页", wsPath: `/g/${gA.token}/ws` });
    check("页面经分组专属 ws 注册成功", (await Promise.race([gp.welcome, sleep(3000).then(() => null)])) === "page-group-1111");

    const groupCall = (token, name, args = {}) =>
      fetch(`http://127.0.0.1:${port5}/g/${token}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }).then((r) => r.json());
    const evA = await groupCall(gA.token, "eval_js", { code: "6 * 7" });
    check("分组 A 的 MCP eval 往返", evA.result?.content?.[0]?.text?.includes("42"), JSON.stringify(evA).slice(0, 120));
    const pagesA = await groupCall(gA.token, "list_pages");
    check("分组 A 可见本组页面", pagesA.result?.content?.[0]?.text?.includes("page-group-1111"));
    const pagesB = await groupCall(gB.token, "list_pages");
    check("分组 B 看不到 A 的页面（隔离）", pagesB.result?.content?.[0]?.text?.includes("没有已连接的页面"), pagesB.result?.content?.[0]?.text?.slice(0, 60));

    const evals5 = (await (await api(`/admin/api/groups/${gA.id}/evals`, { headers: { Cookie: cookie5 } })).json()).evals || [];
    const lastEval = evals5[evals5.length - 1];
    check("管理后台可见 AI 调用记录（工具名 + 结果）", lastEval?.tool === "eval_js" && lastEval?.ok === true && String(lastEval?.result).includes("42"), JSON.stringify(lastEval));

    await api(`/admin/api/groups/${gA.id}`, { method: "DELETE", headers: { Cookie: cookie5 } });
    check("删除分组后其专属入口失效（404）", (await api(`/g/${gA.token}/client.js`)).status === 404);

    const persisted = JSON.parse(await fsReadFile(dataFile5, "utf8"));
    check("分组数据持久化到磁盘（组 B 存留）", persisted.groups.some((g) => g.token === gB.token));

    gp.close();
  } finally {
    child5.kill("SIGKILL");
    await rm(dataFile5, { force: true });
  }

  // stdio + --admin 组合应拒绝启动
  {
    const bad = spawn(process.execPath, [SERVER, "--admin", "x", "--port", String(await freePort())], { stdio: ["pipe", "pipe", "pipe"] });
    const errText = await new Promise((resolve) => {
      let buf = "";
      bad.stderr.on("data", (d) => { buf += d.toString(); });
      bad.on("exit", (code) => resolve(`exit=${code} ${buf}`));
      setTimeout(() => resolve("timeout"), 3000);
    });
    check("stdio + --admin 组合拒绝启动", errText.includes("exit=1") && errText.includes("--transport http"), errText.slice(0, 80));
    bad.kill("SIGKILL");
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("测试运行异常:", err);
  process.exit(1);
});
