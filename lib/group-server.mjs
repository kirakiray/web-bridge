// group-server.mjs — 分组模式：一个进程托管多个互相隔离的分组 + 管理后台
// 启动：node server.js --transport http --admin <管理密码>
// 路由结构：
//   /admin                管理后台（登录后建分组、复制专属配置、观察页面 / console / AI 调用记录）
//   /admin/api/*          后台 API（wb_session cookie 会话鉴权）
//   /g/<token>/client.js  分组专属页面脚本（下发时注入 wsUrl → /g/<token>/ws，client.js 零改动）
//   /g/<token>/mcp        分组专属 MCP Streamable HTTP 端点（token 已在路径中即完成鉴权）
//   /g/<token>/ws         分组页面的 WebSocket
// 分组间完全隔离：各分组独立 registry（页面池 / console 缓冲 / eval 历史互不可见）
// 分组数据持久化在 data/groups.json（含 token，勿提交仓库、勿外泄）

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createRegistry } from "./registry.mjs";
import { createMcpHttpHandler } from "./mcp-http.mjs";

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const TOKEN_PREFIX = "wbg_";

function sha256(s) {
  return createHash("sha256").update(String(s)).digest();
}

// ---------- 管理后台单页（内嵌 vanilla JS/CSS，无构建、无外部依赖） ----------

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>web-bridge 管理后台</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 1020px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 22px; margin: 8px 0; } h2 { font-size: 18px; margin: 8px 0; } h3 { font-size: 15px; margin: 18px 0 6px; }
  button { cursor: pointer; padding: 6px 14px; }
  input, select { padding: 6px; font-size: 14px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 20px; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 14px; word-break: break-all; }
  th { background: #f5f5f5; white-space: nowrap; }
  pre { background: #f5f5f5; padding: 12px; overflow-x: auto; font-size: 13px; }
  .snip { display: flex; gap: 8px; align-items: flex-start; margin: 6px 0 16px; }
  .snip pre { flex: 1; margin: 0; }
  .row { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
  .muted { color: #888; font-size: 13px; }
  #console-view { min-height: 60px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; }
  #login-view { max-width: 360px; margin: 80px auto 0; }
  .err { color: #c33; min-height: 20px; font-size: 13px; }
</style>
</head>
<body>
<div id="login-view" hidden>
  <h1>web-bridge 管理后台</h1>
  <div class="row"><input id="pw" type="password" placeholder="管理密码" style="flex:1" /><button id="login-btn">登录</button></div>
  <div class="err" id="login-err"></div>
</div>
<div id="app-view" hidden>
  <div class="row" style="justify-content:space-between">
    <h1>web-bridge 管理后台</h1>
    <button id="logout-btn">退出登录</button>
  </div>
  <section id="groups-section">
    <div class="row"><input id="group-name" placeholder="新分组名称，如：商城项目 / 联调手机" style="flex:1" /><button id="create-btn">创建分组</button></div>
    <table id="groups-table"><thead><tr><th>分组</th><th>创建时间</th><th>在线页面</th><th>操作</th></tr></thead><tbody></tbody></table>
    <p class="muted">每个分组有专属密钥（token）：编辑器用它接入 MCP，网页用它引入联动脚本，分组间完全隔离。token 等同于该分组的完整控制权，请妥善保管。</p>
  </section>
  <section id="detail" hidden>
    <div class="row"><button id="back-btn">&larr; 返回</button><h2 id="detail-name"></h2></div>
    <h3>编辑器 MCP 配置（复制后粘进 ZCode / Claude Code / Cursor 的 mcp 配置）</h3>
    <div class="snip"><pre id="mcp-snippet"></pre><button id="copy-mcp">复制</button></div>
    <h3>网页联动脚本（塞进要观察 / 操控的静态页面）</h3>
    <div class="snip"><pre id="script-snippet"></pre><button id="copy-script">复制</button></div>
    <h3>在线页面（自动刷新）</h3>
    <table id="pages-table"><thead><tr><th>标题</th><th>pageId</th><th>URL</th><th>连接时间</th></tr></thead><tbody></tbody></table>
    <h3>页面控制台 <select id="console-page"></select></h3>
    <pre id="console-view"></pre>
    <h3>AI 调用记录（AI 经 MCP 在本分组页面里执行过的操作，最新在前）</h3>
    <table id="evals-table"><thead><tr><th>时间</th><th>工具</th><th>结果</th><th>耗时</th><th>代码</th><th>返回</th></tr></thead><tbody></tbody></table>
  </section>
</div>
<script>
(function () {
  "use strict";
  var state = { groups: [], detail: null, consolePage: "", timer: 0 };

  function $(id) { return document.getElementById(id); }
  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function timeStr(ts) { var t = new Date(ts); return p2(t.getHours()) + ":" + p2(t.getMinutes()) + ":" + p2(t.getSeconds()); }
  function cut(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error("未登录"); }
      return res.json().then(function (data) { return { status: res.status, data: data }; });
    });
  }

  function showLogin() {
    stopPoll();
    $("app-view").hidden = true; $("login-view").hidden = false;
    state.detail = null;
  }
  function enter() {
    $("login-view").hidden = true; $("app-view").hidden = false;
    $("groups-section").hidden = false; $("detail").hidden = true;
    state.detail = null;
    loadGroups();
    startPoll();
  }
  function startPoll() { stopPoll(); state.timer = setInterval(tick, 1500); }
  function stopPoll() { if (state.timer) { clearInterval(state.timer); state.timer = 0; } }
  function tick() { if (state.detail) refreshDetail(); else loadGroups(); }

  // ---------- 登录 ----------
  function doLogin() {
    api("POST", "/admin/api/login", { password: $("pw").value }).then(function (r) {
      if (r.status === 200) { $("login-err").textContent = ""; $("pw").value = ""; enter(); }
      else { $("login-err").textContent = "密码错误"; }
    }).catch(function () {});
  }
  $("login-btn").onclick = doLogin;
  $("pw").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
  $("logout-btn").onclick = function () { api("POST", "/admin/api/logout").catch(function () {}); showLogin(); };

  // ---------- 分组列表 ----------
  function loadGroups() {
    api("GET", "/admin/api/groups").then(function (r) {
      state.groups = r.data.groups || [];
      renderGroups();
    }).catch(function () {});
  }
  function renderGroups() {
    var tb = $("groups-table").tBodies[0];
    tb.innerHTML = "";
    state.groups.forEach(function (g) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(g.name) + "</td>" +
        "<td>" + esc(g.createdAt ? new Date(g.createdAt).toLocaleString() : "") + "</td>" +
        "<td>" + g.online + "</td>" +
        "<td><button class='detail-btn' data-id='" + esc(g.id) + "'>详情</button> " +
        "<button class='del-btn' data-id='" + esc(g.id) + "'>删除</button></td>";
      tb.appendChild(tr);
    });
    if (!state.groups.length) {
      var tr2 = document.createElement("tr");
      tr2.innerHTML = "<td colspan='4' class='muted'>还没有分组，先创建一个</td>";
      tb.appendChild(tr2);
    }
  }
  $("groups-table").addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    if (btn.classList.contains("detail-btn")) openDetail(id);
    if (btn.classList.contains("del-btn")) {
      var g = findGroup(id);
      if (g && confirm("删除分组「" + g.name + "」？其专属地址全部失效，已连接页面会被断开。")) {
        api("DELETE", "/admin/api/groups/" + id).then(loadGroups).catch(function () {});
      }
    }
  });
  function findGroup(id) {
    for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
    return null;
  }
  $("create-btn").onclick = function () {
    var name = $("group-name").value.trim();
    if (!name) return;
    api("POST", "/admin/api/groups", { name: name }).then(function (r) {
      if (r.status === 200) { $("group-name").value = ""; loadGroups(); }
    }).catch(function () {});
  };
  $("group-name").addEventListener("keydown", function (e) { if (e.key === "Enter") $("create-btn").click(); });

  // ---------- 分组详情（观察窗口） ----------
  function openDetail(id) {
    var g = findGroup(id);
    if (!g) return;
    state.detail = g;
    state.consolePage = "";
    $("groups-section").hidden = true;
    $("detail").hidden = false;
    $("detail-name").textContent = g.name;
    var origin = location.origin;
    $("mcp-snippet").textContent = JSON.stringify({
      mcpServers: { "web-bridge": { type: "http", url: origin + "/g/" + g.token + "/mcp" } }
    }, null, 2);
    $("script-snippet").textContent = '<script src="' + origin + "/g/" + g.token + '/client.js"><\\/script>';
    $("console-view").textContent = "（选择上方页面查看其 console 输出）";
    refreshDetail();
  }
  $("back-btn").onclick = function () {
    state.detail = null;
    $("detail").hidden = true;
    $("groups-section").hidden = false;
    loadGroups();
  };

  function refreshDetail() {
    var g = state.detail;
    if (!g) return;
    api("GET", "/admin/api/groups/" + g.id + "/pages").then(function (r) {
      renderPages(r.data.pages || []);
    }).catch(function () {});
    api("GET", "/admin/api/groups/" + g.id + "/evals?limit=50").then(function (r) {
      renderEvals(r.data.evals || []);
    }).catch(function () {});
    if (state.consolePage) {
      api("GET", "/admin/api/groups/" + g.id + "/console?pageId=" + encodeURIComponent(state.consolePage) + "&limit=50").then(function (r) {
        renderConsole(r.data.entries || []);
      }).catch(function () {});
    }
  }

  function renderPages(list) {
    var tb = $("pages-table").tBodies[0];
    tb.innerHTML = "";
    list.forEach(function (pg) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(pg.title || "(无标题)") + "</td>" +
        "<td><code>" + esc(pg.pageId.slice(0, 8)) + "</code></td>" +
        "<td>" + esc(pg.url) + "</td>" +
        "<td>" + esc(new Date(pg.connectedAt).toLocaleTimeString()) + "</td>";
      tb.appendChild(tr);
    });
    if (!list.length) {
      var tr2 = document.createElement("tr");
      tr2.innerHTML = "<td colspan='4' class='muted'>暂无页面连接——把上面的联动脚本塞进网页并打开它</td>";
      tb.appendChild(tr2);
    }
    var sel = $("console-page");
    var prev = state.consolePage;
    sel.innerHTML = "";
    var def = document.createElement("option");
    def.value = ""; def.textContent = "（选择页面）";
    sel.appendChild(def);
    list.forEach(function (pg) {
      var o = document.createElement("option");
      o.value = pg.pageId;
      o.textContent = cut(pg.title || "(无标题)", 20) + " · " + pg.pageId.slice(0, 8);
      if (pg.pageId === prev) o.selected = true;
      sel.appendChild(o);
    });
    var still = list.some(function (pg) { return pg.pageId === prev; });
    state.consolePage = still ? prev : "";
    if (!still) $("console-view").textContent = list.length ? "（选择上方页面查看其 console 输出）" : "暂无页面连接";
  }
  $("console-page").addEventListener("change", function () {
    state.consolePage = this.value;
    $("console-view").textContent = "";
  });

  function renderConsole(entries) {
    $("console-view").textContent = entries.map(function (e) {
      return "[" + timeStr(e.ts) + "] [" + e.level + "] " + e.text;
    }).join("\\n") || "（该页面暂无日志）";
  }

  function renderEvals(list) {
    var tb = $("evals-table").tBodies[0];
    tb.innerHTML = "";
    list.slice().reverse().forEach(function (e) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + timeStr(e.ts) + "</td>" +
        "<td>" + esc(e.tool) + "</td>" +
        "<td>" + (e.ok ? "✓" : "<span style='color:#c33'>✗</span>") + "</td>" +
        "<td>" + (e.durationMs == null ? "-" : e.durationMs + "ms") + "</td>" +
        "<td>" + esc(cut(e.code, 100)) + "</td>" +
        "<td>" + esc(cut(e.result, 100)) + "</td>";
      tb.appendChild(tr);
    });
    if (!list.length) {
      var tr2 = document.createElement("tr");
      tr2.innerHTML = "<td colspan='6' class='muted'>暂无记录——AI 通过该分组的 MCP 地址调用工具后，这里会实时出现</td>";
      tb.appendChild(tr2);
    }
  }

  // ---------- 复制 ----------
  function copyText(text, btn) {
    function ok() {
      var old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(function () { btn.textContent = old; }, 1200);
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); ok(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }
  $("copy-mcp").onclick = function () { copyText($("mcp-snippet").textContent, $("copy-mcp")); };
  $("copy-script").onclick = function () { copyText($("script-snippet").textContent, $("copy-script")); };

  // ---------- 启动 ----------
  fetch("/admin/api/session").then(function (res) {
    return res.json();
  }).then(function (data) {
    if (data && data.loggedIn) enter(); else showLogin();
  }).catch(showLogin);
})();
</script>
</body>
</html>`;

// ---------- 服务端 ----------

/**
 * @param {{port?:number, host?:string, adminPassword:string,
 *          dataFile?:string|URL, clientFile?:string|URL,
 *          log?:(...args:unknown[])=>void}} options
 */
export function createGroupServer(options = {}) {
  const {
    port = 3210,
    host = "127.0.0.1",
    adminPassword,
    dataFile,
    clientFile = new URL("../client.js", import.meta.url),
    log = (...args) => console.error("[web-bridge]", ...args),
  } = options;

  if (!adminPassword) throw new Error("分组模式需要管理密码（--admin <密码> 或环境变量 ADMIN_PASSWORD）");
  const dataFilePath = dataFile
    ? (typeof dataFile === "string" ? dataFile : fileURLToPath(dataFile))
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "groups.json");

  /** id -> { id, name, token, createdAt, registry, mcpHandler } */
  const groups = new Map();
  /** sessionId -> 过期时间（仅内存，重启即失效） */
  const sessions = new Map();

  async function loadGroups() {
    try {
      const raw = JSON.parse(await readFile(dataFilePath, "utf8"));
      for (const g of raw.groups || []) {
        groups.set(g.id, { ...g, registry: createRegistry({ log }) });
      }
      if (groups.size) log(`已从 ${dataFilePath} 加载 ${groups.size} 个分组`);
    } catch (err) {
      if (err.code !== "ENOENT") log("分组数据加载失败:", err?.message || err);
    }
  }

  async function persist() {
    await mkdir(path.dirname(dataFilePath), { recursive: true });
    const data = { groups: [...groups.values()].map(({ registry, mcpHandler, ...rest }) => rest) };
    await writeFile(dataFilePath, JSON.stringify(data, null, 2));
  }

  /** 给 MCP 层的 hub 形状：registry 能力 + 地址信息 + 该分组专属的脚本介绍 */
  function groupView(g) {
    return {
      ...g.registry,
      host, port,
      introScript: `<script src="http://${host}:${port}/g/${g.token}/client.js"></script>`,
    };
  }

  function mcpHandlerOf(g) {
    if (!g.mcpHandler) g.mcpHandler = createMcpHttpHandler({ hub: groupView(g), token: null });
    return g.mcpHandler;
  }

  // ---------- 会话 ----------

  function checkPassword(given) {
    return given != null && timingSafeEqual(sha256(adminPassword), sha256(given));
  }
  function sessionFromReq(req) {
    const m = /(?:^|;\s*)wb_session=([a-f0-9]+)/.exec(String(req.headers.cookie || ""));
    if (!m) return false;
    const exp = sessions.get(m[1]);
    if (!exp || exp < Date.now()) { sessions.delete(m[1]); return false; }
    return true;
  }
  function newSession() {
    const sid = randomBytes(24).toString("hex");
    sessions.set(sid, Date.now() + SESSION_TTL_MS);
    const now = Date.now();
    for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
    return sid;
  }

  // ---------- HTTP ----------

  /** 反向代理（nginx/caddy TLS 终止）场景下，按 X-Forwarded-* 推断对外可达的 ws/wss 地址 */
  function publicWsUrl(req) {
    const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const xfHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const proto = xfProto || (req.socket.encrypted ? "wss" : "ws");
    const hostHeader = xfHost || req.headers.host || `${host}:${port}`;
    return `${proto === "https" ? "wss" : proto === "http" ? "ws" : proto}://${hostHeader}`;
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length > 1024 * 1024) reject(new Error("body 过大"));
      });
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); }
        catch (e) { reject(e); }
      });
      req.on("error", reject);
    });
  }

  function json(res, code, obj, extraHeaders = {}) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
    res.end(JSON.stringify(obj));
  }

  function findByToken(token) {
    for (const [, g] of groups) if (g.token === token) return g;
    return null;
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://placeholder.local");
    const parts = url.pathname.split("/").filter(Boolean);

    // ---- 管理后台页面与 API ----
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(ADMIN_HTML);
      return;
    }
    if (url.pathname === "/admin/api/login" && req.method === "POST") {
      let body;
      try { body = await readJson(req); } catch { json(res, 400, { error: "请求格式错误" }); return; }
      if (!checkPassword(body?.password)) {
        await new Promise((r) => setTimeout(r, 300)); // 拖慢暴力尝试
        json(res, 401, { error: "密码错误" });
        return;
      }
      const sid = newSession();
      json(res, 200, { ok: true }, {
        "Set-Cookie": `wb_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      });
      return;
    }
    if (url.pathname === "/admin/api/logout" && req.method === "POST") {
      const m = /wb_session=([a-f0-9]+)/.exec(String(req.headers.cookie || ""));
      if (m) sessions.delete(m[1]);
      json(res, 200, { ok: true }, { "Set-Cookie": "wb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
      return;
    }
    if (url.pathname === "/admin/api/session" && req.method === "GET") {
      json(res, 200, { loggedIn: sessionFromReq(req) });
      return;
    }
    if (parts[0] === "admin" && parts[1] === "api") {
      if (!sessionFromReq(req)) { json(res, 401, { error: "未登录" }); return; }

      if (url.pathname === "/admin/api/groups" && req.method === "GET") {
        json(res, 200, {
          groups: [...groups.values()].map((g) => ({
            id: g.id, name: g.name, token: g.token, createdAt: g.createdAt,
            online: g.registry.listPages().length,
          })),
        });
        return;
      }
      if (url.pathname === "/admin/api/groups" && req.method === "POST") {
        let body;
        try { body = await readJson(req); } catch { json(res, 400, { error: "请求格式错误" }); return; }
        const name = String(body?.name || "").trim().slice(0, 100);
        if (!name) { json(res, 400, { error: "分组名称不能为空" }); return; }
        const g = {
          id: randomUUID(), name,
          token: TOKEN_PREFIX + randomBytes(24).toString("hex"),
          createdAt: Date.now(),
          registry: createRegistry({ log }),
        };
        groups.set(g.id, g);
        await persist();
        log(`分组已创建: ${name}（token ${g.token.slice(0, 10)}…）`);
        json(res, 200, { group: { id: g.id, name: g.name, token: g.token, createdAt: g.createdAt } });
        return;
      }
      const m = /^\/admin\/api\/groups\/([^/]+)(?:\/(pages|console|evals))?$/.exec(url.pathname);
      if (m) {
        const g = groups.get(m[1]);
        if (!g) { json(res, 404, { error: "分组不存在" }); return; }
        if (!m[2] && req.method === "DELETE") {
          g.registry.close();
          groups.delete(g.id);
          await persist();
          log(`分组已删除: ${g.name}`);
          json(res, 200, { ok: true });
          return;
        }
        if (m[2] === "pages" && req.method === "GET") { json(res, 200, { pages: g.registry.listPages() }); return; }
        if (m[2] === "console" && req.method === "GET") {
          json(res, 200, {
            entries: g.registry.getConsole({
              pageId: url.searchParams.get("pageId") || undefined,
              limit: Number(url.searchParams.get("limit")) || 50,
            }),
          });
          return;
        }
        if (m[2] === "evals" && req.method === "GET") {
          json(res, 200, { evals: g.registry.getEvals({ limit: Number(url.searchParams.get("limit")) || 100 }) });
          return;
        }
      }
      json(res, 404, { error: "not found" });
      return;
    }

    // ---- 分组专属入口（token 在路径中，持有即有权访问） ----
    if (parts[0] === "g" && parts.length >= 3) {
      const g = findByToken(parts[1]);
      if (!g) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404: 分组不存在（token 无效或已删除）");
        return;
      }
      const sub = parts.slice(2).join("/");
      if (sub === "client.js") {
        if (req.method === "OPTIONS") {
          // Chrome Local Network Access 预检（公网/HTTPS 页面加载本地脚本时）
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Private-Network": "true",
          });
          res.end();
          return;
        }
        const inject =
          `window.__WEB_BRIDGE__ = { wsUrl: ${JSON.stringify(publicWsUrl(req) + "/g/" + g.token + "/ws")}, token: "" };\n`;
        const source = await readFile(clientFile, "utf8");
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Private-Network": "true",
        });
        res.end(inject + source);
        return;
      }
      if (sub === "mcp") return mcpHandlerOf(g)(req, res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404");
      return;
    }

    // ---- 落地页（不泄露任何分组信息） ----
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>web-bridge</title></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:80px auto">
<h2>web-bridge 分组服务已启动</h2>
<p><a href="/admin">进入管理后台</a>，登录后可创建分组并获取各分组专属的 MCP 配置与页面脚本。</p>
</body></html>`);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
  }

  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log("HTTP 处理异常:", err?.message || err);
      if (!res.headersSent) res.writeHead(500);
      res.end("internal error");
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const parts = new URL(req.url, "http://placeholder.local").pathname.split("/").filter(Boolean);
    const g = parts[0] === "g" && parts[2] === "ws" ? findByToken(parts[1]) : null;
    if (!g) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => g.registry.handleConnection(ws));
  });

  // 死连接清理（浏览器自动响应协议层 ping）
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);

  const ready = (async () => {
    await loadGroups();
    return new Promise((resolve, reject) => {
      httpServer.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`端口 ${port} 已被占用（可能是另一个 web-bridge 实例正在运行）。请关闭旧实例，或换一个 --port。`));
        } else {
          reject(err);
        }
      });
      httpServer.listen(port, host, () => resolve());
    });
  })();

  function close() {
    clearInterval(heartbeat);
    sessions.clear();
    for (const [, g] of groups) g.registry.close();
    wss.close();
    httpServer.close();
  }

  return { ready, close, port, host };
}
