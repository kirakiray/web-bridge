// hub.mjs — 接口 A：WebSocket + HTTP 服务（单实例模式）
// 页面注册表 / console 缓冲 / eval 路由已抽到 registry.mjs（与分组模式共用），
// 本文件只负责：HTTP 路由（/client.js 下发、状态页、/mcp 转发）、WS upgrade、心跳、生命周期

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { createRegistry } from "./registry.mjs";

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

  const registry = createRegistry({ token, log });

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

  wss.on("connection", (ws) => registry.handleConnection(ws));

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
        "Access-Control-Allow-Private-Network": "true",
      });
      res.end(inject + source);
      return;
    }
    if (url.pathname === "/") {
      const list = registry.listPages();
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

  // 死连接清理（浏览器自动响应协议层 ping）
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);

  // ---------- 对 MCP 层暴露的能力（委托 registry） ----------

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
    registry.close();
    wss.close();
    httpServer.close();
  }

  return {
    ready, close, port, host,
    listPages: registry.listPages,
    evalJs: registry.evalJs,
    getConsole: registry.getConsole,
    getEvals: registry.getEvals,
  };
}
