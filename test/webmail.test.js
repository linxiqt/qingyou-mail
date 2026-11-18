import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodemailer from "nodemailer";
import { start } from "../src/server.js";

const password = "Webmail-test-password-2026";
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

test("ordinary webmail login supports SMTP receiving, sending, attachments and drafts with mailbox isolation", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "postoffice-webmail-"));
  const service = await start({
    dataDir,
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
  });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.ports.http}`;
  for (const route of ["/webmail", "/webmail/", "/webmail.html"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data-client="webmail"/);
  }
  const admin = client(base),
    alice = client(base),
    bob = client(base),
    wrong = client(base);
  assert.equal(
    (await admin.call("/setup", { username: "owner", password })).status,
    201,
  );
  assert.equal(
    (await wrong.call("/auth/webmail/login", { email: "owner", password }))
      .status,
    403,
  );
  assert.equal(
    (await admin.call("/admin/manage/domains", { name: "client.example" }))
      .status,
    201,
  );
  for (const email of ["alice@client.example", "bob@client.example"]) {
    assert.equal(
      (
        await admin.call("/admin/users", {
          email,
          name: email.startsWith("alice") ? "Alice" : "Bob",
          password,
        })
      ).status,
      201,
    );
  }
  assert.equal(
    (
      await wrong.call("/auth/webmail/login", {
        email: "alice@client.example",
        password: "wrong",
      })
    ).status,
    401,
  );
  const login = await alice.call("/auth/webmail/login", {
    email: "ALICE@CLIENT.EXAMPLE",
    password,
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, "user");
  assert.equal(
    (
      await bob.call("/auth/webmail/login", {
        email: "bob@client.example",
        password,
      })
    ).status,
    200,
  );
  assert.equal((await alice.call("/admin/manage/domains")).status, 403);
  assert.equal((await alice.call("/admin/users")).status, 403);
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: service.ports.smtp,
    secure: false,
    ignoreTLS: true,
  });
  await transport.sendMail({
    from: "friend@sender.example",
    to: "alice@client.example",
    subject: "网页邮箱 SMTP 收件",
    text: "这是一封本地收件测试。",
    attachments: [{ filename: "hello.txt", content: "attachment payload" }],
  });
  transport.close();
  const inbox = (await alice.call("/messages?folder=inbox")).data.items;
  const received = inbox.find((m) => m.subject === "网页邮箱 SMTP 收件");
  assert(received);
  const detail = await alice.call(`/messages/${received.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.data.body_text, /本地收件测试/);
  assert.equal(detail.data.attachments.length, 1);
  assert.equal((await bob.call(`/messages/${received.id}`)).status, 404);
  assert.equal((await bob.call(`/messages/${received.id}/raw`)).status, 404);
  const attachment = detail.data.attachments[0];
  assert.equal((await bob.call(`/attachments/${attachment.id}`)).status, 404);
  const attachmentResponse = await fetch(
    `${base}/api/client/attachments/${attachment.id}`,
    { headers: { Cookie: alice.cookie } },
  );
  assert.equal(await attachmentResponse.text(), "attachment payload");
  const draft = await alice.call("/drafts", {
    to: "bob@client.example",
    subject: "网页草稿",
    text: "草稿正文",
  });
  assert.equal(draft.status, 201);
  assert.equal((await bob.call(`/messages/${draft.data.id}`)).status, 404);
  const sent = await alice.call("/send", {
    from: "bob@client.example",
    to: "bob@client.example",
    subject: "网页客户端发件",
    html: "<p>来自 Alice 的邮件</p>",
    text: "来自 Alice 的邮件",
    attachments: [
      {
        filename: "reply.txt",
        content: Buffer.from("reply file").toString("base64"),
      },
    ],
  });
  assert.equal(sent.status, 201);
  await service.mail.work();
  const outgoing = (await alice.call(`/messages/${sent.data.id}`)).data;
  assert.equal(outgoing.from_email, "alice@client.example");
  assert.equal(outgoing.folder, "sent");
  const bobInbox = (await bob.call("/messages?folder=inbox")).data.items;
  const delivered = bobInbox.find((m) => m.subject === "网页客户端发件");
  assert(delivered);
  assert.equal(delivered.from_email, "alice@client.example");
  assert.equal((await alice.call(`/messages/${delivered.id}`)).status, 404);
  assert.equal((await alice.call("/auth/logout", {})).status, 200);
  assert.equal((await alice.call("/messages?folder=inbox")).status, 401);
});
