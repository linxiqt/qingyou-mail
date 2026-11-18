import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import nodemailer from "nodemailer";
import { start } from "../src/server.js";
import { createOutbound } from "../src/outbound.js";

const password = "Onboarding-password-2026";
function client(base) {
  return {
    cookie: "",
    csrf: "",
    clientPortal: false,
    async call(url, body, method = body ? "POST" : "GET") {
      if (url === "/auth/webmail/login") this.clientPortal = true;
      if (this.clientPortal && !url.startsWith("/client/"))
        url = "/client" + url;
      const response = await fetch(`${base}/api${url}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Cookie: this.cookie,
          "X-CSRF-Token": this.csrf,
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
function greeting(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("SMTP greeting timed out")),
    );
    socket.once("error", reject);
    socket.once("data", (data) => {
      socket.end("QUIT\r\n");
      resolve(data.toString());
    });
  });
}

test("token-free first setup enforces origin and allows only one concurrent administrator", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "postoffice-first-admin-"),
  );
  const service = await start({
    dataDir,
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    production: false,
    secureCookies: false,
    mailHostname: "localhost",
    dkimBackend: "node",
    outboundMode: "local",
  });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.ports.http}`;
  const a = client(base),
    b = client(base);
  assert.deepEqual((await a.call("/setup/status")).data, {
    needsSetup: true,
    requiresToken: false,
  });
  const crossOrigin = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.invalid",
    },
    body: JSON.stringify({ username: "intruder", password }),
  });
  assert.equal(crossOrigin.status, 403);
  const results = await Promise.all([
    a.call("/setup", { username: "firstadmin", password }),
    b.call("/setup", { username: "secondadmin", password }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    service.store.db
      .prepare("SELECT count(*) AS n FROM users WHERE role='admin'")
      .get().n,
    1,
  );
  assert.equal((await a.call("/setup/status")).data.needsSetup, false);
  assert.equal(
    (await a.call("/setup", { username: "thirdadmin", password })).status,
    409,
  );
});

test("install without a mail domain, log in, configure mail and retain settings after restart", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "postoffice-onboarding-"),
  );
  const options = {
    dataDir,
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    mailHostname: "localhost",
    production: false,
    secureCookies: false,
    outboundMode: "local",
    dkimBackend: "node",
    allowInsecureAuth: true,
  };
  let service = await start(options);
  t.after(async () => {
    await service?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let db = service.store.db;
  let admin = client(`http://127.0.0.1:${service.ports.http}`);
  assert.equal(
    (await admin.call("/setup", { username: "admin", password: "short" }))
      .status,
    400,
  );
  assert.equal(
    (
      await admin.call("/setup", {
        username: "not an account",
        password,
      })
    ).status,
    400,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM users").get().n, 0);
  const setup = await admin.call("/setup", {
    username: "Admin",
    name: "管理员",
    password,
  });
  assert.equal(setup.status, 201);
  assert.equal(setup.data.domainId, null);
  assert.equal(setup.data.user.email, "admin");
  assert.equal(setup.data.user.management_only, true);
  const adminId = setup.data.user.id;
  const namespaceId = db
    .prepare("SELECT domain_id FROM users WHERE id=?")
    .get(adminId).domain_id;
  assert.equal(db.prepare("SELECT count(*) AS n FROM domain_keys").get().n, 0);
  assert.equal(service.mail.localUser("admin"), undefined);
  assert.equal(service.mail.recipientUser("admin"), undefined);
  await admin.call("/auth/logout", {});
  assert.equal(
    (await admin.call("/auth/login", { email: "admin", password })).status,
    200,
  );
  for (const url of [
    "/admin/domains",
    "/admin/manage/domains",
    "/admin/users",
    "/admin/manage/accounts",
  ])
    assert.deepEqual((await admin.call(url)).data.items, [], url);
  const overview = (await admin.call("/admin/overview")).data;
  assert.equal(overview.users, 0);
  assert.equal(overview.domains, 0);
  assert.equal(
    (
      await admin.call(
        `/admin/manage/domains/${namespaceId}`,
        { enabled: false },
        "PATCH",
      )
    ).status,
    404,
  );
  assert.equal(
    (await admin.call(`/admin/manage/domains/${namespaceId}`, {}, "DELETE"))
      .status,
    404,
  );
  assert.equal(
    (
      await admin.call(
        `/admin/managers/${adminId}`,
        { name: "管理中心", scope: "global" },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (await admin.call("/send", { to: "user@outside.example", text: "test" }))
      .status,
    400,
  );
  assert.deepEqual((await admin.call("/admin/mail-settings")).data, {
    hostname: "",
    configured: false,
  });
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: service.ports.submission,
    secure: false,
    ignoreTLS: true,
    auth: { user: "admin", pass: password },
  });
  await assert.rejects(
    transport.verify(),
    (error) => error.responseCode === 535,
  );
  transport.close();
  assert.equal(
    (
      await admin.call("/setup", {
        username: "other",
        password,
      })
    ).status,
    409,
  );

  const domain = await admin.call("/admin/manage/domains", {
    name: "onboarding.example",
  });
  assert.equal(domain.status, 201);
  assert.equal(service.config.mailHostname, "mail.onboarding.example");
  const plan = (await admin.call(`/admin/manage/domains/${domain.data.id}/dns`))
    .data;
  assert.equal(
    plan.records.find((r) => r.type === "MX").value.replace(/\.$/, ""),
    "mail.onboarding.example",
  );
  assert.match(
    await greeting(service.ports.smtp),
    /^220 mail\.onboarding\.example /,
  );
  assert.equal(
    (
      await admin.call("/admin/users", {
        email: "alice@onboarding.example",
        password,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await admin.call("/admin/manage/send", {
        from: "alice@onboarding.example",
        to: "alice@onboarding.example",
        subject: "登录后配置收发",
        text: "本地投递验证",
      })
    ).status,
    201,
  );
  const inbound = nodemailer.createTransport({
    host: "127.0.0.1",
    port: service.ports.smtp,
    secure: false,
    ignoreTLS: true,
  });
  await inbound.sendMail({
    from: "sender@outside.example",
    to: "alice@onboarding.example",
    subject: "SMTP 入站验证",
    text: "incoming",
  });
  inbound.close();
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM messages WHERE folder='inbox'").get()
      .n,
    2,
  );

  const anonymous = client(`http://127.0.0.1:${service.ports.http}`);
  assert.equal(
    (
      await anonymous.call(
        "/admin/mail-settings",
        { hostname: "smtp.onboarding.example" },
        "PUT",
      )
    ).status,
    401,
  );
  const user = client(`http://127.0.0.1:${service.ports.http}`);
  await user.call("/auth/webmail/login", {
    email: "alice@onboarding.example",
    password,
  });
  assert.equal(
    (
      await user.call(
        "/admin/mail-settings",
        { hostname: "smtp.onboarding.example" },
        "PUT",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await admin.call(
        "/admin/mail-settings",
        { hostname: "https://invalid.example" },
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await admin.call(
        "/admin/mail-settings",
        { hostname: "smtp.onboarding.example" },
        "PUT",
      )
    ).status,
    200,
  );
  assert.match(
    await greeting(service.ports.submission),
    /^220 smtp\.onboarding\.example /,
  );
  await service.close();
  service = null;
  service = await start(options);
  db = service.store.db;
  assert.equal(service.config.mailHostname, "smtp.onboarding.example");
  assert.equal(db.prepare("SELECT count(*) AS n FROM domain_keys").get().n, 1);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM messages WHERE folder='inbox'").get()
      .n,
    2,
  );
  admin = client(`http://127.0.0.1:${service.ports.http}`);
  assert.equal(
    (await admin.call("/auth/login", { email: "admin", password })).status,
    200,
  );
  assert.equal(
    (await admin.call("/admin/manage/domains")).data.items.length,
    1,
  );
  assert.equal(
    (await admin.call("/admin/manage/accounts")).data.items.length,
    1,
  );
  assert.match(
    await greeting(service.ports.smtp),
    /^220 smtp\.onboarding\.example /,
  );
});

test("Rspamd can initialize and restart with only a management login, without generating any domain key", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "postoffice-domainless-rspamd-"),
  );
  const options = {
    dataDir,
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    production: false,
    secureCookies: false,
    mailHostname: "localhost",
    dkimBackend: "rspamd",
    outboundMode: "local",
    rspamadmPath: path.join(dataDir, "must-not-be-executed"),
  };
  let service = await start(options);
  t.after(async () => {
    await service?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const admin = client(`http://127.0.0.1:${service.ports.http}`);
  assert.equal(
    (
      await admin.call("/setup", {
        username: "admin",
        password,
      })
    ).status,
    201,
  );
  await service.close();
  service = null;
  service = await start(options);
  assert.equal(
    service.store.db.prepare("SELECT count(*) AS n FROM domain_keys").get().n,
    0,
  );
  const login = client(`http://127.0.0.1:${service.ports.http}`);
  assert.equal(
    (await login.call("/auth/login", { email: "admin", password })).status,
    200,
  );
});

test("SMTP relay uses the hostname saved after login for subsequent deliveries", async () => {
  const names = [];
  const config = {
    outboundMode: "relay",
    mailHostname: "localhost",
    relay: { host: "relay.example" },
  };
  const outbound = createOutbound(config, {
    createTransport(options) {
      return { sendMail: async () => names.push(options.name), close() {} };
    },
  });
  await outbound.sendMail({});
  config.mailHostname = "mail.configured.example";
  await outbound.sendMail({});
  outbound.close();
  assert.deepEqual(names, ["localhost", "mail.configured.example"]);
});
