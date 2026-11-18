import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const scripts = Object.fromEntries(
  await Promise.all(
    ["workspace-tools.js", "app.js"].map(async (name) => [
      name,
      await readFile(new URL(`../public/${name}`, import.meta.url), "utf8"),
    ]),
  ),
);
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
    location: { hash: "#inbox" },
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
  return { w, sandbox };
}

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
