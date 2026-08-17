#!/usr/bin/env node
// server.js — web-bridge MCP Server 入口
// 架构：本进程是中心——
//   接口 A（WebSocket + HTTP，默认 127.0.0.1:3210）：浏览器页面经 client.js 连到这里
//   接口 B（MCP 协议，--transport 二选一）：
//     · stdio（默认）：AI 编辑器本地拉起本进程，mcp.json 里填 command/args
//     · http：Streamable HTTP（端点 /mcp），可部署到外网服务器，mcp.json 里只填
//             { "type": "http", "url": "https://your-domain/mcp" }
//   AI 编辑器与浏览器互不直连，一切经本进程间接联动

import { createHub } from "./lib/hub.mjs";
import { registerTools } from "./lib/mcp.mjs";
import { createMcpHttpHandler } from "./lib/mcp-http.mjs";

// 参数解析：--port/--host/--token/--transport，或环境变量 PORT/HOST/TOKEN/TRANSPORT
function parseArgs() {
  const out = {
    port: process.env.PORT,
    host: process.env.HOST,
    token: process.env.TOKEN || null,
    transport: process.env.TRANSPORT || "stdio",
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = argv[++i];
    else if (argv[i] === "--host") out.host = argv[++i];
    else if (argv[i] === "--token") out.token = argv[++i];
    else if (argv[i] === "--transport") out.transport = argv[++i];
  }
  out.port = Number(out.port) || 3210;
  if (!out.host) out.host = "127.0.0.1";
  if (out.transport !== "stdio" && out.transport !== "http") {
    console.error(`[web-bridge] 无效的 --transport: ${out.transport}（可选 stdio | http）`);
    process.exit(1);
  }
  return out;
}

const { port, host, token, transport } = parseArgs();

const hub = createHub({
  port,
  host,
  token,
  // http 模式下把 MCP 端点挂到同一端口；handler 需要在 hub 实例化后才能拿到引用，这里用闭包转发
  mcpHttpHandler: (req, res) => mcpHttp(req, res),
});
const mcpHttp = createMcpHttpHandler({ hub, token });

try {
  await hub.ready;
} catch (err) {
  console.error(`[web-bridge] 启动失败: ${err.message}`);
  process.exit(1);
}

console.error(`[web-bridge] hub 已就绪:`);
console.error(`[web-bridge]   页面引入: <script src="http://${host}:${port}/client.js"></script>`);
console.error(`[web-bridge]   状态页:   http://${host}:${port}/`);
if (token) console.error("[web-bridge]   令牌模式已开启（client.js 需带 ?token= 参数获取）");

function shutdown(signal) {
  console.error(`[web-bridge] 收到 ${signal}，退出`);
  hub.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (transport === "http") {
  // 远程部署模式：MCP 经 Streamable HTTP 提供服务。
  // 不监听 stdin 关闭（systemd/pm2 托管时 stdin 可能关闭或不存在，不应触发退出）
  console.error(`[web-bridge] MCP HTTP 端点已就绪: http://${host}:${port}/mcp`);
  console.error("[web-bridge] 编辑器配置: { \"type\": \"http\", \"url\": \"http://<对外地址>:" + port + "/mcp\" }");
} else {
  await registerTools(hub);
  console.error("[web-bridge] MCP stdio 服务已就绪，等待 AI 编辑器调用工具");

  // 编辑器关闭 stdio 时退出，避免残留监听端口的僵尸进程
  process.stdin.on("end", () => shutdown("stdin end"));
  process.stdin.on("close", () => shutdown("stdin close"));
}
