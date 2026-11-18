import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { start } from "../src/server.js";
import http from "node:http";
import { createHash } from "node:crypto";
import {
  createConnectionAdapter,
  connectionRequest,
  scrubRemote,
} from "../src/connections.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-parity-"));
  const service = await start({
    host: "127.0.0.1",
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    smtpHost: "127.0.0.1",
    dataDir: dir,
    outboundMode: "local",
  });
  t.after(async () => {
    await service.close();
    assert(
      path
        .resolve(dir)
        .startsWith(
          path.resolve(os.tmpdir()) + path.sep + "postoffice-parity-",
        ),
    );
    await rm(dir, { recursive: true, force: true });
  });
  function client() {
    const cookies = new Map();
    let csrf = "",
      clientPortal = false;
    return async (url, body, method = body === undefined ? "GET" : "POST") => {
      if (url === "/auth/webmail/login") clientPortal = true;
      if (clientPortal && !url.startsWith("/client/")) url = "/client" + url;
      const response = await fetch(
        `http://127.0.0.1:${service.ports.http}/api${url}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            "X-CSRF-Token": csrf,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      for (const value of response.headers.getSetCookie()) {
        const [cookie] = value.split(";"),
          index = cookie.indexOf("=");
        cookies.set(cookie.slice(0, index), cookie.slice(index + 1));
      }
      const json = response.headers
        .get("content-type")
        ?.includes("application/json");
      const data = json
        ? await response.json()
        : Buffer.from(await response.arrayBuffer());
      if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data, headers: response.headers };
    };
  }
  const admin = client();
  const setup = await admin("/setup", {
    domain: "parity.example",
    email: "admin@parity.example",
    name: "管理员",
    password: "Parity-admin-password-2026",
  });
  assert.equal(setup.status, 201);
  return { service, db: service.store.db, admin, client };
}

test("temporary mail pages enforce password, per-IP quota, session ownership and immediate expiry without touching permanent mail", async (t) => {
  const { admin, client, service, db } = await fixture(t);
  assert.equal(
    (
      await admin(
        "/admin/temp-mail/settings",
        { enabled: true, domains: ["parity.example"] },
        "PUT",
      )
    ).status,
    200,
  );
  const created = await admin("/admin/temp-mail/pages", {
    name: "测试页面",
    domains: ["parity.example"],
    requirePassword: true,
    password: "Temporary-page-password",
    dailyIpLimit: 1,
  });
  assert.equal(created.status, 201);
  const base = `/temp/${created.data.token}`,
    guest = client(),
    other = client();
  assert.equal((await guest(base + "/mailboxes", {})).status, 401);
  assert.equal(
    (await guest(base + "/verify", { password: "wrong" })).status,
    401,
  );
  assert.equal(
    (await guest(base + "/verify", { password: "Temporary-page-password" }))
      .status,
    200,
  );
  const mailbox = await guest(base + "/mailboxes", {});
  assert.equal(mailbox.status, 201);
  assert.equal((await guest(base + "/mailboxes", {})).status, 429);
  assert.equal(
    (await other(base + "/verify", { password: "Temporary-page-password" }))
      .status,
    200,
  );
  assert.deepEqual((await other(base + "/mailboxes")).data.items, []);
  assert.equal(
    (await other(base + `/mailboxes/${mailbox.data.id}/messages`)).status,
    404,
  );
  const user = service.mail.localUser("admin@parity.example");
  await service.mail.send(user, {
    to: mailbox.data.email,
    subject: "临时邮箱收件验证",
    text: "验证码为 923456",
    attachments: [
      {
        filename: "hello.txt",
        content: Buffer.from("hello").toString("base64"),
      },
    ],
  });
  await service.mail.send(user, {
    to: user.email,
    subject: "永久邮箱邮件",
    text: "必须保留",
  });
  const mails = await guest(base + `/mailboxes/${mailbox.data.id}/messages`);
  assert.equal(mails.data.items[0].subject, "临时邮箱收件验证");
  const detail = await guest(
    base + `/mailboxes/${mailbox.data.id}/messages/${mails.data.items[0].id}`,
  );
  assert.equal(detail.data.body_text, "验证码为 923456");
  const attachment = await guest(
    base +
      `/mailboxes/${mailbox.data.id}/messages/${detail.data.id}/attachments/${detail.data.attachments[0].id}`,
  );
  assert.equal(attachment.data.toString(), "hello");
  db.prepare("UPDATE users SET temporary_expires_at=? WHERE email=?").run(
    Date.now() - 1,
    mailbox.data.email,
  );
  db.prepare("UPDATE temp_mailboxes SET expires_at=? WHERE id=?").run(
    Date.now() - 1,
    mailbox.data.id,
  );
  assert.equal(service.mail.recipientUser(mailbox.data.email), undefined);
  assert.equal(
    (await guest(base + `/mailboxes/${mailbox.data.id}/messages`)).status,
    404,
  );
  assert.equal((await guest(base + "/mailboxes", {})).status, 429);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM messages WHERE subject='永久邮箱邮件' AND folder='inbox'",
      )
      .get().n,
    1,
  );
  const refreshed = await admin(
    `/admin/temp-mail/pages/${created.data.token}`,
    { password: "New-temporary-password" },
    "PATCH",
  );
  assert.equal(refreshed.status, 200);
  assert.equal((await guest(base + "/mailboxes")).status, 401);
  assert.equal(
    (await guest(base + "/verify", { password: "Temporary-page-password" }))
      .status,
    401,
  );
  assert.equal(
    (await admin("/admin/temp-mail/settings", { enabled: false }, "PUT"))
      .status,
    200,
  );
  assert.equal((await guest(base)).status, 404);
});

test("domain managers are isolated from global APIs and their read/create/update/delete grants are enforced on the server", async (t) => {
  const { admin, client, db } = await fixture(t);
  const allowed = await admin("/admin/manage/domains", {
    name: "scoped.example",
  });
  const hidden = await admin("/admin/manage/domains", {
    name: "hidden.example",
  });
  assert.equal(allowed.status, 201);
  assert.equal(hidden.status, 201);
  const created = await admin("/admin/managers", {
    email: "manager@parity.example",
    name: "受限管理员",
    password: "Manager-password-2026",
    scope: "scoped",
    permissions: [
      { domain_id: allowed.data.id, can_read: true, can_create: true },
    ],
  });
  assert.equal(created.status, 201);
  const manager = client();
  assert.equal(
    (
      await manager("/auth/login", {
        email: "manager@parity.example",
        password: "Manager-password-2026",
      })
    ).status,
    200,
  );
  for (const url of [
    "/admin/overview",
    "/admin/system",
    "/admin/users",
    "/admin/domains",
    "/admin/api-keys",
    "/admin/code-links",
    "/admin/managers",
  ])
    assert.equal((await manager(url)).status, 403, url);
  const user = await manager("/admin/manage/accounts", {
    email: "alice@scoped.example",
    password: "Alice-password-2026",
    role: "admin",
  });
  assert.equal(user.status, 201);
  assert.equal(
    db
      .prepare("SELECT role FROM users WHERE email=?")
      .get("alice@scoped.example").role,
    "user",
  );
  assert.equal(
    (
      await manager("/admin/manage/accounts", {
        email: "intruder@hidden.example",
        password: "Intruder-password-2026",
      })
    ).status,
    403,
  );
  const row = db
    .prepare("SELECT id FROM users WHERE email=?")
    .get("alice@scoped.example");
  assert.equal(
    (
      await manager(
        `/admin/manage/accounts/${row.id}`,
        { name: "禁止修改" },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await manager("/admin/manage/accounts/delete", {
        ids: [row.id],
        confirm: true,
      })
    ).status,
    403,
  );
  assert.deepEqual(
    (await manager("/admin/manage/domains")).data.items.map((d) => d.name),
    ["scoped.example"],
  );
  assert.deepEqual(
    (await manager("/admin/manage/accounts")).data.items.map((u) => u.email),
    ["alice@scoped.example"],
  );
  assert.equal(
    (
      await manager("/admin/manage/send", {
        from: "admin@parity.example",
        to: "alice@scoped.example",
        subject: "禁止越权",
        text: "test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await admin(
        `/admin/managers/${created.data.id}`,
        {
          permissions: [
            {
              domain_id: allowed.data.id,
              can_read: true,
              can_create: true,
              can_update: true,
              can_delete: true,
            },
          ],
        },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal((await manager("/admin/manage/accounts")).status, 401);
  await manager("/auth/login", {
    email: "manager@parity.example",
    password: "Manager-password-2026",
  });
  assert.equal(
    (
      await manager(
        `/admin/manage/accounts/${row.id}`,
        { name: "允许修改" },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await manager("/admin/manage/accounts/delete", {
        ids: [row.id],
        confirm: true,
      })
    ).status,
    200,
  );
  assert.equal(
    db.prepare("SELECT id FROM users WHERE id=?").get(row.id),
    undefined,
  );
});

test("catchall preserves disabled-mailbox rejection and templates sanitize HTML with per-account isolation", async (t) => {
  const { admin, client, service, db } = await fixture(t);
  const domain = db
    .prepare("SELECT id FROM domains WHERE name=?")
    .get("parity.example");
  assert.equal(
    (
      await admin(
        `/admin/manage/domains/${domain.id}/catchall`,
        { email: "admin@parity.example", enabled: true },
        "PUT",
      )
    ).status,
    200,
  );
  const user = service.mail.localUser("admin@parity.example");
  await service.mail.send(user, {
    to: "unknown@parity.example",
    subject: "捕获测试",
    text: "deliver",
  });
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM messages WHERE owner_id=? AND folder='inbox' AND subject='捕获测试'",
      )
      .get(user.id).n,
    1,
  );
  const account = await admin("/admin/manage/accounts", {
    email: "alice@parity.example",
    password: "Alice-password-2026",
  });
  assert.equal(account.status, 201);
  const alice = client();
  await alice("/auth/webmail/login", {
    email: "alice@parity.example",
    password: "Alice-password-2026",
  });
  const id = db
    .prepare("SELECT id FROM users WHERE email=?")
    .get("alice@parity.example").id;
  assert.equal(
    (await admin(`/admin/manage/accounts/${id}`, { active: false }, "PATCH"))
      .status,
    200,
  );
  assert.equal(service.mail.recipientUser("alice@parity.example"), undefined);
  const template = await admin("/templates", {
    name: "HTML模板",
    subject: "测试",
    html: '<h1>Hello</h1><p><strong>World</strong></p><script>alert(1)</script><a href="javascript:alert(1)">link</a>',
  });
  assert.equal(template.status, 201);
  const saved = (await admin("/templates")).data.items[0];
  assert.match(saved.body_html, /<strong>World<\/strong>/);
  assert.doesNotMatch(saved.body_html, /script|javascript:/i);
  assert.equal(
    (await admin(`/admin/manage/accounts/${id}`, { active: true }, "PATCH"))
      .status,
    200,
  );
  await alice("/auth/webmail/login", {
    email: "alice@parity.example",
    password: "Alice-password-2026",
  });
  assert.deepEqual((await alice("/templates")).data.items, []);
  assert.equal(
    (await alice(`/templates/${template.data.id}`, { name: "偷改" }, "PATCH"))
      .status,
    404,
  );
  const sent = await admin("/admin/manage/send", {
    from: "admin@parity.example",
    to: "alice@parity.example",
    subject: "HTML投递",
    html: saved.body_html,
  });
  assert.equal(sent.status, 201);
  const inbox = db
    .prepare(
      "SELECT body_html,raw FROM messages WHERE owner_id=? AND folder='inbox' AND subject='HTML投递'",
    )
    .get(id);
  assert.match(inbox.body_html, /<strong>World<\/strong>/);
  assert.doesNotMatch(inbox.raw.toString(), /alert\(1\)|javascript:/i);
  const messages = (
    await admin(
      "/admin/manage/messages?folder=inbox&emails=alice%40parity.example",
    )
  ).data.items;
  assert.equal(
    (
      await admin("/messages/batch", {
        ids: messages.map((m) => m.id),
        action: "trash",
      })
    ).status,
    200,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM messages WHERE owner_id=? AND folder='inbox'",
      )
      .get(id).n,
    0,
  );
});

test("multi-mailbox code links enforce custom tokens, IP CIDR, body grants, batch creation, logs and detailed rule diagnostics", async (t) => {
  const { admin, client, service } = await fixture(t);
  await admin("/admin/manage/accounts", {
    email: "alice@parity.example",
    password: "Alice-password-2026",
  });
  const user = service.mail.localUser("admin@parity.example");
  await service.mail.send(user, {
    to: user.email,
    subject: "Admin OTP",
    text: "验证码 817493",
  });
  await service.mail.send(user, {
    to: "alice@parity.example",
    subject: "Alice OTP",
    text: "验证码 992248",
  });
  const link = await admin("/admin/code-links", {
    emails: [user.email, "alice@parity.example"],
    token: "Ab12Cd34",
    ipAllowlist: "127.0.0.0/8",
    includeMessage: true,
  });
  assert.equal(link.status, 201);
  const guest = client(),
    read = await guest("/code-links/read", { token: "Ab12Cd34" });
  assert.equal(read.status, 200);
  assert.equal(read.data.mailboxes.length, 2);
  assert.equal(read.data.items.length, 2);
  assert.equal(
    (
      await guest("/code-links/message", {
        token: "Ab12Cd34",
        id: read.data.items[0].id,
      })
    ).status,
    200,
  );
  assert.equal(
    (await guest("/code-links/read", { token: "ab12cd34" })).status,
    404,
  );
  assert.equal(
    (await admin("/admin/code-links", { email: user.email, token: "Ab12Cd34" }))
      .status,
    409,
  );
  assert.equal(
    (
      await admin(
        `/admin/code-links/${link.data.id}`,
        { ipAllowlist: "192.0.2.0/24" },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (await guest("/code-links/read", { token: "Ab12Cd34" })).status,
    404,
  );
  const logs = await admin(`/admin/code-links/${link.data.id}/logs`);
  assert(
    logs.data.items.some(
      (item) => item.result === "denied" && item.reason.includes("IP"),
    ),
  );
  const batch = await admin("/admin/code-links/batch", {
    emails: [user.email, "alice@parity.example"],
  });
  assert.equal(batch.status, 201);
  assert.equal(new Set(batch.data.items.map((i) => i.token)).size, 2);
  const rule = await admin("/admin/code-rules", {
    name: "PIN规则",
    pattern: "PIN: (\\d{4})",
    flags: "g",
    description: "支持全局标志并重置游标",
    priority: 1,
  });
  assert.equal(rule.status, 201);
  const details = await admin("/admin/code-rules/test-all", {
    text: "PIN: 1234 和 验证码 992248",
  });
  assert.equal(details.status, 200);
  assert.equal(details.data.code, "1234");
  assert(details.data.results.length >= 3);
  assert(details.data.stats.matchedRules >= 2);
  const secret = await admin("/admin/code-admin/refresh", {});
  assert.equal(
    (await guest("/code-admin/read", { secret: secret.data.secret })).status,
    200,
  );
  await admin("/admin/code-admin/refresh", {});
  assert.equal(
    (await guest("/code-admin/read", { secret: secret.data.secret })).status,
    404,
  );
  assert.equal(
    (await admin("/admin/code-admin", { public: true }, "PUT")).status,
    400,
  );
});

test("body-enabled code links show ordinary mail while code-only links keep unmatched content private", async (t) => {
  const { admin, client, service } = await fixture(t);
  await admin("/admin/manage/accounts", {
    email: "reader@parity.example",
    password: "Reader-password-2026",
  });
  const sender = service.mail.localUser("admin@parity.example");
  await service.mail.send(sender, {
    to: "reader@parity.example",
    subject: "普通邮件",
    text: "这封邮件没有验证码。",
  });
  await service.mail.send(sender, {
    to: "admin@parity.example",
    subject: "其他邮箱的验证码",
    text: "验证码 654321",
  });
  const link = await admin("/admin/code-links", {
    email: "reader@parity.example",
    includeMessage: false,
  });
  const guest = client();
  let result = await guest("/code-links/read", { token: link.data.token });
  assert.equal(result.status, 200);
  assert.equal(result.data.receivedCount, 1);
  assert.equal(result.data.matchedCount, 0);
  assert.deepEqual(result.data.items, []);
  assert(!JSON.stringify(result.data).includes("普通邮件"));
  assert(!JSON.stringify(result.data).includes("654321"));
  await admin(
    `/admin/code-links/${link.data.id}`,
    { includeMessage: true },
    "PATCH",
  );
  result = await guest("/code-links/read", { token: link.data.token });
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].subject, "普通邮件");
  assert.equal(result.data.items[0].code, null);
  assert(!("body_text" in result.data.items[0]));
  assert(!JSON.stringify(result.data).includes("654321"));
  const id = result.data.items[0].id;
  const message = await guest("/code-links/message", {
    token: link.data.token,
    id,
  });
  assert.equal(message.status, 200);
  assert.match(message.data.body_text, /这封邮件没有验证码/);
  await admin(
    `/admin/code-links/${link.data.id}`,
    { includeMessage: false },
    "PATCH",
  );
  assert.deepEqual(
    (await guest("/code-links/read", { token: link.data.token })).data.items,
    [],
  );
  assert.equal(
    (await guest("/code-links/message", { token: link.data.token, id })).status,
    403,
  );
});

test("API policies enforce sender, all recipient fields, daily quotas, IPs and explicit management scope", async (t) => {
  const { admin, service, db } = await fixture(t);
  const created = await admin("/admin/api-keys", {
    name: "limited",
    scopes: ["mail:send"],
    policy: {
      defaultSender: "admin@parity.example",
      allowedSenders: ["admin@parity.example"],
      allowedRecipientDomains: ["parity.example"],
      dailyLimit: 1,
      ipAllowlist: "127.0.0.0/8",
    },
  });
  assert.equal(created.status, 201);
  const api = async (url, body, key = created.data.token) => {
    const r = await fetch(`http://127.0.0.1:${service.ports.http}/api${url}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  assert.equal(
    (
      await api("/v1/send", {
        to: "admin@parity.example",
        bcc: "someone@external.example",
        text: "blocked",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/v1/send", {
        from: "other@parity.example",
        to: "admin@parity.example",
        text: "blocked",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/v1/send", {
        to: "missing@parity.example",
        text: "failed local mailbox",
      })
    ).status,
    422,
  );
  assert.equal(
    db
      .prepare("SELECT count FROM api_daily_usage WHERE api_key_id=?")
      .get(created.data.id).count,
    0,
  );
  assert.equal(
    (
      await api("/v1/send", {
        to: "admin@parity.example",
        subject: "API验收",
        html: "<strong>hello</strong>",
      })
    ).status,
    201,
  );
  assert.equal(
    (await api("/v1/send", { to: "admin@parity.example", text: "quota" }))
      .status,
    429,
  );
  assert.equal((await api("/v1/manage/accounts")).status, 403);
  await admin(
    `/admin/api-keys/${created.data.id}`,
    { policy: { ipAllowlist: "192.0.2.0/24" } },
    "PATCH",
  );
  assert.equal(
    (await api("/v1/send", { to: "admin@parity.example", text: "IP" })).status,
    403,
  );
  const management = await admin("/admin/api-keys", {
    name: "remote",
    scopes: ["management"],
  });
  assert.equal(
    (await api("/v1/manage/domains", undefined, management.data.token)).status,
    200,
  );
  assert.equal(
    (
      await api(
        "/v1/manage/accounts",
        { email: "remote@parity.example", password: "Remote-password-2026" },
        management.data.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (await api("/v1/manage/platform", undefined, management.data.token)).status,
    404,
  );
  assert.equal(
    (
      await api(
        "/v1/manage/messages?folder=inbox",
        undefined,
        management.data.token,
      )
    ).status,
    200,
  );
  assert.equal((await admin("/admin/connections")).status, 403);
  await admin(`/admin/api-keys/${management.data.id}`, undefined, "DELETE");
  assert.equal(
    (await api("/v1/manage/domains", undefined, management.data.token)).status,
    401,
  );
});

test("paused multi-postoffice management blocks saved and direct access without deleting configuration", async (t) => {
  const { admin, db } = await fixture(t);
  db.prepare(
    "INSERT INTO mail_connections(name,type,url,secret,enabled) VALUES(?,?,?,?,1)",
  ).run("saved connection", "node", "https://mail.example.net/", "test-secret");
  db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('features',?)")
    .run(JSON.stringify({ items: [{ id: "connections", enabled: true, show: true }] }));
  const before = db.prepare("SELECT * FROM mail_connections").all();
  for (const [path, body, method] of [
    ["/admin/connections"],
    ["/admin/CONNECTIONS/"],
    ["/admin/connections", { name: "new" }],
    ["/admin/connections/current", { id: 1 }],
    ["/admin/connections/1/test", {}],
    ["/admin/connections/1/data/accounts"],
    ["/admin/connections/1/messages/1/raw"],
    ["/admin/connections/1/action", { operation: "forward.create" }],
    ["/admin/connections/1", undefined, "DELETE"],
  ]) {
    const response = await admin(path, body, method);
    assert.equal(response.status, 403, path);
    assert.match(response.data.error, /暂时停用/);
  }
  const catalog = (await admin("/admin/features")).data.items;
  const paused = catalog.find((f) => f.id === "connections");
  assert.equal(paused.paused, true);
  assert.equal(paused.enabled, false);
  assert.equal(paused.show, false);
  paused.enabled = paused.show = true;
  const saved = await admin("/admin/features", { items: catalog }, "PUT");
  assert.equal(saved.status, 200);
  assert.equal(saved.data.items.find((f) => f.id === "connections").enabled, false);
  assert.equal((await admin("/admin/connections")).status, 403);
  assert.deepEqual(db.prepare("SELECT * FROM mail_connections").all(), before);
});

test("platform settings protect retention, cache mutation, core features and single-use cleanup plans", async (t) => {
  const { admin, client, service, db } = await fixture(t);
  assert.equal(
    (
      await admin(
        "/admin/platform",
        { name: "测试邮局", retentionEnabled: true },
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await admin(
        "/admin/platform",
        {
          name: "测试邮局",
          cacheEnabled: true,
          cacheSeconds: 30,
          announcement: "hello\nworld",
        },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal((await client()("/platform")).data.name, "测试邮局");
  const first = await admin("/admin/manage/accounts");
  assert.equal(first.headers.get("x-postoffice-cache"), "miss");
  assert.equal(
    (await admin("/admin/manage/accounts")).headers.get("x-postoffice-cache"),
    "hit",
  );
  await admin("/admin/manage/accounts", {
    email: "new@parity.example",
    password: "New-account-password-2026",
  });
  assert.equal((await admin("/admin/manage/accounts")).data.items.length, 2);
  const catalog = (await admin("/admin/features")).data.items;
  assert.equal(
    (
      await admin(
        "/admin/features",
        { items: catalog.map((f) => ({ ...f, enabled: f.id !== "platform" })) },
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await admin(
        "/admin/features",
        {
          items: catalog.map((f) => ({ ...f, enabled: f.id !== "templates" })),
        },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal((await admin("/templates")).status, 403);
  await admin("/admin/features", { items: catalog }, "PUT");
  const user = service.mail.localUser("admin@parity.example");
  await service.mail.send(user, { to: user.email, text: "cleanup fixture" });
  const preview = await admin("/admin/platform/cleanup/preview", {
    mode: "trash",
    days: 0,
    domains: ["parity.example"],
  });
  assert.equal(preview.data.count, 2);
  assert.equal(
    (
      await admin("/admin/platform/cleanup/execute", {
        token: preview.data.token,
        confirmText: "wrong",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await admin("/admin/platform/cleanup/execute", {
        token: preview.data.token,
        confirmText: "移入垃圾箱",
      })
    ).status,
    200,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM messages WHERE folder='trash' AND trashed_at IS NOT NULL",
      )
      .get().n,
    2,
  );
  assert.equal(
    (
      await admin("/admin/platform/cleanup/execute", {
        token: preview.data.token,
        confirmText: "移入垃圾箱",
      })
    ).status,
    409,
  );
  const purge = await admin("/admin/platform/cleanup/preview", {
    mode: "purge",
    days: 0,
  });
  assert.equal(
    (
      await admin("/admin/platform/cleanup/execute", {
        token: purge.data.token,
        confirmText: "永久删除",
      })
    ).status,
    200,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM messages").get().n, 0);
  const savedBackup = await admin("/admin/platform/backup", {});
  assert.equal(savedBackup.status, 201);
  const backupDownload = await admin(savedBackup.data.url.replace("/api", ""));
  assert.equal(backupDownload.status, 200);
  assert.equal(
    backupDownload.data.subarray(0, 16).toString(),
    "SQLite format 3\0",
  );
  assert.equal(
    (await client()(savedBackup.data.url.replace("/api", ""))).status,
    401,
  );
  assert.equal((await admin("/admin/platform/backup", {})).status, 429);
  assert.equal(
    (
      await admin("/admin/platform/assets", {
        content: Buffer.from('<svg onload="alert(1)"></svg>').toString(
          "base64",
        ),
      })
    ).status,
    400,
  );
});

test("remote adapters use authenticated contracts, sanitize responses and reject unsafe targets", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, headers: req.headers, body: raw });
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/api/v1/manage/domains"))
      return res.end(
        JSON.stringify({
          items: [
            { name: "remote.example", enabled: 1, private_key: "hidden" },
          ],
        }),
      );
    if (req.url.startsWith("/plugin"))
      return res.end(
        JSON.stringify({
          data: [
            { username: "a@remote.example", password: "hidden", quota: 1000 },
          ],
        }),
      );
    if (req.url.startsWith("/api/mailbox/all"))
      return res.end(
        JSON.stringify({
          code: 0,
          data: [
            {
              username: "b@remote.example",
              password_encode: "hidden",
              active: 1,
            },
          ],
        }),
      );
    if (req.url === "/api/email_template/create")
      return res.end(JSON.stringify({ code: 0, data: { id: 7 } }));
    if (req.url === "/api/contact/group/create")
      return res.end(JSON.stringify({ code: 0, data: { id: 8 } }));
    if (req.url === "/api/contact/group/import")
      return res.end(JSON.stringify({ code: 0, data: {} }));
    if (req.url === "/api/batch_mail/task/create")
      return res.end(JSON.stringify({ code: 0, data: { id: 9 } }));
    if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("Location", "http://example.com");
      return res.end();
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`,
    config = { remoteApiAllowPrivate: true, maxMessageBytes: 1024 * 1024 };
  const node = createConnectionAdapter(
    { type: "node", url, secret: "private-secret" },
    config,
  );
  assert.deepEqual((await node.resource("domains")).items, [
    { name: "remote.example", enabled: true },
  ]);
  assert.equal(requests.at(-1).headers.authorization, "Bearer private-secret");
  const bt = createConnectionAdapter(
    { type: "baota", url, secret: "panel-key" },
    config,
  );
  assert.equal(
    (await bt.resource("accounts")).items[0].email,
    "a@remote.example",
  );
  const form = new URLSearchParams(requests.at(-1).body),
    md5 = (v) => createHash("md5").update(v).digest("hex");
  assert.equal(
    form.get("request_token"),
    md5(form.get("request_time") + md5("panel-key")),
  );
  assert(!requests.at(-1).body.includes("panel-key"));
  const billion = createConnectionAdapter(
    { type: "billionmail", url, secret: "admin-token" },
    config,
  );
  assert.equal(
    (await billion.resource("accounts")).items[0].email,
    "b@remote.example",
  );
  await assert.rejects(() => billion.resource("inbox"), /不提供/);
  const send = await billion.action("send", {
    from: "a@remote.example",
    to: "recipient@local.example",
    subject: "test",
    html: "<p>Hi</p><script>alert(1)</script>",
  });
  assert.equal(send.taskId, 9);
  assert(
    !JSON.parse(
      requests.find((r) => r.url === "/api/email_template/create").body,
    ).html_content.includes("<script>"),
  );
  await assert.rejects(
    () =>
      connectionRequest(
        { url, type: "node", secret: "x" },
        "api/v1/manage/domains",
      ),
    /HTTPS|内网|私有|地址/,
  );
  await assert.rejects(
    () =>
      connectionRequest({ url, type: "node", secret: "x" }, "redirect", {
        allowPrivate: true,
      }),
    /HTTP 302/,
  );
  assert.deepEqual(
    scrubRemote({
      password: "x",
      nested: { api_key: "x", token: "x", name: "safe" },
    }),
    { nested: { name: "safe" } },
  );
});
