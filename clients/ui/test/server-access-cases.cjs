const assert = require("node:assert/strict");
module.exports = async function ({
  cdp,
  evaluate,
  wait,
  click,
  fill,
  screenshot,
  base,
  delay,
}) {
  const checks = [];
  const blocked = {
    required: true,
    valid: false,
    mode: "blocked",
    expiresAt: null,
    reason: "程序尚未激活",
  };
  const valid = {
    required: true,
    valid: true,
    mode: "online",
    expiresAt: null,
  };
  const setLicense = (id, value) =>
    evaluate(
      `window.__fixture.licenses ||= {};window.__fixture.licenses[${JSON.stringify(id)}]=${JSON.stringify(value)}`,
    );
  const recheck = async () => {
    await click('[data-action="recheck-server"]');
    await delay(110);
  };
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const boot = await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `document.addEventListener('DOMContentLoaded',()=>{window.__fixture.accessDelay=300;window.__fixture.disconnected=true;});`,
  });
  await cdp("Page.navigate", { url: base + "/?android=1" });
  await wait(`!!document.querySelector('.server-connect-page')`);
  assert.equal(
    await evaluate(
      `!!document.querySelector('.phone-nav')||!!document.querySelector('.mailbox-tiles')`,
    ),
    false,
  );
  await wait(`!!document.querySelector('[data-action="recheck-server"]')`);
  assert.equal(
    await evaluate(`window.__fixture.requests.some(x=>x.path==='/mailbox')`),
    false,
  );
  await screenshot("license-connection-required");
  await evaluate(
    `window.__fixture.disconnected=false;window.__fixture.accessDelay=0`,
  );
  await setLicense("work", blocked);
  await recheck();
  await wait(
    `document.querySelector('[data-mailbox-count="inbox"]')?.textContent==='4'`,
  );
  await cdp("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: boot.identifier,
  });
  assert.equal(
    await evaluate(
      `document.querySelector('.phone-nav [data-action="compose"]').disabled`,
    ),
    true,
  );
  await click('.phone-nav [data-action="mobile-inbox"]');
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  await click('[data-id="m1"]');
  await wait(`!!document.querySelector('.message-body')`);
  assert.equal(
    await evaluate(`document.querySelector('[data-action="reply"]').disabled`),
    true,
  );
  assert.equal(await evaluate(`window.__fixture.sent.length`), 0);
  checks.push(
    "cached accounts cannot enter mail UI until authenticated server connection; unlicensed servers retain reading only",
  );
  await evaluate(`window.__postofficeBack()`);
  await click('.phone-nav [data-action="accounts"]');
  await screenshot("license-account-blocked");
  assert.equal(
    await evaluate(
      `!!document.querySelector('[data-action="recover-license"]')`,
    ),
    false,
  );
  await click('[data-action="switch"][data-id="personal"]');
  await wait(
    `document.querySelector('[data-mailbox-count="inbox"]')?.textContent==='1'`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.phone-nav [data-action="compose"]').disabled`,
    ),
    false,
  );
  await click('.phone-nav [data-action="accounts"]');
  await click('[data-action="switch"][data-id="work"]');
  await wait(
    `document.querySelector('[data-mailbox-count="inbox"]')?.textContent==='4'`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.phone-nav [data-action="compose"]').disabled`,
    ),
    true,
  );
  await setLicense("work", valid);
  await recheck();
  assert.equal(
    await evaluate(
      `document.querySelector('.phone-nav [data-action="compose"]').disabled`,
    ),
    false,
  );
  await click('.phone-nav [data-action="compose"]');
  await wait(`!!document.querySelector('#compose-form')`);
  await fill('[name="to"]', "local@example.test");
  await fill('[name="text"]', "不能因授权变更丢失的草稿");
  await setLicense("work", { ...blocked, reason: "授权已停用" });
  await evaluate(`document.querySelector('#compose-form').requestSubmit()`);
  await wait(
    `document.querySelector('#compose-form [type="submit"]').disabled && !!document.querySelector('[data-action="recheck-server"]')`,
  );
  assert.equal(await evaluate(`window.__fixture.sent.length`), 0);
  assert.equal(
    await evaluate(`document.querySelector('[name="text"]').value`),
    "不能因授权变更丢失的草稿",
  );
  await setLicense("work", valid);
  await recheck();
  assert.equal(
    await evaluate(
      `document.querySelector('#compose-form [type="submit"]').disabled`,
    ),
    false,
  );
  await click('[data-action="save-draft"]');
  await wait(
    `document.querySelector('#draft-status').textContent.includes('已保存')`,
  );
  await click('[data-action="compose-exit"]');
  checks.push(
    "licenses are isolated per account/server; revoke blocks submit without losing draft; restoration unlocks without relogin",
  );
  // No license response and a maintenance-only server are not commercial activation.
  for (const value of [
    {},
    { required: false, valid: true, mode: "development" },
    { ...valid, expiresAt: 1 },
  ]) {
    await setLicense("work", value);
    await click('[data-action="refresh"]');
    await delay(110);
    assert.equal(
      await evaluate(
        `document.querySelector('.phone-nav [data-action="compose"]').disabled`,
      ),
      true,
    );
  }
  checks.push(
    "missing, development-only and expired server licenses do not unlock sending",
  );
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Page.navigate", { url: base });
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  await setLicense("admin", blocked);
  await click('.sidebar [data-action="accounts"]');
  await click('[data-action="switch"][data-id="admin"]');
  await wait(`!!document.querySelector('[data-action="recover-license"]')`);
  assert.equal(await evaluate(`window.__fixture.opens.length`), 0);
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('[data-action="admin"]')].every(b=>b.disabled)`,
    ),
    true,
  );
  await click('[data-action="recover-license"]');
  await wait(`window.__fixture.recoveries?.length===1`);
  await screenshot("license-admin-recovery");
  await setLicense("admin", valid);
  await recheck();
  await click('.admin-intro [data-action="admin"]');
  await wait(`window.__fixture.opens.length===1`);
  checks.push(
    "unlicensed administrator reaches recovery only; licensed administrator can enter management",
  );
  // A delayed check for an old account must never overwrite the current server.
  await setLicense("admin", blocked);
  await evaluate(`window.__fixture.accessDelay=250`);
  await click('.admin-intro [data-action="admin"]');
  await click('.sidebar [data-action="accounts"]');
  await click('[data-action="switch"][data-id="personal"]');
  await delay(500);
  assert.equal(await evaluate(`window.__fixture.opens.length`), 1);
  assert.equal(
    await evaluate(
      `document.querySelector('.sidebar .identity small').textContent`,
    ),
    "hello@example.test",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.sidebar [data-action="compose"]').disabled`,
    ),
    false,
  );
  checks.push(
    "late authorization response from a previous account cannot open its management or block another account",
  );
  return checks;
};
