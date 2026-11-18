import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodemailer from "nodemailer";
import { start } from "../src/server.js";
import { digest, hashPassword } from "../src/security.js";

const password = "Client-access-password-2026";
function browser(base) {
  const cookies = new Map(),
    csrf = {};
  return {
    cookies,
    csrf,
    async call(
      route,
      body,
      method = body === undefined ? "GET" : "POST",
      override = {},
    ) {
      const portal =
        route.startsWith("/client/") || route === "/auth/webmail/login"
          ? "client"
          : "admin";
      const response = await fetch(base + "/api" + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          Cookie: [...cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; "),
          "X-CSRF-Token": csrf[portal] || "",
          ...override,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const value of response.headers.getSetCookie()) {
        const [cookie] = value.split(";"),
          index = cookie.indexOf("=");
        cookies.set(cookie.slice(0, index), cookie.slice(index + 1));
      }
      const data = response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.json()
        : await response.text();
      if (data.csrfToken) csrf[portal] = data.csrfToken;
      return { status: response.status, data };
    },
  };
}

async function fixture(t) {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "postoffice-client-access-"),
  );
  const service = await start({
    dataDir,
    host: "127.0.0.1",
    smtpHost: "127.0.0.1",
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    production: false,
    secureCookies: false,
    dkimBackend: "node",
    outboundMode: "local",
    allowInsecureAuth: true,
    tls: {},
  });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.ports.http}`,
    admin = browser(base),
    db = service.store.db;
  assert.equal(
    (
      await admin.call("/setup", {
        domain: "control.example",
        email: "admin@control.example",
        password,
      })
    ).status,
    201,
  );
  const tenant = (
    await admin.call("/admin/manage/domains", { name: "tenant.example" })
  ).data;
  const other = (
    await admin.call("/admin/manage/domains", { name: "other.example" })
  ).data;
  for (const email of [
    "plain@tenant.example",
    "owner@control.example",
    "foreign@other.example",
  ])
    assert.equal(
      (await admin.call("/admin/manage/accounts", { email, password })).status,
      201,
    );
  const grants = [
    {
      domain_id: tenant.id,
      can_read: true,
      can_create: true,
      can_update: true,
      can_delete: true,
    },
  ];
  const ownerId = db
    .prepare("SELECT id FROM users WHERE email=?")
    .get("owner@control.example").id;
  assert.equal(
    (
      await admin.call(
        `/admin/managers/${ownerId}`,
        { scope: "client", permissions: grants },
        "PATCH",
      )
    ).status,
    200,
  );
  const owner = browser(base);
  const login = await owner.call("/auth/webmail/login", {
    email: "owner@control.example",
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.user.role, "user");
  assert.equal(Number(login.data.user.client_manager), 1);
  return {
    service,
    db,
    base,
    admin,
    owner,
    ownerId,
    tenant,
    other,
    grants,
    login,
  };
}

test("backend and client cookies, CSRF, logout and database sessions are independent", async (t) => {
  const { admin, ownerId, base, db } = await fixture(t);
  assert.equal(
    (
      await admin.call("/auth/login", {
        email: "owner@control.example",
        password,
      })
    ).status,
    403,
  );
  assert.equal(
    (await admin.call("/auth/me")).data.user.email,
    "admin@control.example",
  );
  const adminToken = admin.cookies.get("postoffice_session");
  for (const route of [
    "/client/Admin/managers",
    "/client/V1/messages",
    "/client/SETUP/",
  ])
    assert.equal(
      (await admin.call(route, route.includes("SETUP") ? {} : undefined))
        .status,
      403,
    );
  assert.equal(
    (
      await admin.call("/auth/webmail/login", {
        email: "owner@control.example",
        password,
      })
    ).status,
    200,
  );
  const clientToken = admin.cookies.get("postoffice_client_session");
  assert(adminToken && clientToken && adminToken !== clientToken);
  assert.equal(
    (await admin.call("/auth/me")).data.user.email,
    "admin@control.example",
  );
  assert.equal(
    (await admin.call("/client/auth/me")).data.user.email,
    "owner@control.example",
  );
  assert.equal(
    (
      await admin.call("/auth/me", undefined, "GET", {
        Cookie: `postoffice_session=${clientToken}`,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await admin.call("/client/auth/me", undefined, "GET", {
        Cookie: `postoffice_client_session=${adminToken}`,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await admin.call("/client/auth/logout", {}, "POST", {
        "X-CSRF-Token": admin.csrf.admin,
      })
    ).status,
    403,
  );
  assert.equal((await admin.call("/client/auth/logout", {})).status, 200);
  assert.equal((await admin.call("/client/auth/me")).status, 401);
  assert.equal((await admin.call("/auth/me")).status, 200);
  await admin.call("/auth/webmail/login", {
    email: "owner@control.example",
    password,
  });
  assert.equal((await admin.call("/auth/logout", {})).status, 200);
  assert.equal((await admin.call("/client/auth/me")).status, 200);
  assert.equal((await admin.call("/auth/me")).status, 401);
  const stale = "legacy-browser-token";
  db.prepare(
    "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,portal) VALUES(?,?,?,?,?)",
  ).run(digest(stale), ownerId, "stale", Date.now() + 60000, "legacy");
  const anonymous = browser(base);
  for (const [route, name] of [
    ["/auth/me", "postoffice_session"],
    ["/client/auth/me", "postoffice_client_session"],
  ])
    assert.equal(
      (
        await anonymous.call(route, undefined, "GET", {
          Cookie: `${name}=${stale}`,
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await anonymous.call("/auth/webmail/login/", {
        email: "owner@control.example",
        password,
      })
    ).status,
    200,
  );
});

test("client domain management needs explicit grants and respects mailbox counts and global-only APIs", async (t) => {
  const { db, owner, ownerId, admin, tenant, other, base } = await fixture(t);
  const plain = browser(base);
  await plain.call("/auth/webmail/login", {
    email: "plain@tenant.example",
    password,
  });
  assert.equal((await plain.call("/client/manage/accounts")).status, 403);
  const domains = await owner.call("/client/manage/domains");
  assert.equal(domains.status, 200);
  assert.deepEqual(
    domains.data.items.map((row) => row.name),
    ["tenant.example"],
  );
  for (const route of [
    "/admin/managers",
    "/admin/permission-catalog",
    "/admin/system",
    "/admin/license",
    "/admin/manage/accounts",
  ])
    assert.equal((await owner.call("/client" + route)).status, 403, route);
  assert.equal((await owner.call("/admin/manage/accounts")).status, 401);
  assert.equal((await owner.call("/manage/accounts")).status, 401);
  for (const domain of ["control.example", "other.example"])
    assert.equal(
      (
        await owner.call("/client/manage/accounts", {
          email: `unauthorized@${domain}`,
          password,
        })
      ).status,
      403,
    );
  const before = db.prepare("SELECT count(*) n FROM users").get().n;
  assert.equal(
    (
      await owner.call("/client/manage/accounts/batch", {
        entries: [
          { email: "batch@tenant.example", password },
          { email: "batch@other.example", password },
        ],
      })
    ).status,
    403,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM users").get().n, before);
  assert.equal(
    (
      await admin.call(
        `/admin/manage/domains/${tenant.id}`,
        { mailboxLimit: 2 },
        "PATCH",
      )
    ).status,
    200,
  );
  const created = await owner.call("/client/manage/accounts", {
    email: "new@tenant.example",
    password,
    role: "admin",
    client_manager: 1,
    scope: "global",
  });
  assert.equal(created.status, 201);
  const account = db
    .prepare("SELECT * FROM users WHERE email=?")
    .get("new@tenant.example");
  assert.equal(account.role, "user");
  assert.equal(account.client_manager, 0);
  const quota = await owner.call("/client/manage/accounts", {
    email: "overflow@tenant.example",
    password,
  });
  assert.equal(quota.status, 409);
  assert.equal(quota.data.code, "DOMAIN_MAILBOX_LIMIT");
  assert.equal(
    (
      await owner.call(
        `/client/manage/domains/${tenant.id}`,
        { mailboxLimit: 999 },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.call(
        `/client/manage/domains/${other.id}`,
        { enabled: false },
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.call("/client/manage/accounts/delete", {
        ids: [account.id],
        confirm: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await owner.call("/client/manage/accounts", {
        email: "replacement@tenant.example",
        password,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await admin.call(
        `/admin/managers/${ownerId}`,
        {
          rolePreset: "custom",
          capabilities: ["domains.read"],
          permissions: [],
        },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal((await owner.call("/client/manage/domains")).status, 401);
  await owner.call("/auth/webmail/login", {
    email: "owner@control.example",
    password,
  });
  assert.deepEqual((await owner.call("/client/manage/domains")).data.items, []);
  assert.equal((await owner.call("/client/manage/accounts")).status, 403);
});

test("domain clients cannot take over other clients or administrators through mailbox, mail or forward APIs", async (t) => {
  const { service, db, admin, owner, tenant, grants } = await fixture(t);
  for (const [email, scope] of [
    ["boss@tenant.example", "global"],
    ["neighbor@tenant.example", "client"],
  ])
    assert.equal(
      (
        await admin.call("/admin/managers", {
          email,
          password,
          scope,
          permissions: grants,
        })
      ).status,
      201,
    );
  const messages = [];
  for (const email of [
    "boss@tenant.example",
    "neighbor@tenant.example",
    "foreign@other.example",
    "plain@tenant.example",
  ]) {
    const user = service.mail.localUser(email);
    const sent = await service.mail.send(user, {
      to: "owner@control.example",
      subject: email,
      text: "private",
      attachments: [
        {
          filename: "private.txt",
          content: Buffer.from("private attachment").toString("base64"),
        },
      ],
    });
    messages.push({
      user,
      sent,
      attachment: db
        .prepare("SELECT id FROM attachments WHERE message_id=?")
        .get(sent.id),
    });
  }
  const list = await owner.call("/client/manage/accounts");
  assert.deepEqual(
    list.data.items.map((row) => row.email),
    ["plain@tenant.example"],
  );
  const sentList = await owner.call("/client/manage/messages?folder=sent");
  assert.deepEqual(
    sentList.data.items.map((row) => row.from_email),
    ["plain@tenant.example"],
  );
  for (const { user, sent, attachment } of messages.slice(0, 3)) {
    for (const route of [
      `/client/manage/messages/${sent.id}`,
      `/client/manage/messages/${sent.id}/raw`,
      `/client/manage/attachments/${attachment.id}`,
    ])
      assert.equal((await owner.call(route)).status, 403, route);
    assert.equal(
      (
        await owner.call(
          `/client/manage/accounts/${user.id}`,
          { name: "hijacked", password: "Different-password-2026" },
          "PATCH",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await owner.call("/client/manage/accounts/passwords", {
          emails: user.email,
          password: "Different-password-2026",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await owner.call("/client/manage/accounts/delete", {
          ids: [user.id],
          confirm: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await owner.call("/client/manage/send", {
          from: user.email,
          to: "plain@tenant.example",
          subject: "forged",
          text: "not allowed",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await owner.call("/client/manage/forwards", {
          email: user.email,
          target: "plain@tenant.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await owner.call("/client/manage/forwards/batch", {
          emails: ["plain@tenant.example", user.email],
          target: "owner@control.example",
        })
      ).status,
      403,
    );
  }
  assert.equal(db.prepare("SELECT count(*) n FROM forwards").get().n, 0);
  const own = messages.at(-1);
  assert.equal(
    (await owner.call(`/client/manage/messages/${own.sent.id}`)).status,
    200,
  );
  assert.equal(
    (await owner.call(`/client/manage/attachments/${own.attachment.id}`))
      .status,
    200,
  );
  assert.equal(
    (
      await owner.call("/client/manage/send", {
        from: own.user.email,
        to: "owner@control.example",
        subject: "authorized",
        text: "sent",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await owner.call("/client/manage/forwards", {
        email: own.user.email,
        target: "owner@control.example",
      })
    ).status,
    201,
  );
  assert.equal(
    (await owner.call("/client/manage/forwards")).data.items.length,
    1,
  );
});

test("revoking client mail capabilities blocks both personal routes and SMTP sending", async (t) => {
  const { service, admin, owner, ownerId, grants } = await fixture(t);
  assert.equal(
    (
      await admin.call(
        `/admin/managers/${ownerId}`,
        {
          rolePreset: "custom",
          capabilities: ["domains.read"],
          permissions: grants,
        },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal((await owner.call("/client/auth/me")).status, 401);
  await owner.call("/auth/webmail/login", {
    email: "owner@control.example",
    password,
  });
  assert.equal((await owner.call("/client/messages")).status, 403);
  assert.equal(
    (
      await owner.call("/client/send", {
        to: "plain@tenant.example",
        subject: "denied",
        text: "denied",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.call("/client/manage/send", {
        from: "plain@tenant.example",
        to: "owner@control.example",
        subject: "denied",
        text: "denied",
      })
    ).status,
    403,
  );
  const smtp = nodemailer.createTransport({
    host: "127.0.0.1",
    port: service.ports.submission,
    secure: false,
    ignoreTLS: true,
    auth: { user: "owner@control.example", pass: password },
  });
  t.after(() => smtp.close());
  await assert.rejects(
    smtp.sendMail({
      from: "owner@control.example",
      to: "plain@tenant.example",
      subject: "denied",
      text: "denied",
    }),
    /permission|权限|not allowed|denied/i,
  );
  assert.equal((await admin.call("/admin/permission-catalog")).status, 200);
  assert.equal((await admin.call("/admin/manage/accounts")).status, 200);
});

test("an in-flight password change cannot undo an administrator password reset or revoked session", async (t) => {
  const { db, owner, ownerId } = await fixture(t);
  const resetHash = await hashPassword("Administrator-reset-password-2026");
  const originalPrepare = db.prepare;
  let scheduled = false,
    resetApplied = false;
  db.prepare = function (sql) {
    if (
      !scheduled &&
      sql.includes("SELECT * FROM sessions WHERE token_hash=?")
    ) {
      scheduled = true;
      // The request has its old session/password snapshot; emulate an administrator
      // resetting the mailbox while scrypt yields to the event loop.
      setImmediate(() => {
        originalPrepare
          .call(db, "UPDATE users SET password_hash=? WHERE id=?")
          .run(resetHash, ownerId);
        originalPrepare
          .call(db, "DELETE FROM sessions WHERE user_id=?")
          .run(ownerId);
        resetApplied = true;
      });
    }
    return originalPrepare.call(db, sql);
  };
  try {
    const response = await owner.call("/client/auth/password", {
      currentPassword: password,
      password: "Old-session-new-password-2026",
    });
    assert(resetApplied);
    assert([401, 403, 409].includes(response.status), JSON.stringify(response));
    assert.equal(
      originalPrepare
        .call(db, "SELECT password_hash FROM users WHERE id=?")
        .get(ownerId).password_hash,
      resetHash,
    );
    assert.equal(
      originalPrepare
        .call(db, "SELECT count(*) n FROM sessions WHERE user_id=?")
        .get(ownerId).n,
      0,
    );
  } finally {
    db.prepare = originalPrepare;
  }
});
