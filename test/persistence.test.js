import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { webhookTarget } from "../src/webhooks.js";
import { ensureDomainKeys } from "../src/domain-keys.js";

test("persisted tasks recover after process interruption", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-persist-"));
  let store = openStore({ dataDir: dir });
  try {
    const db = store.db;
    db.prepare("INSERT INTO domains(name) VALUES(?)").run("example.com");
    db.prepare(
      "INSERT INTO users(domain_id,email,name,password_hash,quota_bytes) VALUES(1,?,?,?,?)",
    ).run("test@example.com", "Test", "test-only-unused-hash", 1024 ** 3);
    db.prepare(
      "INSERT INTO delivery_jobs(owner_id,sender,recipient,raw,state) VALUES(1,?,?,?,'sending')",
    ).run(
      "test@example.com",
      "other@example.net",
      Buffer.from("raw MIME bytes"),
    );
    db.prepare("INSERT INTO webhooks(name,url,secret) VALUES(?,?,?)").run(
      "Test",
      "https://example.com/hook",
      "test-secret",
    );
    db.prepare(
      "INSERT INTO webhook_jobs(webhook_id,payload,state) VALUES(1,?,'sending')",
    ).run('{"id":"durable-event"}');
    await ensureDomainKeys(db);
    const publicKey = db
      .prepare("SELECT public_key FROM domain_keys WHERE domain_id=1")
      .get().public_key;
    db.close();
    store = openStore({ dataDir: dir });
    await ensureDomainKeys(store.db);
    assert.equal(
      store.db
        .prepare("SELECT public_key FROM domain_keys WHERE domain_id=1")
        .get().public_key,
      publicKey,
    );
    const mail = store.db.prepare("SELECT * FROM delivery_jobs").get();
    assert.equal(mail.state, "queued");
    assert.equal(Buffer.from(mail.raw).toString(), "raw MIME bytes");
    const hook = store.db.prepare("SELECT * FROM webhook_jobs").get();
    assert.equal(hook.state, "queued");
    assert.equal(JSON.parse(hook.payload).id, "durable-event");
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("webhook validation rejects private addresses and unsafe schemes", async () => {
  for (const url of [
    "http://example.com/hook",
    "https://127.0.0.1/hook",
    "https://10.1.2.3/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[fec0::1]/",
    "file:///etc/passwd",
    "https://user:password@example.com/",
  ])
    await assert.rejects(webhookTarget(url, false));
  assert.equal(
    (await webhookTarget("https://8.8.8.8/hook", false)).address.address,
    "8.8.8.8",
  );
});
test("production configuration requires HTTPS and TLS and ignores legacy setup tokens", () => {
  assert.throws(
    () =>
      loadConfig({ NODE_ENV: "production", PUBLIC_URL: "http://example.com" }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({ NODE_ENV: "production", PUBLIC_URL: "https://example.com" }),
    /TLS/,
  );
  assert.equal(
    loadConfig({ SETUP_TOKEN: "legacy-unused" }).setupToken,
    undefined,
  );
  assert.throws(
    () => loadConfig({ PUBLIC_URL: "https://example.com/unsupported-path" }),
    /PUBLIC_URL/,
  );
});
