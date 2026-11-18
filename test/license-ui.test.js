import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const scripts = Object.fromEntries(
  await Promise.all(
    ["workspace-tools.js", "license-tools.js", "app.js"].map(async (name) => [
      name,
      await readFile(new URL(`../public/${name}`, import.meta.url), "utf8"),
    ]),
  ),
);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const elements = new Map();
  const node = () => ({
    innerHTML: "",
    textContent: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    append() {},
    remove() {},
  });
  for (const selector of [
    "#content",
    "#crumb",
    ".layout",
    ".mobile-menu",
    "#toasts",
  ])
    elements.set(selector, node());
  const document = {
    addEventListener() {},
    querySelector: (selector) => elements.get(selector) || null,
    querySelectorAll: () => [],
    createElement: node,
    documentElement: { dataset: {}, style: { setProperty() {} } },
    body: { style: {}, classList: { toggle() {} } },
  };
  const sandbox = {
    document,
    window: { addEventListener() {} },
    location: { hash: "#license" },
    localStorage: { getItem: () => null },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    URLSearchParams,
    FormData,
    setTimeout: () => 0,
    PostOfficeTools: {
      configure() {},
      publicRoute: async () => false,
      afterRender() {},
    },
  };
  runInNewContext(scripts["workspace-tools.js"], sandbox);
  const w = sandbox.window.MailWorkspace;
  sandbox.MailWorkspace = w;
  runInNewContext(scripts["license-tools.js"], sandbox);
  const calls = [],
    copies = [],
    state = {
      user: { role: "admin", admin_scope: "global" },
      license: { required: true, valid: false },
    };
  let renders = 0,
    shells = 0;
  const api = async (path, options) => {
    calls.push({ path, options });
    if (path === "/preferences")
      return {
        platform: { theme: "light" },
        features: [
          { id: "connections", enabled: true, show: true, order: 0 },
          { id: "users", enabled: true, show: true, order: 1 },
        ],
      };
    if (path === "/admin/connections") return { items: [], currentId: 0 };
    if (path === "/admin/license")
      return {
        required: true,
        valid: false,
        reason: "<img src=x>",
        deviceId: "device-fixture",
        productId: "product-fixture",
      };
    if (path.endsWith("/activate")) return { required: true, valid: true };
    if (path.endsWith("/offline"))
      return { required: true, valid: true, mode: "offline" };
    if (path === "/auth/me")
      return { license: { required: true, valid: true } };
    return {};
  };
  w.configure({
    state,
    esc: escape,
    icon: () => "",
    mailboxClient: false,
    api,
    shell: () => shells++,
    render: async () => renders++,
    copy: (value) => copies.push(value),
    toast() {},
  });
  return {
    w,
    state,
    sandbox,
    elements,
    calls,
    copies,
    api,
    get renders() {
      return renders;
    },
    get shells() {
      return shells;
    },
  };
}

test("license recovery skips gated preferences and isolates scoped administrators and personal mailboxes", async () => {
  const f = fixture();
  await f.w.loadPreferences();
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ["/preferences"],
  );
  assert.equal(f.w.defaultRoute(), "license");
  assert.equal(f.w.canRoute(f.w.defaultRoute()), true);
  assert.equal(f.w.canRoute("users"), false);
  assert.deepEqual(plain(f.w.navigation([], [])), [
    ["license", "key", "程序授权"],
  ]);
  const html = await f.w.pages.license();
  assert.match(html, /device-fixture/);
  assert.match(html, /product-fixture/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
  f.state.user.admin_scope = "scoped";
  f.state.user.permissions = [{ domain_id: 1, can_read: 1 }];
  assert.equal(f.w.defaultRoute(), "service-unavailable");
  assert.equal(f.w.canRoute(f.w.defaultRoute()), true);
  assert.equal(f.w.canRoute("license"), false);
  const before = f.calls.length;
  await assert.rejects(f.w.pages.license(), /仅全局管理员/);
  await assert.rejects(
    f.w.forms["license-activate"]({ key: "KD-FIXTURE" }),
    /仅全局管理员/,
  );
  assert.equal(f.calls.length, before);
  assert.deepEqual(plain(f.w.navigation([], [])), [
    ["service-unavailable", "lock", "服务状态"],
  ]);
  assert.doesNotMatch(
    await f.w.pages["service-unavailable"](),
    /device-fixture|product-fixture/,
  );
  await f.w.actions["license-state-refresh"]();
  assert.equal(f.sandbox.location.hash, "users");
  assert.equal(f.w.canRoute("service-unavailable"), false);
  for (const user of [{ role: "user" }, { role: "admin" }]) {
    f.state.user = user;
    f.w.h.mailboxClient = true;
    f.state.license = { required: true, valid: false };
    assert.equal(f.w.defaultRoute(), "inbox");
    assert.equal(f.w.canRoute("license"), false);
    assert.equal(f.w.canRoute("service-unavailable"), false);
    assert.ok(
      !f.w
        .navigation([], [["inbox", "inbox", "收件箱"]])
        .some(([id]) => id === "license"),
    );
  }
});

test("activation refreshes management navigation and offline import preserves the API contract", async () => {
  const f = fixture();
  f.w.actions["license-device"]({ dataset: { device: "device-fixture" } });
  assert.deepEqual(f.copies, ["device-fixture"]);
  await f.w.forms["license-activate"]({ key: "KD-FIXTURE" });
  assert.equal(f.state.license.valid, true);
  assert.ok(!f.calls.some((c) => c.path === "/admin/connections"));
  assert.equal(f.w.defaultRoute(), "overview");
  assert.ok(f.w.navigation([], []).some(([id]) => id === "users"));
  assert.equal(f.shells, 1);
  assert.equal(f.renders, 1);
  assert.deepEqual(
    plain(f.calls.find((c) => c.path.endsWith("/activate")).options),
    {
      method: "POST",
      body: { key: "KD-FIXTURE" },
    },
  );
  const form = (file) => ({
    elements: { namedItem: () => ({ files: [file] }) },
  });
  await assert.rejects(
    f.w.forms["license-offline"]({}, form({ size: 16385 })),
    /16 KB/,
  );
  await f.w.forms["license-offline"](
    {},
    form({ size: 20, text: async () => '{"grant":"fixture"}' }),
  );
  assert.deepEqual(
    plain(f.calls.find((c) => c.path.endsWith("/offline")).options),
    {
      method: "POST",
      body: { file: '{"grant":"fixture"}' },
    },
  );
  assert.equal(f.state.license.mode, "offline");
});

test("the complete app registers license pages before use and routes API denial without exposing personal mailbox license management", async () => {
  for (const role of ["global", "scoped", "user", "webmail-admin"]) {
    const f = fixture();
    f.sandbox.document.documentElement.dataset.client =
      role === "webmail-admin" ? "webmail" : "";
    f.w.loadPublic = () => new Promise(() => {});
    f.w.afterRender = () => {};
    let denied = false,
      request;
    f.sandbox.fetch = async (url, options) => {
      request = { url, options };
      const response = denied
        ? { code: "LICENSE_REQUIRED", error: "需要恢复授权" }
        : await f.api(url.slice(4), options);
      return {
        ok: !denied,
        status: denied ? 402 : 200,
        json: async () => response,
      };
    };
    runInNewContext(scripts["app.js"], f.sandbox);
    Object.assign(f.w.h.state, {
      user: {
        name: "Fixture",
        role: role === "user" ? "user" : "admin",
        admin_scope: role === "scoped" ? "scoped" : "global",
        management_only: true,
      },
      license: { required: true, valid: false },
      shellLicenseBlocked: true,
      csrf: "csrf-fixture",
    });
    if (role === "global" || role === "scoped") {
      f.sandbox.location.hash =
        role === "global" ? "#license" : "#service-unavailable";
      await f.w.h.render();
      assert.match(
        f.elements.get("#content").innerHTML,
        role === "global" ? /device-fixture/ : /服务待恢复/,
      );
      if (role === "scoped")
        assert.doesNotMatch(
          f.elements.get("#content").innerHTML,
          /device-fixture|product-fixture/,
        );
    }
    denied = true;
    f.sandbox.location.hash = "#inbox";
    await assert.rejects(
      f.w.h.api("/send", { method: "POST", body: {} }),
      /需要恢复授权/,
    );
    assert.equal(request.options.headers["X-CSRF-Token"], "csrf-fixture");
    assert.equal(
      f.sandbox.location.hash,
      ["user", "webmail-admin"].includes(role)
        ? "#inbox"
        : role === "scoped"
          ? "service-unavailable"
          : "license",
    );
  }
});

test("both clients load the license module before app page registration with matching cache versions", async () => {
  for (const name of ["index.html", "webmail.html"]) {
    const html = await readFile(
      new URL(`../public/${name}`, import.meta.url),
      "utf8",
    );
    assert.ok(
      html.indexOf("/workspace-tools.js") < html.indexOf("/license-tools.js"),
    );
    assert.ok(html.indexOf("/license-tools.js") < html.indexOf("/app.js"));
    const versions = [
      "workspace-tools.js",
      "license-tools.js",
      "app.js",
      "workspace-controls.css",
    ].map(
      (asset) =>
        html.match(
          new RegExp(asset.replaceAll(".", "\\.") + '\\?v=([^" ]+)'),
        )?.[1],
    );
    assert.ok(versions.every(Boolean));
    assert.equal(new Set(versions).size, 1);
  }
});

test("webmail transport isolates sessions and management paths while backend transport stays unchanged", async () => {
  for (const webmail of [false, true]) {
    const f = fixture();
    f.sandbox.document.documentElement.dataset.client = webmail
      ? "webmail"
      : "";
    f.w.loadPublic = () => new Promise(() => {});
    const calls = [];
    f.sandbox.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    runInNewContext(scripts["app.js"], f.sandbox);
    f.w.h.state.user = {
      id: 4,
      role: "user",
      client_manager: true,
      capabilities: [],
    };
    f.w.h.state.csrf = "own-session-csrf";
    await f.w.h.api("/auth/me");
    await f.w.h.api("/admin/manage/accounts?page=2");
    await f.w.h.api("/auth/logout", { method: "POST" });
    assert.deepEqual(
      calls.map((c) => c.url),
      webmail
        ? [
            "/api/client/auth/me",
            "/api/client/manage/accounts?page=2",
            "/api/client/auth/logout",
          ]
        : [
            "/api/auth/me",
            "/api/admin/manage/accounts?page=2",
            "/api/auth/logout",
          ],
    );
    f.sandbox.location.hash = "#manage/users";
    f.w.h.go("compose");
    assert.equal(
      f.sandbox.location.hash,
      webmail ? "manage/compose" : "compose",
    );
  }
});
