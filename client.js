/* web-bridge-mcp client.js — 在任意静态网页中引入，连接 web-bridge-mcp MCP Server
 * 用法：<script src="http://127.0.0.1:3210/client.js"></script>
 * （由 server 端下发时会在文件头注入 window.__WEB_BRIDGE__ 配置）
 * 零依赖；自动重连；捕获 console 与未捕获异常；执行 eval 请求并回传序列化结果
 */
(function () {
  "use strict";
  if (window.__WEB_BRIDGE_LOADED__) return;
  window.__WEB_BRIDGE_LOADED__ = true;

  var cfg = window.__WEB_BRIDGE__ || {};
  var WS_URL = cfg.wsUrl || "ws://localhost:3210";
  var TOKEN = cfg.token || "";
  var RECONNECT_DELAYS = [1000, 2000, 5000, 10000];

  // pageId 存 sessionStorage：刷新页面保持不变，每个标签页唯一（复制标签页的冲突由服务端处理）
  var pageId;
  try {
    pageId = sessionStorage.getItem("__web_bridge_page_id__");
    if (!pageId) {
      pageId = crypto.randomUUID
        ? crypto.randomUUID()
        : "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      sessionStorage.setItem("__web_bridge_page_id__", pageId);
    }
  } catch (e) {
    pageId = "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  var ws = null;
  var reconnectAttempt = 0;

  function connect() {
    try { ws = new WebSocket(WS_URL); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = function () {
      reconnectAttempt = 0;
      send({
        type: "hello", role: "page", pageId: pageId,
        url: location.href, title: document.title, ua: navigator.userAgent,
        token: TOKEN,
      });
    };
    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg && msg.type === "eval") handleEval(msg);
    };
    ws.onclose = function () { ws = null; scheduleReconnect(); };
    ws.onerror = function () { /* onclose 会跟着触发 */ };
  }

  function scheduleReconnect() {
    var delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt++;
    setTimeout(connect, delay);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }
  }

  // ---------- 页面信息上报 ----------

  function reportPageInfo() {
    send({ type: "page-info", url: location.href, title: document.title });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportPageInfo);
  } else {
    reportPageInfo();
  }
  window.addEventListener("load", reportPageInfo);
  window.addEventListener("popstate", reportPageInfo);
  window.addEventListener("hashchange", reportPageInfo);
  setInterval(reportPageInfo, 5000); // SPA 的 pushState/replaceState 无统一事件，轮询兜底

  // ---------- console 捕获（透传原方法，节流批量上报） ----------

  var consoleQueue = [];
  var consoleFlushTimer = 0;

  function queueConsole(level, text) {
    consoleQueue.push({ type: "console", level: level, text: text, ts: Date.now() });
    if (!consoleFlushTimer) {
      consoleFlushTimer = setTimeout(function () {
        consoleFlushTimer = 0;
        for (var i = 0; i < consoleQueue.length; i++) send(consoleQueue[i]);
        consoleQueue.length = 0;
      }, 500);
    }
  }

  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== "function") return;
    console[level] = function () {
      try { queueConsole(level, argsToText(arguments)); } catch (e) { /* ignore */ }
      return orig.apply(console, arguments);
    };
  });

  function argsToText(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(preview(args[i], 0, []));
    return parts.join(" ").slice(0, 8000) || "(空)";
  }

  window.addEventListener("error", function (e) {
    var text = e.error && e.error.stack ? String(e.error.stack) : (e.message || "unknown error");
    if (e.filename) text += "\n  at " + e.filename + ":" + (e.lineno || 0) + ":" + (e.colno || 0);
    queueConsole("error", text);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    queueConsole("error", "Uncaught (in promise) " + (r && r.stack ? r.stack : preview(r, 0, [])));
  });

  // ---------- eval 执行 ----------

  // 表达式/语句两种包装：先按表达式包，语法错误则退回语句块（可用 return）
  var PROLOGUE = "const $ = (s, r) => (r || document).querySelector(s);\n" +
    "const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));\n";

  function compile(code) {
    try {
      return new Function('"use strict";\n' + PROLOGUE + "return (async () => (\n" + code + "\n))();");
    } catch (e) {
      return new Function('"use strict";\n' + PROLOGUE + "return (async () => {\n" + code + "\n})();");
    }
  }

  async function handleEval(msg) {
    var started = Date.now();
    var res;
    try {
      var value = await compile(msg.code)();
      res = { type: "eval-result", reqId: msg.reqId, ok: true, value: preview(value, 0, []), durationMs: Date.now() - started };
    } catch (e) {
      res = {
        type: "eval-result", reqId: msg.reqId, ok: false, durationMs: Date.now() - started,
        error: e && e.stack ? String(e.stack) : String(e),
      };
    }
    send(res);
  }

  // ---------- 安全序列化（结果预览） ----------

  var MAX_DEPTH = 6;
  var MAX_CHARS = 50000;

  function preview(v, depth, seen) {
    if (!Array.isArray(seen)) seen = []; // 防御：调用方传错初始值时不至于整体失败
    var out = previewInner(v, depth, seen);
    return out.length > MAX_CHARS ? out.slice(0, MAX_CHARS) + " …[截断]" : out;
  }

  function previewInner(v, depth, seen) {
    try {
      if (v === undefined) return "undefined";
      if (v === null) return "null";
      var t = typeof v;
      if (t === "number" || t === "boolean") return String(v);
      if (t === "bigint") return v.toString() + "n";
      if (t === "string") return depth === 0 ? v : JSON.stringify(v.length > 200 ? v.slice(0, 200) + "…" : v);
      if (t === "symbol") return v.toString();
      if (t === "function") {
        var src = Function.prototype.toString.call(v).split("\n")[0].slice(0, 200);
        return "ƒ " + (v.name || "(anonymous)") + " — " + src;
      }
      if (v instanceof Error) return v.stack ? String(v.stack) : v.name + ": " + v.message;
      if (v instanceof Date) return v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (typeof Node !== "undefined" && v instanceof Node) {
        if (v instanceof Element) {
          var html = v.outerHTML || "";
          return html.length > 200 ? html.slice(0, 200) + "…" : html;
        }
        return "#" + (v.nodeName || "node") + " " + String(v.textContent || "").slice(0, 100);
      }
      if (typeof Window !== "undefined" && v instanceof Window) return "Window";

      if (depth >= MAX_DEPTH) return "[深度超限]";

      // 循环引用检测
      if (seen.indexOf(v) !== -1) return "[Circular]";
      seen = seen.concat([v]);

      if (Array.isArray(v)) {
        var items = v.slice(0, 100).map(function (x) { return previewInner(x, depth + 1, seen); });
        if (v.length > 100) items.push("… 共 " + v.length + " 项");
        return "[" + items.join(", ") + "]";
      }
      if (v instanceof Map) {
        var m = [];
        var n = 0;
        for (var [k, val] of v) {
          if (n++ >= 50) { m.push("… 共 " + v.size + " 项"); break; }
          m.push(previewInner(k, depth + 1, seen) + " => " + previewInner(val, depth + 1, seen));
        }
        return "Map(" + v.size + ") {" + m.join(", ") + "}";
      }
      if (v instanceof Set) {
        var s = [];
        var n2 = 0;
        for (var item of v) {
          if (n2++ >= 50) { s.push("… 共 " + v.size + " 项"); break; }
          s.push(previewInner(item, depth + 1, seen));
        }
        return "Set(" + v.size + ") {" + s.join(", ") + "}";
      }
      if (v instanceof Promise) return "Promise {<pending>}";

      var keys = Object.keys(v).slice(0, 50);
      var parts = keys.map(function (k) { return k + ": " + previewInner(v[k], depth + 1, seen); });
      var ctor = v.constructor && v.constructor.name && v.constructor.name !== "Object" ? v.constructor.name + " " : "";
      if (Object.keys(v).length > 50) parts.push("…");
      return ctor + "{" + parts.join(", ") + "}";
    } catch (e) {
      return "[无法序列化: " + (e && e.message) + "]";
    }
  }

  connect();
})();
