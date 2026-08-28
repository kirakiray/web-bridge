// version.mjs — 唯一版本来源：package.json 的 version 字段
// MCP serverInfo、管理后台页面均从此处取值；升版用 npm run bump（同步更新 SKILL.md frontmatter）

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const VERSION = pkg.version;
