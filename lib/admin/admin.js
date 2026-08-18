// web-bridge 管理后台 — 与 /admin/api/* 交互的单页逻辑（无框架、无构建）
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
        "<td class='muted'>" + esc(g.createdAt ? new Date(g.createdAt).toLocaleString() : "") + "</td>" +
        "<td><span class='pill" + (g.online ? " online" : "") + "'>" + g.online + "</span></td>" +
        "<td class='ops-col'><button class='btn detail-btn' data-id='" + esc(g.id) + "'>详情</button> " +
        "<button class='btn del-btn' data-id='" + esc(g.id) + "'>删除</button></td>";
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
    $("script-snippet").textContent = '<script src="' + origin + "/g/" + g.token + '/client.js"><\/script>';
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
        "<td class='muted'>" + esc(pg.url) + "</td>" +
        "<td class='muted'>" + esc(new Date(pg.connectedAt).toLocaleTimeString()) + "</td>";
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
    }).join("\n") || "（该页面暂无日志）";
  }

  function renderEvals(list) {
    var tb = $("evals-table").tBodies[0];
    tb.innerHTML = "";
    list.slice().reverse().forEach(function (e) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td class='muted'>" + timeStr(e.ts) + "</td>" +
        "<td><span class='tool-tag'>" + esc(e.tool) + "</span></td>" +
        "<td><span class='state " + (e.ok ? "ok" : "fail") + "'>" + (e.ok ? "✓" : "✗") + "</span></td>" +
        "<td class='muted'>" + (e.durationMs == null ? "-" : e.durationMs + "ms") + "</td>" +
        "<td><code class='code-cell'>" + esc(cut(e.code, 100)) + "</code></td>" +
        "<td><code class='code-cell'>" + esc(cut(e.result, 100)) + "</code></td>";
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
