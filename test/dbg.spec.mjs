import { test } from "@playwright/test";
test("probe8", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent("<h1>x</h1>");
  await page.addScriptTag({ url: "http://127.0.0.1:3399/client.js" });
  await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 80; c.height = 40;
    c.getContext('2d').fillRect(0, 0, 80, 40);
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
    navigator.mediaDevices.getDisplayMedia = () => Promise.resolve(c.captureStream(30));
  });
  const r = await page.evaluate(async () => {
    let out;
    try {
      const v = await Promise.race([window.__wbCapture(), new Promise(res => setTimeout(() => res('TIMEOUT'), 8000))]);
      out = typeof v === 'string' ? v : 'ok ' + v.__wbShot.w;
    } catch (e) { out = 'ERR ' + e.message; }
    return [out, window.__wbSteps];
  });
  console.log("P8:", JSON.stringify(r));
  await ctx.close();
});
