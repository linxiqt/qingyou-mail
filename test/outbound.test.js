import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import { createOutbound, mxTargets, outboundMode } from "../src/outbound.js";
import { start } from "../src/server.js";

const missing = () =>
  Promise.reject(Object.assign(new Error("No DNS data"), { code: "ENODATA" }));
const config = { mailHostname: "mail.sender.example", outboundMode: "direct" };
const resolver = (
  records = [{ priority: 10, exchange: "mx.recipient.example" }],
) => ({
  resolveMx: async () => records,
  resolve4: async () => ["8.8.8.8"],
  resolve6: missing,
});

test("direct delivery resolves MX priorities, falls back only without MX and honors Null MX", async () => {
  const r = resolver([
    { priority: 50, exchange: "backup.example." },
    { priority: 10, exchange: "primary.example." },
  ]);
  assert.deepEqual(
    (await mxTargets("recipient.example", r)).map((x) => x.exchange),
    ["primary.example", "backup.example"],
  );
  r.resolveMx = missing;
  assert.equal(
    (await mxTargets("recipient.example", r))[0].exchange,
    "recipient.example",
  );
  r.resolveMx = async () => [{ priority: 0, exchange: "." }];
  await assert.rejects(
    mxTargets("recipient.example", r),
    (e) => e.responseCode === 550 && /Null MX/.test(e.message),
  );
  r.resolveMx = async () => {
    throw Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" });
  };
  await assert.rejects(
    mxTargets("recipient.example", r),
    (e) => e.responseCode === 550,
  );
  r.resolveMx = async () => {
    throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
  };
  await assert.rejects(mxTargets("recipient.example", r), {
    code: "ESERVFAIL",
  });
});

test("direct delivery pins public addresses, retries another MX on transient failure and stops on rejection", async () => {
  const attempts = [];
  let permanent = false;
  const outbound = createOutbound(config, {
    resolver: resolver([
      { priority: 5, exchange: "first.example" },
      { priority: 10, exchange: "second.example" },
    ]),
    createTransport(options) {
      assert.equal(options.host, "8.8.8.8");
      assert.equal(options.port, 25);
      assert.equal(options.name, config.mailHostname);
      assert.equal(options.tls.rejectUnauthorized, true);
      assert.equal(typeof options.getSocket, "function");
      return {
        close() {},
        async sendMail() {
          attempts.push(options.tls.servername);
          if (options.tls.servername === "first.example")
            throw Object.assign(new Error("Try later"), {
              responseCode: permanent ? 550 : 451,
            });
          return { accepted: ["user@recipient.example"] };
        },
      };
    },
  });
  const message = {
    envelope: { from: "user@sender.example", to: ["user@recipient.example"] },
    raw: Buffer.from("message"),
  };
  await outbound.sendMail(message);
  assert.deepEqual(attempts, ["first.example", "second.example"]);
  permanent = true;
  attempts.length = 0;
  await assert.rejects(
    outbound.sendMail(message),
    (e) => e.responseCode === 550,
  );
  assert.deepEqual(attempts, ["first.example"]);
});

test("Internet MX records cannot connect to loopback, metadata or private networks", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ]) {
    const r = resolver();
    r.resolve4 = async () => [ip];
    const outbound = createOutbound(config, {
      resolver: r,
      createTransport() {
        assert.fail("A private MX target must never be connected");
      },
    });
    await assert.rejects(
      outbound.sendMail({ envelope: { to: ["user@recipient.example"] } }),
      (e) => e.responseCode === 550,
    );
  }
  assert.equal(outboundMode({}), "direct");
  assert.equal(outboundMode({ relay: { host: "relay.example" } }), "relay");
  assert.equal(outboundMode({ outboundMode: "direct", relay: {} }), "direct");
});

test("webmail and authenticated SMTP deliver directly through a real SMTP MX, accept replies and report failures", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-direct-"));
  const received = [];
  const remote = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    disableReverseLookup: true,
    onRcptTo(address, _session, callback) {
      callback(
        address.address.startsWith("reject@")
          ? Object.assign(new Error("Mailbox unavailable"), {
              responseCode: 550,
            })
          : null,
      );
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        received.push({
          raw: Buffer.concat(chunks).toString(),
          envelope: session.envelope,
        });
        callback();
      });
    },
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const r = resolver();
  r.resolve4 = async () => ["127.0.0.1"];
  const service = await start({
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    dataDir: dir,
    outboundMode: "direct",
    relay: null,
    allowInsecureAuth: true,
    outboundDependencies: {
      resolver: r,
      port: remote.server.address().port,
      allowPrivateAddresses: true,
    },
  });
  t.after(async () => {
    await service.close();
    await new Promise((resolve) => remote.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.ports.http}`;
  const response = await fetch(base + "/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      domain: "sender.example",
      email: "admin@sender.example",
      password: "Direct-test-password-2026",
    }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const setup = await response.json();
  const send = await fetch(base + "/api/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": setup.csrfToken,
    },
    body: JSON.stringify({
      to: "receiver@recipient.example",
      bcc: "hidden@recipient.example",
      subject: "Direct mail",
      text: "Hello external mailbox",
      attachments: [{ filename: "hello.txt", content: "aGVsbG8=" }],
    }),
  });
  assert.equal(send.status, 201);
  async function until(fn) {
    for (let i = 0; i < 150; i++) {
      if (fn()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out");
  }
  await until(() => received.length === 2);
  await service.mail.work();
  for (const mail of received) {
    assert.match(mail.raw, /DKIM-Signature:/);
    assert.match(mail.raw.replace(/\r?\n[ \t]+/g, " "), /d=sender\.example;/);
    assert(!/Bcc:/i.test(mail.raw));
    assert.match(mail.raw, /hello\.txt/);
    assert.equal(mail.envelope.rcptTo.length, 1);
  }
  const submission = nodemailer.createTransport({
    host: "127.0.0.1",
    port: service.ports.submission,
    ignoreTLS: true,
    auth: { user: "admin@sender.example", pass: "Direct-test-password-2026" },
  });
  await submission.sendMail({
    from: "admin@sender.example",
    to: "smtp@recipient.example",
    subject: "SMTP direct",
    text: "Submitted externally",
  });
  await until(() => received.length === 3);
  const incoming = nodemailer.createTransport({
    host: "127.0.0.1",
    port: service.ports.smtp,
    ignoreTLS: true,
  });
  await incoming.sendMail({
    from: "receiver@recipient.example",
    to: "admin@sender.example",
    subject: "Re: Direct mail",
    text: "Reply delivered",
    attachments: [{ filename: "reply.txt", content: "reply attachment" }],
  });
  const inbox = await (
    await fetch(base + "/api/messages", { headers: { Cookie: cookie } })
  ).json();
  assert(inbox.items.some((m) => m.subject === "Re: Direct mail"));
  await assert.rejects(
    incoming.sendMail({
      from: "stranger@recipient.example",
      to: "other@outside.example",
      text: "Not an open relay",
    }),
    (e) => e.responseCode === 550,
  );
  await assert.rejects(
    incoming.sendMail({
      from: "receiver@recipient.example",
      to: "missing@sender.example",
      text: "No mailbox",
    }),
    (e) => e.responseCode === 550,
  );
  const user = service.mail.localUser("admin@sender.example");
  const failed = await service.mail.send(user, {
    to: "reject@recipient.example",
    subject: "Failure report",
    text: "Reject me",
  });
  await until(
    () =>
      service.store.db
        .prepare("SELECT delivery_status FROM messages WHERE id=?")
        .get(failed.id)?.delivery_status === "failed",
  );
  assert(
    service.store.db
      .prepare(
        "SELECT id FROM messages WHERE folder='inbox' AND subject LIKE '邮件投递失败：Failure report%'",
      )
      .get(),
  );
});
