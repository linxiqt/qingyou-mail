import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { start } from "../src/server.js";
import { effectiveCapabilities } from "../src/admin-permissions.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-permissions-"));
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
    await rm(dir, { recursive: true, force: true });
  });
  function client() {
    let cookie = "",
      csrf = "";
    return async (url, body, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(
        `http://127.0.0.1:${service.ports.http}/api${url}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            "X-CSRF-Token": csrf,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      const data = response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.json()
        : await response.text();
      if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    };
  }
  const admin = client();
  assert.equal(
    (
      await admin("/setup", {
        domain: "control.example",
        email: "root@control.example",
        password: "Control-password-2026",
      })
    ).status,
    201,
  );
  const domain = (
    await admin("/admin/manage/domains", { name: "tenant.example" })
  ).data;
  const other = (
    await admin("/admin/manage/domains", { name: "other.example" })
  ).data;
  assert.equal(
    (
      await admin("/admin/manage/accounts", {
        email: "alice@tenant.example",
        password: "Alice-password-2026",
      })
    ).status,
    201,
  );
  const grants = [
    {
      domain_id: domain.id,
      can_read: true,
      can_create: true,
      can_update: true,
      can_delete: true,
    },
  ];
  async function manager(name, fields = {}) {
    const email = `${name}@control.example`,
      password = "Manager-password-2026";
    const result = await admin("/admin/managers", {
      email,
      password,
      scope: "scoped",
      rolePreset: "auditor",
      permissions: grants,
      ...fields,
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const call = client();
    const login = await call("/auth/login", { email, password });
    assert.equal(login.status, 200);
    return {
      call,
      id: result.data.id,
      login,
      async loginAgain() {
        return call("/auth/login", { email, password });
      },
    };
  }
  return {
    service,
    db: service.store.db,
    admin,
    domain,
    other,
    grants,
    manager,
    client,
  };
}

test("capability presets intersect domain grants and unknown or malformed grants fail closed", async (t) => {
  const { admin, manager, domain, other } = await fixture(t);
  const { call, login } = await manager("auditor");
  assert(login.data.user.capabilities.includes("mail.read"));
  assert(!login.data.user.capabilities.includes("accounts.create"));
  assert.equal(login.data.user.role_preset, "auditor");
  assert.equal(
    (await call("/admin/manage/accounts?page=1&limit=20")).status,
    200,
  );
  assert.equal(
    (
      await call("/admin/manage/accounts", {
        email: "new@tenant.example",
        password: "Password-2026-A",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/admin/manage/domains/${domain.id}`,
        { enabled: false },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (await call(`/admin/manage/domains/${other.id}/dns`)).status,
    403,
  );
  assert.equal(
    (
      await call("/admin/manage/send", {
        from: "alice@tenant.example",
        to: "alice@tenant.example",
        text: "denied",
      })
    ).status,
    403,
  );
  assert.equal((await call("/templates", { name: "denied" })).status, 403);
  assert.equal((await call("/admin/managers")).status, 403);
  assert.equal(
    (
      await admin("/admin/managers", {
        email: "bad@tenant.example",
        password: "Manager-password-2026",
        rolePreset: "custom",
        capabilities: ["system.root"],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await admin("/admin/managers", {
        email: "bad@tenant.example",
        password: "Manager-password-2026",
        permissions: [null],
      })
    ).status,
    400,
  );
  assert.deepEqual(
    effectiveCapabilities({
      role: "admin",
      admin_scope: "scoped",
      admin_capabilities: '{"mail.send":true}',
    }),
    [],
  );
});

test("custom write-only operations have scoped minimal pickers without account-read escalation", async (t) => {
  const { manager, domain, other } = await fixture(t);
  const { call } = await manager("sender", {
    rolePreset: "custom",
    capabilities: ["mail.send"],
    permissions: [{ domain_id: domain.id, can_create: true }],
  });
  assert.equal((await call("/admin/manage/accounts")).status, 403);
  assert.equal((await call("/admin/manage/domains")).status, 403);
  const options = await call(
    "/admin/manage/account-options?purpose=send&q=alice",
  );
  assert.equal(options.status, 200);
  assert.equal(options.data.items.length, 1);
  assert.equal(options.data.items[0].email, "alice@tenant.example");
  assert(!("quota_bytes" in options.data.items[0]));
  assert(!("password_hash" in options.data.items[0]));
  assert.equal(
    (await call("/admin/manage/domain-options?purpose=send")).data.items[0].id,
    domain.id,
  );
  assert.equal(
    (await call("/admin/manage/account-options?purpose=password")).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/admin/manage/account-options?purpose=send&domain=other.example",
      )
    ).data.total,
    0,
  );
  assert.equal(
    (
      await call("/admin/manage/send", {
        from: "alice@tenant.example",
        to: "alice@tenant.example",
        subject: "allowed",
        text: "body",
      })
    ).status,
    201,
  );
  assert.equal(
    (await call(`/admin/manage/domains/${other.id}/dns`)).status,
    403,
  );
});

test("editing accounts cannot reset passwords or gain administrator roles without explicit grants", async (t) => {
  const { db, admin, manager } = await fixture(t);
  const { call } = await manager("editor", {
    rolePreset: "custom",
    capabilities: ["accounts.read", "accounts.update"],
  });
  const user = db
    .prepare("SELECT * FROM users WHERE email='alice@tenant.example'")
    .get();
  assert.equal(
    (
      await call(
        `/admin/manage/accounts/${user.id}`,
        { name: "Alice edited", role: "admin", admin_scope: "global" },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    db.prepare("SELECT role FROM users WHERE id=?").get(user.id).role,
    "user",
  );
  assert.equal(
    (
      await call(
        `/admin/manage/accounts/${user.id}`,
        { password: "Replacement-password-2026" },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/admin/manage/accounts/passwords", { emails: [user.email] }))
      .status,
    403,
  );
  const root = db
    .prepare("SELECT id FROM users WHERE email='root@control.example'")
    .get();
  assert.equal(
    (await admin(`/admin/managers/${root.id}`, { scope: "scoped" }, "PATCH"))
      .status,
    400,
  );
  assert.equal(
    (await admin(`/admin/managers/${root.id}`, { active: false }, "PATCH"))
      .status,
    400,
  );
});

test("permission changes revoke old sessions immediately and remain isolated from cached data", async (t) => {
  const { admin, manager } = await fixture(t);
  await admin("/admin/platform", { cacheEnabled: true }, "PUT");
  const { call, id, loginAgain } = await manager("mutable");
  assert.equal(
    (await call("/admin/manage/accounts?page=1&limit=20")).status,
    200,
  );
  assert.equal(
    (
      await admin(
        `/admin/managers/${id}`,
        { rolePreset: "custom", capabilities: [] },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/admin/manage/accounts?page=1&limit=20")).status,
    401,
  );
  await loginAgain();
  assert.equal(
    (await call("/admin/manage/accounts?page=1&limit=20")).status,
    403,
  );
  assert.equal(
    (await call("/admin/manage/domain-options?purpose=accounts")).status,
    403,
  );
});

test("other administrators' message bodies, raw data, attachments and forwarding rules remain private", async (t) => {
  const { admin, db, service, domain, manager } = await fixture(t);
  const special = await admin("/admin/managers", {
    email: "special@tenant.example",
    password: "Special-password-2026",
    scope: "global",
  });
  assert.equal(special.status, 201);
  const owner = service.mail.localUser("special@tenant.example");
  await service.mail.send(owner, {
    to: owner.email,
    text: "private",
    attachments: [
      {
        filename: "private.txt",
        content: Buffer.from("private attachment").toString("base64"),
      },
    ],
  });
  const message = db
    .prepare("SELECT id FROM messages WHERE owner_id=? AND folder='inbox'")
    .get(owner.id);
  const attachment = db
    .prepare("SELECT id FROM attachments WHERE message_id=?")
    .get(message.id);
  await admin("/admin/manage/forwards", {
    email: owner.email,
    target: "alice@tenant.example",
  });
  const rule = db
    .prepare("SELECT id FROM forwards WHERE user_id=?")
    .get(owner.id);
  const { call } = await manager("restricted", { rolePreset: "domain_admin" });
  assert.deepEqual(
    (await call("/admin/manage/messages?folder=inbox")).data.items,
    [],
  );
  for (const suffix of [
    `messages/${message.id}`,
    `messages/${message.id}/raw`,
    `attachments/${attachment.id}`,
  ])
    assert.equal((await call(`/admin/manage/${suffix}`)).status, 403);
  assert.equal(
    (await call("/messages/batch", { ids: [message.id], action: "trash" }))
      .status,
    403,
  );
  assert.deepEqual((await call("/admin/manage/forwards")).data.items, []);
  assert.equal(
    (
      await call(
        `/admin/manage/forwards/${rule.id}`,
        { target: "restricted@control.example" },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/admin/manage/forwards/delete", { ids: [rule.id] })).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/admin/manage/domains/${domain.id}`,
        { mailboxLimit: 100 },
        "PATCH",
      )
    ).status,
    403,
  );
});

test("deletion and batch-mail endpoints cannot bypass explicit capabilities via cascade or folder changes", async (t) => {
  const { domain, db, service, manager } = await fixture(t);
  const { call } = await manager("deleter", {
    rolePreset: "custom",
    capabilities: ["domains.delete", "mail.read", "mail.update"],
  });
  assert.equal(
    (
      await call(
        `/admin/manage/domains/${domain.id}`,
        { cascade: true, confirmDomain: "tenant.example" },
        "DELETE",
      )
    ).status,
    403,
  );
  const alice = service.mail.localUser("alice@tenant.example");
  await service.mail.send(alice, { to: alice.email, text: "keep" });
  const message = db
    .prepare("SELECT id FROM messages WHERE owner_id=? AND folder='inbox'")
    .get(alice.id);
  assert.equal(
    (
      await call(
        `/admin/manage/messages/${message.id}`,
        { read: true },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/manage/messages/${message.id}`,
        { folder: "trash" },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/messages/batch", { ids: [message.id], action: "trash" }))
      .status,
    403,
  );
  assert.equal(
    db.prepare("SELECT folder FROM messages WHERE id=?").get(message.id).folder,
    "inbox",
  );
});

test("account pagination returns bounded scoped pages, exact totals and displayed-account usage", async (t) => {
  const { admin, manager } = await fixture(t);
  for (let i = 0; i < 4; i++)
    assert.equal(
      (
        await admin("/admin/manage/accounts", {
          email: `list${i}@tenant.example`,
          password: "Account-password-2026",
        })
      ).status,
      201,
    );
  const { call } = await manager("pages");
  const first = await call("/admin/manage/accounts?page=1&limit=2"),
    second = await call("/admin/manage/accounts?page=2&limit=2");
  assert.equal(first.data.total, 5);
  assert.equal(first.data.items.length, 2);
  assert.equal(first.data.limit, 2);
  assert.equal(first.data.page, 1);
  assert(
    first.data.items.every(
      (item) => item.used_bytes === 0 && item.domain === "tenant.example",
    ),
  );
  assert(
    !first.data.items.some((a) => second.data.items.some((b) => a.id === b.id)),
  );
  assert.equal(
    (await call("/admin/manage/accounts?page=1&limit=2&q=list")).data.total,
    4,
  );
  assert.equal(
    (await call("/admin/manage/accounts?page=1&limit=101")).status,
    400,
  );
});

test("revocation during message composition is rechecked before delivery is committed", async (t) => {
  const { manager, service, db } = await fixture(t);
  const { call, id } = await manager("pending", {
    rolePreset: "custom",
    capabilities: ["mail.send"],
  });
  const originalSend = service.mail.send;
  let checked = 0;
  service.mail.send = (user, input, authorize) =>
    originalSend(user, input, () => {
      // Simulate another administrator revoking this permission while MIME build
      // yielded; the second authorization occurs inside the delivery transaction.
      checked++;
      if (checked === 2)
        db.prepare("UPDATE users SET admin_capabilities='[]' WHERE id=?").run(
          id,
        );
      authorize();
    });
  const result = await call("/admin/manage/send", {
    from: "alice@tenant.example",
    to: "alice@tenant.example",
    subject: "must not deliver",
    text: "private",
  });
  assert.equal(result.status, 403);
  assert.equal(checked, 2);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM messages WHERE subject='must not deliver'",
      )
      .get().n,
    0,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM delivery_jobs").get().n, 0);
});

test("global administrator manages mailbox batches without product activation", async (t) => {
  const { admin, service, db } = await fixture(t);
  const owner = service.mail.localUser("root@control.example");
  await service.mail.send(owner, {
    to: "alice@tenant.example",
    text: "license-bound batch",
    subject: "license batch",
  });
  const mine = db
    .prepare("SELECT id FROM messages WHERE owner_id=? AND folder='sent'")
    .get(owner.id).id;
  const foreign = db
    .prepare("SELECT id FROM messages WHERE owner_id<>? AND folder='inbox'")
    .get(owner.id).id;
  assert.equal(
    (await admin("/messages/batch", { ids: [mine], action: "read" })).status,
    200,
  );
  assert.equal(
    (await admin("/messages/batch", { ids: [foreign], action: "trash" }))
      .status,
    200,
  );
  assert.equal(
    (await admin("/messages/batch", { ids: [mine, foreign], action: "unread" }))
      .status,
    200,
  );
  assert.equal(
    db.prepare("SELECT is_read FROM messages WHERE id=?").get(mine).is_read,
    0,
  );
  assert.equal(
    db.prepare("SELECT folder FROM messages WHERE id=?").get(foreign).folder,
    "trash",
  );
});

test("a concurrent manager edit cannot restore domain grants removed while password hashing awaited", async (t) => {
  const { admin, manager, db } = await fixture(t);
  const { id } = await manager("concurrent", { rolePreset: "domain_admin" });
  const originalPrepare = db.prepare;
  let scheduled = false,
    narrowed = false;
  db.prepare = function (sql) {
    if (
      !scheduled &&
      sql === "SELECT id FROM domains WHERE name=? AND enabled=1"
    ) {
      scheduled = true;
      setImmediate(() => {
        originalPrepare
          .call(
            db,
            "UPDATE domain_permissions SET can_create=0,can_update=0,can_delete=0 WHERE user_id=?",
          )
          .run(id);
        narrowed = true;
      });
    }
    return originalPrepare.call(db, sql);
  };
  try {
    const result = await admin(
      `/admin/managers/${id}`,
      { name: "Concurrent edit", password: "New-manager-password-2026" },
      "PATCH",
    );
    assert(narrowed);
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.equal(
      originalPrepare
        .call(db, "SELECT can_create FROM domain_permissions WHERE user_id=?")
        .get(id).can_create,
      0,
    );
  } finally {
    db.prepare = originalPrepare;
  }
});
