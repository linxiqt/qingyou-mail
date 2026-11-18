import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { dnsPlan, checkDnsPlan } from "../src/dns.js";

test("DNS dialog verifies the edited mail IP and shows expected and published SPF together", async () => {
  const config = {
    production: true,
    publicUrl: "https://210.16.166.94:37456",
    mailHostname: "mail.yilx.cloud",
  };
  const fields = {
    hostname: { value: "mail.yilx.cloud" },
    ip: { value: "210.16.166.94" },
  };
  const output = { isConnected: true, innerHTML: "", textContent: "" };
  let dialog, checked;
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const w = {
    pages: {},
    actions: {},
    forms: {},
    remote: () => false,
    isGlobal: () => false,
    can: (capability) => capability === "domains.read",
    resource: async () => ({
      items: [{ id: 2, name: "yilx.cloud", enabled: true }],
    }),
    e: escape,
    $: (selector) =>
      selector === "[data-dns-result]"
        ? output
        : fields[selector.match(/^\[name=(.+)\]$/)?.[1]],
    button: (label) => escape(label),
    input: (name, label, value) =>
      `${escape(label)}<input name="${name}" value="${escape(value)}">`,
    title: () => "",
    note: escape,
    status: () => "",
    table: (headers, rows) => `${headers.join(" | ")}\n${rows.join("\n")}`,
    dialog: (...args) => {
      dialog = args;
    },
    h: {
      async api(url, options) {
        if (url.endsWith("/dns/check")) {
          checked = JSON.parse(JSON.stringify(options.body));
          const plan = dnsPlan("yilx.cloud", config, checked);
          return checkDnsPlan(
            { records: plan.records.filter((r) => r.key === "spf") },
            { resolveTxt: async () => [["v=spf1 ip4:210.16.166.94 ~all"]] },
          );
        }
        const query = new URL(url, "https://example.test").searchParams;
        return dnsPlan("yilx.cloud", config, Object.fromEntries(query));
      },
    },
  };
  runInNewContext(
    await readFile(new URL("../public/mail-tools.js", import.meta.url), "utf8"),
    {
      MailWorkspace: w,
      URLSearchParams,
      document: { addEventListener() {} },
    },
  );
  await w.pages.domains();
  await w.actions["domain-dns"]({ dataset: { id: "2" } });
  assert.match(dialog[1], /公网 IP 已从网页入口自动带入/);
  assert.match(dialog[1], /210\.16\.166\.94/);
  const node = { dataset: { id: "2" }, disabled: false };
  await w.actions["verify-dns"](node);
  assert.equal(checked.ip, "210.16.166.94");
  assert.match(output.innerHTML, /已生效/);
  fields.ip.value = "198.51.100.10";
  await w.actions["verify-dns"](node);
  assert.equal(checked.ip, "198.51.100.10");
  assert.match(output.innerHTML, /本次建议值/);
  assert.match(output.innerHTML, /v=spf1 ip4:198\.51\.100\.10 ~all/);
  assert.match(output.innerHTML, /v=spf1 ip4:210\.16\.166\.94 ~all/);
  assert.match(output.innerHTML, /记录不匹配/);
  assert.equal(node.disabled, false);
  await dialog[2]({ hostname: fields.hostname.value, ip: fields.ip.value });
  assert.match(dialog[1], /198\.51\.100\.10/);
});
