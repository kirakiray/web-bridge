// web-bridge 管理后台 — 与 /admin/api/* 交互的单页逻辑（无框架、无构建）
// i18n：跟随浏览器语言默认中文/英文，顶部可手动切换，选择存 localStorage
(function () {
  "use strict";
  var state = { groups: [], detail: null, consolePage: "", timer: 0 };

  // ---------- i18n ----------
  var I18N = {
    "zh-CN": {
      brandSub: "管理后台", loginHint: "输入管理密码登录，管理分组并观察 AI 与页面",
      password: "管理密码", login: "登录", logout: "退出登录",
      wrongPassword: "密码错误", groupNameNeeded: "请输入分组名称",
      groups: "分组", createGroup: "创建分组", newGroupPh: "新分组名称，如：商城项目 / 联调手机",
      colCreated: "创建时间", colOnline: "在线页面", colOps: "操作", detail: "详情", del: "删除",
      noGroups: "还没有分组，先创建一个",
      groupFoot: "每个分组有专属密钥（token）：编辑器用它接入 MCP，网页用它引入联动脚本，分组间完全隔离。token 等同于该分组的完整控制权，请妥善保管。",
      back: "← 返回", mcpTitle: "编辑器 MCP 配置", mcpSub: "复制后粘进 ZCode / Claude Code / Cursor 的 mcp 配置",
      scriptTitle: "网页联动脚本", scriptSub: "塞进要观察 / 操控的静态页面",
      copy: "复制", copied: "已复制",
      pagesTitle: "在线页面", pagesSub: "自动刷新", colTitle: "标题", colPageId: "pageId",
      colUrl: "URL", colConnTime: "连接时间", noPages: "暂无页面连接——把上面的联动脚本塞进网页并打开它",
      consoleTitle: "页面控制台", consolePick: "（选择页面）",
      consolePickHint: "（选择上方页面查看其 console 输出）", consoleEmpty: "（该页面暂无日志）",
      evalsTitle: "AI 调用记录", evalsSub: "AI 经 MCP 在本分组页面里执行过的操作，最新在前",
      colTime: "时间", colTool: "工具", colResult: "结果", colDuration: "耗时", colCode: "代码", colReturn: "返回",
      noEvals: "暂无记录——AI 通过该分组的 MCP 地址调用工具后，这里会实时出现",
      confirmDel: name => "删除分组「" + name + "」？其专属地址全部失效，已连接页面会被断开。",
      noTitle: "(无标题)", timeUnit: "ms",
    },
    "en": {
      brandSub: "Admin Console", loginHint: "Enter the admin password to manage groups and watch AI & pages",
      password: "Admin password", login: "Log in", logout: "Log out",
      wrongPassword: "Wrong password", groupNameNeeded: "Please enter a group name",
      groups: "Groups", createGroup: "Create group", newGroupPh: "New group name, e.g. shop-project / mobile-testing",
      colCreated: "Created", colOnline: "Online pages", colOps: "Actions", detail: "Detail", del: "Delete",
      noGroups: "No groups yet — create one first",
      groupFoot: "Each group has its own secret token: editors use it for MCP access, pages use it for the relay script; groups are fully isolated. A token grants full control of its group — keep it safe.",
      back: "← Back", mcpTitle: "Editor MCP config", mcpSub: "Copy into ZCode / Claude Code / Cursor mcp config",
      scriptTitle: "Page relay script", scriptSub: "Embed into the static page you want to observe / control",
      copy: "Copy", copied: "Copied",
      pagesTitle: "Connected pages", pagesSub: "auto refresh", colTitle: "Title", colPageId: "pageId",
      colUrl: "URL", colConnTime: "Connected", noPages: "No pages yet — embed the relay script above into a page and open it",
      consoleTitle: "Page console", consolePick: "(pick a page)",
      consolePickHint: "(Pick a page above to view its console output)", consoleEmpty: "(No logs on this page yet)",
      evalsTitle: "AI call log", evalsSub: "Actions the AI performed via MCP in this group's pages, newest first",
      colTime: "Time", colTool: "Tool", colResult: "Result", colDuration: "Took", colCode: "Code", colReturn: "Returned",
      noEvals: "Nothing yet — entries appear here once the AI calls tools via this group's MCP endpoint",
      confirmDel: name => "Delete group \"" + name + "\"? Its URLs stop working and connected pages will be dropped.",
      noTitle: "(untitled)", timeUnit: "ms",
    },
    "ja": {
      brandSub: "管理コンソール", loginHint: "管理パスワードでログインし、グループを管理して AI とページを観察します",
      password: "管理パスワード", login: "ログイン", logout: "ログアウト",
      wrongPassword: "パスワードが違います", groupNameNeeded: "グループ名を入力してください",
      groups: "グループ", createGroup: "グループ作成", newGroupPh: "新しいグループ名（例：ショッププロジェクト / モバイル調整）",
      colCreated: "作成日時", colOnline: "オンラインページ", colOps: "操作", detail: "詳細", del: "削除",
      noGroups: "グループはまだありません。まず作成してください",
      groupFoot: "各グループには専用トークンがあります。エディターは MCP 接続に、ページは連携スクリプトに使用し、グループ間は完全に分離されます。トークンはそのグループの完全な制御権と同義です。厳重に保管してください。",
      back: "← 戻る", mcpTitle: "エディター MCP 設定", mcpSub: "コピーして ZCode / Claude Code / Cursor の mcp 設定に貼り付けてください",
      scriptTitle: "ページ連携スクリプト", scriptSub: "観察 / 操作したい静的ページに埋め込んでください",
      copy: "コピー", copied: "コピーしました",
      pagesTitle: "接続中のページ", pagesSub: "自動更新", colTitle: "タイトル", colPageId: "pageId",
      colUrl: "URL", colConnTime: "接続時刻", noPages: "ページ未接続 — 上の連携スクリプトをページに埋め込んで開いてください",
      consoleTitle: "ページコンソール", consolePick: "（ページを選択）",
      consolePickHint: "（上のページを選択するとコンソール出力が表示されます）", consoleEmpty: "（このページにログはまだありません）",
      evalsTitle: "AI 呼び出し履歴", evalsSub: "AI が MCP 経由でこのグループのページで実行した操作、新しい順",
      colTime: "時刻", colTool: "ツール", colResult: "結果", colDuration: "所要", colCode: "コード", colReturn: "戻り値",
      noEvals: "記録はまだありません — AI がこのグループの MCP エンドポイントでツールを呼び出すと、ここにリアルタイムで表示されます",
      confirmDel: name => "グループ「" + name + "」を削除しますか？専用 URL はすべて無効になり、接続中のページも切断されます。",
      noTitle: "(無題)", timeUnit: "ms",
    },
  };
  // 语言注册表：id → 显示名。新增语言只需在 I18N 加字典 + 这里加一行
  var LANGS = [
    { id: "zh-CN", name: "简体中文" },
    { id: "en", name: "English" },
    { id: "ja", name: "日本語" },
  ];
  var lang = "zh-CN";
  function detectLang() {
    var saved = null;
    try { saved = localStorage.getItem("wb-lang"); } catch (e) { /* ignore */ }
    if (saved && I18N[saved]) return saved;
    var nav = (navigator.language || "").toLowerCase();
    if (nav.startsWith("zh")) return "zh-CN";
    if (nav.startsWith("ja")) return "ja";
    return "en";
  }
  function t(key) {
    var entry = I18N[lang][key];
    return typeof entry === "function" ? entry : (entry != null ? entry : key);
  }

  function $(id) { return document.getElementById(id); }
  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function timeStr(ts) { var d = new Date(ts); return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()); }
  function cut(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      // 仅"已登录会话"的 401 才视为掉线跳登录页；login 本身的 401 = 密码错误，正常下发
      if (res.status === 401 && !/\/admin\/api\/login$/.test(url)) { showLogin(); throw new Error("unauthorized"); }
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

  // ---------- 语言应用 ----------
  function applyLang() {
    document.title = "web-bridge " + t("brandSub");
    var map = {
      "brand-sub": t("brandSub"), "brand-sub-top": t("brandSub"),
      "login-hint": t("loginHint"), "logout-btn": t("logout"),
      "pw": t("password"), "login-btn": t("login"),
      "groups-title": t("groups"), "group-name": t("newGroupPh"), "create-btn": t("createGroup"),
      "th-created": t("colCreated"), "th-online": t("colOnline"), "th-ops": t("colOps"),
      "group-foot": t("groupFoot"),
      "back-btn": t("back"), "mcp-title": t("mcpTitle"), "mcp-sub": t("mcpSub"),
      "script-title": t("scriptTitle"), "script-sub": t("scriptSub"),
      "copy-mcp": t("copy"), "copy-script": t("copy"),
      "pages-title": t("pagesTitle"), "pages-sub": t("pagesSub"),
      "th-title": t("colTitle"), "th-pageid": t("colPageId"), "th-url": t("colUrl"), "th-conn": t("colConnTime"),
      "console-title": t("consoleTitle"), "console-def": t("consolePick"),
      "evals-title": t("evalsTitle"), "evals-sub": t("evalsSub"),
      "th-time": t("colTime"), "th-tool": t("colTool"), "th-result": t("colResult"),
      "th-duration": t("colDuration"), "th-code": t("colCode"), "th-return": t("colReturn"),
    };
    for (var id in map) {
      var el = $(id);
      if (!el) continue;
      if (el.tagName === "INPUT") el.placeholder = map[id];
      else el.textContent = map[id];
    }
    // 重新渲染动态区域（表格、下拉、提示语）
    renderGroups();
    if (state.detail) { renderPages(lastPages); renderEvals(lastEvals); }
  }
  // 语言下拉框（登录页与顶栏各一个，按 LANGS 注册表动态渲染）
  function renderLangSelects() {
    ["lang-select-login", "lang-select-top"].forEach(function (id) {
      var sel = $(id);
      if (!sel) return;
      sel.innerHTML = "";
      LANGS.forEach(function (l) {
        var o = document.createElement("option");
        o.value = l.id;
        o.textContent = l.name;
        if (lang === l.id) o.selected = true;
        sel.appendChild(o);
      });
    });
  }
  ["lang-select-login", "lang-select-top"].forEach(function (id) {
    document.addEventListener("change", function (e) {
      if (e.target.id === id) setLang(e.target.value);
    });
  });
  function setLang(l) {
    if (!I18N[l] || lang === l) return;
    lang = l;
    try { localStorage.setItem("wb-lang", l); } catch (e) { /* ignore */ }
    renderLangSelects();
    applyLang();
  }

  // ---------- 登录 ----------
  function doLogin() {
    api("POST", "/admin/api/login", { password: $("pw").value }).then(function (r) {
      if (r.status === 200) { $("login-err").textContent = ""; $("pw").value = ""; enter(); }
      else { $("login-err").textContent = t("wrongPassword"); }
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
    if (!tb) return;
    tb.innerHTML = "";
    state.groups.forEach(function (g) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(g.name) + "</td>" +
        "<td class='muted'>" + esc(g.createdAt ? new Date(g.createdAt).toLocaleString() : "") + "</td>" +
        "<td><span class='pill" + (g.online ? " online" : "") + "'>" + g.online + "</span></td>" +
        "<td class='ops-col'><button class='btn detail-btn' data-id='" + esc(g.id) + "'>" + esc(t("detail")) + "</button> " +
        "<button class='btn del-btn' data-id='" + esc(g.id) + "'>" + esc(t("del")) + "</button></td>";
      tb.appendChild(tr);
    });
    if (!state.groups.length) {
      var tr2 = document.createElement("tr");
      tr2.innerHTML = "<td colspan='4' class='muted'>" + esc(t("noGroups")) + "</td>";
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
      if (g && confirm(t("confirmDel")(g.name))) {
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
    if (!name) { $("create-err").textContent = t("groupNameNeeded"); $("group-name").focus(); return; }
    $("create-err").textContent = "";
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
      mcpServers: { "web-bridge-mcp": { type: "http", url: origin + "/g/" + g.token + "/mcp" } }
    }, null, 2);
    $("script-snippet").textContent = '<script src="' + origin + "/g/" + g.token + '/client.js"><\/script>';
    $("console-view").textContent = t("consolePickHint");
    refreshDetail();
  }
  $("back-btn").onclick = function () {
    state.detail = null;
    $("detail").hidden = true;
    $("groups-section").hidden = false;
    loadGroups();
  };

  var lastPages = [];
  var lastEvals = [];

  function refreshDetail() {
    var g = state.detail;
    if (!g) return;
    api("GET", "/admin/api/groups/" + g.id + "/pages").then(function (r) {
      lastPages = r.data.pages || [];
      renderPages(lastPages);
    }).catch(function () {});
    api("GET", "/admin/api/groups/" + g.id + "/evals?limit=50").then(function (r) {
      lastEvals = r.data.evals || [];
      renderEvals(lastEvals);
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
      tr.innerHTML = "<td>" + esc(pg.title || t("noTitle")) + "</td>" +
        "<td><code>" + esc(pg.pageId.slice(0, 8)) + "</code></td>" +
        "<td class='muted'>" + esc(pg.url) + "</td>" +
        "<td class='muted'>" + esc(new Date(pg.connectedAt).toLocaleTimeString()) + "</td>";
      tb.appendChild(tr);
    });
    if (!list.length) {
      var tr2 = document.createElement("tr");
      tr2.innerHTML = "<td colspan='4' class='muted'>" + esc(t("noPages")) + "</td>";
      tb.appendChild(tr2);
    }
    var sel = $("console-page");
    var prev = state.consolePage;
    sel.innerHTML = "";
    var def = document.createElement("option");
    def.value = ""; def.id = "console-def"; def.textContent = t("consolePick");
    sel.appendChild(def);
    list.forEach(function (pg) {
      var o = document.createElement("option");
      o.value = pg.pageId;
      o.textContent = cut(pg.title || t("noTitle"), 20) + " · " + pg.pageId.slice(0, 8);
      if (pg.pageId === prev) o.selected = true;
      sel.appendChild(o);
    });
    var still = list.some(function (pg) { return pg.pageId === prev; });
    state.consolePage = still ? prev : "";
    if (!still) $("console-view").textContent = list.length ? t("consolePickHint") : t("noPages");
  }
  $("console-page").addEventListener("change", function () {
    state.consolePage = this.value;
    $("console-view").textContent = "";
  });

  function renderConsole(entries) {
    $("console-view").textContent = entries.map(function (e) {
      return "[" + timeStr(e.ts) + "] [" + e.level + "] " + e.text;
    }).join("\n") || t("consoleEmpty");
  }

  function renderEvals(list) {
    var tb = $("evals-table").tBodies[0];
    tb.innerHTML = "";
    list.slice().reverse().forEach(function (e) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td class='muted'>" + timeStr(e.ts) + "</td>" +
        "<td><span class='tool-tag'>" + esc(e.tool) + "</span></td>" +
        "<td><span class='state " + (e.ok ? "ok" : "fail") + "'>" + (e.ok ? "✓" : "✗") + "</span></td>" +
        "<td class='muted'>" + (e.durationMs == null ? "-" : e.durationMs + t("timeUnit")) + "</td>" +
        "<td><code class='code-cell'>" + esc(cut(e.code, 100)) + "</code></td>" +
        "<td><code class='code-cell'>" + esc(cut(e.result, 100)) + "</code></td>";
      tb.appendChild(tr);
    });
    if (!list.length) {
      var tr2 = document.createElement("tr");
      tr2.innerHTML = "<td colspan='6' class='muted'>" + esc(t("noEvals")) + "</td>";
      tb.appendChild(tr2);
    }
  }

  // ---------- 复制 ----------
  function copyText(text, btn) {
    function ok() {
      var old = btn.dataset.label || btn.textContent;
      btn.textContent = t("copied");
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
  lang = detectLang();
  renderLangSelects();
  applyLang();
  fetch("/admin/api/session").then(function (res) {
    return res.json();
  }).then(function (data) {
    if (data && data.loggedIn) enter(); else showLogin();
  }).catch(showLogin);
})();
