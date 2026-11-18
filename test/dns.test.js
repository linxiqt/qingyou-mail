import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, sign, verify } from "node:crypto";
import { dnsPlan, checkDnsPlan } from "../src/dns.js";
import { generateDomainKey } from "../src/domain-keys.js";
import { dnsJsonAnswers, createDnsResolver } from "../src/dns-resolver.js";

test("HTTPS DNS fallback parses TXT chunks and MX and keeps authoritative missing results", async () => {
  const data = {
    Status: 0,
    Answer: [
      { type: 16, data: '"v=DKIM1; p=abc""DEF="' },
      { type: 15, data: "10 mail.sample.example." },
    ],
  };
  assert.deepEqual(dnsJsonAnswers(data, "TXT"), [["v=DKIM1; p=abc", "DEF="]]);
  assert.deepEqual(dnsJsonAnswers(data, "MX"), [
    { priority: 10, exchange: "mail.sample.example." },
  ]);
  assert.throws(() => dnsJsonAnswers({ Status: 3 }, "MX"), {
    code: "ENOTFOUND",
  });
  let queries = 0;
  const native = {
    resolveTxt: async () => {
      throw Object.assign(new Error(), { code: "ETIMEOUT" });
    },
    resolveMx: async () => {
      throw Object.assign(new Error(), { code: "ENODATA" });
    },
  };
  const resolver = createDnsResolver({}, native, async (url) => {
    queries++;
    assert.equal(url.searchParams.get("type"), "TXT");
    return { ok: true, json: async () => data };
  });
  assert.deepEqual(await resolver.resolveTxt("sample.example"), [
    ["v=DKIM1; p=abc", "DEF="],
  ]);
  assert(resolver.fallbackUsed);
  await assert.rejects(resolver.resolveMx("sample.example"), {
    code: "ENODATA",
  });
  assert.equal(queries, 1);
});

const config = {
  mailHostname: "mail.example.com",
  production: false,
  relay: null,
  tls: {},
};
test("IP-based production web origins supply missing mail IP and match the published SPF", async () => {
  const plan = dnsPlan("yilx.cloud", {
    ...config,
    production: true,
    publicUrl: "https://210.16.166.94:37456",
    mailHostname: "mail.yilx.cloud",
    mailPublicIp: "",
  });
  assert.equal(plan.ip, "210.16.166.94");
  assert.equal(plan.ipSource, "web-address");
  const spf = plan.records.find((r) => r.key === "spf");
  assert.equal(spf.value, "v=spf1 ip4:210.16.166.94 ~all");
  const result = await checkDnsPlan(
    { records: [spf] },
    { resolveTxt: async () => [["v=spf1 ip4:210.16.166.94 ~all"]] },
  );
  assert.equal(result.items[0].status, "passed");
});

test("Explicit mail addresses override the web IP, and private/development web origins are not guessed", () => {
  const production = {
    ...config,
    production: true,
    publicUrl: "https://203.0.113.25:8443",
  };
  const configured = dnsPlan("sample.example", {
    ...production,
    mailPublicIp: "198.51.100.10",
  });
  assert.equal(configured.ip, "198.51.100.10");
  assert.equal(configured.ipSource, "configuration");
  const supplied = dnsPlan(
    "sample.example",
    { ...production, mailPublicIp: "198.51.100.10" },
    { ip: "198.51.100.20" },
  );
  assert.equal(supplied.ip, "198.51.100.20");
  assert.equal(supplied.ipSource, "input");
  for (const overrides of [
    { publicUrl: "https://localhost:8443" },
    { publicUrl: "https://127.0.0.1:8443" },
    { publicUrl: "https://10.0.0.1:8443" },
    { publicUrl: "https://web.sample.example" },
    { production: false },
  ])
    assert.equal(
      dnsPlan("sample.example", { ...production, ...overrides }).ip,
      "",
    );
  const ipv6 = dnsPlan("sample.example", {
    ...production,
    publicUrl: "https://[2001:db8::25]:8443",
  });
  assert.equal(ipv6.ip, "2001:db8::25");
  assert.equal(
    ipv6.records.find((r) => r.key === "spf").value,
    "v=spf1 ip6:2001:db8::25 ~all",
  );
});

test("SPF checks tolerate TXT chunks and surrounding whitespace while retaining wrong-IP failures", async () => {
  const spf = dnsPlan("sample.example", config, {
    ip: "203.0.113.25",
  }).records.find((r) => r.key === "spf");
  const resolver = {
    resolveTxt: async () => [["  V=SPF1\t", "ip4:203.0.113.25   ~all  "]],
  };
  const result = await checkDnsPlan({ records: [spf] }, resolver);
  assert.equal(result.items[0].status, "passed");
  assert.equal(result.items[0].value, spf.value);
  const wrong = await checkDnsPlan(
    { records: [spf] },
    { resolveTxt: async () => [["v=spf1 ip4:198.51.100.10 ~all"]] },
  );
  assert.equal(wrong.items[0].status, "mismatch");
  assert.equal(wrong.items[0].value, spf.value);
  assert.deepEqual(wrong.items[0].found, ["v=spf1 ip4:198.51.100.10 ~all"]);
});

test("DNS guidance preserves a separate IP web origin while MX uses the mail hostname", () => {
  const plan = dnsPlan("sample.example", {
    ...config,
    production: true,
    mailHostname: "mail.sample.example",
    publicUrl: "https://203.0.113.25:8443",
  });
  assert(plan.env.includes("PUBLIC_URL=https://203.0.113.25:8443"));
  assert.equal(
    plan.records.find((r) => r.key === "mx").value,
    "mail.sample.example",
  );
  const development = dnsPlan("sample.example", {
    ...config,
    publicUrl: "http://localhost:3100",
  });
  assert(development.env.includes("PUBLIC_URL=https://mail.sample.example"));
});
test("DNS records use a real, independent DKIM public key and correct MX", async () => {
  const a = await generateDomainKey(),
    b = await generateDomainKey();
  assert.notEqual(a.publicKey, b.publicKey);
  const key = {
    domainName: "sample.example",
    keySelector: a.selector,
    privateKey: a.privateKey,
  };
  const p = dnsPlan("sample.example", config, { ip: "203.0.113.25" }, key);
  assert.equal(p.hostname, "mail.sample.example");
  assert.equal(
    p.records.find((r) => r.key === "mx").value,
    "mail.sample.example",
  );
  assert.equal(p.records.find((r) => r.key === "mx").priority, 10);
  assert.equal(
    p.records.find((r) => r.key === "spf").value,
    "v=spf1 ip4:203.0.113.25 ~all",
  );
  const dkim = p.records.find((r) => r.key === "dkim");
  assert.equal(dkim.host, "default._domainkey");
  const pub = createPublicKey({
    key: Buffer.from(dkim.value.split("p=")[1], "base64"),
    type: "spki",
    format: "der",
  });
  assert(
    verify(
      "sha256",
      Buffer.from("test message"),
      pub,
      sign("sha256", Buffer.from("test message"), a.privateKey),
    ),
  );
  assert(!JSON.stringify(p).includes("PRIVATE KEY"));
});
test("DNS matching joins TXT chunks, validates DMARC and compares DKIM case sensitively", async () => {
  const key = await generateDomainKey();
  const p = dnsPlan(
    "sample.example",
    config,
    { ip: "203.0.113.25" },
    {
      domainName: "sample.example",
      keySelector: "default",
      privateKey: key.privateKey,
    },
  );
  const dk = p.records.find((r) => r.key === "dkim").value;
  const txt = {
    "sample.example": [["v=spf1 ip4:203.0.113.25 ~all"]],
    "default._domainkey.sample.example": [[dk.slice(0, 100), dk.slice(100)]],
    "_dmarc.sample.example": [["v=DMARC1; p=reject"]],
  };
  const resolver = {
    resolve4: async () => ["203.0.113.25"],
    resolveMx: async () => [{ exchange: "MAIL.SAMPLE.EXAMPLE.", priority: 10 }],
    resolveTxt: async (host) => txt[host] || [],
  };
  let result = await checkDnsPlan(p, resolver);
  assert(result.items.every((r) => r.status === "passed"));
  txt["default._domainkey.sample.example"] = [
    [
      dk.replace("p=", "p=").slice(0, dk.indexOf("p=") + 2) +
        key.publicKey.toLowerCase(),
    ],
  ];
  txt["sample.example"].push(["v=spf1 -all"]);
  txt["_dmarc.sample.example"] = [["v=DMARC1; p=invalid"]];
  result = await checkDnsPlan(p, resolver);
  for (const type of ["spf", "dkim", "dmarc"])
    assert.equal(result.items.find((r) => r.key === type).status, "mismatch");
});

test("MX display omits the root dot while checks accept both forms and uppercase targets", async () => {
  const plan = dnsPlan(
    "yilx.cloud",
    { ...config, mailHostname: "mail.yilx.cloud" },
    { hostname: "MAIL.YILX.CLOUD." },
  );
  const mx = plan.records.find((r) => r.key === "mx");
  assert.equal(mx.value, "mail.yilx.cloud");
  assert.equal(mx.name, "yilx.cloud");
  for (const exchange of ["mail.yilx.cloud", "MAIL.YILX.CLOUD."]) {
    const result = await checkDnsPlan(
      { records: [mx] },
      { resolveMx: async () => [{ exchange, priority: 10 }] },
    );
    assert.equal(result.items[0].status, "passed");
  }
});

test("MX checks query the selected mailbox domain and distinguish a missing subdomain MX", async () => {
  const cfg = { ...config, mailHostname: "mail.yilx.cloud" };
  const queried = [];
  const resolver = {
    resolveMx: async (name) => {
      queried.push(name);
      return name === "yilx.cloud"
        ? [{ exchange: "mail.yilx.cloud.", priority: 10 }]
        : [];
    },
  };
  for (const [domain, expected] of [
    ["yilx.cloud", "passed"],
    ["mail.yilx.cloud", "missing"],
  ]) {
    const mx = dnsPlan(domain, cfg).records.find((r) => r.key === "mx");
    const result = await checkDnsPlan({ records: [mx] }, resolver);
    assert.equal(result.items[0].status, expected);
    assert.equal(result.items[0].name, domain);
  }
  assert.deepEqual(queried, ["yilx.cloud", "mail.yilx.cloud"]);
});
test("DNS guidance never invents a relay SPF and distinguishes resolver errors", async () => {
  const p = dnsPlan("sample.example", {
    ...config,
    relay: { host: "smtp.provider.example" },
  });
  assert.equal(p.records.find((r) => r.key === "spf").value, null);
  assert.equal(p.records.find((r) => r.key === "address").value, null);
  assert(p.warnings.some((w) => w.includes("TLS")));
  const resolver = {
    resolve4: async () => {
      throw Object.assign(new Error(), { code: "ETIMEOUT" });
    },
    resolveMx: async () => {
      throw Object.assign(new Error(), { code: "ENODATA" });
    },
    resolveTxt: async () => [],
  };
  const result = await checkDnsPlan(p, resolver);
  assert.equal(result.items.find((r) => r.key === "address").status, "error");
  assert.equal(result.items.find((r) => r.key === "mx").status, "missing");
  assert.throws(
    () => dnsPlan("sample.example", config, { ip: "not-an-ip" }),
    /IP/,
  );
});
