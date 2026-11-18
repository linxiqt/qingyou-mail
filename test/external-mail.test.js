import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pathToFileURL, fileURLToPath } from "node:url";
import { hashPassword } from "../src/security.js";
import { openStore } from "../src/db.js";
import { migrateMailProtocolSchema } from "../src/mail-protocol-schema.js";

const appDir =
  process.env.QINGYOU_PROTOCOL_TEST_ROOT ||
  fileURLToPath(new URL("..", import.meta.url));
const { start } = await import(
  pathToFileURL(path.join(appDir, "src/server.js"))
);
const { loadConfig } = await import(
  pathToFileURL(path.join(appDir, "src/config.js"))
);
const { edition } = await import(
  pathToFileURL(path.join(appDir, "src/edition.js"))
);
const run = promisify(execFile);
async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
function runClients(cfg, fixture = "external-mail-client.py") {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.QINGYOU_TEST_PYTHON ||
        (process.platform === "win32" ? "python" : "python3"),
      [fileURLToPath(new URL("fixtures/" + fixture, import.meta.url))],
      { windowsHide: true },
    );
    let out = "",
      err = "";
    child.on("error", reject);
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (err += data));
    child.on("close", (code) => {
      try {
        if (code) throw Error(err);
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify(cfg));
  });
}
test(
  "implicit TLS with independent POP3, IMAP and SMTP clients",
  { timeout: 60000 },
  async (t) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "qingyou-protocol-"));
    const cert = path.join(tmp, "localhost.pem"),
      key = path.join(tmp, "key.pem");
    let app;
    t.after(async () => {
      if (app) await app.close();
      assert.ok(
        path
          .resolve(tmp)
          .startsWith(path.join(os.tmpdir(), "qingyou-protocol-")),
      );
      await rm(tmp, { recursive: true, force: true, maxRetries: 4 });
    });
    await run(
      process.env.QINGYOU_TEST_OPENSSL || "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { windowsHide: true },
    );
    const domainCert = path.join(tmp, "domain.pem");
    await run(
      process.env.QINGYOU_TEST_OPENSSL || "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        key,
        "-subj",
        "/CN=mail.example.test",
        "-addext",
        "subjectAltName=DNS:mail.example.test",
        "-days",
        "2",
        "-out",
        domainCert,
      ],
      { windowsHide: true },
    );
    const tlsEnv = {
      TLS_CERT_PATH: cert,
      TLS_KEY_PATH: key,
      TLS_SNI_HOSTNAME: "mail.example.test",
      TLS_SNI_CERT_PATH: domainCert,
      TLS_SNI_KEY_PATH: key,
    };
    assert.throws(
      () => loadConfig({ ...tlsEnv, TLS_SNI_HOSTNAME: "wrong.example.test" }),
      /TLS_SNI_HOSTNAME/,
    );
    assert.throws(
      () => loadConfig({ ...tlsEnv, TLS_SNI_KEY_PATH: "" }),
      /TLS_SNI_KEY_PATH/,
    );
    const portSet = new Set();
    while (portSet.size < 3) portSet.add(await freePort());
    const [imapsPort, pop3sPort, smtpsPort] = portSet;
    const config = {
      dataDir: tmp,
      host: "127.0.0.1",
      smtpHost: "127.0.0.1",
      port: 0,
      smtpPort: 0,
      submissionPort: 0,
      imapsPort,
      pop3sPort,
      smtpsPort,
      tls: loadConfig(tlsEnv).tls,
      outboundMode: "local",
      dkimBackend: "node",
      mailHostname: "localhost",
      secureCookies: false,
    };
    app = await start(config);
    const { db } = app.store;
    db.prepare("INSERT INTO domains(name) VALUES(?)").run("example.test");
    const pwd = await hashPassword("Local-protocol-fixture-2026!");
    for (const name of ["alice@example.test", "bob@example.test", "admin"]) {
      db.prepare(
        "INSERT INTO users(domain_id,email,name,password_hash,quota_bytes) VALUES(1,?,?,?,?)",
      ).run(name, name, pwd, 100 * 1024 * 1024);
    }
    if (edition.required)
      await app.mail.receive(
        Buffer.from(
          "From: external@example.invalid\r\nTo: bob@example.test\r\nSubject: existing mail\r\nMIME-Version: 1.0\r\n\r\nfirst line\r\n.line with dot\r\nlast line\r\n",
        ),
        { from: "external@example.invalid", to: ["bob@example.test"] },
      );
    const params = {
      ...app.ports,
      ca: cert,
      domainCa: domainCert,
      database: path.join(tmp, "postoffice.sqlite"),
      locked: edition.required,
    };
    const api = "http://127.0.0.1:" + app.ports.http + "/api/client";
    const login = await fetch(api + "/auth/webmail/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bob@example.test",
        password: "Local-protocol-fixture-2026!",
      }),
    });
    assert.equal(login.status, 200);
    const settings = await fetch(api + "/auth/mail-client", {
      headers: { cookie: login.headers.get("set-cookie").split(";")[0] },
    });
    assert.equal(settings.status, 200);
    const shown = await settings.json();
    assert.equal(shown.username, "bob@example.test");
    assert.deepEqual(
      [shown.imapsPort, shown.pop3sPort, shown.smtpsPort],
      [imapsPort, pop3sPort, smtpsPort],
    );
    assert.equal(
      Object.keys(shown).some((k) => k.toLowerCase().includes("password")),
      false,
    );
    const ids = await runClients(params);
    if (!edition.required) {
      const bob = db
        .prepare("SELECT id FROM users WHERE email='bob@example.test'")
        .get();
      assert.equal(
        db
          .prepare(
            "SELECT starred*is_read AS both FROM messages WHERE owner_id=? AND folder='inbox'",
          )
          .get(bob.id).both,
        1,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM messages WHERE owner_id=? AND folder='drafts'",
          )
          .get(bob.id).n,
        1,
      );
    }
    await app.close();
    app = null;
    app = await start(config);
    assert.deepEqual(
      await runClients({ ...params, ...ids, verifyRestart: true }),
      { restart: true },
    );
  },
);

test("only the opted-in mailbox can use plain IMAP and authenticate on the inbound SMTP port", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "qingyou-plain-mail-"));
  let app;
  t.after(async () => {
    if (app) await app.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 4 });
  });
  const address = "worker@example.test",
    other = "other@example.test";
  const password = "Private-test-mail-2026!";
  assert.equal(loadConfig({}).imapPort, 0);
  assert.equal(loadConfig({ MAIL_PLAINTEXT_ACCOUNT: address }).imapPort, 143);
  assert.throws(
    () => loadConfig({ IMAP_PORT: "143" }),
    /MAIL_PLAINTEXT_ACCOUNT/,
  );
  assert.throws(() => loadConfig({ MAIL_PLAINTEXT_ACCOUNT: "*@example.test" }));
  const imapPort = await freePort();
  let smtpPort = await freePort();
  while (smtpPort === imapPort) smtpPort = await freePort();
  const config = {
    dataDir: tmp,
    host: "127.0.0.1",
    smtpHost: "127.0.0.1",
    port: 0,
    smtpPort,
    submissionPort: 0,
    imapsPort: 0,
    pop3sPort: 0,
    smtpsPort: 0,
    imapPort,
    plaintextMailbox: address,
    mailHostname: "mail.example.test",
    mailPublicIp: "127.0.0.1",
    outboundMode: "local",
    dkimBackend: "node",
    secureCookies: false,
  };
  app = await start(config);
  const db = app.store.db;
  db.prepare("INSERT INTO domains(name) VALUES(?)").run("example.test");
  const hash = await hashPassword(password);
  for (const email of [address, other])
    db.prepare(
      "INSERT INTO users(domain_id,email,name,password_hash,quota_bytes) VALUES(1,?,?,?,?)",
    ).run(email, email, hash, 1024 * 1024);
  await app.mail.receive(
    Buffer.from(
      "From: sender@external.test\r\nTo: worker@example.test\r\nSubject: seed\r\n\r\nvisible fixture\r\n",
    ),
    { from: "sender@external.test", to: [address] },
  );
  const api = "http://127.0.0.1:" + app.ports.http + "/api/client";
  for (const email of [address, other]) {
    const login = await fetch(api + "/auth/webmail/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.status, 200);
    const settings = await fetch(api + "/auth/mail-client", {
      headers: { cookie: login.headers.get("set-cookie").split(";")[0] },
    });
    const body = await settings.json();
    if (email === address)
      assert.deepEqual(body.plaintext, {
        hostname: "mail.example.test",
        imapPort,
        smtpPort,
      });
    else assert.equal(body.plaintext, undefined);
  }
  const params = {
    ...app.ports,
    address,
    other,
    password,
    locked: edition.required,
  };
  assert.deepEqual(await runClients(params, "single-mailbox-client.py"), {
    verified: true,
  });
  assert.equal(
    db.prepare("SELECT password_hash FROM users WHERE email=?").get(address)
      .password_hash,
    hash,
  );
  await app.close();
  app = null;
  app = await start({ ...config, imapPort: 0, plaintextMailbox: "" });
  assert.equal(app.ports.imap, 0);
  assert.deepEqual(
    await runClients(
      { ...params, smtp: app.ports.smtp, disabled: true },
      "single-mailbox-client.py",
    ),
    { disabled: true },
  );
});

test("existing messages receive stable UIDs, and moving or replacing the highest row never reuses an inbox UID", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "qingyou-uid-"));
  const store = openStore({ dataDir: tmp }),
    db = store.db;
  t.after(async () => {
    db.close();
    assert.ok(
      path.resolve(tmp).startsWith(path.join(os.tmpdir(), "qingyou-uid-")),
    );
    await rm(tmp, { recursive: true, force: true });
  });
  for (const { name } of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'protocol_%'",
    )
    .all())
    db.exec("DROP TRIGGER " + name);
  db.exec(
    "DROP TABLE protocol_messages; DROP TABLE protocol_folders; INSERT INTO domains(name) VALUES('example.test'); INSERT INTO users(domain_id,email,name,password_hash,quota_bytes) VALUES(1,'bob@example.test','Bob','dummy',12345)",
  );
  const insert = db.prepare(
    "INSERT INTO messages(owner_id,folder,from_email) VALUES(1,'inbox','fixture@example.test')",
  );
  insert.run();
  insert.run();
  migrateMailProtocolSchema(db);
  const uids = () =>
    db
      .prepare(
        "SELECT uid FROM protocol_messages WHERE folder='inbox' ORDER BY uid",
      )
      .all()
      .map((row) => row.uid);
  assert.deepEqual(uids(), [1, 2]);
  db.exec("DELETE FROM messages WHERE id=2");
  insert.run();
  db.exec(
    "UPDATE messages SET folder='archive' WHERE id=1; UPDATE messages SET folder='inbox' WHERE id=1",
  );
  migrateMailProtocolSchema(db);
  assert.deepEqual(uids(), [3, 4]);
});
