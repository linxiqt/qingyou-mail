import test from "node:test";
import assert from "node:assert/strict";
import {
  esc,
  parseRecipients,
  recipientsText,
  isAdmin,
  can,
  listPath,
  createRequestGate,
  aiText,
} from "../model.js";

test("account role cannot be inferred from display name or username", () => {
  assert.equal(
    isAdmin({ portal: "client", user: { username: "admin", role: "user" } }),
    false,
  );
  assert.equal(isAdmin({ portal: "client", user: { role: "admin" } }), false);
  assert.equal(isAdmin({ portal: "admin", user: { role: "admin" } }), true);
});
test("managed client privileges use explicit capabilities", () => {
  const account = {
    user: { client_manager: true, capabilities: ["mail.read"] },
  };
  assert.equal(can(account, "mail.read"), true);
  assert.equal(can(account, "mail.send"), false);
  assert.equal(can(null, "mail.read"), false);
});
test("new requests and account changes invalidate older responses", async () => {
  const gate = createRequestGate();
  const old = gate.ticket(),
    latest = gate.ticket();
  assert.equal(old(), false);
  assert.equal(latest(), true);
  gate.invalidate();
  assert.equal(latest(), false);
  const accountB = gate.ticket();
  assert.equal(accountB(), true);
});
test("unread search is encoded and constrained to a paged inbox", () => {
  const url = new URL(listPath("unread", 2, " a&b? "), "https://example.test");
  assert.equal(url.pathname, "/messages");
  assert.equal(url.searchParams.get("folder"), "inbox");
  assert.equal(url.searchParams.get("unread"), "1");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("limit"), "30");
  assert.equal(url.searchParams.get("q"), "a&b?");
});
test("untrusted mail strings are escaped and AI excludes attachments", () => {
  assert.equal(
    esc('<img src="x" onerror="alert(1)">'),
    "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;",
  );
  const text = aiText({
    subject: "Schedule",
    from_email: "test@example.test",
    body_text: "Hello",
    body_html: "SECRET HTML",
    attachments: [{ content: "SECRET ATTACHMENT" }],
  });
  assert.match(text, /Schedule/);
  assert.match(text, /Hello/);
  assert.doesNotMatch(text, /SECRET/);
});
test("recipient input accepts common separators without changing addresses", () => {
  assert.deepEqual(
    parseRecipients("a@example.test； b@example.test\nc@example.test"),
    ["a@example.test", "b@example.test", "c@example.test"],
  );
  assert.equal(
    recipientsText([{ address: "a@example.test" }, "b@example.test"]),
    "a@example.test, b@example.test",
  );
});
