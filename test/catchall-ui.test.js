import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const scripts = await Promise.all(
  ["workspace-tools", "mail-tools"].map((name) =>
    readFile(new URL(`../public/${name}.js`, import.meta.url), "utf8"),
  ),
);
function fixture() {
  const listeners = {};
  const sandbox = {
    document: {
      addEventListener(type, callback) {
        (listeners[type] ||= []).push(callback);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { dataset: {} },
    },
    window: {},
    matchMedia: () => ({ addEventListener() {} }),
    location: { hash: "#forwards" },
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(scripts[0], sandbox);
  const w = sandbox.window.MailWorkspace;
  const rows = [
    {
      id: 4,
      email: "inbox@a.test",
      target: "archive@outside.test",
      domain_id: 1,
      keep_copy: 1,
      enabled: 1,
    },
    {
      id: "catchall:1",
      kind: "catchall",
      email: "*@a.test",
      target: "catch@outside.test",
      domain_id: 1,
      keep_copy: 0,
      enabled: 0,
    },
    {
      id: "catchall:2",
      kind: "catchall",
      email: "*@b.test",
      target: "owner@b.test",
      domain_id: 2,
      keep_copy: 0,
      enabled: 1,
    },
  ];
  const calls = [],
    state = {
      user: {
        id: 1,
        role: "admin",
        admin_scope: "global",
        email: "admin@a.test",
      },
    };
  let currentDialog;
  w.dialog = (title, html, submit) => {
    currentDialog = { title, html, submit };
  };
  w.configure({
    state,
    esc: (value) =>
      String(value ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      ),
    icon: () => "",
    toast() {},
    closeModal() {},
    render: async () => {},
    confirmAction: async (_title, _message, callback) => callback(),
    api: async (path, options) => {
      calls.push({ path, options });
      if (options?.method) return { ok: true };
      if (path.startsWith("/admin/manage/forwards")) return { items: rows };
      if (path.startsWith("/admin/manage/account-options"))
        return { items: [{ email: "inbox@a.test", active: 1, domain_id: 1 }] };
      if (path.startsWith("/admin/manage/domain-options"))
        return {
          items: [
            { id: 1, name: "a.test" },
            { id: 2, name: "b.test" },
          ],
        };
      throw Error(`Unexpected API: ${path}`);
    },
  });
  sandbox.MailWorkspace = w;
  runInNewContext(scripts[1], sandbox);
  return {
    w,
    state,
    rows,
    calls,
    listeners,
    get dialog() {
      return currentDialog;
    },
  };
}
const form = (checks) => ({
  elements: { namedItem: (name) => ({ checked: Boolean(checks[name]) }) },
});

test("forward list distinguishes catch-all from mailbox rules and preserves per-domain actions", async () => {
  const { w, state } = fixture();
  state.user.admin_scope = "scoped";
  state.user.capabilities = ["forwards.read", "forwards.write"];
  state.user.permissions = [
    { domain_id: 1, can_read: 1, can_update: 1, can_delete: 1 },
    { domain_id: 2, can_read: 1 },
  ];
  const html = await w.pages.forwards();
  assert.match(html, /Catch-all/);
  assert.match(html, /邮箱转发/);
  assert.match(html, /仅不存在的收件地址/);
  assert.match(html, /catch@outside.test/);
  assert.match(html, /data-m-action="forward-edit" data-id="catchall:1"/);
  assert.doesNotMatch(
    html,
    /data-m-action="forward-(?:edit|delete)" data-id="catchall:2"/,
  );
  assert.doesNotMatch(html, /data-row-select value="catchall:2"/);
  assert.doesNotMatch(html, /data-m-action="forward-create"/);
});

test("creating a catch-all sends a wildcard source without enabling mailbox copies", async () => {
  const f = fixture();
  await f.w.actions["forward-create"]();
  assert.match(f.dialog.html, /data-forward-kind/);
  assert.match(f.dialog.html, /Catch-all（域名兜底）/);
  assert.match(f.dialog.html, /\*@a.test/);
  assert.match(f.dialog.html, /不保存来源副本/);
  assert.ok(
    f.calls.some((call) => call.path.endsWith("purpose=forward-catchall")),
  );
  assert.ok(
    f.calls.every((call) => !call.path.startsWith("/admin/manage/domains")),
  );
  await f.dialog.submit(
    {
      kind: "catchall",
      catchallDomain: "a.test",
      target: "archive@outside.test",
    },
    form({ enabled: true, keepCopy: true }),
  );
  const saved = f.calls.at(-1);
  assert.equal(saved.path, "/admin/manage/forwards");
  assert.equal(saved.options.method, "POST");
  assert.equal(saved.options.body.email, "*@a.test");
  assert.equal(saved.options.body.keepCopy, false);
  assert.equal(saved.options.body.enabled, true);
});

test("editing catch-all supports update-only domain grants and keeps string identifiers", async () => {
  const f = fixture();
  f.state.user.admin_scope = "scoped";
  f.state.user.capabilities = ["forwards.read", "forwards.write"];
  f.state.user.permissions = [{ domain_id: 1, can_read: 1, can_update: 1 }];
  await f.w.pages.forwards();
  await f.w.actions["forward-edit"]({ dataset: { id: "catchall:1" } });
  assert.ok(
    f.calls.some((call) =>
      call.path.endsWith("purpose=forward-catchall-update"),
    ),
  );
  assert.doesNotMatch(f.dialog.html, /data-forward-kind/);
  assert.doesNotMatch(f.dialog.html, /\*@b.test/);
  assert.match(f.dialog.html, /value="a.test" selected/);
  await f.dialog.submit(
    {
      kind: "mailbox",
      catchallDomain: "a.test",
      target: "changed@outside.test",
    },
    form({ enabled: false }),
  );
  const saved = f.calls.at(-1);
  assert.equal(saved.path, "/admin/manage/forwards/catchall:1");
  assert.equal(saved.options.method, "PATCH");
  assert.equal(saved.options.body.email, "*@a.test");
  assert.equal(saved.options.body.enabled, false);
});

test("switching forwarding type disables hidden source controls so native validation uses the selected type", async () => {
  const f = fixture();
  const mailboxField = { disabled: false },
    domainField = { disabled: true };
  const sections = [
    {
      dataset: { forwardSection: "mailbox" },
      querySelectorAll: () => [mailboxField],
    },
    {
      dataset: { forwardSection: "catchall" },
      querySelectorAll: () => [domainField],
    },
  ];
  const kind = { value: "catchall" };
  const target = {
    matches: (selector) => selector === "[data-forward-kind]",
    closest: () => null,
    form: {
      elements: { namedItem: () => kind },
      querySelectorAll: () => sections,
    },
  };
  for (const callback of f.listeners.change) await callback({ target });
  assert.equal(mailboxField.disabled, true);
  assert.equal(domainField.disabled, false);
  assert.equal(sections[0].hidden, true);
  kind.value = "mailbox";
  for (const callback of f.listeners.change) await callback({ target });
  assert.equal(mailboxField.disabled, false);
  assert.equal(domainField.disabled, true);
});

test("deleting a catch-all rule preserves its namespaced identifier", async () => {
  const f = fixture();
  await f.w.pages.forwards();
  await f.w.actions["forward-delete"]({ dataset: { id: "catchall:1" } });
  const deleted = f.calls.at(-1);
  assert.equal(deleted.path, "/admin/manage/forwards/delete");
  assert.equal(deleted.options.method, "POST");
  assert.equal(deleted.options.body.ids.length, 1);
  assert.equal(deleted.options.body.ids[0], "catchall:1");
});
