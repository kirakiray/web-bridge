/* web-bridge-mcp client.js — 在任意静态网页中引入，连接 web-bridge-mcp MCP Server
 * 用法：<script src="http://127.0.0.1:3210/client.js"></script>
 * （由 server 端下发时会在文件头注入 window.__WEB_BRIDGE__ 配置）
 * 零依赖；自动重连；捕获 console 与未捕获异常；执行 eval 请求并回传序列化结果；
 * 右上角注入可拖拽的连接状态气泡（绿=已连接 黄=连接中 红=已断开）
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
    setStatus("connecting");
    try { ws = new WebSocket(WS_URL); } catch (e) { setStatus("disconnected"); scheduleReconnect(); return; }
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
      if (msg && msg.type === "eval") { recordEval(msg); handleEval(msg); }
      else if (msg && msg.type === "welcome") setStatus("connected"); // 服务端已接受本页，连接真正可用
    };
    ws.onclose = function () { ws = null; setStatus("disconnected"); scheduleReconnect(); };
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
  setInterval(function () { reportPageInfo(); ensureBubble(); }, 5000); // SPA 的 pushState/replaceState 无统一事件，轮询兜底；顺带把被框架清掉的气泡挂回

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

  // 表达式/语句两种包装：先按表达式包，语法错误则退回语句块（可用 return）。
  // 语句块模式下若最后一句是表达式语句，自动补 return（AI 写多语句代码时无需记得显式 return）。
  var PROLOGUE = "const $ = (s, r) => (r || document).querySelector(s);\n" +
    "const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));\n" +
    // $deep / $$deep：递归穿入所有已打开的 shadowRoot 查询（Web Components 页面必需）；
    // $import：动态 import 的 base 是注入脚本的跨域地址而非页面，必须显式以页面 URL 解析
    "function __deepAll(root, out) {\n" +
    "  out.push(root);\n" +
    "  var els = root.querySelectorAll('*');\n" +
    "  for (var i = 0; i < els.length; i++) if (els[i].shadowRoot) __deepAll(els[i].shadowRoot, out);\n" +
    "  return out;\n" +
    "}\n" +
    "const $deep = (s, r) => { for (var root of __deepAll(r || document, [])) { var el = root.querySelector(s); if (el) return el; } return null; };\n" +
    "const $$deep = (s, r) => { var out = []; for (var root of __deepAll(r || document, [])) out.push(...root.querySelectorAll(s)); return out; };\n" +
    "const $import = (s) => import(new URL(s, location.href).href);\n";

  var NO_AUTORETURN_RE = /^(return|if|for|while|switch|do|try|catch|finally|throw|break|continue|const|let|var|function|class|else|\/\/|\/\*|\*|\}|\)|;|await\s+(function|class))/;

  function compile(code) {
    try {
      return new Function('"use strict";\n' + PROLOGUE + "return (async () => (\n" + code + "\n))();");
    } catch (e) { /* 不是单个表达式，走语句块 */ }
    // 语句块 + 自动 return：把最后一句表达式语句补上 return（尾部跨行表达式/块语句时
    // 转换结果编译不过，自然退回原始语句块包装）。
    // 注意：同一行含多条语句时只能对最后一个 ';' 之后的语句补 return——
    // 若对整行补 return，会变成 `return 第一句; 后续语句`，后续全部沦为死代码且编译仍通过。
    var lines = code.split("\n");
    for (var i = lines.length - 1; i >= 0; i--) {
      var t = lines[i].trim();
      if (t && t !== ";") {
        if (NO_AUTORETURN_RE.test(t)) break; // 最后一句不是表达式语句，保持原样
        var semi = t.lastIndexOf(";");
        if (semi !== -1) {
          // 多语句行：只 return 最后一个 ';' 之后的语句；补不出合法变换就放弃自动 return（宁可不返回值，不可吞语句）
          var tail = t.slice(semi + 1).trim();
          if (tail && !NO_AUTORETURN_RE.test(tail)) {
            try {
              return new Function('"use strict";\n' + PROLOGUE + "return (async () => {\n" + t.slice(0, semi + 1) + " return " + tail + "\n})();");
            } catch (e2) { /* fall through */ }
          }
          break;
        }
        try {
          return new Function('"use strict";\n' + PROLOGUE + "return (async () => {\nreturn " + t + "\n})();");
        } catch (e2) { /* 转换不合法，退回 */ }
        break;
      }
    }
    return new Function('"use strict";\n' + PROLOGUE + "return (async () => {\n" + code + "\n})();");
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
    finishEvalRecord(msg.reqId, res.ok, res.durationMs);
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

  // ---------- 连接状态气泡（右上角可拖拽圆点：绿=已连接 黄=连接中 红=已断开） ----------

  var BUBBLE_COLORS = { connecting: "#f59e0b", connected: "#22c55e", disconnected: "#ef4444" };
  var BUBBLE_LABELS = { connecting: "连接中", connected: "已连接", disconnected: "已断开" };
  var BUBBLE_POS_KEY = "__web_bridge_bubble_pos__";
  var bubbleHost = null, bubbleDot = null, bubbleAnim = null, bubbleState = "disconnected";

  function setStatus(state) {
    bubbleState = state;
    if (bubbleHost) bubbleHost.title = "web-bridge-mcp · " + BUBBLE_LABELS[state] + "（双击查看操作记录）";
    if (bubbleDot) bubbleDot.style.background = BUBBLE_COLORS[state];
    if (bubbleAnim) { bubbleAnim.cancel(); bubbleAnim = null; }
    if (state === "connecting" && bubbleDot && bubbleDot.animate) {
      bubbleAnim = bubbleDot.animate( // 呼吸动画：等待服务端确认期间闪烁提示
        [{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }], { duration: 1200, iterations: Infinity }
      );
    }
  }

  function ensureBubble() {
    if (!bubbleHost) {
      if (document.body) createBubble();
    } else if (!bubbleHost.isConnected && document.body) {
      document.body.appendChild(bubbleHost); // SPA 重写 body 后把气泡挂回（append 幂等，监听不重复）
    }
    if (opDialogOpen && opDialogHost && !opDialogHost.isConnected && document.body) {
      document.body.appendChild(opDialogHost); // 对话框开着时被清掉也一并挂回
    }
  }

  function createBubble() {
    bubbleHost = document.createElement("div");
    var s = bubbleHost.style; // 样式全走 CSSOM：页面 CSS 无法侵入，严格 CSP（禁内联 style 标签/属性）下也生效
    s.position = "fixed";
    s.top = "16px";
    s.right = "16px";
    s.width = "20px";
    s.height = "20px";
    s.zIndex = "2147483647";
    s.cursor = "grab";
    s.userSelect = "none";
    s.touchAction = "none";
    var root = bubbleHost.attachShadow ? bubbleHost.attachShadow({ mode: "open" }) : bubbleHost;
    bubbleDot = document.createElement("div");
    var d = bubbleDot.style;
    d.width = "100%";
    d.height = "100%";
    d.borderRadius = "50%";
    d.background = BUBBLE_COLORS.disconnected;
    d.border = "2px solid rgba(255,255,255,.9)";
    d.boxShadow = "0 1px 4px rgba(0,0,0,.4)";
    var NS = "http://www.w3.org/2000/svg";
    var icon = document.createElementNS(NS, "svg"); // 白色脉冲折线图标（activity），寓意实时桥接活动
    icon.setAttribute("viewBox", "0 0 12 12");
    var is = icon.style;
    is.position = "absolute";
    is.left = "50%"; is.top = "50%";
    is.width = "10px"; is.height = "10px";
    is.transform = "translate(-50%, -50%)";
    is.pointerEvents = "none";
    var pulse = document.createElementNS(NS, "path");
    pulse.setAttribute("d", "M1 6 H3.4 L5 2.6 L7 9.4 L8.6 6 H11");
    pulse.setAttribute("fill", "none");
    pulse.setAttribute("stroke", "rgba(255,255,255,.95)");
    pulse.setAttribute("stroke-width", "1.5");
    pulse.setAttribute("stroke-linecap", "round");
    pulse.setAttribute("stroke-linejoin", "round");
    icon.appendChild(pulse);
    d.position = "relative";
    d.display = "block";
    bubbleDot.appendChild(icon);
    root.appendChild(bubbleDot);
    initBubbleDrag();
    restoreBubblePos();
    document.body.appendChild(bubbleHost);
    setStatus(bubbleState); // 补齐气泡创建前已发生的状态
  }

  function initBubbleDrag() {
    var dragging = false, moved = false, startX = 0, startY = 0, origX = 0, origY = 0, lastDownTs = 0;
    bubbleHost.addEventListener("pointerdown", function (e) {
      var now = Date.now();
      if (now - lastDownTs < 350) { // 手动判定双击（不依赖 click 兼容事件），打开操作记录
        lastDownTs = 0;
        openOpDialog();
        return;
      }
      lastDownTs = now;
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      var r = bubbleHost.getBoundingClientRect();
      origX = r.left; origY = r.top;
      bubbleHost.style.cursor = "grabbing";
      try { bubbleHost.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    bubbleHost.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return; // 位移阈值：区分点击与拖拽
      moved = true;
      applyBubblePos(origX + dx, origY + dy);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      bubbleHost.style.cursor = "grab";
      if (moved) { // 拖拽过后重置双击计时，避免"拖完快速点一下"误判为双击
        lastDownTs = 0;
        try {
          var r = bubbleHost.getBoundingClientRect();
          sessionStorage.setItem(BUBBLE_POS_KEY, Math.round(r.left) + "," + Math.round(r.top));
        } catch (e) { /* ignore */ }
      }
    }
    bubbleHost.addEventListener("pointerup", endDrag);
    bubbleHost.addEventListener("pointercancel", endDrag);
  }

  function applyBubblePos(x, y) {
    var w = bubbleHost.offsetWidth || 20, h = bubbleHost.offsetHeight || 20;
    x = Math.min(Math.max(x, 4), window.innerWidth - w - 4); // clamp 在视口内，留 4px 边距
    y = Math.min(Math.max(y, 4), window.innerHeight - h - 4);
    var s = bubbleHost.style;
    s.right = "auto";
    s.left = x + "px";
    s.top = y + "px";
  }

  function restoreBubblePos() {
    try {
      var saved = sessionStorage.getItem(BUBBLE_POS_KEY);
      if (!saved) return;
      var p = saved.split(",");
      applyBubblePos(Number(p[0]), Number(p[1]));
    } catch (e) { /* ignore */ }
  }

  // ---------- MCP 操作记录（双击气泡查看；sessionStorage 持久化，按页面加载分组隔开） ----------
  // 服务端对本页的指令只有 eval 一个通道（click/type/get_text 等在 wire 层都是生成 JS 走 eval），
  // 因此记录 eval 即等于记录 MCP 做过的全部操作。

  var OP_LOG_KEY = "__web_bridge_op_log__";
  var OP_SESSIONS_MAX = 5;   // 最多保留最近几次页面加载
  var OP_ENTRIES_MAX = 100;  // 每次加载最多记录条数（超出丢最旧）
  var OP_CODE_MAX = 2000;    // 单条代码的存储截断长度

  var opLog = { sessions: [] };
  try {
    var opStored = sessionStorage.getItem(OP_LOG_KEY);
    if (opStored) {
      var opParsed = JSON.parse(opStored);
      if (opParsed && Array.isArray(opParsed.sessions)) opLog = opParsed;
    }
  } catch (e) { /* 数据损坏时从空日志重新开始 */ }
  opLog.sessions.push({ startedAt: Date.now(), entries: [] }); // 本次加载即新分组：刷新后旧记录隔到上一组
  if (opLog.sessions.length > OP_SESSIONS_MAX) opLog.sessions.splice(0, opLog.sessions.length - OP_SESSIONS_MAX);
  var opSession = opLog.sessions[opLog.sessions.length - 1];
  saveOpLog(); // 初始化即落盘，否则首次加载到刷新之间没有任何记录时，分组不会写入 storage

  function saveOpLog() {
    try { sessionStorage.setItem(OP_LOG_KEY, JSON.stringify(opLog)); } catch (e) { /* 写满/被禁时退化为内存记录 */ }
  }

  function recordEval(msg) {
    opSession.entries.push({
      ts: Date.now(), reqId: msg.reqId,
      note: typeof msg.note === "string" && msg.note ? msg.note.slice(0, 500) : null, // AI 附带的自然语言操作说明
      code: typeof msg.code === "string" ? msg.code.slice(0, OP_CODE_MAX) : String(msg.code),
      ok: null, durationMs: null, // null = 执行中，eval-result 回包后回填
    });
    if (opSession.entries.length > OP_ENTRIES_MAX) opSession.entries.splice(0, opSession.entries.length - OP_ENTRIES_MAX);
    saveOpLog();
    if (opDialogOpen) renderOpDialog(); // 对话框开着时实时刷新
  }

  function finishEvalRecord(reqId, ok, durationMs) {
    for (var i = opSession.entries.length - 1; i >= 0; i--) {
      if (opSession.entries[i].reqId === reqId) {
        opSession.entries[i].ok = ok;
        opSession.entries[i].durationMs = durationMs;
        break;
      }
    }
    saveOpLog();
    if (opDialogOpen) renderOpDialog();
  }

  // ---------- 操作记录对话框（独立 Shadow DOM 宿主，样式全走 CSSOM，与气泡同套隔离方案） ----------

  var opDialogHost = null, opDialogOpen = false, opDialogBody = null;

  function css(el, styles) {
    for (var k in styles) el.style[k] = styles[k];
    return el;
  }

  function openOpDialog() {
    if (opDialogOpen) { // 已开着但被 SPA 清掉 body 时重新挂回
      if (opDialogHost && !opDialogHost.isConnected && document.body) document.body.appendChild(opDialogHost);
      return;
    }
    opDialogOpen = true;
    if (!opDialogHost) buildOpDialog();
    document.body.appendChild(opDialogHost);
    document.addEventListener("keydown", opDialogEsc);
    renderOpDialog();
  }

  function opDialogEsc(e) { if (e.key === "Escape") closeOpDialog(); }

  function closeOpDialog() {
    if (!opDialogOpen) return;
    opDialogOpen = false;
    document.removeEventListener("keydown", opDialogEsc);
    if (opDialogHost && opDialogHost.parentNode) opDialogHost.parentNode.removeChild(opDialogHost);
  }

  // 部分页面（fullpage 整页滚动库、地图等）在 window 上捕获 wheel/touchmove 并 preventDefault 劫持滚动，
  // 弹窗与页面共享事件流，内部滚动会被页面吞掉。这里对可滚区域非被动接管：
  // 有可滚空间时 preventDefault + stopPropagation 并手动驱动 scrollTop，无空间时放行给页面。
  function hookWheel(scroller) {
    scroller.addEventListener("wheel", function (e) {
      var max = scroller.scrollHeight - scroller.clientHeight;
      if (max <= 0) return;
      e.preventDefault();
      e.stopPropagation();
      var delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1);
      scroller.scrollTop = Math.min(Math.max(scroller.scrollTop + delta, 0), max);
    }, { passive: false, capture: true });
    // 触摸滚动走 touchmove 而非 wheel，同样被页面劫持时在此接管
    var lastTouchY = null;
    scroller.addEventListener("touchstart", function (e) { lastTouchY = e.touches[0].clientY; }, { passive: true });
    scroller.addEventListener("touchmove", function (e) {
      var max = scroller.scrollHeight - scroller.clientHeight;
      if (max <= 0) { lastTouchY = null; return; }
      e.preventDefault();
      e.stopPropagation();
      if (lastTouchY == null) { lastTouchY = e.touches[0].clientY; return; }
      var y = e.touches[0].clientY;
      scroller.scrollTop = Math.min(Math.max(scroller.scrollTop + (lastTouchY - y), 0), max);
      lastTouchY = y;
    }, { passive: false, capture: true });
  }

  function buildOpDialog() {
    opDialogHost = document.createElement("div");
    css(opDialogHost, {
      position: "fixed", top: "0", left: "0", right: "0", bottom: "0",
      zIndex: "2147483647",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,.45)",
      fontFamily: "system-ui, -apple-system, sans-serif",
    });
    var root = opDialogHost.attachShadow ? opDialogHost.attachShadow({ mode: "open" }) : opDialogHost;
    var panel = document.createElement("div");
    css(panel, {
      background: "#fff", borderRadius: "10px", boxShadow: "0 8px 32px rgba(0,0,0,.3)",
      width: "560px", maxWidth: "calc(100vw - 32px)", maxHeight: "70vh",
      display: "flex", flexDirection: "column", overflow: "hidden",
    });
    var bar = document.createElement("div");
    css(bar, { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #e5e7eb" });
    var title = document.createElement("strong");
    title.textContent = "MCP 对本页的操作记录";
    css(title, { fontSize: "14px" });
    var closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    css(closeBtn, { border: "none", background: "none", fontSize: "16px", cursor: "pointer", color: "#666", padding: "2px 6px", lineHeight: "1" });
    closeBtn.addEventListener("click", closeOpDialog);
    bar.appendChild(title); bar.appendChild(closeBtn);
    opDialogBody = document.createElement("div");
    css(opDialogBody, { padding: "4px 16px 16px", overflowY: "auto", fontSize: "13px", color: "#111" });
    panel.appendChild(bar); panel.appendChild(opDialogBody);
    root.appendChild(panel);
    hookWheel(opDialogBody);
    // 滚轮/触摸落在标题栏、遮罩上时目标不在 body 内，原生滚动无处可去；转发给 body
    panel.addEventListener("wheel", function (e) {
      if (e.composedPath().indexOf(opDialogBody) !== -1) return; // body 自己的 hookWheel 已处理
      var max = opDialogBody.scrollHeight - opDialogBody.clientHeight;
      if (max <= 0) return;
      e.preventDefault();
      var delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? opDialogBody.clientHeight : 1);
      opDialogBody.scrollTop = Math.min(Math.max(opDialogBody.scrollTop + delta, 0), max);
    }, { passive: false, capture: true });
    opDialogHost.addEventListener("click", function (e) { if (e.target === opDialogHost) closeOpDialog(); }); // 点遮罩空白处关闭
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function renderOpDialog() {
    if (!opDialogBody) return;
    opDialogBody.textContent = "";
    for (var s = opLog.sessions.length - 1; s >= 0; s--) { // 最新一次加载排最上
      var session = opLog.sessions[s];
      var head = document.createElement("div");
      head.textContent = (session === opSession ? "── 本次加载 " : "── 上次加载 ") + fmtTime(session.startedAt) + " ──";
      css(head, { margin: "10px 0 6px", fontWeight: "600", color: "#6b7280", fontSize: "12px", borderTop: "1px solid #e5e7eb", paddingTop: "8px" });
      opDialogBody.appendChild(head);
      if (!session.entries.length) {
        var none = document.createElement("div");
        none.textContent = "（无操作）";
        css(none, { color: "#9ca3af", fontSize: "12px", padding: "2px 0 6px" });
        opDialogBody.appendChild(none);
        continue;
      }
      for (var i = 0; i < session.entries.length; i++) opDialogBody.appendChild(renderOpEntry(session.entries[i]));
    }
  }

  function renderOpEntry(entry) {
    var item = document.createElement("div");
    css(item, { marginBottom: "10px" });
    var line = document.createElement("div");
    css(line, { display: "flex", alignItems: "center", fontSize: "12px", gap: "8px" });
    var time = document.createElement("span");
    time.textContent = fmtTime(entry.ts);
    css(time, { color: "#6b7280" });
    var badge = document.createElement("span");
    if (entry.ok === true) {
      badge.textContent = "✓ " + (entry.durationMs != null ? entry.durationMs + "ms" : "");
      css(badge, { color: "#16a34a", fontWeight: "600" });
    } else if (entry.ok === false) {
      badge.textContent = "✗ " + (entry.durationMs != null ? entry.durationMs + "ms" : "");
      css(badge, { color: "#dc2626", fontWeight: "600" });
    } else {
      badge.textContent = "执行中…";
      css(badge, { color: "#9ca3af" });
    }
    line.appendChild(time); line.appendChild(badge);
    var noteEl = null;
    if (entry.note) { // 自然语言操作说明：主行，比代码显眼
      noteEl = document.createElement("div");
      noteEl.textContent = entry.note;
      css(noteEl, { margin: "3px 0 0", fontSize: "13px", fontWeight: "600", color: "#111827", lineHeight: "1.5" });
    }
    var pre = document.createElement("pre");
    pre.textContent = entry.code; // textContent 填充，杜绝代码注入
    css(pre, {
      margin: "4px 0 0", padding: "6px 8px", background: "#f5f5f5", borderRadius: "6px",
      fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "11px", lineHeight: "1.5",
      color: "#6b7280", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "100px", overflowY: "auto",
    });
    hookWheel(pre); // 单条代码超长时 pre 自身也可滚，同样接管 wheel
    item.appendChild(line);
    if (noteEl) item.appendChild(noteEl);
    item.appendChild(pre);
    return item;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureBubble);
  } else {
    ensureBubble();
  }

  connect();
})();
