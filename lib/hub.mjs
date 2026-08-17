// hub.mjs — 接口 A：WebSocket + HTTP 服务
// 职责：页面注册表、eval 请求路由、console 环形缓冲、/client.js 注入下发、状态页
// 所有日志走 stderr（stdout 被 MCP stdio 协议占用）

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const CONSOLE_BUFFER_MAX = 500;
const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
const MAX_EVAL_TIMEOUT_MS = 120_000;
const HELLO_TIMEOUT_MS = 5_000;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/**
 * @param {{port?:number, host?:string, token?:string|null, clientFile?:string|URL,
 *          mcpHttpHandler?:(req:import("node:http").IncomingMessage,res:import("node:http").ServerResponse)=>Promise<void>,
 *          log?:(...args:unknown[])=>void}} [options]
 */
export function createHub(options = {}) {
  const {
    port = 3210,
    host = "127.0.0.1",
    token = null,
    clientFile = new URL("../client.js", import.meta.url),
    mcpHttpHandler = null,
    log = (...args) => console.error("[web-bridge]", ...args),
  } = options;

  /** 已连接页面：pageId -> entry */
  const pages = new Map();
  /** console 缓冲：pageId -> entries[]（页面断连后仍保留，便于事后排查） */
  const consoleBuffers = new Map();
  /** 进行中的 eval：reqId -> { resolve, timer, pageId } */
  const pendingEvals = new Map();
  let reqSeq = 0;

  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log("HTTP 处理异常:", err?.message || err);
      if (!res.headersSent) res.writeHead(500);
      res.end("internal error");
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => handleConnection(ws));

  // ---------- HTTP ----------

  /** 反向代理（nginx/caddy TLS 终止）场景下，按 X-Forwarded-* 推断对外可达的 ws/wss 地址 */
  function publicWsUrl(req) {
    const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const xfHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const proto = xfProto || (req.socket.encrypted ? "wss" : "ws");
    const hostHeader = xfHost || req.headers.host || `${host}:${port}`;
    return `${proto === "https" ? "wss" : proto === "http" ? "ws" : proto}://${hostHeader}`;
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://placeholder.local");
    if (url.pathname === "/mcp") {
      // MCP Streamable HTTP 端点（远程部署模式），由 server.js 注入的处理器接管
      if (mcpHttpHandler) return mcpHttpHandler(req, res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404: MCP HTTP 传输未启用（--transport http）");
      return;
    }
    if (url.pathname === "/client.js") {
      if (token && url.searchParams.get("token") !== token) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("403: 缺少或错误的 ?token= 参数");
        return;
      }
      const inject =
        `window.__WEB_BRIDGE__ = { wsUrl: ${JSON.stringify(publicWsUrl(req))}, ` +
        `token: ${JSON.stringify(token || "")} };\n`;
      const source = await readFile(clientFile, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(inject + source);
      return;
    }
    if (url.pathname === "/") {
      const list = listPages();
      const rows = list.length
        ? list.map((p) => `<tr><td><code>${escapeHtml(p.pageId.slice(0, 8))}</code></td>` +
            `<td>${escapeHtml(p.title)}</td><td>${escapeHtml(p.url)}</td>` +
            `<td>${escapeHtml(new Date(p.connectedAt).toLocaleString())}</td></tr>`).join("\n")
        : `<tr><td colspan="4" style="color:#888">暂无页面连接</td></tr>`;
      const baseUrl = publicWsUrl(req).replace(/^ws/, "http");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>web-bridge</title></head>
<body style="font-family:system-ui,sans-serif;max-width:900px;margin:40px auto">
<h2>web-bridge 状态页</h2>
<p>在任意静态网页中加入下面这行，页面即连接本服务：</p>
<pre style="background:#f5f5f5;padding:12px">&lt;script src="${escapeHtml(baseUrl)}/client.js"&gt;&lt;/script&gt;</pre>
<h3>已连接页面（${list.length}）</h3>
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><th>pageId</th><th>标题</th><th>URL</th><th>连接时间</th></tr>
${rows}
</table></body></html>`);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
  }

  // ---------- WebSocket ----------

  function handleConnection(ws) {
    let registered = false;
    let pageId = null;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    const helloTimer = setTimeout(() => {
      if (!registered) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== "object") return;

      if (!registered) {
        if (msg.type === "hello" && msg.role === "page") {
          if (token && msg.token !== token) {
            ws.send(JSON.stringify({ type: "error", error: "invalid token" }));
            ws.close(4003, "invalid token");
            return;
          }
          clearTimeout(helloTimer);
          registered = true;
          pageId = typeof msg.pageId === "string" && msg.pageId ? msg.pageId.slice(0, 100) : randomUUID();
          // 复制标签页会复制 sessionStorage 导致 pageId 重复：新连接替换旧连接
          const old = pages.get(pageId);
          if (old?.ws && old.ws !== ws) old.ws.terminate();
          pages.set(pageId, {
            ws, pageId,
            url: String(msg.url || "").slice(0, 2000),
            title: String(msg.title || "").slice(0, 500),
            ua: String(msg.ua || "").slice(0, 500),
            connectedAt: Date.now(),
          });
          if (!consoleBuffers.has(pageId)) consoleBuffers.set(pageId, []);
          ws.send(JSON.stringify({ type: "welcome", pageId }));
          log(`页面已连接: ${pageId.slice(0, 8)} ${pages.get(pageId).url}`);
        }
        return;
      }

      switch (msg.type) {
        case "page-info": {
          const entry = pages.get(pageId);
          if (entry) {
            if (typeof msg.url === "string") entry.url = msg.url.slice(0, 2000);
            if (typeof msg.title === "string") entry.title = msg.title.slice(0, 500);
          }
          break;
        }
        case "console": {
          const buf = consoleBuffers.get(pageId);
          if (buf) {
            buf.push({
              level: String(msg.level || "log").slice(0, 20),
              text: String(msg.text ?? "").slice(0, 8000),
              ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
            });
            if (buf.length > CONSOLE_BUFFER_MAX) buf.splice(0, buf.length - CONSOLE_BUFFER_MAX);
          }
          break;
        }
        case "eval-result": {
          const p = pendingEvals.get(msg.reqId);
          if (!p) return; // 已超时的迟到回包，忽略
          clearTimeout(p.timer);
          pendingEvals.delete(msg.reqId);
          if (msg.ok) p.resolve({ ok: true, value: msg.value, durationMs: msg.durationMs });
          else p.resolve({ ok: false, error: String(msg.error || "unknown eval error") });
          break;
        }
        default:
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (registered && pages.get(pageId)?.ws === ws) {
        pages.delete(pageId);
        log(`页面已断开: ${pageId.slice(0, 8)}`);
        // 该页面所有进行中的 eval 立即失败
        for (const [reqId, p] of pendingEvals) {
          if (p.pageId === pageId) {
            clearTimeout(p.timer);
            pendingEvals.delete(reqId);
            p.resolve({ ok: false, error: "页面连接已断开" });
          }
        }
      }
    });
  }

  // 死连接清理（浏览器自动响应协议层 ping）
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);

  // ---------- 对 MCP 层暴露的能力 ----------

  function listPages() {
    return [...pages.values()].map(({ ws, ...rest }) => rest);
  }

  /**
   * @returns {Promise<{ok:true, value?:string, durationMs?:number} | {ok:false, error:string}>}
   */
  function evalJs({ pageId, code, timeoutMs }) {
    const entry = pages.get(pageId);
    if (!entry) {
      return Promise.resolve({ ok: false, error: `页面未连接: ${pageId}` });
    }
    if (entry.ws.readyState !== 1 /* OPEN */) {
      return Promise.resolve({ ok: false, error: `页面连接已关闭: ${pageId}` });
    }
    const t = Math.min(Math.max(1, Number(timeoutMs) || DEFAULT_EVAL_TIMEOUT_MS), MAX_EVAL_TIMEOUT_MS);
    const reqId = `r${++reqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingEvals.delete(reqId);
        resolve({ ok: false, error: `eval 超时（${t}ms），代码可能包含死循环或未决 Promise` });
      }, t);
      pendingEvals.set(reqId, { resolve, timer, pageId });
      try {
        entry.ws.send(JSON.stringify({ type: "eval", reqId, code, timeoutMs: t }));
      } catch (err) {
        clearTimeout(timer);
        pendingEvals.delete(reqId);
        resolve({ ok: false, error: `发送失败: ${err?.message || err}` });
      }
    });
  }

  function getConsole({ pageId, limit = 50 } = {}) {
    const buf = consoleBuffers.get(pageId) || [];
    const n = Math.min(Math.max(1, Number(limit) || 50), CONSOLE_BUFFER_MAX);
    return buf.slice(-n);
  }

  const ready = new Promise((resolve, reject) => {
    httpServer.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(
          `端口 ${port} 已被占用（可能是另一个 web-bridge 实例正在运行）。` +
          `请关闭旧实例，或通过环境变量 PORT / --port 换一个端口。`
        ));
      } else {
        reject(err);
      }
    });
    httpServer.listen(port, host, () => resolve());
  });

  function close() {
    clearInterval(heartbeat);
    for (const [, p] of pendingEvals) { clearTimeout(p.timer); p.resolve({ ok: false, error: "服务已关闭" }); }
    pendingEvals.clear();
    wss.close();
    httpServer.close();
  }

  return { ready, listPages, evalJs, getConsole, close, port, host };
}
