// playwright.config.mjs — 真实浏览器链路测试配置
// 起两个独立实例，均用专用端口，避免与编辑器经 mcp.json 拉起的默认 3210 实例互相干扰：
//   1) 单实例模式（默认 3399，WB_TEST_PORT 可覆盖）
//   2) 分组模式 / 管理后台（默认 3398，WB_TEST_GPORT 可覆盖）
// hub 页面列表是共享状态，且多个用例依赖"单页时 pageId 可省略"，必须串行

const PORT = Number(process.env.WB_TEST_PORT) || 3399;
const GPORT = Number(process.env.WB_TEST_GPORT) || 3398;
const ADMIN_PW = "admin-test-pw";

export default {
  testDir: "./test",
  testMatch: "**/*.spec.mjs",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    headless: true,
  },
  webServer: [
    {
      command: `node server.js --transport http --port ${PORT}`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node server.js --transport http --admin ${ADMIN_PW} --port ${GPORT}`,
      url: `http://127.0.0.1:${GPORT}/`,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
};
