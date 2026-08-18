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

// ---------- 管理后台静态资源（lib/admin/ 下的独立文件，启动时读入内存缓存） ----------

const ADMIN_DIR = new URL("./admin/", import.meta.url);
const ADMIN_ROUTES = {
  "/admin": { file: "index.html", type: "text/html; charset=utf-8" },
  "/admin/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/admin/admin.css": { file: "admin.css", type: "text/css; charset=utf-8" },
  "/admin/admin.js": { file: "admin.js", type: "text/javascript; charset=utf-8" },
};
let adminAssets = null;
async function loadAdminAssets() {
  adminAssets = {};
  for (const [pathname, { file, type }] of Object.entries(ADMIN_ROUTES)) {
    adminAssets[pathname] = { body: await readFile(new URL(file, ADMIN_DIR), "utf8"), type };
  }
}

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
    log = (...args) => console.error("[web-bridge-mcp]", ...args),
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
    // no-store：session/列表等接口的数据随时变化，禁止浏览器用缓存响应（否则退出后刷新仍显示已登录）
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
    res.end(JSON.stringify(obj));
  }

  function findByToken(token) {
    for (const [, g] of groups) if (g.token === token) return g;
    return null;
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://placeholder.local");
    const parts = url.pathname.split("/").filter(Boolean);

    // ---- 管理后台页面与静态资源 ----
    const asset = adminAssets?.[url.pathname];
    if (asset) {
      res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" });
      res.end(asset.body);
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
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>web-bridge-mcp</title></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:80px auto">
<h2>web-bridge-mcp 分组服务已启动</h2>
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
    await loadAdminAssets();
    return new Promise((resolve, reject) => {
      httpServer.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`端口 ${port} 已被占用（可能是另一个 web-bridge-mcp 实例正在运行）。请关闭旧实例，或换一个 --port。`));
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
