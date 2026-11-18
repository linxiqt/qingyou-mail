import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { mapLimit } from "../src/async-pool.js";

test("bounded jobs preserve order and settle running work before returning an error", async () => {
  let active = 0,
    peak = 0;
  const output = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--;
    return n * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(output, [2, 4, 6, 8, 10, 12]);
  let finished = false,
    scheduled = 0;
  await assert.rejects(
    mapLimit([0, 1, 2, 3], 2, async (n) => {
      scheduled++;
      if (n === 0) throw new Error("stop");
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
    }),
    /stop/,
  );
  assert.equal(scheduled, 2);
  assert.equal(finished, true);
});

test("browser coalesces simultaneous reads, isolates results and invalidates on writes", async () => {
  const source = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  let requests = [];
  const sandbox = {
    state: { user: { id: 1 }, csrf: "token" },
    mailboxClient: true,
    isAdmin: () => false,
    fetch: (url, options) =>
      new Promise((resolve) => requests.push({ url, options, resolve })),
  };
  runInNewContext(
    source.slice(
      source.indexOf("const apiPath ="),
      source.indexOf("function toast("),
    ),
    sandbox,
  );
  const first = sandbox.api("/mailbox");
  const second = sandbox.api("/mailbox");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/client/mailbox");
  requests[0].resolve({ ok: true, json: async () => ({ counts: [1] }) });
  const [a, b] = await Promise.all([first, second]);
  a.counts.push(2);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), { counts: [1] });
  const stale = sandbox.api("/mailbox");
  const write = sandbox.api("/send", {
    method: "POST",
    body: { text: "hello" },
  });
  const fresh = sandbox.api("/mailbox");
  assert.equal(requests.length, 4);
  assert.equal(requests[2].options.headers["X-CSRF-Token"], "token");
  for (const req of requests.slice(1))
    req.resolve({ ok: true, json: async () => ({ ok: true }) });
  await Promise.all([stale, write, fresh]);
  const fail = sandbox.api("/mailbox");
  requests.at(-1).resolve({
    ok: false,
    status: 403,
    json: async () => ({ error: "denied" }),
  });
  await assert.rejects(fail, /denied/);
  const retry = sandbox.api("/mailbox");
  assert.equal(requests.length, 6);
  requests.at(-1).resolve({ ok: true, json: async () => ({ ok: true }) });
  await retry;
});
