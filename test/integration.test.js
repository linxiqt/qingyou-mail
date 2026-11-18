import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import { start } from "../src/server.js";

const password = "Test-account-password-2026";
async function until(fn) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting for delivery");
}
function client(base) {
  return {
    cookie: "",
    csrf: "",
    clientPortal: false,
    async call(url, { method = "GET", body, headers = {} } = {}) {
      if (url === "/auth/webmail/login") this.clientPortal = true;
      if (this.clientPortal && !url.startsWith("/client/"))
        url = "/client" + url;
      const r = await fetch(`${base}/api${url}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const cookie = r.headers.get("set-cookie");
      if (cookie) this.cookie = cookie.split(";")[0];
      const data = await r.json().catch(() => null);
      if (data?.csrfToken) this.csrf = data.csrfToken;
      return { status: r.status, data, headers: r.headers };
    },
  };
}

test("mail server, administrator permissions and integrations", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-test-"));
  const received = [];
  let temporaryFailures = 1;
  const events = [];
  const relay = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    authOptional: true,
    disableReverseLookup: true,
    onRcptTo(address, _session, callback) {
      if (address.address === "permanent@outside.example")
        return callback(
          Object.assign(new Error("Mailbox rejected"), { responseCode: 550 }),
        );
      if (
        address.address === "temporary@outside.example" &&
        temporaryFailures-- > 0
      )
        return callback(
          Object.assign(new Error("Try later"), { responseCode: 451 }),
        );
      callback();
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        received.push({
          raw: Buffer.concat(chunks),
          envelope: session.envelope,
        });
        cb();
      });
    },
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const hook = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      events.push({
        headers: req.headers,
        raw: Buffer.concat(chunks).toString(),
      });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  const service = await start({
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    dataDir: dir,
    allowInsecureAuth: true,
    webhookAllowPrivate: true,
    maxMessageBytes: 3 * 1024 ** 2,
    relay: {
      host: "127.0.0.1",
      port: relay.server.address().port,
      secure: false,
      ignoreTLS: true,
    },
  });
  t.after(async () => {
    await service.close();
    await Promise.all([
      new Promise((r) => relay.close(r)),
      new Promise((r) => hook.close(r)),
    ]);
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.ports.http}`;
  const admin = client(base),
    alice = client(base),
    bob = client(base);
  let aliceId, bobId, carolId, messageId, attachmentId, hookSecret;
  await t.test(
    "initialization needs no token and can only run once",
    async () => {
      assert.equal(
        (
          await admin.call("/setup", {
            method: "POST",
            body: { password: "short" },
          })
        ).status,
        400,
      );
      const setup = await admin.call("/setup", {
        method: "POST",
        body: {
          domain: "example.com",
          email: "admin@example.com",
          name: "Administrator",
          password,
        },
      });
      assert.equal(setup.status, 201);
      assert.equal(setup.data.user.role, "admin");
      assert.equal(typeof setup.data.domainId, "number");
      assert.equal(
        (
          await admin.call("/setup", {
            method: "POST",
            body: {},
          })
        ).status,
        409,
      );
    },
  );
  await t.test(
    "batch accounts are atomic and do not expose password hashes",
    async () => {
      const r = await admin.call("/admin/users/batch", {
        method: "POST",
        body: {
          domain: "example.com",
          entries: [
            { local: "alice", password },
            { local: "bob", password },
            { local: "carol", password },
          ],
        },
      });
      assert.equal(r.status, 201);
      assert.equal(r.data.items.length, 3);
      const bad = await admin.call("/admin/users/batch", {
        method: "POST",
        body: {
          domain: "example.com",
          entries: [{ local: "rollback-user" }, { local: "alice" }],
        },
      });
      assert.equal(bad.status, 409);
      const users = (await admin.call("/admin/users")).data.items;
      assert.equal(users.length, 4);
      assert(
        !users.some((u) => u.password_hash || u.email.startsWith("rollback")),
      );
      aliceId = users.find((u) => u.email === "alice@example.com").id;
      bobId = users.find((u) => u.email === "bob@example.com").id;
      carolId = users.find((u) => u.email === "carol@example.com").id;
      assert.equal(
        (
          await alice.call("/auth/webmail/login", {
            method: "POST",
            body: { email: "alice@example.com", password },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await bob.call("/auth/webmail/login", {
            method: "POST",
            body: { email: "bob@example.com", password },
          })
        ).status,
        200,
      );
    },
  );
  await t.test("all administrative routes reject a normal user", async () => {
    for (const route of [
      "/overview",
      "/users",
      "/domains",
      "/forwards",
      "/messages",
      "/codes",
      "/api-keys",
      "/webhooks",
      "/system",
    ])
      assert.equal((await alice.call(`/admin${route}`)).status, 403, route);
    for (const route of [
      "/users/batch",
      "/users/passwords",
      "/bulk-send",
      "/domains",
      "/forwards",
      "/api-keys",
      "/webhooks",
    ])
      assert.equal(
        (await alice.call(`/admin${route}`, { method: "POST", body: {} }))
          .status,
        403,
        route,
      );
    assert.equal(
      (
        await alice.call("/admin/messages/1", {
          method: "PATCH",
          body: { read: true },
        })
      ).status,
      403,
    );
    assert.equal((await alice.call("/admin/attachments/1")).status, 403);
  });
  await t.test("sessions enforce CSRF and browser origin", async () => {
    assert.equal(
      (
        await alice.call("/send", {
          method: "POST",
          body: {},
          headers: { "X-CSRF-Token": "invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await alice.call("/send", {
          method: "POST",
          body: {},
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const unauth = client(base);
    assert.equal((await unauth.call("/mailbox")).status, 401);
  });
  await t.test(
    "new domains generate private DKIM keys and public copyable DNS plans",
    async () => {
      const created = await admin.call("/admin/domains", {
        method: "POST",
        body: { name: "dns-test.example" },
      });
      assert.equal(created.status, 201);
      assert.equal(typeof created.data.id, "number");
      const r = await admin.call(
        `/admin/domains/${created.data.id}/dns?ip=203.0.113.25`,
      );
      assert.equal(r.status, 200);
      assert.equal(r.data.records.length, 5);
      assert(
        r.data.records
          .find((x) => x.key === "dkim")
          .value.startsWith("v=DKIM1; k=rsa; p="),
      );
      assert(!JSON.stringify(r.data).includes("PRIVATE KEY"));
      assert.equal(
        (await alice.call(`/admin/domains/${created.data.id}/dns`)).status,
        403,
      );
      assert.equal(
        (
          await alice.call(`/admin/domains/${created.data.id}/dns/check`, {
            method: "POST",
            body: {},
          })
        ).status,
        403,
      );
      await admin.call(`/admin/domains/${created.data.id}`, {
        method: "DELETE",
      });
      assert(
        !service.store.db
          .prepare("SELECT * FROM domain_keys WHERE domain_id=?")
          .get(created.data.id),
      );
    },
  );
  await t.test(
    "local delivery, blind recipients, attachments and isolation",
    async () => {
      const r = await admin.call("/send", {
        method: "POST",
        body: {
          to: ["alice@example.com"],
          bcc: ["bob@example.com"],
          subject: "验证码 482193",
          text: "Your verification code is 482193.",
          attachments: [
            {
              filename: "hello.txt",
              content: Buffer.from("hello attachment").toString("base64"),
            },
          ],
        },
      });
      assert.equal(r.status, 201);
      messageId = (await alice.call("/messages")).data.items[0].id;
      const m = await alice.call(`/messages/${messageId}`);
      assert.equal(
        m.data.body_text.trim(),
        "Your verification code is 482193.",
      );
      assert.deepEqual(m.data.bcc, []);
      attachmentId = m.data.attachments[0].id;
      const a = await fetch(`${base}/api/client/attachments/${attachmentId}`, {
        headers: { Cookie: alice.cookie },
      });
      assert.equal(await a.text(), "hello attachment");
      assert.equal((await bob.call(`/messages/${messageId}`)).status, 404);
      assert.equal(
        (await bob.call(`/attachments/${attachmentId}`)).status,
        404,
      );
      const raw = await fetch(`${base}/api/client/messages/${messageId}/raw`, {
        headers: { Cookie: alice.cookie },
      });
      assert(!/^Bcc:/im.test(await raw.text()));
      const sent = (await admin.call(`/messages/${r.data.id}`)).data;
      assert.equal(sent.bcc[0].address, "bob@example.com");
      assert.equal(sent.delivery_status, "delivered");
    },
  );
  await t.test("recipient quota failure rolls back all copies", async () => {
    const before = service.store.db
      .prepare("SELECT count(*) n FROM messages")
      .get().n;
    service.store.db
      .prepare("UPDATE users SET quota_bytes=1 WHERE id=?")
      .run(carolId);
    const r = await alice.call("/send", {
      method: "POST",
      body: {
        to: ["bob@example.com", "carol@example.com"],
        text: "quota must roll back",
      },
    });
    assert.equal(r.status, 422);
    assert.equal(
      service.store.db.prepare("SELECT count(*) n FROM messages").get().n,
      before,
    );
    service.store.db
      .prepare("UPDATE users SET quota_bytes=? WHERE id=?")
      .run(1024 ** 3, carolId);
  });
  await t.test(
    "drafts can be replaced and sent without leaving a duplicate",
    async () => {
      let r = await alice.call("/drafts", {
        method: "POST",
        body: { subject: "Draft", text: "hello" },
      });
      assert.equal(r.status, 201);
      r = await alice.call("/drafts", {
        method: "POST",
        body: {
          id: r.data.id,
          to: ["bob@example.com"],
          subject: "Draft updated",
          text: "ready",
        },
      });
      assert.equal(r.status, 201);
      assert.equal((await alice.call("/messages?folder=drafts")).data.total, 1);
      assert.equal(
        (
          await alice.call("/send", {
            method: "POST",
            body: {
              draftId: r.data.id,
              to: ["bob@example.com"],
              subject: "Draft sent",
              text: "sent",
            },
          })
        ).status,
        201,
      );
      assert.equal((await alice.call("/messages?folder=drafts")).data.total, 0);
    },
  );
  await t.test("forwards preserve rules and reject cycles", async () => {
    const before = (await bob.call("/messages")).data.total;
    assert.equal(
      (
        await admin.call("/admin/forwards", {
          method: "POST",
          body: {
            email: "bob@example.com",
            target: "carol@example.com",
            keepCopy: false,
          },
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await admin.call("/admin/forwards", {
          method: "POST",
          body: { email: "carol@example.com", target: "bob@example.com" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await alice.call("/send", {
          method: "POST",
          body: { to: ["bob@example.com"], text: "forward me" },
        })
      ).status,
      201,
    );
    assert.equal((await bob.call("/messages")).data.total, before);
    assert.equal(
      service.store.db
        .prepare(
          "SELECT count(*) n FROM messages WHERE owner_id=? AND body_text LIKE '%forward me%'",
        )
        .get(carolId).n,
      1,
    );
  });
  await t.test(
    "inbound SMTP receives HTML safely and signs webhook events",
    async () => {
      const h = await admin.call("/admin/webhooks", {
        method: "POST",
        body: {
          name: "test hook",
          url: `http://127.0.0.1:${hook.address().port}/mail`,
        },
      });
      assert.equal(h.status, 201);
      hookSecret = h.data.secret;
      const transport = nodemailer.createTransport({
        host: "127.0.0.1",
        port: service.ports.smtp,
        secure: false,
        ignoreTLS: true,
      });
      await transport.sendMail({
        from: "sender@outside.example",
        to: "alice@example.com",
        subject: "Incoming",
        html: '<p>Hello <strong>world</strong></p><script>alert(1)</script><img src="https://example.com/track" onerror="alert(1)">',
      });
      const m = (await alice.call("/messages")).data.items[0];
      const detail = (await alice.call(`/messages/${m.id}`)).data;
      assert(detail.body_html.includes("<strong>world</strong>"));
      assert(!/script|onerror|<img/i.test(detail.body_html));
      await until(() => events.length > 0);
      const e = events[0];
      const expected = createHmac("sha256", hookSecret)
        .update(`${e.headers["x-postoffice-timestamp"]}.${e.raw}`)
        .digest("hex");
      assert.equal(e.headers["x-postoffice-signature"], `sha256=${expected}`);
      assert.equal(JSON.parse(e.raw).event, "mail.received");
      await assert.rejects(
        transport.sendMail({
          from: "sender@outside.example",
          to: "outside@another.example",
          text: "open relay?",
        }),
        (e) => e.responseCode === 550,
      );
      await assert.rejects(
        transport.sendMail({
          from: "alice@example.com",
          to: "bob@example.com",
          text: "spoof?",
        }),
        (e) => e.responseCode === 553,
      );
    },
  );
  await t.test(
    "authenticated SMTP validates identity and queues external delivery",
    async () => {
      const transport = nodemailer.createTransport({
        host: "127.0.0.1",
        port: service.ports.submission,
        secure: false,
        ignoreTLS: true,
        auth: { user: "alice@example.com", pass: password },
      });
      await transport.sendMail({
        from: "alice@example.com",
        to: "external@outside.example",
        subject: "External SMTP",
        text: "durable external message",
      });
      await until(() =>
        received.some(
          (m) => m.envelope.rcptTo[0].address === "external@outside.example",
        ),
      );
      const deliveredRaw = received
        .find(
          (m) => m.envelope.rcptTo[0].address === "external@outside.example",
        )
        .raw.toString();
      assert.match(deliveredRaw, /DKIM-Signature:/i);
      assert.match(
        deliveredRaw.replace(/\r?\n[ \t]+/g, " "),
        /\bd=example\.com;/,
      );
      assert.match(deliveredRaw.replace(/\r?\n[ \t]+/g, " "), /\bs=default;/);
      const sent = (await alice.call("/messages?folder=sent")).data.items.find(
        (m) => m.subject === "External SMTP",
      );
      await until(
        () =>
          service.store.db
            .prepare("SELECT delivery_status FROM messages WHERE id=?")
            .get(sent.id).delivery_status === "delivered",
      );
      await assert.rejects(
        transport.sendMail({
          from: "bob@example.com",
          to: "alice@example.com",
          text: "spoof",
        }),
        (e) => e.responseCode === 553,
      );
      await assert.rejects(
        transport.sendMail({
          envelope: { from: "alice@example.com", to: ["carol@example.com"] },
          from: "bob@example.com",
          to: "carol@example.com",
          text: "header spoof",
        }),
        (e) => e.responseCode === 553,
      );
    },
  );
  await t.test(
    "API keys enforce scopes, include codes, and revoke immediately",
    async () => {
      const key = await admin.call("/admin/api-keys", {
        method: "POST",
        body: { name: "read only", scopes: ["codes:read"] },
      });
      assert.equal(key.status, 201);
      const headers = { Authorization: `Bearer ${key.data.token}` };
      const c = client(base);
      const codes = await c.call("/v1/codes?email=alice@example.com", {
        headers,
      });
      assert.equal(codes.status, 200);
      assert(codes.data.items.some((x) => x.code === "482193"));
      assert.equal(
        (await c.call("/v1/send", { method: "POST", headers, body: {} }))
          .status,
        403,
      );
      assert(
        !service.store.db
          .prepare("SELECT * FROM api_keys")
          .get()
          .token_hash.includes(key.data.token),
      );
      await admin.call(`/admin/api-keys/${key.data.id}`, { method: "DELETE" });
      assert.equal((await c.call("/v1/codes", { headers })).status, 401);
    },
  );
  await t.test(
    "bulk sends are individual and batch password changes revoke sessions",
    async () => {
      const r = await admin.call("/admin/bulk-send", {
        method: "POST",
        body: {
          recipients: ["alice@example.com", "carol@example.com"],
          subject: "Broadcast",
          text: "individual copies",
        },
      });
      assert.equal(r.status, 200);
      assert(r.data.items.every((x) => x.ok));
      const m = (await alice.call("/messages")).data.items.find(
        (x) => x.subject === "Broadcast",
      );
      assert.equal(m.to.length, 1);
      const changed = await admin.call("/admin/users/passwords", {
        method: "POST",
        body: { emails: ["alice@example.com"] },
      });
      assert.equal(changed.status, 200);
      assert.equal((await alice.call("/mailbox")).status, 401);
      assert.equal(
        (
          await alice.call("/auth/webmail/login", {
            method: "POST",
            body: {
              email: "alice@example.com",
              password: changed.data.items[0].password,
            },
          })
        ).status,
        200,
      );
    },
  );
  await t.test(
    "external failures keep per-recipient state and can be retried",
    async () => {
      const permanent = await admin.call("/send", {
        method: "POST",
        body: {
          to: ["permanent@outside.example", "success@outside.example"],
          subject: "Partial delivery",
          text: "test recipient states",
        },
      });
      assert.equal(permanent.status, 201);
      const jobs = () =>
        service.store.db
          .prepare("SELECT * FROM delivery_jobs WHERE message_id=? ORDER BY id")
          .all(permanent.data.id);
      await until(
        () =>
          jobs().length === 2 &&
          jobs().every((j) => ["failed", "delivered"].includes(j.state)),
      );
      assert.equal(
        service.store.db
          .prepare("SELECT delivery_status FROM messages WHERE id=?")
          .get(permanent.data.id).delivery_status,
        "partial",
      );
      const failed = jobs().find((j) => j.state === "failed");
      assert.equal(failed.attempts, 1);
      assert.match(failed.last_error, /Mailbox rejected/);
      assert.equal(
        (
          await admin.call(`/admin/queue/${failed.id}/retry`, {
            method: "POST",
          })
        ).status,
        200,
      );
      await until(
        () =>
          service.store.db
            .prepare("SELECT state FROM delivery_jobs WHERE id=?")
            .get(failed.id).state === "failed",
      );
      const temporary = await admin.call("/send", {
        method: "POST",
        body: { to: ["temporary@outside.example"], text: "temporary failure" },
      });
      assert.equal(temporary.status, 201);
      const getTemp = () =>
        service.store.db
          .prepare("SELECT * FROM delivery_jobs WHERE message_id=?")
          .get(temporary.data.id);
      await until(async () => {
        // Drive the test queue explicitly instead of racing its 10s timer
        // while the preceding job's webhook is still finishing.
        await service.mail.work();
        return getTemp()?.state === "queued" && getTemp().attempts === 1;
      });
      service.store.db
        .prepare("UPDATE delivery_jobs SET next_attempt=0 WHERE message_id=?")
        .run(temporary.data.id);
      await until(async () => {
        await service.mail.work();
        return getTemp().state === "delivered";
      });
      assert.equal(getTemp().attempts, 2);
    },
  );
  await t.test("disabled users and domains cannot log in or send", async () => {
    await admin.call(`/admin/users/${bobId}`, {
      method: "PATCH",
      body: { active: false },
    });
    assert.equal((await bob.call("/mailbox")).status, 401);
    assert.equal(
      (
        await bob.call("/auth/webmail/login", {
          method: "POST",
          body: { email: "bob@example.com", password },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await admin.call(`/admin/users/1`, {
          method: "PATCH",
          body: { active: false },
        })
      ).status,
      400,
    );
    await admin.call("/admin/domains", {
      method: "POST",
      body: { name: "second.example" },
    });
    await admin.call("/admin/users", {
      method: "POST",
      body: { email: "user@second.example", name: "second", password },
    });
    const domain = (await admin.call("/admin/domains")).data.items.find(
      (x) => x.name === "second.example",
    );
    await admin.call(`/admin/domains/${domain.id}`, {
      method: "PATCH",
      body: { enabled: false },
    });
    assert.equal(
      (
        await bob.call("/auth/webmail/login", {
          method: "POST",
          body: { email: "user@second.example", password },
        })
      ).status,
      401,
    );
  });
  await t.test("trash, restore, delete and admin read permission", async () => {
    assert.equal(
      (await admin.call(`/admin/messages/${messageId}`)).status,
      200,
    );
    await alice.call(`/messages/${messageId}`, {
      method: "PATCH",
      body: { folder: "trash" },
    });
    assert.equal((await alice.call("/messages?folder=trash")).data.total, 1);
    await alice.call(`/messages/${messageId}/restore`, { method: "POST" });
    assert.equal((await alice.call("/messages?folder=trash")).data.total, 0);
    assert.equal(
      (await alice.call(`/messages/${messageId}`, { method: "DELETE" })).status,
      400,
    );
    await alice.call(`/messages/${messageId}`, {
      method: "PATCH",
      body: { folder: "trash" },
    });
    assert.equal(
      (await alice.call(`/messages/${messageId}`, { method: "DELETE" })).status,
      200,
    );
    assert.equal(
      (await alice.call(`/attachments/${attachmentId}`)).status,
      404,
    );
  });
});

test("local-only mode rejects external sends and insecure SMTP authentication is disabled", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-no-relay-"));
  const s = await start({
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    dataDir: dir,
    relay: null,
    outboundMode: "local",
    allowInsecureAuth: false,
  });
  t.after(async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  const c = client(`http://127.0.0.1:${s.ports.http}`);
  await c.call("/setup", {
    method: "POST",
    body: {
      domain: "example.com",
      email: "admin@example.com",
      password,
    },
  });
  assert.equal(
    (
      await c.call("/send", {
        method: "POST",
        body: { to: "external@outside.example", text: "hello" },
      })
    ).status,
    422,
  );
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: s.ports.submission,
    secure: false,
    ignoreTLS: true,
    auth: { user: "admin@example.com", pass: password },
  });
  await assert.rejects(
    transport.sendMail({
      from: "admin@example.com",
      to: "admin@example.com",
      text: "clear auth",
    }),
    (e) => e.responseCode === 538,
  );
});
