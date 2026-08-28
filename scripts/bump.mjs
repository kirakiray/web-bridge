#!/usr/bin/env node
// bump.mjs — 统一升版：package.json + .agents/skills/web-bridge-mcp/SKILL.md frontmatter
// 用法：npm run bump            （等价 npm run bump patch）
//       npm run bump minor|major|patch
//       npm run bump 1.2.3      （指定精确版本）

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const skillPath = path.join(root, ".agents", "skills", "web-bridge-mcp", "SKILL.md");

const arg = process.argv[2] || "patch";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const oldVersion = pkg.version;
let [maj, min, pat] = pkg.version.split(".").map(Number);

if (arg === "major") { maj++; min = 0; pat = 0; }
else if (arg === "minor") { min++; pat = 0; }
else if (arg === "patch") { pat++; }
else if (/^\d+\.\d+\.\d+$/.test(arg)) { [maj, min, pat] = arg.split(".").map(Number); }
else {
  console.error(`无效参数: ${arg}（支持 major | minor | patch | x.y.z）`);
  process.exit(1);
}
const version = `${maj}.${min}.${pat}`;

pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

let skill = readFileSync(skillPath, "utf8");
if (/^version:.*$/m.test(skill)) {
  skill = skill.replace(/^version:.*$/m, `version: "${version}"`);
} else {
  // frontmatter 里还没有 version 字段：插在首行 --- 之后
  skill = skill.replace(/^---\n/, `---\nversion: "${version}"\n`);
}
writeFileSync(skillPath, skill);

console.log(`${oldVersion} -> ${version}（已同步 package.json 与 SKILL.md）`);
