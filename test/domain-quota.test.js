import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { openStore } from "../src/db.js";
import { start } from "../src/server.js";
import {
  normalizeMailboxLimit,
  mailboxCapacity,
  assertMailboxCapacity,
  assertMailboxLimit,
  quotaError,
} from "../src/domain-quota.js";

const cleanup = new Map();
async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-domain-quota-"));
  cleanup.set(dir, []);
  t.after(async () => {
    for (const close of cleanup.get(dir).reverse()) await close();
    cleanup.delete(dir);
    assert(
      path
        .resolve(dir)
        .startsWith(
          path.resolve(os.tmpdir()) + path.sep + "postoffice-domain-quota-",
        ),
    );
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function storeFixture(t) {
  const dir = await directory(t);
  const store = openStore({ dataDir: dir });
  cleanup.get(dir).push(() => store.db.close());
  return { ...store, dir };
}

function createUser(db, domain, name, options = {}) {
  return db
    .prepare(
      "INSERT INTO users(domain_id,email,name,password_hash,quota_bytes,role,active,is_temporary) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      domain,
      `${name}@quota.example`,
      name,
      "test-unused-hash",
      1048576,
      options.role || "user",
      options.active ?? 1,
      options.temporary ?? 0,
    );
}

test("mailbox limits validate strictly and count disabled, administrator and temporary mailboxes", async (t) => {
  const { db } = await storeFixture(t);
  for (const value of [
    true,
    false,
    "",
    "12",
    -1,
    1.5,
    Infinity,
    NaN,
    {},
    [],
    1000001,
  ])
    assert.throws(() => normalizeMailboxLimit(value), /邮箱数量/);
  assert.equal(normalizeMailboxLimit(undefined), null);
  assert.equal(normalizeMailboxLimit(undefined, 3), 3);
  assert.equal(normalizeMailboxLimit(null), null);
  assert.equal(normalizeMailboxLimit(0), 0);
  db.prepare(
    "INSERT INTO domains(id,name,mailbox_limit) VALUES(1,'quota.example',3)",
  ).run();
  createUser(db, 1, "admin", { role: "admin" });
  createUser(db, 1, "disabled", { active: 0 });
  createUser(db, 1, "temporary", { temporary: 1 });
  assert.deepEqual(mailboxCapacity(db, 1), {
    mailbox_limit: 3,
    mailbox_count: 3,
    mailbox_remaining: 0,
  });
  assert.throws(
    () => assertMailboxCapacity(db, 1),
    (error) => error.status === 409 && error.code === "DOMAIN_MAILBOX_LIMIT",
  );
  assert.throws(
    () => createUser(db, 1, "excess"),
    (error) => quotaError(error).status === 409,
  );
  assert.throws(
    () => assertMailboxLimit(db, 1, 2),
    (error) => error.code === "DOMAIN_MAILBOX_LIMIT_BELOW_USAGE",
  );
  assert.throws(
    () => db.prepare("UPDATE domains SET mailbox_limit=2 WHERE id=1").run(),
    (error) => quotaError(error).code === "DOMAIN_MAILBOX_LIMIT_BELOW_USAGE",
  );
  assert.equal(mailboxCapacity(db, 1).mailbox_count, 3);
  db.prepare("DELETE FROM users WHERE email='disabled@quota.example'").run();
  createUser(db, 1, "replacement");
  assert.equal(mailboxCapacity(db, 1).mailbox_count, 3);
  db.prepare("UPDATE domains SET mailbox_limit=NULL WHERE id=1").run();
  createUser(db, 1, "unlimited");
  assert.equal(mailboxCapacity(db, 1).mailbox_remaining, null);
  const unrelated = new Error("unrelated");
  assert.equal(quotaError(unrelated), unrelated);
});

test("capacity guards roll back entire batches, block domain moves and support zero capacity", async (t) => {
  const { db, transaction } = await storeFixture(t);
  db.exec(
    "INSERT INTO domains(id,name,mailbox_limit) VALUES(1,'quota.example',1),(2,'empty.example',0),(3,'other.example',NULL)",
  );
  assert.throws(
    () =>
      transaction(() => {
        createUser(db, 1, "first");
        createUser(db, 1, "second");
      }),
    /DOMAIN_MAILBOX_LIMIT/,
  );
  assert.equal(mailboxCapacity(db, 1).mailbox_count, 0);
  assert.throws(() => createUser(db, 2, "zero"), /DOMAIN_MAILBOX_LIMIT/);
  const id = Number(createUser(db, 3, "moving").lastInsertRowid);
  assert.throws(
    () => db.prepare("UPDATE users SET domain_id=2 WHERE id=?").run(id),
    /DOMAIN_MAILBOX_LIMIT/,
  );
  assert.equal(
    db.prepare("SELECT domain_id FROM users WHERE id=?").get(id).domain_id,
    3,
  );
  transaction(() => {
    assertMailboxCapacity(db, 1);
    db.prepare("UPDATE users SET domain_id=1 WHERE id=?").run(id);
  });
  assert.equal(mailboxCapacity(db, 1).mailbox_remaining, 0);
  assert.throws(
    () =>
      db.prepare("UPDATE domains SET mailbox_limit=1000001 WHERE id=3").run(),
    /CHECK constraint/,
  );
});

test("existing databases migrate once without changing unlimited capacity or mailbox data", async (t) => {
  const dir = await directory(t);
  const dbPath = path.join(dir, "postoffice.sqlite");
  let db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE domains(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,domain_id INTEGER NOT NULL REFERENCES domains(id),email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',active INTEGER NOT NULL DEFAULT 1,quota_bytes INTEGER NOT NULL,created_at TEXT);
    INSERT INTO domains(id,name) VALUES(1,'quota.example');
    INSERT INTO users(id,domain_id,email,name,password_hash,quota_bytes) VALUES(1,1,'existing@quota.example','Existing','unchanged-hash',1048576);
  `);
  db.close();
  for (let i = 0; i < 2; i++) {
    db = openStore({ dataDir: dir }).db;
    try {
      assert.deepEqual(mailboxCapacity(db, 1), {
        mailbox_limit: null,
        mailbox_count: 1,
        mailbox_remaining: null,
      });
      assert.equal(
        db.prepare("SELECT password_hash FROM users WHERE id=1").get()
          .password_hash,
        "unchanged-hash",
      );
      assert.equal(
        db.prepare("SELECT admin_role FROM users WHERE id=1").get().admin_role,
        "legacy",
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'domain_mailbox_capacity_%'",
          )
          .get().n,
        3,
      );
    } finally {
      db.close();
    }
  }
});

test("two independent database connections cannot consume the same final slot", async (t) => {
  const { db, dir } = await storeFixture(t);
  db.exec(
    "INSERT INTO domains(id,name,mailbox_limit) VALUES(1,'quota.example',1)",
  );
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);
  let ready = 0;
  const workers = [];
  const jobs = ["racer-a", "racer-b"].map(
    (name) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(
          `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.path);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
      const gate = new Int32Array(workerData.barrier);
      parentPort.postMessage({ready:true});
      Atomics.wait(gate,0,0,10000);
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare("INSERT INTO users(domain_id,email,name,password_hash,quota_bytes) VALUES(1,?,?,'unused',1048576)").run(workerData.name+'@quota.example',workerData.name);
        db.exec('COMMIT');
        parentPort.postMessage({ok:true});
      } catch(error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        parentPort.postMessage({ok:false,error:error.message});
      } finally { db.close(); }
    `,
          {
            eval: true,
            workerData: {
              path: path.join(dir, "postoffice.sqlite"),
              name,
              barrier,
            },
          },
        );
        workers.push(worker);
        worker.on("error", reject);
        worker.on("message", (message) => {
          if (message.ready) {
            if (++ready === 2) {
              Atomics.store(gate, 0, 1);
              Atomics.notify(gate, 0);
            }
          } else resolve(message);
        });
      }),
  );
  const results = await Promise.all(jobs);
  await Promise.all(workers.map((worker) => worker.terminate()));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.find((r) => !r.ok).error, "DOMAIN_MAILBOX_LIMIT");
  assert.equal(mailboxCapacity(db, 1).mailbox_count, 1);
});

async function apiFixture(t) {
  const dataDir = await directory(t);
  const service = await start({
    host: "127.0.0.1",
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    smtpHost: "127.0.0.1",
    dataDir,
    outboundMode: "local",
  });
  cleanup.get(dataDir).push(() => service.close());
  function client() {
    const cookies = new Map();
    let csrf = "";
    return async (url, body, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(
        `http://127.0.0.1:${service.ports.http}/api${url}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            Cookie: [...cookies]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
            "X-CSRF-Token": csrf,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      for (const value of response.headers.getSetCookie()) {
        const [cookie] = value.split(";");
        const index = cookie.indexOf("=");
        cookies.set(cookie.slice(0, index), cookie.slice(index + 1));
      }
      const data = await response.json();
      if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    };
  }
  const admin = client();
  const setup = await admin("/setup", {
    domain: "quota.example",
    email: "admin@quota.example",
    name: "Quota admin",
    password: "Quota-admin-test-2026",
  });
  assert.equal(setup.status, 201);
  return { service, db: service.store.db, admin, client };
}

test("all HTTP account creation paths share domain capacity and full batches leave no partial accounts", async (t) => {
  const { db, admin, client } = await apiFixture(t);
  const domainId = db
    .prepare("SELECT id FROM domains WHERE name='quota.example'")
    .get().id;
  const setLimit = async (mailboxLimit) => {
    const result = await admin(
      `/admin/manage/domains/${domainId}`,
      { mailboxLimit },
      "PATCH",
    );
    assert.equal(result.status, 200, JSON.stringify(result.data));
  };
  await setLimit(2);
  const password = "Quota-mailbox-test-2026";
  const batch = await admin("/admin/manage/accounts/batch", {
    entries: [
      { email: "batch-a@quota.example", password },
      { email: "batch-b@quota.example", password },
    ],
  });
  assert.equal(batch.status, 409, JSON.stringify(batch.data));
  assert.equal(mailboxCapacity(db, domainId).mailbox_count, 1);
  const legacyBatch = await admin("/admin/users/batch", {
    entries: [
      { email: "legacy-a@quota.example", password },
      { email: "legacy-b@quota.example", password },
    ],
  });
  assert.equal(legacyBatch.status, 409);
  assert.equal(mailboxCapacity(db, domainId).mailbox_count, 1);
  assert.equal(
    (await admin("/admin/users", { email: "one@quota.example", password }))
      .status,
    201,
  );
  for (const route of [
    "/admin/users",
    "/admin/manage/accounts",
    "/admin/managers",
  ]) {
    const result = await admin(route, {
      email: "over-limit@quota.example",
      password,
      scope: "scoped",
      rolePreset: "auditor",
      permissions: [],
    });
    assert.equal(
      result.status,
      409,
      `${route}: ${JSON.stringify(result.data)}`,
    );
    assert.equal(result.data.code, "DOMAIN_MAILBOX_LIMIT");
  }
  const lower = await admin(
    `/admin/manage/domains/${domainId}`,
    { mailboxLimit: 1 },
    "PATCH",
  );
  assert.equal(lower.status, 409);
  assert.equal(lower.data.code, "DOMAIN_MAILBOX_LIMIT_BELOW_USAGE");
  const domainResult = await admin("/admin/manage/domains");
  const domain = domainResult.data.items.find((item) => item.id === domainId);
  assert.equal(domain.mailbox_count, 2);
  assert.equal(domain.mailbox_remaining, 0);
  await admin(
    "/admin/temp-mail/settings",
    { enabled: true, domains: ["quota.example"] },
    "PUT",
  );
  const page = await admin("/admin/temp-mail/pages", {
    name: "Quota test",
    domains: ["quota.example"],
    requirePassword: false,
    dailyIpLimit: 5,
  });
  assert.equal(page.status, 201);
  const guest = client();
  assert.equal(
    (await guest(`/temp/${page.data.token}/mailboxes`, {})).status,
    409,
  );
  await setLimit(3);
  assert.equal(
    (await guest(`/temp/${page.data.token}/mailboxes`, {})).status,
    201,
  );
  assert.equal(mailboxCapacity(db, domainId).mailbox_count, 3);
  const full = await admin("/admin/manage/accounts", {
    email: "after-temp@quota.example",
    password,
  });
  assert.equal(full.status, 409);
  await setLimit(null);
  assert.equal(
    (
      await admin("/admin/manage/accounts", {
        email: "unlimited@quota.example",
        password,
      })
    ).status,
    201,
  );
});
