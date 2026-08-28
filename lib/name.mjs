// name.mjs — 分组 → MCP server 命名规则（唯一实现）
// 规则：`web-bridge-mcp-<分组名slug>`。分组名转小写、非文字/数字压成 `-`、去首尾 `-`；
// 中日文等文字与数字保留（中文分组名直接可读）；slug 为空回退 `web-bridge-mcp`。
// lib/admin/admin.js（浏览器端，无构建无法共享模块）里有一份等价实现，改规则时两处同步。

export function mcpServerName(groupName) {
  const slug = String(groupName || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `web-bridge-mcp-${slug}` : "web-bridge-mcp";
}
