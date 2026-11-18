import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { signWithRspamd } from "../src/rspamd.js";

const raw = Buffer.concat([
  Buffer.from(
    "From: admin@sender.example\r\nTo: recipient@example.net\r\nSubject: DKIM bytes\r\nContent-Type: application/octet-stream\r\n\r\n",
  ),
  Buffer.from([0, 1, 127, 128, 255, 13, 10]),
]);
const signature =
  "v=1; a=rsa-sha256; c=relaxed/relaxed; d=sender.example;\r\n\ts=default; h=from:to:subject; bh=YWJjZA==;\r\n\tb=YWJjZA==";
const message = {
  raw,
  sender: "admin@sender.example",
  recipient: "recipient@example.net",
  domain: "sender.example",
  selector: "default",
};

async function service(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    rspamdUrl: `http://127.0.0.1:${server.address().port}/checkv2`,
    rspamdTimeoutMs: 1000,
    mailHostname: "mail.sender.example",
  };
}

test("Rspamd receives authenticated envelope metadata and exact raw bytes; returned folding is preserved", async (t) => {
  const config = await service(t, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/checkv2");
    assert.equal(request.headers.user, message.sender);
    assert.equal(request.headers.from, message.sender);
    assert.equal(request.headers.rcpt, message.recipient);
    assert.equal(request.headers.ip, "127.0.0.1");
    assert.equal(request.headers.helo, "mail.sender.example");
    assert.equal(Number(request.headers["content-length"]), raw.length);
    assert.deepEqual(JSON.parse(request.headers.settings), {
      symbols_enabled: ["DKIM_SIGNED"],
    });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), raw);
    response.end(JSON.stringify({ "dkim-signature": signature }));
  });
  assert.deepEqual(
    await signWithRspamd(config, message),
    Buffer.concat([Buffer.from(`DKIM-Signature: ${signature}\r\n`), raw]),
  );
  assert.deepEqual(message.raw, raw);
});

test("Rspamd accepts a signature array, optional header prefix and LF continuation folding", async (t) => {
  const second = `DKIM-Signature: ${signature.replaceAll("\r\n", "\n")}\n`;
  const config = await service(t, (request, response) => {
    request.resume();
    response.end(JSON.stringify({ "dkim-signature": [signature, second] }));
  });
  const signed = await signWithRspamd(config, message);
  const expected = Buffer.from(`DKIM-Signature: ${signature}\r\n`);
  assert.deepEqual(signed, Buffer.concat([expected, expected, raw]));
});

test("Rspamd signing fails closed for absent, malformed, injected or mismatched signatures", async (t) => {
  let reply;
  let requests = 0;
  const config = await service(t, (request, response) => {
    requests++;
    request.resume();
    response.end(JSON.stringify(reply));
  });
  const invalidValues = [
    undefined,
    null,
    [],
    "",
    { signature },
    signature.replace("sender.example", "wrong.example"),
    signature.replace("s=default", "s=other"),
    signature.replace("v=1", "v=2"),
    signature.replace("h=from:to:subject", "h=to:subject"),
    `${signature}; s=default`,
    `${signature}\r\nBcc: victim@example.net`,
    `${signature}\n\nforged body`,
    `${signature}\rBcc: victim@example.net`,
    `${signature}\0`,
    `v=1; a=rsa-sha256; d=sender.example; s=default; h=from; bh=YWJjZA==; b=${"a".repeat(1000)}`,
  ];
  for (const value of invalidValues) {
    reply = { "dkim-signature": value };
    await assert.rejects(
      signWithRspamd(config, message),
      (error) =>
        error.responseCode === 451 &&
        /签名|选择器/.test(error.message) &&
        !/连接失败/.test(error.message),
    );
  }
  assert.equal(requests, invalidValues.length);
});

test("Rspamd HTTP, JSON, size and deadline failures remain temporary delivery errors", async (t) => {
  let scenario;
  const config = await service(t, (request, response) => {
    request.resume();
    if (scenario === "status") response.writeHead(503).end("unavailable");
    if (scenario === "json") response.end("not json");
    if (scenario === "length")
      response.writeHead(200, { "Content-Length": 300000 }).flushHeaders();
    if (scenario === "chunked") {
      response.writeHead(200, { "Transfer-Encoding": "chunked" });
      response.end("x".repeat(300000));
    }
    // Deliberately leave the timeout response open.
  });
  const expected = {
    status: /HTTP 503/,
    json: /JSON/,
    length: /响应过大/,
    chunked: /响应过大/,
    timeout: /请求超时/,
  };
  for (scenario of Object.keys(expected)) {
    await assert.rejects(
      signWithRspamd({ ...config, rspamdTimeoutMs: 80 }, message),
      (error) =>
        error.responseCode === 451 && expected[scenario].test(error.message),
    );
  }
});

test("Rspamd refuses unsafe request metadata or a remote service before sending mail bytes", async (t) => {
  let requests = 0;
  const config = await service(t, (request, response) => {
    requests++;
    request.resume();
    response.end(JSON.stringify({ "dkim-signature": signature }));
  });
  for (const invalid of [
    { sender: "admin@sender.example\r\nX-Injected: yes" },
    { recipient: "recipient@example.net\nX-Injected: yes" },
    { domain: "sender.example\r\n" },
    { selector: "default\r\n" },
    { domain: "other.example" },
    { raw: "not a buffer" },
  ])
    await assert.rejects(signWithRspamd(config, { ...message, ...invalid }), {
      responseCode: 451,
    });
  for (const rspamdUrl of [
    "http://example.net/checkv2",
    "http://127.0.0.1/checkv2?x=1",
    "http://user:pass@127.0.0.1/checkv2",
    "http://127.0.0.1/scanv2",
  ])
    await assert.rejects(signWithRspamd({ ...config, rspamdUrl }, message), {
      responseCode: 451,
    });
  assert.equal(requests, 0);
});
