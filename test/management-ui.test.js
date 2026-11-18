import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { capabilityCatalog, rolePresets } from "../src/admin-permissions.js";
const scripts = await Promise.all(
  ["workspace-tools", "mail-tools", "system-tools"].map((name) =>
    readFile(new URL(`../public/${name}.js`, import.meta.url), "utf8"),
  ),
);
function fixture() {
  const modal = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const document = {
    addEventListener() {},
    querySelector: (s) => (s === "#modal-root" ? modal : null),
    querySelectorAll: () => [],
    documentElement: { dataset: {}, style: { setProperty() {} } },
    body: { style: {}, classList: { toggle() {} } },
  };
  const sandbox = {
    document,
    window: {},
    matchMedia: () => ({ addEventListener() {} }),
    location: { hash: "#users" },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null },
  };
  runInNewContext(scripts[0], sandbox);
  const w = sandbox.window.MailWorkspace;
  sandbox.MailWorkspace = w;
  runInNewContext(scripts[1], sandbox);
  runInNewContext(scripts[2], sandbox);
  const calls = [],
    state = {
      user: {
        id: 1,
        name: "Admin",
        email: "admin@a.test",
        role: "admin",
        admin_scope: "global",
      },
    };
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const domains = [
    {
      id: 1,
      name: "a.test",
      enabled: 1,
      mailbox_count: 3,
      mailbox_limit: 5,
      mailbox_remaining: 2,
    },
  ];
  w.configure({
    state,
    esc,
    icon: () => "",
    toast() {},
    closeModal() {},
    render: async () => {},
    api: async (path, options) => {
      calls.push({ path, options });
      if (path === "/admin/permission-catalog")
        return { capabilities: capabilityCatalog, presets: rolePresets };
      if (path === "/admin/managers")
        return {
          items: [
            {
              ...state.user,
              active: 1,
              permissions: [],
              capabilities: capabilityCatalog.map((c) => c.id),
            },
          ],
        };
      if (path === "/admin/mail-settings") return { hostname: "mail.a.test" };
      if (
        path.startsWith("/admin/manage/domains") ||
        path.startsWith("/admin/manage/domain-options")
      )
        return { items: domains };
      if (path.startsWith("/admin/manage/accounts?"))
        return {
          items: [
            {
              id: 2,
              email: "reader@a.test",
              name: "Reader",
              domain_id: 1,
              role: "user",
              active: 1,
              quota_bytes: 1048576,
              used_bytes: 512,
            },
          ],
          total: 245,
          page: 1,
          limit: 30,
        };
      if (path.startsWith("/admin/manage/account-options"))
        return { items: [], total: 0, page: 1, limit: 200 };
      if (
        path.startsWith("/admin/manage/messages") ||
        path.startsWith("/messages?")
      )
        return { items: [], total: 0, page: 1, limit: 30 };
      throw Error(`Unexpected API: ${path}`);
    },
  });
  return { w, state, calls, modal, domains };
}
test("restricted navigation intersects explicit capabilities with domain operations", async () => {
  const { w, state } = fixture();
  state.user.admin_scope = "scoped";
  state.user.capabilities = ["accounts.read", "domains.read", "mail.read"];
  state.user.permissions = [
    {
      domain_id: 1,
      domain: "a.test",
      can_read: 1,
      can_create: 0,
      can_update: 0,
      can_delete: 0,
    },
  ];
  assert.equal(w.canRoute("users"), true);
  assert.equal(w.canRoute("domains"), true);
  assert.equal(w.canRoute("compose"), false);
  assert.equal(w.canRoute("managers"), false);
  assert.equal(w.can("mail.read", 2), false);
  assert.equal(w.button("Write", "write-mail"), "");
  assert.equal(w.button("Delete", "mail-batch", 'data-kind="trash"'), "");
  state.user.capabilities = [];
  assert.equal(w.defaultRoute(), "access");
  assert.equal(w.canRoute("access"), true);
  assert.match(await w.pages.access(), /尚未分配功能权限/);
  assert.equal(w.canRoute("users"), false);
});
test("system pages and permission management share parent navigation while old routes still work", async () => {
  const { w, state, calls } = fixture();
  const items = [
    ["users", "users", "用户列表"],
    ["connections", "server", "多邮局管理"],
    ["managers", "shield", "权限管理"],
    ["system", "server", "邮局管理"],
    ["platform", "settings", "平台设置"],
    ["features", "settings", "功能管理"],
    ["about", "info", "程序信息"],
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(w.navigation(items, []))), [
    ["users", "users", "用户列表"],
    ["system", "settings", "系统设置"],
  ]);
  assert.equal(w.navigationGroup("managers"), "users");
  for (const id of ["system", "platform", "features", "about"]) {
    assert.equal(w.canRoute(id), true);
    assert.equal(w.navigationGroup(id), "system");
    assert.match(
      w.sectionNavigation(id),
      new RegExp(`href="#${id}" class="selected" aria-current="page"`),
    );
  }
  const tabs = w.sectionNavigation("users");
  assert.match(tabs, /href="#users"/);
  assert.match(tabs, /href="#managers"/);
  assert.equal(w.canRoute("connections"), false);
  await w.context();
  assert.equal(w.connectionId, 0);
  assert.equal(w.remote(), false);
  assert.equal(
    calls.length,
    0,
    "paused remote management must not fetch saved connections",
  );
  assert.match(await w.pages.connections(), /暂时停用/);
  assert.equal(calls.length, 0);
  state.user.admin_scope = "scoped";
  state.user.capabilities = ["accounts.read"];
  state.user.permissions = [{ domain_id: 1, can_read: 1 }];
  assert.equal(w.sectionNavigation("users"), "");
  assert.equal(w.canRoute("managers"), false);
  assert.equal(w.canRoute("platform"), false);
});
test("grouped tabs honor disabled and hidden features without an activation tab", async () => {
  const { w, state } = fixture();
  w.h.api = async (path) => {
    assert.equal(path, "/preferences");
    return {
      platform: { theme: "light" },
      features: [
        { id: "users", enabled: true, show: true, order: 0 },
        { id: "managers", enabled: false, show: false, order: 1 },
        { id: "system", enabled: false, show: false, order: 2 },
        { id: "platform", enabled: true, show: true, order: 3 },
        { id: "features", enabled: true, show: true, order: 4 },
        { id: "about", enabled: true, show: false, order: 5 },
        { id: "connections", enabled: true, show: true, order: 6 },
      ],
    };
  };
  await w.loadPreferences();
  assert.deepEqual(JSON.parse(JSON.stringify(w.navigation([], []))), [
    ["users", "users", "用户列表"],
    ["platform", "settings", "系统设置"],
  ]);
  assert.equal(w.canRoute("managers"), false);
  assert.equal(w.sectionNavigation("users"), "");
  const html = w.sectionNavigation("platform");
  assert.doesNotMatch(html, /href="#license"/);
  assert.doesNotMatch(html, /href="#(?:system|about|connections)"/);
  assert.equal(
    w.canRoute("about"),
    true,
    "hidden pages retain direct-link access",
  );
  assert.equal(w.canRoute("license"), false);
});
test("paused multi-postoffice controls cannot be enabled when saving feature settings", async () => {
  const { w } = fixture();
  const featureRows = [
    { id: "users", name: "用户列表", core: true, enabled: true, show: true },
    {
      id: "connections",
      name: "多邮局管理",
      paused: true,
      enabled: false,
      show: false,
    },
  ];
  let saved;
  w.h.shell = () => {};
  w.h.api = async (path, options) => {
    if (path === "/admin/features") {
      if (options?.method === "PUT") saved = options.body.items;
      return { items: featureRows };
    }
    assert.equal(path, "/preferences");
    return { platform: { theme: "light" }, features: featureRows };
  };
  const html = await w.pages.features();
  assert.match(html, /暂时停用/);
  assert.match(html, /name="show-connections"[^>]*disabled/);
  assert.match(html, /name="enable-connections"[^>]*disabled/);
  await w.forms.features(
    {},
    {
      elements: { namedItem: () => ({ checked: true }) },
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(saved[1])), {
    id: "connections",
    show: false,
    enabled: false,
  });
});
test("account list uses bounded server pages and server total; filters reset page", async () => {
  const { w, calls } = fixture();
  const html = await w.pages.users();
  assert.match(
    calls.find((c) => c.path.startsWith("/admin/manage/accounts?")).path,
    /page=1&limit=30/,
  );
  assert.match(html, /共 245/);
  assert.match(html, /导出当前页/);
  assert.match(html, /1 \/ 9/);
  await w.actions["users-page"]({ dataset: { page: "3" } });
  await w.pages.users();
  assert.match(
    calls.filter((c) => c.path.startsWith("/admin/manage/accounts?")).at(-1)
      .path,
    /page=3/,
  );
  await w.forms["user-filter"]({ q: "reader", domain: "a.test", limit: "50" });
  await w.pages.users();
  const last = calls
    .filter((c) => c.path.startsWith("/admin/manage/accounts?"))
    .at(-1).path;
  assert.match(last, /q=reader/);
  assert.match(last, /page=1/);
  assert.match(last, /limit=50/);
});
test("domain capacities distinguish unlimited and zero and keep limit control superadmin-only", async () => {
  const { w, state, domains } = fixture();
  let html = await w.pages.domains();
  assert.match(html, /还可创建 2 个/);
  assert.match(html, /data-m-action="domain-limit"/);
  domains[0].mailbox_limit = null;
  html = await w.pages.domains();
  assert.match(html, /未设置数量上限/);
  domains[0].mailbox_limit = 0;
  domains[0].mailbox_count = 0;
  html = await w.pages.domains();
  assert.match(html, /还可创建 0 个/);
  state.user.admin_scope = "scoped";
  state.user.capabilities = ["domains.read"];
  state.user.permissions = [{ domain_id: 1, can_read: 1 }];
  html = await w.pages.domains();
  assert.doesNotMatch(
    html,
    /data-m-action="domain-limit"|data-m-action="domain-create"|data-m-action="domain-delete"|data-m-action="domain-toggle"/,
  );
});
test("permission editor uses backend catalog, exposes custom grants and escapes domain text", async () => {
  const { w, modal, domains } = fixture();
  domains[0].name = "<script>";
  const html = await w.pages.managers();
  assert.match(html, /权限管理/);
  assert.match(html, /超级管理员/);
  w.actions["manager-create"]();
  assert.match(modal.innerHTML, /value="client_manager" selected/);
  assert.match(modal.innerHTML, /value="client" selected/);
  assert.match(modal.innerHTML, /value="custom"/);
  assert.match(modal.innerHTML, /value="accounts.password"/);
  assert.match(modal.innerHTML, /data-grant="1"/);
  assert.match(modal.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(modal.innerHTML, /<script>/);
});

test("client workspace exposes assigned mailbox tools without backend pages or implicit domain rights", async () => {
  const { w, state, calls } = fixture();
  let managing = true;
  w.h.mailboxClient = true;
  w.h.clientWorkspace = () => managing;
  Object.assign(state.user, {
    role: "user",
    client_manager: true,
    admin_scope: "scoped",
    capabilities: [
      "accounts.read",
      "accounts.create",
      "domains.read",
      "mail.read",
    ],
    permissions: [{ domain_id: 1, can_read: 1, can_create: 1 }],
  });
  assert.equal(w.isGlobal(), false);
  assert.equal(w.canRoute("users"), true);
  assert.equal(w.can("accounts.create", 1, "create"), true);
  assert.equal(w.can("accounts.create", 2, "create"), false);
  for (const route of [
    "managers",
    "system",
    "api",
    "license",
    "connections",
    "drafts",
  ])
    assert.equal(w.canRoute(route), false, route);
  const users = await w.pages.users();
  assert.match(users, /account-create/);
  assert.doesNotMatch(users, /account-permissions/);
  const domainHtml = await w.pages.domains();
  assert.doesNotMatch(
    domainHtml,
    /domain-create|domain-limit|domain-delete|domain-toggle/,
  );
  assert(!calls.some((c) => c.path === "/admin/mail-settings"));
  managing = false;
  assert.equal(w.canRoute("users"), false);
  assert.equal(w.canRoute("inbox"), true);
  assert.equal(w.canRoute("compose"), false);
  let html = await w.mailbox("inbox");
  assert.doesNotMatch(
    html,
    /data-m-action="write-mail"|data-m-action="mail-batch"/,
  );
  assert.match(calls.at(-1).path, /^\/messages\?/);
  state.user.capabilities = [];
  assert.equal(w.defaultRoute(), "access");
  assert.equal(w.canRoute("inbox"), false);
});

test("superadmin can grant an existing ordinary mailbox client permissions without resetting its password", async () => {
  const { w, modal } = fixture();
  const html = await w.pages.users();
  assert.match(html, /data-m-action="account-permissions"/);
  await w.actions["account-permissions"]({ dataset: { id: "2" } });
  assert.match(modal.innerHTML, /value="reader@a.test" required readonly/);
  assert.match(modal.innerHTML, /value="client" selected/);
  assert.match(modal.innerHTML, /value="client_manager" selected/);
  assert.match(modal.innerHTML, /新密码（留空保留）/);
  assert.match(modal.innerHTML, /data-grant="1"/);
});

test("mailbox toolbar hides sending and mutations for auditors but preserves personal mailbox controls", async () => {
  const { w, state } = fixture();
  state.user.admin_scope = "scoped";
  state.user.capabilities = ["mail.read"];
  state.user.permissions = [{ domain_id: 1, can_read: 1 }];
  let html = await w.mailbox("inbox");
  assert.doesNotMatch(
    html,
    /data-m-action="write-mail"|data-m-action="mail-batch"/,
  );
  state.user.capabilities = ["mail.read", "mail.update"];
  state.user.permissions[0].can_update = 1;
  html = await w.mailbox("inbox");
  assert.match(html, /data-kind="read"/);
  assert.match(html, /data-kind="archive"/);
  assert.doesNotMatch(html, /data-kind="trash"/);
  w.h.mailboxClient = true;
  html = await w.mailbox("inbox");
  assert.match(html, /data-m-action="write-mail"/);
  assert.match(html, /data-kind="trash"/);
});
