import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { start } from "../src/server.js";

test("fresh installations authenticate without activation or license state on disk", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "qingyou-no-activation-"));
  const service = await start({ dataDir, port: 0, smtpPort: 0, submissionPort: 0, outboundMode: "local" });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + service.ports.http + "/api";
  assert.equal((await fetch(base + "/admin/overview")).status, 401);
  const response = await fetch(base + "/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Isolated-test-only-123" }),
  });
  assert.equal(response.status, 201);
  const headers = { Cookie: response.headers.get("set-cookie").split(";")[0] };
  const session = await (await fetch(base + "/auth/me", { headers })).json();
  assert.equal(session.license.required, false);
  assert.equal(session.license.valid, true);
  assert.equal((await fetch(base + "/admin/overview", { headers })).status, 200);
  assert.equal((await readdir(dataDir)).includes("license"), false);
});
