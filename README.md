# web-bridge-mcp — Let AI editors operate any static web page

**web-bridge-mcp** is an MCP Server (single Node process, dual interfaces) that lets AI editors execute JavaScript, read the console, and simulate clicks / typing on any static web page that includes `client.js`. Great for cross-browser, multi-tab local debugging — and it can also be deployed to a public server.

```
   AI Editor             ┌───────────────────┐            Browser page
┌──────────────┐         │    MCP Server     │         ┌──────────────────┐
│  MCP Client  │         │  (Node, 1 process) │         │ <script src=     │
│              │ stdio or │ · Iface B: MCP    │WebSocket │  :3210/client.js">│
│  AI stops    │◄───────►│   (stdio / http)  │◄────────►│  client.js       │
│    here      │ Streamable│ · Iface A: WS    │ Iface A │  (eval execution/│
└──────────────┘ HTTP(remote)│ · HTTP /client.js│        │   console capture)│
                           └───────────────────┘        └──────────────────┘
```

The AI editor and the browser **never talk directly**: both connections terminate at the MCP Server (`server.js`, the relay). The AI manipulates pages indirectly through tool calls.

[中文文档 (Chinese)](README.zh-CN.md)

## Quick Start (3 steps)

Whether local or on a public server, the flow is the same: **① start the relay server with node → ② configure its http/https URL in your editor → ③ embed the `<script>` tag into your static page**.

### Step 1: Start the MCP relay server

```bash
# npm package: web-bridge-mcp — runs directly via npx; if you cloned this repo, run npm install first

# Local use (listens on 127.0.0.1 only by default)
npx web-bridge-mcp --transport http        # in this repo: npm run serve

# Deploy to a public server (token is mandatory on the public internet;
# keep it running with systemd / pm2)
npx web-bridge-mcp --transport http --host 0.0.0.0 --port 3210 --token <secret>
```

Once started there are three endpoints (localhost:3210 for example):

| Endpoint | URL | For |
| --- | --- | --- |
| MCP endpoint | `http://127.0.0.1:3210/mcp` | Paste into your editor (step 2) |
| Page script | `http://127.0.0.1:3210/client.js` | Embed into your page (step 3) |
| Status page | `http://127.0.0.1:3210/` | Open in a browser to see connected pages |

CLI flags can also be set via environment variables `PORT` / `HOST` / `TOKEN` / `TRANSPORT`.

### Step 2: Configure the relay server URL in your editor

**ZCode / Claude Code** (project `.mcp.json`, or `claude mcp add`), **Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "web-bridge-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3210/mcp"
    }
  }
}
```

When deployed on a server (with token), replace the URL with the public one and add the auth header:

```json
{
  "mcpServers": {
    "web-bridge-mcp": {
      "type": "http",
      "url": "https://your-domain.com/mcp",
      "headers": { "Authorization": "Bearer <secret>" }
    }
  }
}
```

> Note 1: `type` refers to the **MCP transport protocol** (`http` = Streamable HTTP transport; `stdio` = process pipe, see below) — it is independent of the URL's own protocol. So even if the `url` is `https://`, `type` stays `http`: https is simply http over TLS, and there is no separate `"https"` transport type.
>
> Note 2: Claude Desktop only supports the local [stdio mode](#alternative-local-stdio-mode-editor-starts-the-server) below.

### Step 3: Embed the script into your static page

Any page, any port works (CORS is open):

```html
<script src="http://127.0.0.1:3210/client.js"></script>
```

When deployed on a server, point the script at it (with token if enabled):

```html
<script src="https://your-domain.com/client.js?token=<secret>"></script>
```

### Verify

Tell the AI: "Use web-bridge-mcp's list_pages to see which pages are connected, then eval_js to click #btn and read the console". If it lists your page, all three steps are wired up.

> Order doesn't matter: the page can be opened before the server — client.js auto-reconnects (1s→2s→5s→10s backoff) and attaches as soon as the server is up. Hub status page: http://127.0.0.1:3210/
>
> Once embedded, the page shows a small draggable status bubble in the top-right corner (green = connected, yellow = connecting, red = disconnected), so you can always tell the page is bridged to the MCP server and whether the link is alive. Double-click the bubble to see exactly what the MCP server has done to the page — every operation with its natural-language note, success/failure and duration, grouped per page load.

## Alternative: local stdio mode (the editor starts the server)

If you only use it locally and don't want to run step 1 manually, put the server path directly in your editor config: the editor spawns it as a child process, MCP runs over the process's stdin/stdout pipe (no URL needed), and the relay is up automatically; the process exits with the editor.

```json
{
  "mcpServers": {
    "web-bridge-mcp": {
      "command": "npx",
      "args": ["-y", "web-bridge-mcp"],
      "env": { "PORT": "3210" }
    }
  }
}
```

(Same format for Cursor / Claude Desktop; if you cloned this repo, use `"command": "node", "args": ["/path/to/web-bridge-mcp/server.js"]` — see the template [mcp.json](mcp.json).)

How to choose:

| | HTTP mode (3-step guide above) | stdio mode |
| --- | --- | --- |
| Who starts server.js | You, manually; can live on a server | The editor, on demand |
| Editor config | Just a URL | command + args |
| Best for | Server deployment, multi-device / shared, remote access | Local instant use; the only option for Claude Desktop |

In both modes the browser side is identical (the `<script>` from step 3).

## Admin Console & Groups (multi-project / shared)

To serve multiple projects at once, or hand each person/editor its own isolated entry point, start in **group mode**:

```bash
npx web-bridge-mcp --transport http --port 3210 --admin <admin-password>

# In this repo: npm run serve:groups (password defaults to 123456; override with the ADMIN_PASSWORD env var)
```

Open `http://127.0.0.1:3210/admin`, log in with the admin password, and you can:

- **Create groups**: each group gets its own secret token plus two ready-to-copy snippets —
  - The editor-side **MCP JSON** (URL points to the group's own `/g/<token>/mcp`)
  - The page-side **relay `<script>` tag** (the group's own `/g/<token>/client.js`)
- **Human observation window** (auto-refresh every 1.5s — the human and the AI see the same live view):
  - Connected pages (title / pageId / URL / connected-at)
  - Console stream of any page
  - **AI call log** — every action the AI performed via MCP in this group's pages (tool, code, duration, result), so you can audit exactly what the AI did

Groups are fully isolated: an editor connected to group A cannot see or touch group B's pages. Group data persists in `data/groups.json` (customize with `--data <path>`; the file contains tokens — never commit it; `data/` is already gitignored).

> Security & limits: a group token equals full control of that group (arbitrary JS in its pages) — treat it like a password. Generate the admin password with `openssl rand -hex 32`; always use TLS on the public internet; in group mode editors can only connect via HTTP URL (stdio unavailable).

## MCP Tools

| Tool | Params | Description |
| --- | --- | --- |
| `list_pages` | — | List connected pages (pageId, title, URL, connected-at) |
| `eval_js` | `code`, optional `pageId` / `timeoutMs` / `note` | Execute arbitrary JS in the page and return the serialized result; `await` supported; last expression is returned automatically, or use `return` in a statement block; `$` / `$$` (querySelector / querySelectorAll) provided |
| `get_console` | optional `pageId` / `limit` | Read the page's recent console output and uncaught errors |
| `click` | `selector`, optional `pageId` / `note` | Find element by CSS selector and click() (scrolls into view first) |
| `type` | `selector` / `text`, optional `pageId` / `note` | Focus, write text, dispatch input / change events (contenteditable compatible) |
| `get_text` | optional `selector` (default body), `pageId` / `note` | Read element innerText |

`pageId` rule: it can be omitted when exactly one page is connected; with multiple pages and no pageId the tool returns an error plus the page list, and the AI retries with the right pageId.

`note`: a natural-language description of the operation, shown to the human on the page side (in the status-bubble operation log, above the executed code). The AI is instructed to always provide it; click/type/get_text fall back to a short label like `click #btn` when omitted.

## Public Deployment Notes

- **HTTPS pages can only reach `https/wss`** (mixed-content restriction). Use nginx / caddy as a reverse proxy for TLS termination; client.js auto-detects `X-Forwarded-Proto` / `X-Forwarded-Host` and generates the correct `wss://` URL — no extra config needed. caddy example (auto certs):

  ```
  your-domain.com {
    reverse_proxy 127.0.0.1:3210
  }
  ```

- With a token enabled, `/mcp` accepts three auth styles: `Authorization: Bearer <secret>` (recommended; put it in editor headers config), `X-Web-Bridge-MCP-Token: <secret>`, or the `?token=` query parameter.
- HTTP transport implements the official **Streamable HTTP** protocol (stateless): every request is handled independently while sharing the same hub, so multiple editors can connect at once.
- For public deployments always: set `--token`, use TLS, and only open the ports you need in the firewall.

## Security Notes

- By default the server listens on `127.0.0.1` only. Any web page open on this machine (including third-party sites you browse) can try to connect to the local port — in default no-token mode they could receive AI-sent code and forge results.
- On untrusted networks, or when exposing to LAN devices (`--host 0.0.0.0`), **always enable `--token`**: fetching client.js then requires `?token=<secret>`, and the first WebSocket packet is verified too.

## WebSocket Message Protocol (internal reference)

WS messages between the browser and the MCP Server are JSON text frames; refer to this when working on `lib/hub.mjs` / `client.js`:

| Direction | Message | Fields | Notes |
| --- | --- | --- | --- |
| page → server | `hello` | `role:"page"`, `pageId`, `url`, `title`, `ua`, `token?` | First packet after connect; disconnected if not received within 5s; duplicate pageId (duplicated tab) → new connection replaces the old |
| page → server | `page-info` | `url`, `title` | Sent on connect, DOMContentLoaded/load/popstate/hashchange, and every 5s as a poll fallback (SPAs) |
| page → server | `console` | `level`, `text`, `ts` | Wrapped console methods & uncaught errors, batched with 500ms throttle; server keeps a 500-entry ring buffer per page (kept after disconnect) |
| page → server | `eval-result` | `reqId`, `ok`, `value?`, `error?`, `durationMs` | Late responses (already timed out) are ignored |
| server → page | `welcome` | `pageId` | hello accepted |
| server → page | `eval` | `reqId`, `code`, `timeoutMs` | Code to execute |
| server → page | `error` | `error` | e.g. invalid token |

eval conventions (client.js): code is first wrapped as an expression `async () => ( code )`, falling back to a statement block (with `return`) on SyntaxError; `$` / `$$` are predefined; timeouts are enforced server-side (default 30s, max 120s); results are safely serialized as string previews (Error→stack, DOM→outerHTML excerpt, circular refs marked, depth ≤ 6, ≤ 50k chars).

## Development

- Tests: `npm test` (Node e2e: spawns the server + fake pages + tool calls over both stdio and HTTP transports); `npm run test:browser` (Playwright real-browser e2e: Chromium loads [test/test-page.html](test/test-page.html), verifies all 6 tools over a real WebSocket; run `npx playwright install chromium` first). The real-browser flow can also be verified manually with the test page.
- Dependencies: `ws` (WebSocket), `@modelcontextprotocol/sdk` (MCP), `zod` (validation); dev dependency `@playwright/test`. Node ≥ 18.
