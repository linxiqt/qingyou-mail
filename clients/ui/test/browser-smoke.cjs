// Local, network-free rendering/interaction test. Does not connect to any mailbox.
// Run: node clients/ui/test/browser-smoke.cjs
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  out = path.resolve(__dirname, ".artifacts");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file =
      pathname === "/bridge.js"
        ? path.join(__dirname, "fixture.js")
        : path.resolve(
            root,
            "." + (pathname === "/" ? "/index.html" : pathname),
          );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
        path.extname(file)
      ] || "application/octet-stream",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
let browser, ws, profile, closeBrowser;
async function run() {
  await fs.mkdir(out, { recursive: true });
  profile = path.join(out, "edge-profile-" + Date.now());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const executable =
    process.env.UI_TEST_BROWSER ||
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  browser = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--disable-gpu",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  let debuggingPort;
  for (let i = 0; i < 200; i++) {
    try {
      debuggingPort = (
        await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await delay(50);
    }
  }
  if (!debuggingPort) throw Error("Browser did not start");
  const targets = await (
    await fetch("http://127.0.0.1:" + debuggingPort + "/json")
  ).json();
  ws = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const pending = new Map();
  let sequence = 0;
  const errors = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === "Runtime.exceptionThrown")
      errors.push(
        m.params.exceptionDetails.text +
          " " +
          (m.params.exceptionDetails.exception?.description || ""),
      );
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  closeBrowser = () => cdp('Browser.close');
  const evaluate = async (expression) => {
    const r = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.exception?.description || r.exceptionDetails.text,
      );
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(30);
    }
    throw Error("UI condition timed out: " + expression);
  };
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) =>
    evaluate(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  const screenshot = async (name) => {
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(
      path.join(out, name + ".png"),
      Buffer.from(shot.data, "base64"),
    );
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Page.navigate", { url: base });
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  assert.equal(
    await evaluate(`document.querySelector('.shell').scrollWidth<=innerWidth`),
    true,
  );
  await click('[data-id="m1"]');
  await wait(`!!document.querySelector('.message-body')`);
  assert.match(
    await evaluate(`document.querySelector('.message-body').textContent`),
    /周四下午两点/,
  );
  await screenshot("desktop-inbox");
  await click('[data-action="download"]');
  await wait(`window.__fixture.downloads.length===1`);
  assert.equal(
    await evaluate(`!!document.querySelector('[data-action="ai-settings"]')`),
    false,
  );
  await click('[data-action="api-docs"]');
  await wait(`!!document.querySelector('.api-article h2')`);
  assert.equal(
    await evaluate(`document.querySelectorAll('.api-nav-item').length`),
    32,
  );
  assert.equal(
    await evaluate(`document.querySelector('.shell').scrollWidth<=innerWidth`),
    true,
  );
  await click('[data-copy="server"]');
  await wait(`window.__fixture.copies?.length===1`);
  assert.equal(
    await evaluate(`window.__fixture.copies[0]`),
    "https://mail.example.test",
  );
  await click('[data-copy="openapi-mail"]');
  await wait(`window.__fixture.copies.length===2`);
  assert.equal(
    await evaluate(
      `Object.values(JSON.parse(window.__fixture.copies[1]).paths).reduce((n,p)=>n+Object.keys(p).length,0)`,
    ),
    8,
  );
  await click('[data-copy="openapi"]');
  await wait(`window.__fixture.copies.length===3`);
  assert.equal(
    await evaluate(
      `Object.values(JSON.parse(window.__fixture.copies[2]).paths).reduce((n,p)=>n+Object.keys(p).length,0)`,
    ),
    31,
  );
  await screenshot("desktop-api-overview");
  await fill('[aria-label="搜索接口"]', "getMail");
  assert.equal(
    await evaluate(`document.querySelectorAll('.api-nav-item').length`),
    2,
  );
  await click('[data-endpoint="getMail"]');
  await click('[data-copy="curl"]');
  await wait(`window.__fixture.copies.length===4`);
  assert.match(
    await evaluate(`window.__fixture.copies[3]`),
    /\/api\/v1\/manage\/messages\/123/,
  );
  assert.match(await evaluate(`window.__fixture.copies[3]`), /po_YOUR_API_KEY/);
  await screenshot("desktop-api-endpoint");
  await fill('[aria-label="搜索接口"]', "nothing-exists");
  assert.match(
    await evaluate(`document.querySelector('.api-count').textContent`),
    /0 个接口/,
  );
  await click("[data-reset-search]");
  await evaluate(`window.__fixture.copyFails=true`);
  await click('[data-copy="all"]');
  await wait(`!!document.querySelector('.api-copy-fallback')`);
  assert.match(
    await evaluate(`document.querySelector('.api-copy-status').textContent`),
    /复制失败/,
  );
  assert.match(
    await evaluate(`document.querySelector('.api-copy-fallback').value`),
    /operationId: createDomain/,
  );
  await evaluate(`window.__fixture.copyFails=false`);
  await click('[data-copy="all"]');
  await wait(`window.__fixture.copies.length===5`);
  assert.equal(
    await evaluate(`!!document.querySelector('.api-copy-fallback')`),
    false,
  );
  await click('[data-action="api-exit"]');
  await click('[data-action="compose"]');
  await wait(`!!document.querySelector('#compose-form')`);
  await fill('[name="to"]', "colleague@example.test");
  await fill('[name="subject"]', "隔离测试草稿");
  await fill('[name="text"]', "本地测试，不会连接真实服务器。");
  await click('[data-action="save-draft"]');
  await wait(
    `document.querySelector('#draft-status').textContent.includes('已保存')`,
  );
  await evaluate(`document.querySelector('#compose-form').requestSubmit()`);
  await wait(
    `window.__fixture.sent.length===2&&!document.querySelector('#dialog').open`,
  );
  assert.equal(
    await evaluate(`window.__fixture.sent[1].body.draftId`),
    "saved-draft",
  );
  // A delayed search from account A must never replace account B's mailbox.
  await fill("#search", "slow");
  await delay(290);
  await click('[data-action="accounts"]');
  await click('[data-action="switch"][data-id="personal"]');
  await wait(
    `document.querySelector('.mail-subject')?.textContent==='个人邮箱专属邮件'`,
  );
  await delay(450);
  assert.equal(
    await evaluate(`document.querySelectorAll('.mail-row').length`),
    1,
  );
  assert.equal(
    await evaluate(`document.querySelector('.mail-subject').textContent`),
    "个人邮箱专属邮件",
  );
  await click('[data-action="api-docs"]');
  await wait(`!!document.querySelector('[data-copy="server"]')`);
  await click('[data-copy="server"]');
  await wait(`window.__fixture.copies.length===6`);
  assert.equal(
    await evaluate(`window.__fixture.copies.at(-1)`),
    "https://second.example.test:8443",
  );
  await click('[data-action="accounts"]');
  await click('[data-action="switch"][data-id="admin"]');
  await wait(`window.__fixture.opens.length===1`);
  assert.equal(await evaluate(`!!document.querySelector('.admin-pane')`), true);
  assert.equal(
    await evaluate(`!!document.querySelector('.message-list')`),
    false,
  );
  await screenshot("desktop-admin");
  await click('[data-action="api-docs"]');
  await wait(`!!document.querySelector('[data-copy="server"]')`);
  assert.equal(
    await evaluate(`document.querySelector('.api-code pre').textContent`),
    "https://mail.example.test",
  );
  await screenshot("desktop-admin-api");
  // Android shares the documentation and copy UI; admin launch stays desktop-only.
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp("Page.navigate", { url: base + "/?android=1" });
  await wait(
    `document.querySelector('[data-mailbox-count="inbox"]')?.textContent==='4'`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-mailbox-count="unread"]').textContent`,
    ),
    "2",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-mailbox-count="sent"]').textContent`,
    ),
    "8",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-mailbox-count="trash"]').textContent`,
    ),
    "0",
  );
  assert.equal(await evaluate(`window.__postofficeBack()`), false);
  const fits = async () => {
    assert.equal(
      await evaluate(`document.documentElement.scrollWidth<=innerWidth`),
      true,
    );
    assert.deepEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('.phone-nav button,.mailbox-tile,.phone-folder-group button,.phone-filters button')).filter(el=>el.getClientRects().length&&!el.closest('[inert]')).filter(el=>{const r=el.getBoundingClientRect();return r.width<48||r.height<48}).map(el=>el.textContent)`,
      ),
      [],
    );
  };
  await fits();
  await screenshot("android-overview");
  await evaluate(`document.querySelector('.phone-overview').scrollTop=1000`);
  await screenshot("android-overview-folders");
  await evaluate(`document.querySelector('.phone-overview').scrollTop=0`);
  await click('.mailbox-tiles [data-folder="inbox"]');
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  assert.equal(
    await evaluate(`document.querySelector('.shell').scrollWidth<=innerWidth`),
    true,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.mail-row').getBoundingClientRect().top < innerHeight*.6`,
    ),
    true,
  );
  await fits();
  await screenshot("android-inbox");
  await click('.phone-nav [data-action="accounts"]');
  await screenshot("android-accounts");
  assert.equal(await evaluate(`window.__postofficeBack()`), true);
  assert.equal(await evaluate(`document.querySelector('#dialog').open`), false);
  await click('.phone-filters [data-folder="unread"]');
  await wait(`document.querySelectorAll('.mail-row').length===2`);
  assert.match(
    await evaluate(
      `window.__fixture.requests.filter(r=>r.path.startsWith('/messages?')).at(-1).path`,
    ),
    /unread=1/,
  );
  await click('.phone-filters [data-folder="starred"]');
  await wait(`document.querySelectorAll('.mail-row').length===1`);
  await screenshot("android-starred");
  await click('.phone-filters [data-folder="inbox"]');
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  await fill("#search", "组件");
  await wait(`document.querySelectorAll('.mail-row').length===1`);
  assert.match(
    await evaluate(`document.querySelector('.mail-subject').textContent`),
    /组件/,
  );
  await fill("#search", "no-message-matches");
  await wait(
    `document.querySelector('.empty h2')?.textContent==='没有找到邮件'`,
  );
  await screenshot("android-empty");
  await fill("#search", "");
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  await evaluate(`window.__fixture.failMail=true`);
  await click('[data-action="refresh"]');
  await wait(
    `document.querySelector('#list-error').textContent.includes('暂时无法连接')`,
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('.mail-row').length`),
    4,
  );
  await screenshot("android-offline");
  await evaluate(`window.__fixture.failMail=false`);
  await click('#list-error [data-action="refresh"]');
  await wait(`document.querySelector('#list-error').textContent===''`);
  // Switching accounts must reset overview totals and ignore old search results.
  await fill("#search", "slow");
  await delay(290);
  await click('.phone-nav [data-action="accounts"]');
  await click('[data-action="switch"][data-id="personal"]');
  await wait(
    `document.querySelector('[data-mailbox-count="inbox"]')?.textContent==='1'`,
  );
  await delay(450);
  assert.equal(
    await evaluate(
      `document.querySelector('[data-mailbox-count="inbox"]').textContent`,
    ),
    "1",
  );
  await click('.phone-nav [data-action="mobile-inbox"]');
  await wait(
    `document.querySelector('.mail-subject')?.textContent==='个人邮箱专属邮件'`,
  );
  await click('.phone-nav [data-action="accounts"]');
  await click('[data-action="switch"][data-id="work"]');
  await wait(
    `document.querySelector('[data-mailbox-count="inbox"]')?.textContent==='4'`,
  );
  await click('[data-action="api-docs"]');
  await wait(`!!document.querySelector('.api-article h2')`);
  assert.equal(
    await evaluate(`document.querySelector('.shell').scrollWidth<=innerWidth`),
    true,
  );
  await screenshot("android-api-overview");
  await fill('[aria-label="搜索接口"]', "sendMail");
  await click('[data-endpoint="sendMail"]');
  await click('[data-copy="curl"]');
  await wait(`window.__fixture.copies?.length===1`);
  assert.match(await evaluate(`window.__fixture.copies[0]`), /\/api\/v1\/send/);
  await screenshot("android-api-endpoint");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 768,
    height: 1024,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(
    await evaluate(`document.querySelector('.shell').scrollWidth<=innerWidth`),
    true,
  );
  await screenshot("tablet-api-endpoint");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await click('[data-action="api-exit"]');
  assert.equal(
    await evaluate(`!!document.querySelector('.phone-overview')`),
    true,
  );
  await click('[data-action="mobile-search"]');
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  assert.equal(await evaluate(`document.activeElement.id`), "search");
  await evaluate(`document.activeElement.blur()`);
  await evaluate(
    `document.querySelector('#message-list').scrollTop=100;window.__listScroll=document.querySelector('#message-list').scrollTop`,
  );
  await click('[data-id="m4"]');
  await wait(`!!document.querySelector('.message-body')`);
  assert.match(
    await evaluate(`document.querySelector('.message-body').textContent`),
    /纯 HTML 邮件也能阅读/,
  );
  assert.equal(await evaluate(`Boolean(window.BAD)`), false);
  assert.equal(await evaluate(`!!document.querySelector('iframe')`), false);
  assert.equal(
    await evaluate(`!!document.querySelector('[data-action="ai"]')`),
    false,
  );
  await screenshot("android-reader");
  assert.equal(
    await evaluate(`document.querySelector('.phone-nav').inert`),
    true,
  );
  assert.equal(await evaluate(`window.__postofficeBack()`), true);
  assert.equal(
    await evaluate(`document.querySelector('#message-list').scrollTop`),
    await evaluate(`window.__listScroll`),
  );
  assert.equal(await evaluate(`document.activeElement.dataset.id`), "m4");
  await click('[data-id="m1"]');
  await wait(`!!document.querySelector('.message-body')`);
  await click('[data-action="reply"]');
  await wait(`!!document.querySelector('#compose-form')`);
  await fill('[name="text"]', "这是仅在本机运行的界面测试。");
  await evaluate(
    `window.__realConfirm=window.confirm; window.confirm=()=>false`,
  );
  assert.equal(await evaluate(`window.__postofficeBack()`), true);
  assert.equal(await evaluate(`!!document.querySelector('.compose-page')`), true);
  await screenshot("android-compose");
  await click('[data-action="save-draft"]');
  await wait(
    `document.querySelector('#draft-status').textContent.includes('已保存')`,
  );
  await evaluate(
    `window.confirm=window.__realConfirm;window.__postofficeBack()`,
  );
  assert.equal(await evaluate(`document.querySelector('#dialog').open`), false);
  await evaluate(`window.__postofficeBack()`);
  // Compact portrait, tablet and landscape layouts use the Android shell.
  for (const [width, height] of [
    [320, 740],
    [375, 812],
    [430, 932],
    [768, 1024],
    [844, 390],
  ]) {
    await cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await fits();
    assert.equal(
      await evaluate(`document.querySelector('#message-list').clientHeight>80`),
      true,
    );
    await screenshot("android-inbox-" + width);
  }
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "dark" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  await screenshot("android-inbox-dark");
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.phone-nav button')).transitionDuration`,
    ),
    "0s",
  );
  await evaluate(`window.__postofficeBack()`);
  await screenshot("android-overview-dark");
  await cdp("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "no-preference" },
    ],
  });
  await click('.phone-nav [data-action="mobile-inbox"]');
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  await evaluate(`window.__fixture.expired=true`);
  await click('[data-action="refresh"]');
  await wait(`!!document.querySelector('[data-action="reauth"]')`);
  await click('[data-action="reauth"]');
  assert.equal(
    await evaluate(`document.querySelector('[name="username"]').value`),
    "work@example.test",
  );
  assert.equal(
    await evaluate(`document.querySelector('[name="server"]').value`),
    "https://mail.example.test",
  );
  const navigationChecks = await require('./navigation-cases.cjs')({cdp,evaluate,wait,click,fill,screenshot,base,delay});
  const licenseChecks = await require('./server-access-cases.cjs')({cdp,evaluate,wait,click,fill,screenshot,base,delay});
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    checks: [
      "desktop layout",
      "message read",
      "attachment download",
      "in-app API reference with 31 real operations",
      "copy URL, cURL, full guide and both OpenAPI definitions",
      "copy failure selection fallback and retry",
      "API search and account-specific server address",
      "Android/tablet API reference and copying",
      "draft save",
      "send saved draft",
      "stale account response isolation",
      "verified admin switch",
      "mobile layout",
      "Android overview server counts and true zero states",
      "Android inbox filters, search, empty state and failed-sync retry",
      "Android per-account totals and delayed response isolation",
      "Android native Back bridge, scroll restoration and dirty draft guard",
      "Android 320/375/390/430/768px and landscape layouts with 48px navigation targets",
      "Android dark theme and reduced motion",
      "HTML-only plaintext fallback",
      "expired login recovery",
      ...navigationChecks,
      ...licenseChecks,
    ],
    screenshots: out,
  };
  await fs.writeFile(
    path.join(out, "smoke-report.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Edge can detach from its launcher on Windows. Close the exact test browser
    // through its private debugging session before terminating the launcher.
    if (ws?.readyState === WebSocket.OPEN && closeBrowser) {
      await Promise.race([closeBrowser().catch(() => {}), delay(2000)]);
    }
    ws?.close();
    browser?.kill();
    server.closeAllConnections();
    server.close();
    // Remove only this test's verified profile directory after Edge releases it.
    if (profile && path.dirname(profile) === out) {
      await delay(800);
      await fs
        .rm(profile, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 300,
        })
        .catch(() => {});
    }
  });
