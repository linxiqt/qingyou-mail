import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLicense,
  licensed,
  connected,
  canRecoverLicense,
} from "../server-access.js";

test("sending requires a verified connection and explicit valid server license", () => {
  const a = {
    connection: "connected",
    license: normalizeLicense({
      required: true,
      valid: true,
      expiresAt: null,
      mode: "online",
    }),
  };
  assert.equal(licensed(a), true);
  assert.equal(licensed({ ...a, license: normalizeLicense({ required: false, valid: true }) }), true);
  for (const license of [
    undefined,
    {},
    { required: false, valid: false },
    { required: "true", valid: true, expiresAt: null },
    { required: true, valid: true },
    { required: true, valid: false, expiresAt: null },
    { required: true, valid: true, expiresAt: 1 },
    { required: true, valid: true, expiresAt: "9999999999" },
  ])
    assert.equal(licensed({ ...a, license: normalizeLicense(license) }), false);
  for (const connection of [undefined, "checking", "error", "expired"])
    assert.equal(licensed({ ...a, connection }), false);
  assert.equal(licensed({ ...a, authExpired: true }), false);
  assert.equal(
    licensed({ ...a, license: { ...a.license, expiresAt: 2000 } }, 2000000),
    false,
  );
  assert.equal(
    licensed({ ...a, license: { ...a.license, expiresAt: 2001 } }, 2000000),
    true,
  );
});
test("license summaries discard secrets and each server keeps independent authorization", () => {
  const good = normalizeLicense({
    required: true,
    valid: true,
    expiresAt: null,
    mode: "online",
    license_key: "secret",
    deviceId: "private",
  });
  assert.equal("license_key" in good, false);
  assert.equal("deviceId" in good, false);
  const first = { connection: "connected", license: good },
    second = {
      connection: "connected",
      license: normalizeLicense({
        required: true,
        valid: false,
        expiresAt: null,
      }),
    };
  assert.equal(licensed(first), true);
  assert.equal(licensed(second), false);
  assert.equal(connected(second), true);
});
test("only a currently verified global admin receives recovery entry", () => {
  const admin = {
    connection: "connected",
    portal: "admin",
    user: { role: "admin", admin_scope: "global" },
  };
  assert.equal(canRecoverLicense(admin), true);
  assert.equal(canRecoverLicense({ ...admin, portal: "client" }), false);
  assert.equal(
    canRecoverLicense({
      ...admin,
      user: { role: "admin", admin_scope: "scoped" },
    }),
    false,
  );
  assert.equal(canRecoverLicense({ ...admin, connection: "error" }), false);
});
