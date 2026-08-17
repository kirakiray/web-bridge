// playwright.config.mjs — 真实浏览器链路测试配置
// 用独立端口（默认 3399，WB_TEST_PORT 可覆盖）起一个 web-bridge（HTTP 传输），
// 避免与编辑器经 mcp.json 拉起的默认 3210 实例互相干扰

const PORT = Number(process.env.WB_TEST_PORT) || 3399;

export default {
  testDir: "./test",
  testMatch: "**/*.spec.mjs",
  timeout: 30_000,
  // hub 的页面列表是共享状态，且多个用例依赖"单页时 pageId 可省略"，必须串行
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    headless: true,
  },
  webServer: {
    command: `node server.js --transport http --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
};
