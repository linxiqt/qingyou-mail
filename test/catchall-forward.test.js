import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodemailer from "nodemailer";
import { start } from "../src/server.js";

const password = "Catchall-test-password-2026";
async function fixture(t, local = false) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "postoffice-catchall-"));
  const delivered = [];
  const app = await start({
    host: "127.0.0.1",
    port: 0,
    smtpHost: "127.0.0.1",
    smtpPort: 0,
    submissionPort: 0,
    dataDir,
    outboundMode: local ? "local" : "relay",
    allowInsecureAuth: true,
    relay: { host: "relay.invalid", port: 25 },
    outboundDependencies: {
      createTransport: () => ({
        close() {},
        async sendMail(message) {
          delivered.push(message);
          return { accepted: message.envelope.to, rejected: [] };
        },
      }),
    },
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function client() {
    let cookie = "",
      csrf = "";
    return async (url, body, method = body === undefined ? "GET" : "POST") => {
      const r = await fetch(`http://127.0.0.1:${app.ports.http}/api${url}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      const data = await r.json();
      if (data.csrfToken) csrf = data.csrfToken;
      return { status: r.status, data };
    };
  }
  const admin = client();
  assert.equal(
    (await admin("/setup", { username: "admin", password })).status,
    201,
  );
  const alpha = (
    await admin("/admin/manage/domains", { name: "alpha.example" })
  ).data;
  const beta = (await admin("/admin/manage/domains", { name: "beta.example" }))
    .data;
  const smtp = nodemailer.createTransport({
    host: "127.0.0.1",
    port: app.ports.smtp,
    ignoreTLS: true,
  });
  t.after(() => smtp.close());
  return { app, db: app.store.db, admin, client, alpha, beta, delivered, smtp };
}
const raw = (to) =>
  Buffer.from(
    `From: sender@outside.example\r\nTo: ${to}\r\nSubject: catchall fixture\r\n\r\nIncoming body\r\n`,
  );

test("SMTP catch-all forwards an empty domain to external targets without opening relay or catching disabled mailboxes", async (t) => {
  const { app, db, admin, alpha, delivered, smtp } = await fixture(t);
  assert.equal(
    (
      await admin("/admin/manage/forwards", {
        email: "*@alpha.example",
        target: "sink@external.example",
      })
    ).status,
    201,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM users WHERE domain_id=?").get(alpha.id)
      .n,
    0,
  );
  const rule = (await admin("/admin/manage/forwards")).data.items[0];
  assert.equal(rule.id, `catchall:${alpha.id}`);
  assert.equal(rule.kind, "catchall");
  assert.equal(rule.keep_copy, 0);
  assert.equal(
    (
      await admin("/admin/manage/forwards", {
        email: "*@alpha.example",
        target: "duplicate@external.example",
      })
    ).status,
    409,
  );
  await smtp.sendMail({
    envelope: {
      from: "sender@outside.example",
      to: "never-created@alpha.example",
    },
    raw: raw("never-created@alpha.example"),
  });
  for (let i = 0; !delivered.length && i < 30; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(delivered[0].envelope.to, ["sink@external.example"]);
  assert.equal(delivered[0].envelope.from, "sender@outside.example");
  const job = db.prepare("SELECT owner_id FROM delivery_jobs").get();
  assert.equal(
    job.owner_id,
    db.prepare("SELECT id FROM users WHERE email='admin'").get().id,
  );
  await assert.rejects(
    smtp.sendMail({
      envelope: {
        from: "sender@outside.example",
        to: "relay@external.example",
      },
      raw: raw("relay@external.example"),
    }),
    (e) => e.responseCode === 550,
  );
  assert.equal(
    (
      await admin("/admin/manage/accounts", {
        email: "known@alpha.example",
        password,
      })
    ).status,
    201,
  );
  await smtp.sendMail({
    envelope: { from: "sender@outside.example", to: "known@alpha.example" },
    raw: raw("known@alpha.example"),
  });
  assert.equal(
    db.prepare("SELECT count(*) n FROM messages WHERE folder='inbox'").get().n,
    1,
  );
  assert.equal(delivered.length, 1);
  db.prepare(
    "UPDATE users SET active=0 WHERE email='known@alpha.example'",
  ).run();
  await assert.rejects(
    smtp.sendMail({
      envelope: { from: "sender@outside.example", to: "known@alpha.example" },
      raw: raw("known@alpha.example"),
    }),
    (e) => e.responseCode === 550,
  );
  assert.equal(
    (
      await admin(
        `/admin/manage/forwards/${rule.id}`,
        { enabled: false },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(app.mail.acceptsRecipient("random@alpha.example"), false);
  assert.equal(
    (
      await admin(
        `/admin/manage/forwards/${rule.id}`,
        { enabled: true },
        "PATCH",
      )
    ).status,
    200,
  );
  db.prepare("UPDATE domains SET enabled=0 WHERE id=?").run(alpha.id);
  assert.equal(app.mail.acceptsRecipient("random@alpha.example"), false);
  db.prepare("UPDATE domains SET enabled=1 WHERE id=?").run(alpha.id);
  assert.equal(
    (await admin("/admin/manage/forwards/delete", { ids: [rule.id] })).status,
    200,
  );
  assert.equal(app.mail.acceptsRecipient("random@alpha.example"), false);
});

test("catch-all local delivery, legacy capture replacement and cyclic chains are atomic", async (t) => {
  const { app, db, admin, alpha, beta } = await fixture(t);
  for (const email of ["sink@alpha.example", "sink@beta.example"])
    assert.equal(
      (await admin("/admin/manage/accounts", { email, password })).status,
      201,
    );
  assert.equal(
    (
      await admin(
        `/admin/manage/domains/${alpha.id}/catchall`,
        { email: "sink@alpha.example" },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await admin("/admin/manage/forwards", {
        email: "*@alpha.example",
        target: "sink@beta.example",
      })
    ).status,
    201,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM domain_catchalls WHERE domain_id=?")
      .get(alpha.id).n,
    0,
  );
  await app.mail.receive(raw("unknown@alpha.example"), {
    from: "sender@outside.example",
    to: ["unknown@alpha.example"],
  });
  assert.equal(
    db
      .prepare(
        "SELECT u.email FROM messages m JOIN users u ON u.id=m.owner_id WHERE m.folder='inbox'",
      )
      .get().email,
    "sink@beta.example",
  );
  for (const endpoint of ["/admin/manage/forwards", "/admin/forwards"])
    assert.equal(
      (
        await admin(endpoint, {
          email: "sink@beta.example",
          target: "unknown@alpha.example",
        })
      ).status,
      400,
    );
  assert.equal(db.prepare("SELECT count(*) n FROM forwards").get().n, 0);
  assert.equal(
    (
      await admin("/admin/manage/forwards", {
        email: "*@beta.example",
        target: "unknown@alpha.example",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await admin(
        `/admin/manage/forwards/catchall:${alpha.id}`,
        { target: "unknown@beta.example" },
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    db
      .prepare("SELECT target FROM catchall_forwards WHERE domain_id=?")
      .get(alpha.id).target,
    "sink@beta.example",
  );
  assert.equal(
    (
      await admin(
        `/admin/manage/domains/${alpha.id}/catchall`,
        { email: "sink@alpha.example" },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM catchall_forwards WHERE domain_id=?")
      .get(alpha.id).n,
    0,
  );
  assert.equal(
    app.mail.recipientUser("other@alpha.example").email,
    "sink@alpha.example",
  );
  const tooManyHops = Buffer.concat([
    Buffer.from("Received: from another-node\r\n".repeat(50)),
    raw("unknown@alpha.example"),
  ]);
  await assert.rejects(
    app.mail.receive(tooManyHops, {
      from: "sender@outside.example",
      to: ["unknown@alpha.example"],
    }),
    (e) => e.responseCode === 554,
  );
});

test("client catch-all permissions are explicit per domain and CRUD operation", async (t) => {
  const { admin, client, alpha, beta, db } = await fixture(t);
  const grants = [
    {
      domain_id: alpha.id,
      can_read: true,
      can_create: true,
      can_update: true,
      can_delete: true,
    },
  ];
  const manager = await admin("/admin/managers", {
    email: "owner@alpha.example",
    password,
    scope: "client",
    permissions: grants,
    capabilities: ["forwards.read", "forwards.write"],
  });
  assert.equal(manager.status, 201);
  const owner = client();
  assert.equal(
    (
      await owner("/client/auth/login", {
        email: "owner@alpha.example",
        password,
      })
    ).status,
    200,
  );
  assert.deepEqual(
    (
      await owner("/client/manage/domain-options?purpose=forward-catchall")
    ).data.items.map((d) => d.id),
    [alpha.id],
  );
  assert.equal(
    (
      await owner("/client/manage/forwards", {
        email: "*@alpha.example",
        target: "sink@external.example",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await owner("/client/manage/forwards", {
        email: "*@beta.example",
        target: "sink@external.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await admin("/admin/manage/forwards", {
        email: "*@beta.example",
        target: "sink@external.example",
      })
    ).status,
    201,
  );
  assert.deepEqual(
    (await owner("/client/manage/forwards")).data.items.map((r) => r.domain_id),
    [alpha.id],
  );
  assert.equal(
    (
      await owner(
        `/client/manage/forwards/catchall:${beta.id}`,
        { target: "stolen@external.example" },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await owner("/client/manage/forwards/delete", {
        ids: [`catchall:${alpha.id}`, `catchall:${beta.id}`],
      })
    ).status,
    403,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM catchall_forwards").get().n,
    2,
  );
  db.prepare(
    "UPDATE domain_permissions SET can_create=0,can_delete=0 WHERE user_id=?",
  ).run(manager.data.id);
  assert.deepEqual(
    (await owner("/client/manage/domain-options?purpose=forward-catchall")).data
      .items,
    [],
  );
  assert.deepEqual(
    (
      await owner(
        "/client/manage/domain-options?purpose=forward-catchall-update",
      )
    ).data.items.map((d) => d.id),
    [alpha.id],
  );
  assert.equal(
    (
      await owner(
        `/client/manage/forwards/catchall:${alpha.id}`,
        { target: "changed@external.example" },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await owner("/client/manage/forwards/delete", {
        ids: [`catchall:${alpha.id}`],
      })
    ).status,
    403,
  );
  db.prepare(
    "UPDATE users SET admin_capabilities='[\"forwards.read\"]' WHERE id=?",
  ).run(manager.data.id);
  assert.equal(
    (
      await owner(
        `/client/manage/forwards/catchall:${alpha.id}`,
        { enabled: false },
        "PATCH",
      )
    ).status,
    403,
  );
});

test("catch-all forwarding respects local-only outbound configuration", async (t) => {
  const { admin } = await fixture(t, true);
  assert.equal(
    (
      await admin("/admin/manage/forwards", {
        email: "*@alpha.example",
        target: "sink@external.example",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await admin("/admin/manage/accounts", {
        email: "sink@beta.example",
        password,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await admin("/admin/manage/forwards", {
        email: "*@alpha.example",
        target: "sink@beta.example",
      })
    ).status,
    201,
  );
});

test("only domain update permission can replace a prior capture mailbox", async (t) => {
  const { admin, client, db, alpha } = await fixture(t);
  assert.equal(
    (
      await admin("/admin/manage/accounts", {
        email: "sink@alpha.example",
        password,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await admin(
        `/admin/manage/domains/${alpha.id}/catchall`,
        { email: "sink@alpha.example" },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await admin("/admin/managers", {
        email: "owner@alpha.example",
        password,
        scope: "client",
        permissions: [
          { domain_id: alpha.id, can_read: true, can_create: true },
        ],
        capabilities: ["forwards.write"],
      })
    ).status,
    201,
  );
  const owner = client();
  assert.equal(
    (
      await owner("/client/auth/login", {
        email: "owner@alpha.example",
        password,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await owner("/client/manage/forwards", {
        email: "*@alpha.example",
        target: "sink@external.example",
      })
    ).status,
    403,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM domain_catchalls WHERE domain_id=?")
      .get(alpha.id).n,
    1,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM catchall_forwards").get().n,
    0,
  );
});

test("existing catch-all rules can be disabled even when their domain or delivery target is unavailable", async (t) => {
  const { admin, db, alpha, beta, app } = await fixture(t, true);
  assert.equal(
    (
      await admin("/admin/manage/accounts", {
        email: "sink@beta.example",
        password,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await admin("/admin/manage/forwards", {
        email: "*@alpha.example",
        target: "sink@beta.example",
      })
    ).status,
    201,
  );
  db.prepare("UPDATE users SET active=0 WHERE email='sink@beta.example'").run();
  db.prepare("UPDATE domains SET enabled=0 WHERE id=?").run(alpha.id);
  assert(
    (
      await admin(
        "/admin/manage/domain-options?purpose=forward-catchall-update",
      )
    ).data.items.some((d) => d.id === alpha.id),
  );
  assert.equal(
    (
      await admin(
        `/admin/manage/forwards/catchall:${alpha.id}`,
        { enabled: false },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(app.mail.acceptsRecipient("unknown@alpha.example"), false);
  db.prepare("UPDATE domains SET enabled=1 WHERE id=?").run(alpha.id);
  db.prepare(
    "UPDATE catchall_forwards SET enabled=1,target='sink@external.example' WHERE domain_id=?",
  ).run(alpha.id);
  assert.equal(
    (
      await admin(
        `/admin/manage/forwards/catchall:${alpha.id}`,
        { enabled: false },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    db
      .prepare("SELECT enabled FROM catchall_forwards WHERE domain_id=?")
      .get(alpha.id).enabled,
    0,
  );
  assert.equal(
    (
      await admin(
        `/admin/manage/forwards/catchall:${alpha.id}`,
        { enabled: true },
        "PATCH",
      )
    ).status,
    400,
  );
});
