// registry.mjs — 页面注册表：hub（单实例模式）与 group-server（分组模式）共用的核心
// 职责：页面注册、console 环形缓冲、eval 路由与超时、eval 调用历史（供管理后台观察）
// 通过 handleConnection(ws) 挂到任意 WebSocketServer 的连接上（upgrade 路由由宿主负责）

import { randomUUID } from "node:crypto";

const CONSOLE_BUFFER_MAX = 500;
const EVAL_HISTORY_MAX = 200;
const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
const MAX_EVAL_TIMEOUT_MS = 120_000;
const HELLO_TIMEOUT_MS = 5_000;

/**
 * @param {{token?:string|null, log?:(...args:unknown[])=>void}} [options]
 *   token：hello 首包校验口令；null 表示不校验（分组模式下由 ws 路径中的分组 token 承担鉴权）
 */
export function createRegistry(options = {}) {
  const { token = null, log = () => {} } = options;

  /** 已连接页面：pageId -> entry */
  const pages = new Map();
  /** console 缓冲：pageId -> entries[]（页面断连后仍保留，便于事后排查） */
  const consoleBuffers = new Map();
  /** 进行中的 eval：reqId -> { resolve, timer, pageId } */
  const pendingEvals = new Map();
  /** eval 调用历史（环形）：最近 EVAL_HISTORY_MAX 条，管理后台观察用 */
  const evalHistory = [];
  let reqSeq = 0;

  function recordEval(entry) {
    evalHistory.push(entry);
    if (evalHistory.length > EVAL_HISTORY_MAX) evalHistory.splice(0, evalHistory.length - EVAL_HISTORY_MAX);
  }

  // ---------- WebSocket 连接（协议与单实例模式完全一致） ----------

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

  // ---------- 对 MCP 层暴露的能力 ----------

  function listPages() {
    return [...pages.values()].map(({ ws, ...rest }) => rest);
  }

  /**
   * @param {{pageId:string, code:string, timeoutMs?:number, label?:string, note?:string}} params
   *   label：调用来源的可读标注（如 "eval_js" / "click #btn"），记入 eval 历史
   *   note：AI 提供的自然语言操作说明，随 eval 消息下发给页面（页面用户可见）
   * @returns {Promise<{ok:true, value?:string, durationMs?:number} | {ok:false, error:string}>}
   */
  async function evalJs({ pageId, code, timeoutMs, label, note }) {
    const t = Math.min(Math.max(1, Number(timeoutMs) || DEFAULT_EVAL_TIMEOUT_MS), MAX_EVAL_TIMEOUT_MS);
    const noteText = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : "";
    const finish = (result) => {
      recordEval({
        ts: Date.now(),
        tool: label || "eval",
        pageId: pageId ?? null,
        ok: !!result.ok,
        durationMs: result.durationMs ?? null,
        code: String(code).slice(0, 300),
        note: noteText.slice(0, 300) || null,
        result: String(result.ok ? (result.value ?? "(undefined)") : result.error).slice(0, 300),
      });
      return result;
    };

    const entry = pages.get(pageId);
    if (!entry) {
      return finish({ ok: false, error: `页面未连接: ${pageId}` });
    }
    if (entry.ws.readyState !== 1 /* OPEN */) {
      return finish({ ok: false, error: `页面连接已关闭: ${pageId}` });
    }
    const reqId = `r${++reqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingEvals.delete(reqId);
        resolve(finish({ ok: false, error: `eval 超时（${t}ms），代码可能包含死循环或未决 Promise` }));
      }, t);
      // 包一层 finish：所有回包路径（eval-result / 断连 / 服务关闭）都记入 eval 历史
      pendingEvals.set(reqId, { resolve: (result) => resolve(finish(result)), timer, pageId });
      try {
        const msg = { type: "eval", reqId, code, timeoutMs: t };
        if (noteText) msg.note = noteText; // 说明下发给页面（老 client.js 忽略未知字段，向后兼容）
        entry.ws.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        pendingEvals.delete(reqId);
        resolve(finish({ ok: false, error: `发送失败: ${err?.message || err}` }));
      }
    });
  }

  function getConsole({ pageId, limit = 50 } = {}) {
    const buf = consoleBuffers.get(pageId) || [];
    const n = Math.min(Math.max(1, Number(limit) || 50), CONSOLE_BUFFER_MAX);
    return buf.slice(-n);
  }

  /** 最近的 eval 调用历史（管理后台观察 AI 行为用） */
  function getEvals({ limit = 100 } = {}) {
    const n = Math.min(Math.max(1, Number(limit) || 100), EVAL_HISTORY_MAX);
    return evalHistory.slice(-n);
  }

  /** 断开所有页面连接、结束所有进行中的 eval（分组删除 / 服务关闭时调用） */
  function close() {
    for (const [, p] of pendingEvals) { clearTimeout(p.timer); p.resolve({ ok: false, error: "服务已关闭" }); }
    pendingEvals.clear();
    for (const [, entry] of pages) {
      try { entry.ws.terminate(); } catch { /* ignore */ }
    }
    pages.clear();
  }

  return { handleConnection, listPages, evalJs, getConsole, getEvals, close };
}
