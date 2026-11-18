import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { start } from "../src/server.js";
import { effectiveCapabilities } from "../src/admin-permissions.js";

const password = "Client-password-2026";
async function fixture(t) {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "postoffice-client-grants-"),
  );
  const app = await start({
    host: "127.0.0.1",
    port: 0,
    smtpHost: "127.0.0.1",
    smtpPort: 0,
    submissionPort: 0,
    dataDir,
    outboundMode: "local",
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function client() {
    let cookie = "",
      csrf = "";
    return async (path, body, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(
        `http://127.0.0.1:${app.ports.http}/api${path}`,
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
        password,
      })
    ).status,
    201,
  );
  const alpha = (
    await admin("/admin/manage/domains", { name: "alpha.example" })
  ).data;
  const beta = (await admin("/admin/manage/domains", { name: "beta.example" }))
    .data;
  for (const email of ["plain@alpha.example", "private@beta.example"])
    assert.equal(
      (await admin("/admin/manage/accounts", { email, password })).status,
      201,
    );
  const permissions = [
    {
      domain_id: alpha.id,
      can_read: true,
      can_create: true,
      can_update: true,
      can_delete: true,
    },
  ];
  async function manager(email, fields = {}) {
    const created = await admin("/admin/managers", {
      email,
      password,
      scope: "client",
      permissions,
      ...fields,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const call = client();
    const login = await call("/auth/webmail/login", { email, password });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    return {
      call,
      id: created.data.id,
      user: login.data.user,
      login: () => call("/auth/webmail/login", { email, password }),
    };
  }
  return { app, db: app.store.db, admin, alpha, beta, manager, client };
}

test("client domain ownership is explicit and normal mailboxes cannot acquire management rights", async (t) => {
  const { admin, alpha, beta, manager, client, db } = await fixture(t);
  const user = await manager("owner@control.example");
  assert.equal(user.user.role, "user");
  assert.equal(user.user.client_manager, true);
  assert.equal(user.user.role_preset, "client_manager");
  assert(!user.user.capabilities.includes("domains.delete"));
  assert.deepEqual(
    (await user.call("/client/manage/domains")).data.items.map((d) => d.id),
    [alpha.id],
  );
  assert.equal((await user.call("/admin/manage/accounts")).status, 401);
  assert.equal((await user.call("/client/admin/managers")).status, 403);
  assert.equal(
    (
      await user.call("/client/manage/accounts", {
        email: "created@alpha.example",
        password,
        role: "admin",
        client_manager: 1,
      })
    ).status,
    201,
  );
  const created = db
    .prepare("SELECT * FROM users WHERE email='created@alpha.example'")
    .get();
  assert.equal(created.role, "user");
  assert.equal(created.client_manager, 0);
  assert.equal(
    (
      await user.call("/client/manage/accounts", {
        email: "bad@beta.example",
        password,
      })
    ).status,
    403,
  );
  assert.equal(
    (await user.call(`/client/manage/domains/${beta.id}/dns`)).status,
    403,
  );
  assert.equal(
    (
      await user.call(
        `/client/manage/domains/${alpha.id}`,
        { mailboxLimit: 999 },
        "PATCH",
      )
    ).status,
    403,
  );
  const plain = client();
  assert.equal(
    (
      await plain("/auth/webmail/login", {
        email: "plain@alpha.example",
        password,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await plain("/client/manage/accounts", {
        email: "denied@alpha.example",
        password,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await admin("/admin/managers", {
        email: "badmanager@alpha.example",
        password,
        scope: "client",
        rolePreset: "domain_admin",
      })
    ).status,
    400,
  );
  assert.deepEqual(
    effectiveCapabilities({
      role: "user",
      client_manager: 1,
      admin_capabilities: null,
    }),
    [],
  );
});

test("clients cannot access peer managers through mail, attachments, account or forwarding routes", async (t) => {
  const { admin, app, db, manager } = await fixture(t);
  const owner = await manager("owner@alpha.example");
  const peer = await manager("peer@alpha.example");
  const sender = app.mail.localUser("plain@alpha.example");
  await app.mail.send(sender, {
    to: "peer@alpha.example",
    subject: "Private",
    text: "private",
    attachments: [
      {
        filename: "private.txt",
        content: Buffer.from("private").toString("base64"),
      },
    ],
  });
  const message = db
    .prepare("SELECT id FROM messages WHERE owner_id=? AND folder='inbox'")
    .get(peer.id);
  const attachment = db
    .prepare("SELECT id FROM attachments WHERE message_id=?")
    .get(message.id);
  await admin("/admin/manage/forwards", {
    email: "peer@alpha.example",
    target: "plain@alpha.example",
  });
  const forward = db
    .prepare("SELECT id FROM forwards WHERE user_id=?")
    .get(peer.id);
  const accounts = (await owner.call("/client/manage/accounts")).data.items;
  assert(!accounts.some((u) => u.id === peer.id));
  assert(
    !(await owner.call("/client/manage/messages?folder=inbox")).data.items.some(
      (m) => m.id === message.id,
    ),
  );
  assert.deepEqual(
    (await owner.call("/client/manage/forwards")).data.items,
    [],
  );
  for (const suffix of [
    `messages/${message.id}`,
    `messages/${message.id}/raw`,
    `attachments/${attachment.id}`,
  ])
    assert.equal(
      (await owner.call(`/client/manage/${suffix}`)).status,
      403,
      suffix,
    );
  assert.equal(
    (
      await owner.call(
        `/client/manage/accounts/${peer.id}`,
        { password: "Hijack-password-2026" },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.call("/client/manage/accounts/passwords", {
        emails: "peer@alpha.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.call("/client/manage/accounts/delete", {
        ids: [peer.id],
        confirm: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.call("/client/manage/send", {
        from: "peer@alpha.example",
        to: "plain@alpha.example",
        text: "spoof",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.call("/client/manage/messages/batch", {
        ids: [message.id],
        action: "trash",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.call("/client/manage/forwards", {
        email: "peer@alpha.example",
        target: "plain@alpha.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.call(
        `/client/manage/forwards/${forward.id}`,
        { email: "plain@alpha.example", target: "owner@alpha.example" },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (await owner.call("/client/manage/forwards/delete", { ids: [forward.id] }))
      .status,
    403,
  );
});

test("client custom permissions, domain quotas and revocation remain enforced on every request", async (t) => {
  const { admin, alpha, manager, db } = await fixture(t);
  const owner = await manager("creator@control.example", {
    rolePreset: "custom",
    capabilities: ["accounts.create"],
    permissions: [{ domain_id: alpha.id, can_create: true }],
  });
  assert.equal(
    (await owner.call("/client/manage/domain-options?purpose=create")).status,
    200,
  );
  assert.equal((await owner.call("/client/manage/accounts")).status, 403);
  assert.equal(
    (await owner.call("/client/manage/account-options?purpose=password"))
      .status,
    403,
  );
  assert.equal(
    (
      await admin(
        `/admin/manage/domains/${alpha.id}`,
        { mailboxLimit: 2 },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await owner.call("/client/manage/accounts/batch", {
        domain: "alpha.example",
        entries: [
          { local: "first", password },
          { local: "second", password },
        ],
      })
    ).status,
    409,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM users WHERE email IN('first@alpha.example','second@alpha.example')",
      )
      .get().n,
    0,
  );
  assert.equal(
    (
      await owner.call("/client/manage/accounts", {
        email: "last@alpha.example",
        password,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await owner.call("/client/manage/accounts", {
        email: "excess@alpha.example",
        password,
      })
    ).status,
    409,
  );
  assert.equal(
    (await admin(`/admin/managers/${owner.id}`, { scope: "user" }, "PATCH"))
      .status,
    200,
  );
  assert.equal(
    (await owner.call("/client/manage/domain-options?purpose=create")).status,
    401,
  );
  assert.equal((await owner.login()).status, 200);
  assert.equal(
    (await owner.call("/client/manage/domain-options?purpose=create")).status,
    403,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM domain_permissions WHERE user_id=?")
      .get(owner.id).n,
    0,
  );
});

test("equivalent case and trailing-slash delete routes cannot fall back to account creation permission", async (t) => {
  const { manager, db } = await fixture(t);
  const owner = await manager("creator@control.example", {
    rolePreset: "custom",
    capabilities: ["accounts.create"],
  });
  // Domain grants allow deletion, but the separate feature capability does not.
  const victim = db
    .prepare("SELECT id FROM users WHERE email='plain@alpha.example'")
    .get();
  for (const path of [
    "/client/manage/accounts/delete",
    "/client/manage/accounts/delete/",
    "/client/manage/accounts/Delete",
    "/client/manage/ACCOUNTS/DELETE/",
  ]) {
    assert.equal(
      (await owner.call(path, { ids: [victim.id], confirm: true })).status,
      403,
      path,
    );
    assert(db.prepare("SELECT id FROM users WHERE id=?").get(victim.id), path);
  }
});
