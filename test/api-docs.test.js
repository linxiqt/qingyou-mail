import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Resolver } from "node:dns/promises";
import { start } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createQingyouClient } from "../docs/api/examples/qingyou-tools.mjs";

const document = JSON.parse(
  await readFile(new URL("../docs/api/openapi.json", import.meta.url), "utf8"),
);
const operations = new Map(
  Object.entries(document.paths).flatMap(([route, methods]) =>
    Object.entries(methods).map(([method, op]) => [
      op.operationId,
      { route, method: method.toUpperCase(), ...op },
    ]),
  ),
);

test("OpenAPI operation set matches the existing Bearer surface and compact import", async () => {
  const source = await readFile(
    new URL("../src/management.js", import.meta.url),
    "utf8",
  );
  const actual = [
    ...source.matchAll(
      /adminRouter\.(get|post|put|patch|delete)\("(\/manage\/(?:accounts|domains|forwards|messages|attachments|send|bulk-send)(?:[/:][^"]*)?)"/g,
    ),
  ].map(
    ([, method, route]) =>
      `${method.toUpperCase()} /api/v1${route.replace(/:id/g, "{id}")}`,
  );
  actual.push("POST /api/v1/send", "GET /api/v1/messages", "GET /api/v1/codes");
  assert.deepEqual(
    [...operations.values()].map((op) => `${op.method} ${op.route}`).sort(),
    actual.sort(),
  );
  assert.equal(operations.size, 31);
  const compact = JSON.parse(
    await readFile(
      new URL("../docs/api/openapi-mail.json", import.meta.url),
      "utf8",
    ),
  );
  const compactOps = Object.values(compact.paths).flatMap(Object.values);
  assert.equal(compactOps.length, 8);
  for (const op of compactOps)
    assert.equal(op.description, operations.get(op.operationId).description);
  assert.deepEqual(document.security, [{ bearerAuth: [] }]);
});

test("AI example keeps credentials out of tool definitions, limits routes and requires host approval", async () => {
  const key = "po_test_only_key";
  const requests = [];
  const client = createQingyouClient({
    baseUrl: "https://mail.example.com:8443",
    apiKey: key,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ id: 7 }, { status: 201 });
    },
  });
  const definitions = JSON.stringify(client.describeTools());
  assert(!definitions.includes(key));
  assert(!definitions.includes("approvedByUser"));
  await assert.rejects(
    client.invoke("createDomain", { body: { name: "example.com" } }),
    /not allowed/,
  );
  await assert.rejects(
    client.invoke("listMail", {
      query: { email: "a@example.com" },
      url: "https://other.example",
    }),
    /unknown field/,
  );
  await assert.rejects(
    client.invoke("getMail", { path: { id: "../accounts" } }),
    /invalid number/,
  );
  await assert.rejects(
    client.invoke("sendMail", {
      body: { to: ["b@example.com"], text: "hello" },
    }),
    /WRITE_APPROVAL_REQUIRED/,
  );
  await assert.rejects(
    client.invoke("sendMail", {
      body: { to: ["b@example.com"] },
      approvedByUser: true,
    }),
    /unknown field/,
  );
  assert.equal(requests.length, 0);
  await client.invoke(
    "sendMail",
    { body: { from: "a@example.com", to: ["b@example.com"], text: "hello" } },
    { approvedByUser: true },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://mail.example.com:8443/api/v1/send");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${key}`);
  assert.equal(requests[0].init.redirect, "error");
  assert.throws(
    () =>
      createQingyouClient({
        baseUrl: "http://remote.example",
        apiKey: key,
        allowLocalHttp: true,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createQingyouClient({ baseUrl: "https://mail.example/api", apiKey: key }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createQingyouClient({
        baseUrl: "https://user:password@mail.example",
        apiKey: key,
      }),
    /HTTPS/,
  );
  let calls = 0;
  const failing = createQingyouClient({
    baseUrl: "https://mail.example",
    apiKey: key,
    fetchImpl: async () => {
      calls++;
      throw new Error("Connection lost");
    },
  });
  await assert.rejects(
    failing.invoke(
      "sendMail",
      { body: { to: ["a@example.com"] } },
      { approvedByUser: true },
    ),
    (error) => error.outcomeUncertain === true,
  );
  assert.equal(calls, 1, "never retries a possibly committed write");
});

test("all 31 documented operations work with Bearer keys against an isolated real server", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-api-docs-"));
  const service = await start({
    ...loadConfig({}),
    host: "127.0.0.1",
    port: 0,
    smtpPort: 0,
    submissionPort: 0,
    dataDir: dir,
    outboundMode: "local",
    dnsDohFallback: false,
    mailHostname: "mail.agent.example",
  });
  t.after(async () => {
    await service.close();
    const absolute = path.resolve(dir);
    assert.equal(
      path.dirname(absolute).toLowerCase(),
      path.resolve(os.tmpdir()).toLowerCase(),
    );
    assert(path.basename(absolute).startsWith("postoffice-api-docs-"));
    await rm(absolute, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${service.ports.http}`;
  const setup = await fetch(baseUrl + "/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      domain: "agent.example",
      email: "admin@agent.example",
      password: "Documentation-test-only-2026",
    }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const csrf = (await setup.json()).csrfToken;
  async function key(scopes, policy = {}) {
    const r = await fetch(baseUrl + "/api/admin/api-keys", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Documentation test", scopes, policy }),
    });
    assert.equal(r.status, 201);
    return (await r.json()).token;
  }
  const management = await key(["management"]);
  const readKey = await key(["mail:read"]);
  const sendKey = await key(["mail:send"], {
    allowedSenders: ["alice@agent.example"],
    allowedRecipientDomains: ["agent.example"],
    dailyLimit: 1,
  });
  const codesKey = await key(["codes:read"]);
  const cases = [];
  async function call(name, args = {}, apiKey = management, expected = 200) {
    const op = operations.get(name);
    assert(op, name);
    const url = new URL(
      op.route.replace(/\{([^}]+)\}/g, (_, p) =>
        encodeURIComponent(String(args.path[p])),
      ),
      baseUrl,
    );
    for (const [k, v] of Object.entries(args.query || {}))
      url.searchParams.set(k, String(v));
    const r = await fetch(url, {
      method: op.method,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(args.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    });
    const type = r.headers.get("content-type")?.split(";")[0];
    const value = type === "application/json" ? await r.json() : await r.text();
    assert.equal(r.status, expected, `${name}: ${JSON.stringify(value)}`);
    cases.push({
      operationId: name,
      args,
      status: r.status,
      contentType: type,
      response: value,
    });
    return value;
  }

  await call("listMail", {}, "", 401);
  await call("listMail", {}, management, 403);
  await call("getMail", { path: { id: 1 } }, readKey, 403);
  const ipKey = await key(["mail:read"], { ipAllowlist: "192.0.2.10" });
  await call("listMail", {}, ipKey, 403);
  await call("listDomains");
  await call(
    "createAccount",
    { body: { email: "alice@agent.example", name: "Alice", quotaMB: 10 } },
    management,
    201,
  );
  await call(
    "createAccount",
    { body: { email: "bob@agent.example" } },
    management,
    201,
  );
  await call(
    "createAccount",
    { body: { email: "bob@agent.example" } },
    management,
    409,
  );
  const generated = await call(
    "createAccounts",
    {
      body: {
        entries: [
          { email: "one@agent.example" },
          { email: "two@agent.example" },
        ],
      },
    },
    management,
    201,
  );
  assert.equal(generated.items.length, 2);
  await call(
    "createAccounts",
    {
      body: {
        domain: "agent.example",
        count: 1,
        randomUsername: false,
        prefix: "generated",
        randomPassword: true,
      },
    },
    management,
    201,
  );
  const accounts = await call("listAccounts", {
    query: { domain: "agent.example", page: 1, limit: 30 },
  });
  const accountId = (email) => accounts.items.find((a) => a.email === email).id;
  await call("updateAccount", {
    path: { id: accountId("alice@agent.example") },
    body: {
      name: "Alice API",
      note: "Docs fixture",
      quotaMB: 20,
      active: true,
    },
  });
  await call("resetPasswords", {
    body: { emails: ["two@agent.example"], length: 18 },
  });

  await call(
    "sendMail",
    {
      body: {
        from: "bob@agent.example",
        to: ["alice@agent.example"],
        text: "denied sender",
      },
    },
    sendKey,
    403,
  );
  const sent = await call(
    "sendMail",
    {
      body: {
        from: "alice@agent.example",
        to: ["bob@agent.example"],
        subject: "API contract fixture",
        text: "验证码 654321",
        attachments: [{ filename: "note.txt", content: "SGVsbG8=" }],
      },
    },
    sendKey,
    201,
  );
  const page = await call(
    "listMail",
    {
      query: {
        email: "bob@agent.example",
        folder: "inbox",
        page: 1,
        limit: 10,
        q: "API contract",
        unread: "1",
      },
    },
    readKey,
  );
  assert.equal(page.items.length, 1);
  assert(!("body_text" in page.items[0]));
  const messageId = page.items[0].id;
  assert.notEqual(sent.id, messageId);
  const detail = await call("getMail", { path: { id: messageId } });
  assert.match(detail.body_text, /654321/);
  assert.equal(detail.is_read, 0);
  assert(!("raw" in detail));
  assert.equal(
    (
      await call(
        "listMail",
        { query: { email: "bob@agent.example", unread: "1" } },
        readKey,
      )
    ).total,
    1,
  );
  assert.equal(
    await call("downloadAttachment", {
      path: { id: detail.attachments[0].id },
    }),
    "Hello",
  );
  assert.match(
    await call("downloadMail", { path: { id: messageId } }),
    /MIME-Version:/,
  );
  await call("listManagedMail", {
    query: {
      emails: "alice@agent.example,bob@agent.example",
      folder: "inbox",
      page: 1,
      limit: 10,
    },
  });
  const codeResults = await call(
    "listCodes",
    { query: { email: "bob@agent.example" } },
    codesKey,
  );
  assert.equal(codeResults.items[0].code, "654321");
  await call("updateMail", {
    path: { id: messageId },
    body: { read: true, starred: true },
  });
  assert.equal(
    (
      await call(
        "listMail",
        { query: { email: "bob@agent.example", folder: "starred" } },
        readKey,
      )
    ).total,
    1,
  );
  await call("batchUpdateMail", {
    body: { ids: [messageId], action: "archive" },
  });
  await call("updateMail", {
    path: { id: messageId },
    body: { folder: "trash" },
  });
  await call("restoreMail", { path: { id: messageId } });
  assert.equal(
    (await call("getMail", { path: { id: messageId } })).folder,
    "archive",
  );
  await call(
    "deleteMailPermanently",
    { path: { id: messageId } },
    management,
    400,
  );
  await call("updateMail", {
    path: { id: messageId },
    body: { folder: "trash" },
  });
  await call("deleteMailPermanently", { path: { id: messageId } });
  await call("getMail", { path: { id: messageId } }, management, 404);
  await call(
    "sendMail",
    {
      body: {
        from: "alice@agent.example",
        to: ["bob@agent.example"],
        text: "quota denied",
      },
    },
    sendKey,
    429,
  );
  await call(
    "sendManagedMail",
    {
      body: {
        from: "alice@agent.example",
        to: ["bob@agent.example"],
        text: "local management fixture",
      },
    },
    management,
    201,
  );
  const bulk = await call("sendBulkMail", {
    body: {
      from: "alice@agent.example",
      recipients: ["bob@agent.example", "missing@agent.example"],
      subject: "bulk fixture",
      text: "local only",
    },
  });
  assert.deepEqual(
    bulk.items.map((item) => item.ok),
    [true, false],
  );

  const domain = await call(
    "createDomain",
    { body: { name: "managed.example", mailboxLimit: 5 } },
    management,
    201,
  );
  await call(
    "createAccount",
    { body: { email: "sink@managed.example" } },
    management,
    201,
  );
  await call(
    "updateDomain",
    { path: { id: domain.id }, body: { mailboxLimit: 0 } },
    management,
    409,
  );
  await call("updateDomain", {
    path: { id: domain.id },
    body: { mailboxLimit: 3, enabled: true },
  });
  const dnsOptions = { hostname: "mail.managed.example", ip: "203.0.113.44" };
  const plan = await call("getDomainDns", {
    path: { id: domain.id },
    query: dnsOptions,
  });
  for (const [method, type] of [
    ["resolve4", "A"],
    ["resolve6", "AAAA"],
    ["resolveMx", "MX"],
    ["resolveTxt", "TXT"],
  ]) {
    t.mock.method(Resolver.prototype, method, async (name) =>
      plan.records
        .filter((r) => r.type === type && r.name === name)
        .map((r) =>
          type === "TXT"
            ? [r.value]
            : type === "MX"
              ? { exchange: r.value + ".", priority: r.priority }
              : r.value,
        ),
    );
  }
  const checked = await call("checkDomainDns", {
    path: { id: domain.id },
    body: dnsOptions,
  });
  assert(checked.items.every((r) => r.status === "passed"));
  await call("setDomainCatchall", {
    path: { id: domain.id },
    body: { enabled: true, email: "sink@managed.example" },
  });
  await call(
    "createForward",
    {
      body: {
        email: "*@managed.example",
        target: "alice@agent.example",
        enabled: true,
      },
    },
    management,
    201,
  );
  await call(
    "createForward",
    {
      body: {
        email: "alice@agent.example",
        target: "bob@agent.example",
        keepCopy: true,
      },
    },
    management,
    201,
  );
  await call(
    "createForwards",
    {
      body: {
        emails: ["one@agent.example", "two@agent.example"],
        target: "bob@agent.example",
        keepCopy: false,
      },
    },
    management,
    201,
  );
  const forwards = await call("listForwards");
  assert(forwards.items.some((f) => f.id === `catchall:${domain.id}`));
  await call("updateForward", {
    path: { id: `catchall:${domain.id}` },
    body: { target: "bob@agent.example" },
  });
  await call("deleteForwards", {
    body: { ids: forwards.items.map((f) => f.id) },
  });
  await call(
    "deleteDomain",
    { path: { id: domain.id }, body: {} },
    management,
    400,
  );
  await call("deleteDomain", {
    path: { id: domain.id },
    body: { cascade: true, confirmDomain: "managed.example" },
  });
  await call("deleteAccounts", {
    body: {
      ids: [accountId("one@agent.example"), accountId("two@agent.example")],
      confirm: true,
    },
  });

  const client = createQingyouClient({
    baseUrl,
    apiKey: readKey,
    allowLocalHttp: true,
    allowedOperations: ["listMail"],
  });
  const viaExample = await client.invoke("listMail", {
    query: { email: "alice@agent.example", folder: "sent", limit: 10 },
  });
  assert(
    viaExample.items.some(
      (m) => m.id === sent.id && m.delivery_status === "delivered",
    ),
  );
  assert.equal(
    new Set(cases.filter((c) => c.status < 300).map((c) => c.operationId)).size,
    31,
  );
  const output = new URL(
    "../test-results/api-docs-contract-cases.json",
    import.meta.url,
  );
  await mkdir(new URL("../test-results/", import.meta.url), {
    recursive: true,
  });
  await writeFile(output, JSON.stringify(cases, null, 2));
  t.diagnostic(
    `${cases.length} HTTP exchanges recorded; all 31 operation successes covered. DNS mocked, mail local only.`,
  );
});
