import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  generateKeyPairSync,
  sign,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import nodemailer from "nodemailer";
import { createLicense } from "../src/license.js";
import { start } from "../src/server.js";

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "postoffice-license-"),
  );
  const pair = generateKeyPairSync("ed25519");
  const cleanups = [];
  const state = {
    reply: "ok",
    verify: 0,
    heartbeat: 0,
    requests: [],
    verifiedAt: 0,
    nextVerifyAt: 0,
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/checkv2") {
      await state.onSign();
      if (state.signingFailure) res.writeHead(500).end();
      else
        res.end(
          JSON.stringify({
            "dkim-signature": `v=1; a=rsa-sha256; d=licensed.example; s=${state.selector}; h=from; bh=YWJj; b=YWJj`,
          }),
        );
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks));
    state.requests.push({ path: req.url, body });
    if (req.url === "/api/v1/verify") state.verify++;
    else state.heartbeat++;
    if (state.reply === "unavailable") {
      res.writeHead(503).end();
      return;
    }
    if (state.reply === "malformed") {
      res.end("not-json");
      return;
    }
    if (state.reply === "http_reject") {
      res.writeHead(403).end();
      return;
    }
    if (state.reply === "deny") {
      res.end(JSON.stringify({ valid: false, code: "LICENSE_DISABLED" }));
      return;
    }
    if (state.reply === "ip_changed" && req.url === "/api/v1/heartbeat") {
      state.reply = "ok";
      res.end(JSON.stringify({ valid: false, code: "IP_CHANGED" }));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (req.url === "/api/v1/verify") {
      state.verifiedAt = now;
      state.nextVerifyAt = now + 14 * 86400;
    }
    res.end(
      JSON.stringify({
        valid: true,
        code: "OK",
        product_id:
          state.reply === "wrong_product" ? "app_other" : body.product_id,
        expires_at: now + 86400,
        server_time: now,
        verified_at: state.verifiedAt,
        next_verify_at:
          state.nextVerifyAt + (state.reply === "extended_heartbeat" ? 1 : 0),
        observed_ip: "203.0.113.10",
        ...(req.url === "/api/v1/verify"
          ? { verification_token: randomBytes(32).toString("base64url") }
          : {}),
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    dataDir: directory,
    license: {
      required: true,
      product: "app_mail_test",
      server: `http://127.0.0.1:${server.address().port}`,
      publicKey: pair.publicKey,
    },
  };
  t.after(async () => {
    const failures = [];
    try {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
    if (failures.length)
      throw new AggregateError(failures, "Fixture cleanup failed");
  });
  const grant = (device, changes = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "keydock-offline-license",
        product_id: "app_mail_test",
        license_id: "test-license",
        device_hash: createHash("sha256").update(device).digest("hex"),
        issued_at: now,
        not_before: now,
        expires_at: now + 14 * 86400,
        jti: "test-offline-grant",
        grant_type: "self_service",
        ...changes,
      }),
    );
    return JSON.stringify({
      payload: payload.toString("base64url"),
      signature: sign(null, payload, pair.privateKey).toString("base64url"),
    });
  };
  return {
    config,
    state,
    grant,
    cleanup: (operation) => cleanups.push(operation),
  };
}

test("KeyDock activation, heartbeats, IP revalidation, offline signatures and persisted denial", async (t) => {
  const f = await fixture(t);
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  let license = createLicense(f.config);
  f.cleanup(() => license.close());
  await license.init();
  assert.equal(license.status().valid, false);
  assert.throws(() => license.assertAllowed(), {
    code: "LICENSE_REQUIRED",
    responseCode: 451,
  });
  const device = license.adminStatus().deviceId;
  assert.match(device, /^[a-f0-9]{64}$/);
  f.state.reply = "wrong_product";
  await assert.rejects(license.activate("KD-DEMO"));
  f.state.reply = "ok";
  await license.activate("KD-DEMO");
  assert.equal(license.status().mode, "online");
  assert.equal(license.adminStatus().key, undefined);
  assert.equal(license.status().deviceId, undefined);
  const checks = f.state.verify;
  clock += 60001;
  await license.ensureValid();
  assert.equal(f.state.heartbeat, 1);
  assert.equal(f.state.verify, checks);
  assert.equal(f.state.requests.at(-1).body.license_key, undefined);
  f.state.reply = "ip_changed";
  clock += 60001;
  await license.ensureValid();
  assert.equal(f.state.verify, checks + 1);
  clock += 14 * 86400 * 1000 + 1;
  await license.ensureValid();
  assert.equal(f.state.verify, checks + 2);
  const offline = f.grant(device);
  await assert.rejects(
    license.importOffline(f.grant(device, { product_id: "app_wrong" })),
    /不匹配/,
  );
  await assert.rejects(
    license.importOffline(f.grant("different-device")),
    /不匹配/,
  );
  await assert.rejects(
    license.importOffline(
      f.grant(device, { expires_at: Math.floor(Date.now() / 1000) - 1 }),
    ),
    /到期/,
  );
  await assert.rejects(
    license.importOffline(
      f.grant(device, {
        expires_at: Math.floor(Date.now() / 1000) + 15 * 86400,
      }),
    ),
    /期限/,
  );
  const tampered = JSON.parse(offline);
  tampered.payload = Buffer.from("{}").toString("base64url");
  await assert.rejects(license.importOffline(JSON.stringify(tampered)), /签名/);
  await license.importOffline(offline);
  f.state.reply = "unavailable";
  await license.ensureValid(true);
  assert.equal(license.status().mode, "offline");
  f.state.reply = "malformed";
  await license.ensureValid(true);
  assert.equal(license.status().valid, false);
  f.state.reply = "deny";
  await license.ensureValid(true);
  assert.equal(license.status().valid, false);
  await assert.rejects(license.importOffline(offline), /拒绝/);
  await license.close();
  f.state.reply = "unavailable";
  license = createLicense(f.config);
  await license.init();
  assert.equal(license.adminStatus().deviceId, device);
  assert.equal(license.status().valid, false);
  f.state.reply = "ok";
  await license.activate("KD-RESTORED");
  assert.equal(license.status().valid, true);
  assert.equal(
    await readFile(path.join(f.config.dataDir, "license/license.key"), "utf8"),
    "KD-RESTORED",
  );
});

test("TLS errors, HTTP refusals and malformed heartbeats cannot activate the offline fallback", async (t) => {
  const f = await fixture(t);
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  let license = createLicense(f.config);
  f.cleanup(() => license.close());
  await license.init();
  await license.activate("KD-DEMO");
  await license.importOffline(f.grant(license.adminStatus().deviceId));
  for (const reply of ["malformed", "http_reject", "extended_heartbeat"]) {
    f.state.reply = reply;
    clock += 60001;
    await license.ensureValid();
    assert.equal(license.status().valid, false, reply);
    assert.equal(license.status().mode, "blocked", reply);
  }
  f.state.reply = "unavailable";
  await license.ensureValid(true);
  assert.equal(license.status().mode, "offline");
  await license.close();
  license = createLicense({
    ...f.config,
    license: {
      ...f.config.license,
      server: f.config.license.server.replace("http:", "https:"),
    },
  });
  await license.init();
  assert.equal(license.status().valid, false);
  assert.match(license.status().reason, /安全检查/);
});

test("offline time cannot be extended by reimport or wall clock rollback", async (t) => {
  const f = await fixture(t);
  let clock = 0;
  const wall = Date.now();
  t.mock.method(performance, "now", () => clock);
  t.mock.method(Date, "now", () => wall);
  let license = createLicense(f.config);
  f.cleanup(() => license.close());
  await license.init();
  const device = license.adminStatus().deviceId;
  const grant = f.grant(device, {
    issued_at: Math.floor(wall / 1000) - 86400,
    not_before: Math.floor(wall / 1000) - 86400,
    expires_at: Math.floor(wall / 1000) + 600,
  });
  await license.importOffline(grant);
  assert.equal(license.status().mode, "offline");
  clock += 600 * 1000 + 1;
  assert.equal(license.status().valid, false);
  await license.importOffline(grant);
  assert.equal(license.status().valid, false);
  await license.close();
  t.mock.method(Date, "now", () => wall - 3600000);
  license = createLicense(f.config);
  await license.init();
  assert.equal(license.status().valid, false);
  await assert.rejects(license.importOffline(grant), /时钟回退/);
});

test("an explicit refusal of the active key persists when reactivation is attempted", async (t) => {
  const f = await fixture(t);
  let license = createLicense(f.config);
  f.cleanup(() => license.close());
  await license.init();
  await license.activate("KD-DEMO");
  const grant = f.grant(license.adminStatus().deviceId);
  await license.importOffline(grant);
  f.state.reply = "deny";
  await assert.rejects(license.activate("KD-DEMO"));
  assert.equal(license.status().valid, false);
  await license.close();
  f.state.reply = "unavailable";
  license = createLicense(f.config);
  await license.init();
  assert.equal(license.status().valid, false);
  await assert.rejects(license.importOffline(grant), /拒绝/);
});

function client(base) {
  return {
    cookie: "",
    csrf: "",
    clientPortal: false,
    async call(route, body) {
      if (route === "/auth/webmail/login") this.clientPortal = true;
      if (this.clientPortal && !route.startsWith("/client/"))
        route = "/client" + route;
      const response = await fetch(base + "/api" + route, {
        method: body ? "POST" : "GET",
        headers: {
          Cookie: this.cookie,
          "X-CSRF-Token": this.csrf,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.headers.has("set-cookie"))
        this.cookie = response.headers.get("set-cookie").split(";")[0];
      const data = await response.json();
      if (data.csrfToken) this.csrf = data.csrfToken;
      return { status: response.status, data };
    },
  };
}
test("license expiry during asynchronous Rspamd signing preserves queue attempts and prevents external delivery", async (t) => {
  const f = await fixture(t);
  let deliveries = 0;
  const service = await start({
    ...f.config,
    host: "127.0.0.1",
    smtpHost: "127.0.0.1",
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    mailHostname: "mail.licensed.example",
    production: false,
    secureCookies: false,
    outboundMode: "relay",
    relay: { host: "unused-relay.example" },
    outboundDependencies: {
      createTransport: () => ({
        close() {},
        async sendMail() {
          deliveries++;
        },
      }),
    },
    dkimBackend: "node",
    tls: {},
    deliveryMaxAttempts: 1,
  });
  f.cleanup(() => service.close());
  const admin = client(`http://127.0.0.1:${service.ports.http}`);
  const password = "License-test-password-2026";
  await admin.call("/setup", { username: "owner", password });
  await service.license.activate("KD-DEMO");
  assert.equal(
    (await admin.call("/admin/manage/domains", { name: "licensed.example" }))
      .status,
    201,
  );
  assert.equal(
    (
      await admin.call("/admin/users", {
        email: "reader@licensed.example",
        password,
      })
    ).status,
    201,
  );
  const user = service.store.db
    .prepare("SELECT id FROM users WHERE email=?")
    .get("reader@licensed.example");
  f.state.selector = service.store.db
    .prepare("SELECT selector FROM domain_keys LIMIT 1")
    .get().selector;
  service.config.dkimBackend = "rspamd";
  service.config.rspamdUrl = f.config.license.server + "/checkv2";
  f.state.onSign = async () => {
    f.state.reply = "deny";
    await service.license.ensureValid(true);
  };
  for (const signingFailure of [false, true]) {
    f.state.reply = "ok";
    await service.license.activate("KD-DEMO");
    f.state.signingFailure = signingFailure;
    service.store.db.prepare("DELETE FROM delivery_jobs").run();
    service.store.db
      .prepare(
        "INSERT INTO delivery_jobs(owner_id,sender,recipient,raw) VALUES(?,?,?,?)",
      )
      .run(
        user.id,
        "reader@licensed.example",
        "external@receiver.example",
        Buffer.from("From: reader@licensed.example\r\n\r\nqueued"),
      );
    await service.mail.work();
    assert.equal(service.license.status().valid, false);
    const job = service.store.db
      .prepare("SELECT state,attempts FROM delivery_jobs")
      .get();
    assert.equal(job.state, "queued");
    assert.equal(job.attempts, 0);
    assert.equal(deliveries, 0);
    assert.equal(
      service.store.db.prepare("SELECT count(*) AS total FROM messages").get()
        .total,
      0,
    );
  }
});

test("license gates backend, API and authenticated SMTP; preserves inbound mail, recovery login and queue attempts", async (t) => {
  const f = await fixture(t);
  const service = await start({
    ...f.config,
    host: "127.0.0.1",
    smtpHost: "127.0.0.1",
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    production: false,
    secureCookies: false,
    outboundMode: "local",
    dkimBackend: "node",
    tls: {},
    allowInsecureAuth: true,
  });
  f.cleanup(() => service.close());
  const base = `http://127.0.0.1:${service.ports.http}`;
  const admin = client(base),
    user = client(base),
    stranger = client(base);
  const password = "License-test-password-2026";
  assert.equal(
    (await admin.call("/setup", { username: "owner", password })).status,
    201,
  );
  assert.equal((await admin.call("/admin/users")).status, 402);
  assert.equal((await admin.call("/auth/me")).status, 200);
  assert.equal((await stranger.call("/admin/license")).status, 401);
  const csrf = await fetch(base + "/api/admin/license/activate", {
    method: "POST",
    headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "KD-DEMO" }),
  });
  assert.equal(csrf.status, 403);
  assert.equal(
    (await admin.call("/admin/license/activate", { key: "KD-DEMO" })).status,
    200,
  );
  assert.equal(
    (await admin.call("/admin/manage/domains", { name: "licensed.example" }))
      .status,
    201,
  );
  const account = (
    await admin.call("/admin/users", {
      email: "reader@licensed.example",
      name: "Reader",
      password,
    })
  ).data;
  assert.equal(
    (
      await user.call("/auth/webmail/login", {
        email: "reader@licensed.example",
        password,
      })
    ).status,
    200,
  );
  assert.equal((await user.call("/admin/license")).status, 403);
  const userId = service.store.db
    .prepare("SELECT id FROM users WHERE email=?")
    .get("reader@licensed.example").id;
  service.store.db
    .prepare(
      "INSERT INTO delivery_jobs(owner_id,sender,recipient,raw) VALUES(?,?,?,?)",
    )
    .run(
      userId,
      "reader@licensed.example",
      "external@receiver.example",
      Buffer.from("From: reader@licensed.example\r\n\r\nqueued"),
    );
  f.state.reply = "deny";
  await service.license.ensureValid(true);
  assert.equal((await admin.call("/admin/users")).status, 402);
  const send = await user.call("/send", {
    to: "reader@licensed.example",
    text: "blocked",
  });
  assert.equal(send.status, 402);
  assert.equal(send.data.code, "LICENSE_REQUIRED");
  await service.mail.work();
  assert.equal(
    service.store.db.prepare("SELECT attempts FROM delivery_jobs").get()
      .attempts,
    0,
  );
  const inbound = nodemailer.createTransport({
    host: "127.0.0.1",
    port: service.ports.smtp,
    secure: false,
    ignoreTLS: true,
  });
  f.cleanup(() => inbound.close());
  await inbound.sendMail({
    from: "friend@outside.example",
    to: "reader@licensed.example",
    subject: "授权失效仍保存来信",
    text: "keep inbound",
  });
  inbound.close();
  assert.equal(
    (await user.call("/messages?folder=inbox")).data.items[0].subject,
    "授权失效仍保存来信",
  );
  const submission = nodemailer.createTransport({
    host: "127.0.0.1",
    port: service.ports.submission,
    secure: false,
    ignoreTLS: true,
    auth: { user: "reader@licensed.example", pass: password },
  });
  f.cleanup(() => submission.close());
  await assert.rejects(
    submission.sendMail({
      from: "reader@licensed.example",
      to: "reader@licensed.example",
      text: "blocked",
    }),
    (error) => error.responseCode === 451,
  );
  submission.close();
  await admin.call("/auth/logout", {});
  assert.equal(
    (await admin.call("/auth/login", { email: "owner", password })).status,
    200,
  );
  assert.equal((await admin.call("/admin/license")).data.valid, false);
  f.state.reply = "ok";
  assert.equal(
    (await admin.call("/admin/license/activate", { key: "KD-RESTORED" }))
      .status,
    200,
  );
  assert.equal((await admin.call("/admin/users")).status, 200);
});
