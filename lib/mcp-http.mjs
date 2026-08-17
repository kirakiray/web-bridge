// mcp-http.mjs — 接口 B 的远程模式：MCP Streamable HTTP 传输（端点 /mcp）
// 用于把 web-bridge 部署到外网服务器：编辑器只需在 MCP 配置里填
//   { "type": "http", "url": "https://your-domain/mcp" }（开启令牌时附带 Authorization 头）
// 采用官方 stateless 模式：每个 POST 请求独立的 transport + McpServer 实例，共享同一个 hub

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.mjs";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 5 * 1024 * 1024) reject(new Error("body 过大")); // 防滥用
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/**
 * @param {{hub: import("./hub.mjs").Hub, token?: string|null,
 *          log?:(...args:unknown[])=>void}} options
 * @returns {(req:import("node:http").IncomingMessage,res:import("node:http").ServerResponse)=>Promise<void>}
 */
export function createMcpHttpHandler({ hub, token = null, log = () => {} } = {}) {
  return async function handle(req, res) {
    // CORS：便于浏览器内的 MCP 客户端（如 Inspector）跨源访问
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Web-Bridge-Token, Mcp-Session-Id, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    if (token) {
      const auth = String(req.headers.authorization || "");
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const custom = String(req.headers["x-web-bridge-token"] || "");
      const queryToken = new URL(req.url, "http://placeholder.local").searchParams.get("token");
      if ((bearer || custom || queryToken || "") !== token) {
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="web-bridge"' });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized: 缺少或错误的令牌" }, id: null }));
        return;
      }
    }

    if (req.method !== "POST") {
      // stateless 模式：无会话可注销、无服务端推送流
      res.writeHead(405, { "Allow": "POST, OPTIONS" }).end();
      return;
    }

    let body;
    try { body = await readBody(req); }
    catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return;
    }

    let server;
    let transport;
    try {
      server = createMcpServer(hub);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless：不生成会话，每个请求自包含
        enableJsonResponse: true,      // POST 直接回 JSON，不维持 SSE 长流
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("MCP HTTP 请求处理失败:", err?.message || err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      } else {
        res.end();
      }
      transport?.close();
      server?.close();
    }
  };
}
