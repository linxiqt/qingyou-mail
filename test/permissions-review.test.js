import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { start } from "../src/server.js";

async function fixture(t) {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "postoffice-permission-review-"),
  );
  const service = await start({
    host: "127.0.0.1",
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    smtpHost: "127.0.0.1",
    dataDir,
    outboundMode: "local",
  });
  t.after(async () => {
    await service.close();
    assert(
      path
        .resolve(dataDir)
        .startsWith(
          path.resolve(os.tmpdir()) +
            path.sep +
            "postoffice-permission-review-",
        ),
    );
    await rm(dataDir, { recursive: true, force: true });
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
      const raw = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("postoffice_session="));
      if (raw) cookie = raw.split(";")[0];
      const data = await response.json();
      if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    };
  }
  const admin = client();
  assert.equal(
    (
      await admin("/setup", {
        domain: "review.example",
        email: "admin@review.example",
        password: "Review-admin-pass-2026",
        name: "Review admin",
      })
    ).status,
    201,
  );
  return { service, db: service.store.db, admin, client };
}

test("a manager without mail read cannot obtain other users' mail through legacy URLs or API keys", async (t) => {
  const { admin, client, service, db } = await fixture(t);
  const domainId = db
    .prepare("SELECT id FROM domains WHERE name='review.example'")
    .get().id;
  assert.equal(
    (
      await admin("/admin/manage/accounts", {
        email: "recipient@review.example",
        password: "Review-recipient-pass-2026",
      })
    ).status,
    201,
  );
  await service.mail.send(service.mail.localUser("admin@review.example"), {
    to: "recipient@review.example",
    subject: "Private fixture",
    text: "Private fixture content",
    attachments: [
      {
        filename: "fixture.txt",
        content: Buffer.from("Private attachment").toString("base64"),
      },
    ],
  });
  const message = db
    .prepare(
      "SELECT m.id FROM messages m JOIN users u ON u.id=m.owner_id WHERE u.email='recipient@review.example' AND m.folder='inbox'",
    )
    .get();
  const attachment = db
    .prepare("SELECT id FROM attachments WHERE message_id=?")
    .get(message.id);
  assert.equal(
    (
      await admin("/admin/managers", {
        email: "operator@review.example",
        password: "Review-manager-pass-2026",
        scope: "scoped",
        rolePreset: "custom",
        capabilities: ["accounts.read"],
        permissions: [
          {
            domain_id: domainId,
            can_read: true,
            can_create: true,
            can_update: true,
            can_delete: true,
          },
        ],
      })
    ).status,
    201,
  );
  const manager = client();
  assert.equal(
    (
      await manager("/auth/login", {
        email: "operator@review.example",
        password: "Review-manager-pass-2026",
      })
    ).status,
    200,
  );
  const routes = [
    "/admin/messages",
    `/admin/messages/${message.id}`,
    `/admin/messages/${message.id}/raw`,
    `/admin/attachments/${attachment.id}`,
    "/admin/manage/messages",
    `/admin/manage/messages/${message.id}`,
    `/admin/manage/messages/${message.id}/raw`,
    `/admin/manage/attachments/${attachment.id}`,
    "/admin/codes",
    "/admin/code-links",
    "/admin/api-keys",
    "/admin/system",
    "/admin/platform/backups",
    "/admin/managers",
  ];
  for (const route of routes) {
    const result = await manager(route);
    assert.equal(result.status, 403, route);
    assert(!JSON.stringify(result.data).includes("Private fixture content"));
  }
  assert.equal((await manager(`/messages/${message.id}`)).status, 404);
  assert.equal((await manager(`/attachments/${attachment.id}`)).status, 404);
  assert.equal((await manager("/v1/messages")).status, 401);
  assert.equal(
    (await manager("/messages/batch", { ids: [message.id], action: "trash" }))
      .status,
    403,
  );
  assert.equal(
    db.prepare("SELECT folder FROM messages WHERE id=?").get(message.id).folder,
    "inbox",
  );
});

test("revoking a global administrator during legacy account creation prevents the pending write", async (t) => {
  const { admin, client, db } = await fixture(t);
  const created = await admin("/admin/managers", {
    email: "delegated@review.example",
    password: "Review-manager-pass-2026",
    scope: "global",
  });
  assert.equal(created.status, 201);
  const delegated = client();
  assert.equal(
    (
      await delegated("/auth/login", {
        email: "delegated@review.example",
        password: "Review-manager-pass-2026",
      })
    ).status,
    200,
  );
  // Revoke after the route authenticated but immediately before it awaits a
  // password hash. This deterministic hook avoids a timing-dependent race test.
  const originalPrepare = db.prepare.bind(db);
  let revoked = false;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (sql !== "SELECT * FROM domains WHERE name=? AND enabled=1")
      return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key !== "get") {
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...args) => {
          const result = target.get(...args);
          db.prepare = originalPrepare;
          originalPrepare("UPDATE users SET role='user' WHERE id=?").run(
            created.data.id,
          );
          originalPrepare("DELETE FROM sessions WHERE user_id=?").run(
            created.data.id,
          );
          revoked = true;
          return result;
        };
      },
    });
  };
  let result;
  try {
    result = await delegated("/admin/users", {
      email: "should-not-exist@review.example",
      password: "Review-mailbox-pass-2026",
    });
  } finally {
    db.prepare = originalPrepare;
  }
  assert(revoked, "revocation hook must run inside the request");
  assert(
    [401, 403].includes(result.status),
    `pending write returned ${result.status}`,
  );
  assert.equal(
    db
      .prepare(
        "SELECT id FROM users WHERE email='should-not-exist@review.example'",
      )
      .get(),
    undefined,
  );
});
