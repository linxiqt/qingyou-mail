import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssetHandler } from "../src/static-assets.js";
import { openStore } from "../src/db.js";
import { messageColumns } from "../src/message-columns.js";

test("public assets negotiate precompressed representations, revalidate, and never cache private paths", async (t) => {
  const app = express();
  app.use(await createAssetHandler(new URL("../public", import.meta.url)));
  app.use((_req, res) => res.status(404).end());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const get = (url, encoding, etag, method = "GET") =>
    new Promise((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: url,
            method,
            headers: {
              "Accept-Encoding": encoding,
              ...(etag ? { "If-None-Match": etag } : {}),
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (x) => chunks.push(x));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                data: Buffer.concat(chunks),
              }),
            );
          },
        )
        .on("error", reject);
    });
  const original = await readFile(new URL("../public/app.js", import.meta.url));
  const br = await get("/app.js?v=client", "br");
  assert.equal(br.status, 200);
  assert.equal(br.headers["content-encoding"], "br");
  assert.deepEqual(brotliDecompressSync(br.data), original);
  assert.ok(br.data.length < original.length * 0.5);
  assert.equal((await get("/app.js", "br", br.headers.etag)).status, 304);
  const gz = await get("/app.js", "gzip");
  assert.deepEqual(gunzipSync(gz.data), original);
  assert.notEqual(gz.headers.etag, br.headers.etag);
  assert.equal(
    (await get("/app.js", "br;q=0, gzip;q=0, identity;q=1")).headers[
      "content-encoding"
    ],
    undefined,
  );
  assert.equal(
    (await get("/app.js", "br;q=0, gzip;q=0, identity;q=0")).status,
    406,
  );
  assert.equal((await get("/app.js", "br", null, "HEAD")).data.length, 0);
  for (const url of [
    "/api/messages",
    "/.env",
    "/../src/config.js",
    "/index.html",
  ])
    assert.equal((await get(url, "br")).status, 404);
});

test("mailbox counts use covering index and regular message reads exclude MIME blobs", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "postoffice-load-"));
  const store = openStore({ dataDir: dir });
  t.after(async () => {
    store.db.close();
    assert.ok(path.basename(dir).startsWith("postoffice-load-"));
    await rm(dir, { recursive: true, force: true });
  });
  const plan = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT folder,count(*),sum(CASE WHEN is_read=0 THEN 1 ELSE 0 END) FROM messages WHERE owner_id=? GROUP BY folder",
    )
    .all(1);
  assert.match(
    plan.map((x) => x.detail).join(" "),
    /COVERING INDEX message_mailbox_counts/,
  );
  assert.ok(!messageColumns().split(",").includes("raw"));
  assert.ok(!messageColumns("m.").split(",").includes("m.raw"));
});
