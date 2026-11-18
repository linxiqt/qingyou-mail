import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createPublicKey, verify } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { openStore } from "../src/db.js";
import { createMailService } from "../src/mail.js";
import { rspamdKeyPath } from "../src/domain-keys.js";
import { start } from "../src/server.js";

const noData = () =>
  Promise.reject(Object.assign(new Error("No DNS data"), { code: "ENODATA" }));
const publicResolver = {
  resolveMx: async () => [{ priority: 10, exchange: "mx.recipient.example" }],
  resolve4: async () => ["8.8.8.8"],
  resolve6: noData,
};
const signature =
  "v=1; a=rsa-sha256; c=relaxed/relaxed; d=sender.example; s=rsptest; h=from:to:subject; bh=YWJjZA==; b=YWJjZA==";

async function eventually(
  predicate,
  message = "Timed out waiting for delivery",
) {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function fixture(
  t,
  respond = (_request, response) =>
    response.end(JSON.stringify({ "dkim-signature": signature })),
) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const captured = {
        headers: request.headers,
        raw: Buffer.concat(chunks),
        url: request.url,
        method: request.method,
      };
      requests.push(captured);
      response.setHeader("Content-Type", "application/json");
      respond(captured, response);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-rspamd-"));
  const store = openStore({ dataDir: dir });
  const { db } = store;
  db.prepare("INSERT INTO domains(name) VALUES(?)").run("sender.example");
  db.prepare(
    "INSERT INTO users(domain_id,email,name,password_hash,role,quota_bytes) VALUES(1,?,?,?,'admin',?)",
  ).run("admin@sender.example", "Test sender", "unused-test-hash", 1024 ** 3);
  db.prepare(
    "INSERT INTO domain_keys(domain_id,selector,private_key,public_key) VALUES(1,?,?,?)",
  ).run("rsptest", "unused-node-private-key", "unused-public-key");
  const delivered = [];
  const config = {
    mailHostname: "mail.sender.example",
    maxMessageBytes: 20 * 1024 ** 2,
    outboundMode: "direct",
    dkimBackend: "rspamd",
    rspamdUrl: `http://127.0.0.1:${server.address().port}/checkv2`,
    rspamdTimeoutMs: 1000,
    rspamdSelector: "rsptest",
    // Prove the old global signing option is also disabled for composed mail.
    dkim: {
      domainName: "sender.example",
      keySelector: "old",
      privateKey: "unused-old-key",
    },
    outboundDependencies: {
      resolver: publicResolver,
      createTransport() {
        return {
          close() {},
          async sendMail(message) {
            delivered.push({ ...message, raw: Buffer.from(message.raw) });
            return { accepted: [...message.envelope.to] };
          },
        };
      },
    },
  };
  const mail = createMailService(store, config);
  t.after(async () => {
    await mail.stop();
    db.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    store,
    mail,
    config,
    delivered,
    requests,
    user: db.prepare("SELECT * FROM users WHERE id=1").get(),
  };
}

test("Rspamd signs webmail and authenticated submissions before outbound delivery without changing MIME or exposing Bcc", async (t) => {
  const { store, mail, delivered, requests, user } = await fixture(t);
  const attachment = Buffer.from("attachment bytes\u0000\u00ff", "utf8");
  const sent = await mail.send(user, {
    to: "receiver@recipient.example",
    bcc: "hidden@recipient.example",
    subject: "Rspamd webmail integration",
    text: "Original body\nwith a second line.",
    attachments: [
      { filename: "payload.bin", content: attachment.toString("base64") },
    ],
  });
  await eventually(() => delivered.length === 2);
  await eventually(
    () =>
      store.db
        .prepare("SELECT delivery_status FROM messages WHERE id=?")
        .get(sent.id).delivery_status === "delivered",
  );
  assert.deepEqual(delivered.map((message) => message.envelope.to[0]).sort(), [
    "hidden@recipient.example",
    "receiver@recipient.example",
  ]);
  const queuedRaw = Buffer.from(
    store.db
      .prepare("SELECT raw FROM delivery_jobs WHERE message_id=? LIMIT 1")
      .get(sent.id).raw,
  );
  assert(
    !/^DKIM-Signature:/im.test(queuedRaw.toString()),
    "Node must not pre-sign Rspamd mail",
  );
  for (let i = 0; i < delivered.length; i++) {
    const message = delivered[i];
    assert.equal(
      message.dkim,
      undefined,
      "Nodemailer must not add a second signature",
    );
    assert.equal(
      (message.raw.toString().match(/^DKIM-Signature:/gim) || []).length,
      1,
    );
    assert.deepEqual(
      message.raw.subarray(message.raw.indexOf("\r\n") + 2),
      queuedRaw,
    );
    assert(!/^Bcc:/im.test(message.raw.toString()));
    const parsed = await simpleParser(message.raw);
    assert.equal(parsed.subject, "Rspamd webmail integration");
    assert.equal(
      parsed.text.replace(/\r\n/g, "\n").trim(),
      "Original body\nwith a second line.",
    );
    assert.equal(parsed.attachments.length, 1);
    assert.deepEqual(parsed.attachments[0].content, attachment);
    const request = requests.find(
      (entry) => entry.headers.rcpt === message.envelope.to[0],
    );
    assert.equal(request.url, "/checkv2");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.user, user.email);
    assert.equal(request.headers.from, user.email);
    assert.equal(request.headers.helo, "mail.sender.example");
    assert.deepEqual(request.raw, queuedRaw);
  }
  const submitted = Buffer.from(
    "From: admin@sender.example\r\nTo: smtp@recipient.example\r\nBcc: hidden-smtp@recipient.example\r\nSubject: SMTP submission\r\nDate: Mon, 19 Oct 2026 10:00:00 +0000\r\nMessage-ID: <smtp-test@sender.example>\r\n\r\nSubmitted body\r\n",
  );
  const smtp = await mail.receive(
    submitted,
    {
      from: user.email,
      to: ["smtp@recipient.example", "hidden-smtp@recipient.example"],
    },
    user,
    "127.0.0.1",
  );
  await mail.work();
  await eventually(() => delivered.length === 4);
  await eventually(
    () =>
      store.db
        .prepare("SELECT delivery_status FROM messages WHERE id=?")
        .get(smtp.id).delivery_status === "delivered",
  );
  for (const message of delivered.slice(2)) {
    assert.equal(message.dkim, undefined);
    assert.equal(
      (message.raw.toString().match(/^DKIM-Signature:/gim) || []).length,
      1,
    );
    assert(!/^Bcc:/im.test(message.raw.toString()));
    assert.match(message.raw.toString(), /Submitted body\r\n$/);
  }
});

test("missing or unavailable Rspamd signing keeps the durable delivery queued and retry succeeds only after signing recovers", async (t) => {
  let mode = "missing";
  const { store, mail, delivered, requests, user } = await fixture(
    t,
    (_request, response) => {
      if (mode === "unavailable") {
        response.statusCode = 503;
        response.end("{}");
      } else
        response.end(
          JSON.stringify(
            mode === "missing" ? {} : { "dkim-signature": signature },
          ),
        );
    },
  );
  const { id } = await mail.send(user, {
    to: "receiver@recipient.example",
    subject: "Recover signing",
    text: "Persist while signer unavailable",
  });
  const job = () =>
    store.db.prepare("SELECT * FROM delivery_jobs WHERE message_id=?").get(id);
  await eventually(
    () =>
      job()?.attempts === 1 && job()?.state === "queued" && job()?.last_error,
  );
  const originalRaw = Buffer.from(job().raw);
  assert.equal(delivered.length, 0);
  assert.match(job().last_error, /Rspamd DKIM/);
  assert(job().next_attempt > Date.now());
  assert.equal(
    store.db.prepare("SELECT delivery_status FROM messages WHERE id=?").get(id)
      .delivery_status,
    "queued",
  );
  mode = "unavailable";
  store.db
    .prepare("UPDATE delivery_jobs SET next_attempt=0 WHERE id=?")
    .run(job().id);
  await mail.work();
  assert.equal(job().attempts, 2);
  assert.equal(job().state, "queued");
  assert.match(job().last_error, /HTTP 503/);
  assert.equal(delivered.length, 0);
  assert.deepEqual(Buffer.from(job().raw), originalRaw);
  mode = "ready";
  store.db
    .prepare("UPDATE delivery_jobs SET next_attempt=0 WHERE id=?")
    .run(job().id);
  await mail.work();
  assert.equal(job().attempts, 3);
  assert.equal(job().state, "delivered");
  assert.equal(job().last_error, "");
  assert.equal(delivered.length, 1);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    delivered[0].raw.subarray(delivered[0].raw.indexOf("\r\n") + 2),
    originalRaw,
  );
});

// Independent DKIM verification for the optional real-daemon test. Keep this
// separate from the signing implementation so a broken signer cannot self-test.
function verifyDkim(raw, publicKey, domain, selector) {
  const text = raw.toString("latin1");
  const boundary = text.indexOf("\r\n\r\n");
  assert(boundary >= 0);
  const headers = text
    .slice(0, boundary)
    .split(/\r\n(?![ \t])/)
    .map((line) => ({
      name: line.slice(0, line.indexOf(":")).toLowerCase(),
      raw: line,
    }));
  const signatures = headers.filter(
    (header) => header.name === "dkim-signature",
  );
  assert.equal(signatures.length, 1);
  const dkim = signatures[0].raw;
  const tags = new Map(
    dkim
      .slice(dkim.indexOf(":") + 1)
      .replace(/\r\n[ \t]+/g, " ")
      .split(";")
      .filter((part) => part.trim())
      .map((part) => {
        const equals = part.indexOf("=");
        return [part.slice(0, equals).trim(), part.slice(equals + 1).trim()];
      }),
  );
  assert.equal(tags.get("a"), "rsa-sha256");
  assert.equal(tags.get("d"), domain);
  assert.equal(tags.get("s"), selector);
  const [headerMode, bodyMode] = (tags.get("c") || "simple/simple").split("/");
  let body = text.slice(boundary + 4);
  if (bodyMode === "relaxed")
    body = body
      .split("\r\n")
      .map((line) => line.replace(/[ \t]+$/g, "").replace(/[ \t]+/g, " "))
      .join("\r\n");
  else assert.equal(bodyMode, "simple");
  body = body.replace(/(?:\r\n)*$/, "") + "\r\n";
  let bodyBytes = Buffer.from(body, "latin1");
  if (tags.has("l")) bodyBytes = bodyBytes.subarray(0, Number(tags.get("l")));
  assert.equal(
    createHash("sha256").update(bodyBytes).digest("base64"),
    tags.get("bh"),
    "DKIM body hash must match delivered MIME",
  );
  function canonicalHeader(line) {
    if (headerMode === "simple") return line + "\r\n";
    assert.equal(headerMode, "relaxed");
    const colon = line.indexOf(":");
    return (
      line.slice(0, colon).toLowerCase() +
      ":" +
      line
        .slice(colon + 1)
        .replace(/\r\n[ \t]+/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim() +
      "\r\n"
    );
  }
  const used = new Set();
  const signedHeaders = [];
  for (const name of tags
    .get("h")
    .toLowerCase()
    .split(":")
    .map((value) => value.trim())) {
    for (let i = headers.length - 1; i >= 0; i--) {
      if (!used.has(i) && headers[i].name === name) {
        used.add(i);
        signedHeaders.push(canonicalHeader(headers[i].raw));
        break;
      }
    }
  }
  signedHeaders.push(
    canonicalHeader(dkim.replace(/(\bb\s*=)[^;]*/i, "$1")).replace(/\r\n$/, ""),
  );
  const key = createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  assert(
    verify(
      "RSA-SHA256",
      Buffer.from(signedHeaders.join(""), "latin1"),
      key,
      Buffer.from(tags.get("b").replace(/\s/g, ""), "base64"),
    ),
    "DKIM signature must verify with the generated DNS public key",
  );
}

test(
  "real Rspamd generates the setup key and signs webmail plus SMTP submission with verifiable DKIM",
  { skip: !process.env.RSPAMD_INTEGRATION_URL },
  async (t) => {
    const domain = "rspamd-check.example";
    const selector = process.env.RSPAMD_SELECTOR || "rspamd";
    const keyConfig = {
      rspamdKeyDir: process.env.RSPAMD_KEY_DIR || "/var/lib/postoffice-dkim",
      rspamdSelector: selector,
    };
    const keyFile = rspamdKeyPath(keyConfig, domain);
    try {
      await access(keyFile);
      assert.fail(
        `Refusing to reuse or remove existing integration key: ${keyFile}`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "postoffice-real-rspamd-"),
    );
    const received = [];
    const remote = new SMTPServer({
      authOptional: true,
      disabledCommands: ["AUTH", "STARTTLS"],
      disableReverseLookup: true,
      onData(stream, session, callback) {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () => {
          received.push({
            raw: Buffer.concat(chunks),
            envelope: session.envelope,
          });
          callback();
        });
      },
    });
    await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
    let service;
    t.after(async () => {
      await service?.close();
      await new Promise((resolve) => remote.close(resolve));
      await rm(keyFile, { force: true });
      await rm(dir, { recursive: true, force: true });
    });
    service = await start({
      production: false,
      secureCookies: false,
      host: "127.0.0.1",
      smtpHost: "127.0.0.1",
      port: 0,
      smtpPort: 0,
      submissionPort: 0,
      dataDir: dir,
      publicUrl: "http://localhost",
      mailHostname: `mail.${domain}`,
      dkimBackend: "rspamd",
      rspamdUrl: process.env.RSPAMD_INTEGRATION_URL,
      rspamdTimeoutMs: 10000,
      ...keyConfig,
      rspamadmPath: process.env.RSPAMADM_PATH || "/usr/bin/rspamadm",
      dkim: undefined,
      outboundMode: "direct",
      relay: null,
      tls: {},
      allowInsecureAuth: true,
      outboundDependencies: {
        resolver: { ...publicResolver, resolve4: async () => ["127.0.0.1"] },
        port: remote.server.address().port,
        allowPrivateAddresses: true,
      },
    });
    const base = `http://127.0.0.1:${service.ports.http}`;
    const password = "Rspamd-integration-test-2026";
    const response = await fetch(base + "/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain,
        email: `admin@${domain}`,
        password,
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const setup = await response.json();
    await access(keyFile);
    const key = service.store.db
      .prepare("SELECT selector, public_key FROM domain_keys")
      .get();
    assert.equal(key.selector, selector);
    const send = await fetch(base + "/api/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": setup.csrfToken,
      },
      body: JSON.stringify({
        to: "receiver@recipient.example",
        subject: "Real Rspamd webmail",
        text: "Verify real daemon body",
        attachments: [
          {
            filename: "proof.txt",
            content: Buffer.from("proof bytes").toString("base64"),
          },
        ],
      }),
    });
    assert.equal(send.status, 201, await send.clone().text());
    await eventually(() => received.length === 1);
    verifyDkim(received[0].raw, key.public_key, domain, selector);
    const parsed = await simpleParser(received[0].raw);
    assert.equal(parsed.attachments[0].content.toString(), "proof bytes");
    const submission = nodemailer.createTransport({
      host: "127.0.0.1",
      port: service.ports.submission,
      ignoreTLS: true,
      auth: { user: `admin@${domain}`, pass: password },
    });
    t.after(() => submission.close());
    await submission.sendMail({
      from: `admin@${domain}`,
      to: "smtp@recipient.example",
      subject: "Real Rspamd SMTP",
      text: "SMTP body signed by real daemon",
    });
    await service.mail.work();
    await eventually(() => received.length === 2);
    verifyDkim(received[1].raw, key.public_key, domain, selector);
    assert.equal(
      (await simpleParser(received[1].raw)).text.trim(),
      "SMTP body signed by real daemon",
    );
  },
);
