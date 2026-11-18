import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { start } from "../src/server.js";
import { runCodeRules } from "../src/codes.js";
import { verifyPassword } from "../src/security.js";

test("generated batch accounts honor selected character classes, preserve case and create atomically", async (t) => {
  const { service, admin, call } = await fixture(t);
  const result = await admin("/admin/users/batch", {
    domain: "tools.example",
    count: 4,
    usernameLength: 10,
    usernameUppercase: true,
    passwordLength: 16,
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.items.length, 4);
  for (const account of result.body.items) {
    const local = account.email.split("@")[0];
    assert.equal(local.length, 10);
    assert.match(local, /[a-z]/);
    assert.match(local, /[A-Z]/);
    assert.match(local, /\d/);
    assert.equal(account.password.length, 16);
    assert.match(account.password, /[A-Z]/);
    assert.match(account.password, /\d/);
    assert.match(account.password, /[!@#$%^&*_=+?-]/);
    const saved = service.store.db
      .prepare("SELECT * FROM users WHERE email=?")
      .get(account.email.toLowerCase());
    assert.equal(saved.display_email, account.email);
    assert.notEqual(saved.password_hash, account.password);
    assert(await verifyPassword(account.password, saved.password_hash));
    assert.equal(
      (
        await call("/auth/webmail/login", {
          email: account.email,
          password: account.password,
        })
      ).status,
      200,
    );
  }
  const prefixed = await admin("/admin/users/batch", {
    domain: "tools.example",
    count: 2,
    randomUsername: false,
    prefix: "member",
    startNumber: 9,
    randomPassword: false,
    password: "Shared-password-2026",
  });
  assert.deepEqual(
    prefixed.body.items.map((item) => item.email),
    ["member09@tools.example", "member10@tools.example"],
  );
  const before = service.store.db
    .prepare("SELECT count(*) n FROM users")
    .get().n;
  assert.equal(
    (
      await admin("/admin/users/batch", {
        domain: "tools.example",
        count: 2,
        randomUsername: false,
        prefix: "member",
        startNumber: 8,
      })
    ).status,
    409,
  );
  assert.equal(
    service.store.db.prepare("SELECT count(*) n FROM users").get().n,
    before,
  );
  assert.equal(
    (await admin("/admin/users/batch", { domain: "tools.example", count: 101 }))
      .status,
    400,
  );
});

test("code links scope access to one mailbox, expire and revoke, while custom rules and settings affect all readers", async (t) => {
  const { service, admin, call } = await fixture(t);
  await admin("/admin/users", {
    domain: "tools.example",
    local: "alice",
    password: "Alice-password-2026",
  });
  await service.mail.send(service.mail.localUser("admin@tools.example"), {
    to: "admin@tools.example",
    subject: "Admin code",
    text: "验证码 817493",
  });
  await service.mail.send(service.mail.localUser("admin@tools.example"), {
    to: "alice@tools.example",
    subject: "Alice code",
    text: "验证码 992248",
  });
  const created = await admin("/admin/code-links", {
    email: "alice@tools.example",
    hours: 1,
    label: "测试",
  });
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^[A-Za-z0-9]{8}$/);
  const read = await call("/code-links/read", { token: created.body.token });
  assert.equal(read.status, 200);
  assert.equal(read.body.mailbox, "alice@tools.example");
  assert.deepEqual(
    read.body.items.map((item) => item.code),
    ["992248"],
  );
  assert(!JSON.stringify(read.body).includes("817493"));
  assert(!JSON.stringify(read.body).includes("body_text"));
  assert.equal(
    (await call("/code-links/read", { token: "invalid!" })).status,
    404,
  );
  await admin(
    `/admin/code-links/${created.body.id}`,
    { enabled: false },
    "PATCH",
  );
  assert.equal(
    (await call("/code-links/read", { token: created.body.token })).status,
    404,
  );
  await admin(
    `/admin/code-links/${created.body.id}`,
    { enabled: true },
    "PATCH",
  );
  service.store.db
    .prepare("UPDATE code_links SET expires_at=0 WHERE id=?")
    .run(created.body.id);
  assert.equal(
    (await call("/code-links/read", { token: created.body.token })).status,
    404,
  );
  await admin(`/admin/code-links/${created.body.id}`, { hours: 1 }, "PATCH");
  const rule = await admin("/admin/code-rules", {
    name: "字母验证码",
    pattern: "PIN: ([A-Z]{4}-[0-9]{2})",
    flags: "",
    priority: 1,
  });
  assert.equal(rule.status, 201);
  const preview = await admin("/admin/code-rules/test", {
    samples: ["PIN: ABCD-12", "no match"],
  });
  assert.equal(preview.body.items[0].code, "ABCD-12");
  assert.equal(preview.body.items[1].code, null);
  await service.mail.send(service.mail.localUser("admin@tools.example"), {
    to: "alice@tools.example",
    subject: "Letter PIN",
    text: "PIN: WXYZ-45",
  });
  const custom = await call("/code-links/read", { token: created.body.token });
  assert.equal(custom.body.items[0].code, "WXYZ-45");
  await admin("/admin/code-settings", { allowPublicLinks: false }, "PUT");
  assert.equal(
    (await call("/code-links/read", { token: created.body.token })).status,
    404,
  );
  await admin("/admin/code-settings", { enabled: false }, "PUT");
  assert.deepEqual((await admin("/admin/codes")).body.items, []);
  const login = await call("/auth/webmail/login", {
    email: "alice@tools.example",
    password: "Alice-password-2026",
  });
  const denied = await call(
    "/client/admin/code-links",
    undefined,
    "GET",
    login.cookie,
  );
  assert.equal(denied.status, 403);
  assert.equal(
    (await call("/admin/code-links", undefined, "GET", login.cookie)).status,
    401,
  );
  await admin(`/admin/code-rules/${rule.body.id}`, undefined, "DELETE");
  assert.equal(
    (await admin("/admin/code-rules/test", { samples: ["PIN: ABCD-12"] })).body
      .items[0].code,
    null,
  );
});

test("pathological extraction rules terminate without blocking later requests", async () => {
  await assert.rejects(
    runCodeRules(
      [{ id: 1, name: "slow", pattern: "(a+)+$", flags: "" }],
      [{ body_text: "a".repeat(15000) + "!" }],
      100,
    ),
    /超时/,
  );
  const result = await runCodeRules(
    [{ id: 2, name: "safe", pattern: "code ([0-9]{6})", flags: "i" }],
    [{ body_text: "code 123456" }],
  );
  assert.equal(result[0].code, "123456");
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-tools-"));
  const service = await start({
    host: "127.0.0.1",
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    dataDir: dir,
    outboundMode: "local",
  });
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.ports.http}`;
  let cookie = "",
    csrf = "";
  async function call(
    url,
    body,
    method = body === undefined ? "GET" : "POST",
    session = "",
    token = "",
  ) {
    const response = await fetch(base + "/api" + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(session ? { Cookie: session } : {}),
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const setup = await call("/setup", {
    domain: "tools.example",
    email: "admin@tools.example",
    password: "Admin-password-2026",
  });
  assert.equal(setup.status, 201);
  cookie = setup.cookie;
  csrf = setup.body.csrfToken;
  return {
    service,
    call,
    admin: (url, body, method) => call(url, body, method, cookie, csrf),
  };
}
