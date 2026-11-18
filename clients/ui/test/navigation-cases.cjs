// Interaction contract tests. CDP touch/mouse/key events exercise real browser
// capture and compatibility clicks; synthetic events cover missing-final-move
// and cancellation boundaries that CDP cannot represent directly.
const assert = require("node:assert/strict");
module.exports = async function navigationCases({
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
  const view = () => evaluate(`document.querySelector('.shell')?.dataset.view`);
  const selected = () =>
    evaluate(
      `document.querySelector('.phone-nav [aria-current="page"]')?.dataset.action`,
    );
  const candidate = () =>
    evaluate(
      `document.querySelector('.phone-nav [data-candidate]')?.dataset.action || null`,
    );
  const point = (action) =>
    evaluate(
      `(()=>{const r=document.querySelector('.phone-nav [data-action="${action}"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    );
  const barRect = () =>
    evaluate(
      `(()=>{const r=document.querySelector('.phone-nav').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`,
    );
  const touch = async (type, points) => {
    await cdp("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p) => ({
        ...p,
        radiusX: 1,
        radiusY: 1,
        force: 1,
      })),
    });
    await delay(35);
  };
  const mouse = (type, p, down = false) =>
    cdp("Input.dispatchMouseEvent", {
      type,
      ...p,
      ...(type === "mouseMoved"
        ? {}
        : { button: "left", clickCount: 1, buttons: down ? 1 : 0 }),
    });
  const tap = async (action) => {
    const p = await point(action);
    await touch("touchStart", [{ ...p, id: 1 }]);
    await touch("touchEnd", []);
  };
  const mouseClick = async (action) => {
    const p = await point(action);
    await mouse("mouseMoved", p);
    await mouse("mousePressed", p, true);
    await mouse("mouseReleased", p);
  };
  const resetActions = () => evaluate(`window.__navActions=[]`);
  const actions = () => evaluate(`window.__navActions`);
  const synthetic = (type, p, id = 91, target = ".phone-nav", extra = {}) =>
    evaluate(
      `document.querySelector(${JSON.stringify(target)}).dispatchEvent(new PointerEvent(${JSON.stringify(type)},${JSON.stringify({ bubbles: true, cancelable: true, isPrimary: true, pointerId: id, pointerType: "touch", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: p.x, clientY: p.y, ...extra })}))`,
    );
  const observeActions = () =>
    evaluate(
      `window.__navActions=[];document.addEventListener('click',e=>{const b=e.target.closest('[data-scrub-nav] > button');if(b)window.__navActions.push(b.dataset.action);});`,
    );
  const measureOverflow = () =>
    evaluate(
      `document.documentElement.scrollWidth>innerWidth || [...document.querySelectorAll('.phone-nav button')].some(b=>{const r=b.getBoundingClientRect();return r.width<48||r.height<48})`,
    );
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp("Page.navigate", { url: base + "/?android=1" });
  await wait(
    `document.querySelector('[data-mailbox-count="inbox"]')?.textContent==='4'`,
  );
  await observeActions();
  await evaluate(
    `document.querySelector('.phone-overview').scrollTop=120;window.__originalPage=document.querySelector('.phone-overview');window.__originalScroll=window.__originalPage.scrollTop`,
  );
  const home = await point("mobile-home"),
    inbox = await point("mobile-inbox"),
    compose = await point("compose"),
    account = await point("accounts");
  await mouse("mouseMoved", home);
  await wait(
    `document.querySelector('.phone-nav').hasAttribute('data-light-on')`,
  );
  const firstLight = await evaluate(
    `getComputedStyle(document.querySelector('.phone-nav')).getPropertyValue('--light-x')`,
  );
  await mouse("mouseMoved", account);
  await delay(50);
  assert.notEqual(
    await evaluate(
      `getComputedStyle(document.querySelector('.phone-nav')).getPropertyValue('--light-x')`,
    ),
    firstLight,
  );
  assert.equal(await candidate(), null);
  assert.equal(await selected(), "mobile-home");
  assert.deepEqual(await actions(), []);
  await screenshot("nav-hover-light");
  await mouse("mouseMoved", { x: 5, y: 5 });
  await delay(260);
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.phone-nav'),'::before').opacity`,
    ),
    "0",
  );
  checks.push("mouse hover follows locally without selecting; fades on leave");

  await touch("touchStart", [{ ...home, id: 1 }]);
  for (const [p, action] of [
    [inbox, "mobile-inbox"],
    [compose, "compose"],
    [account, "accounts"],
  ]) {
    await touch("touchMove", [{ ...p, id: 1 }]);
    assert.equal(await candidate(), action);
    assert.equal(await selected(), "mobile-home");
    assert.equal(await view(), "home");
    assert.equal(
      await evaluate(
        `window.__originalPage===document.querySelector('.phone-overview') && window.__originalPage.scrollTop===window.__originalScroll`,
      ),
      true,
    );
    assert.deepEqual(await actions(), []);
  }
  await screenshot("nav-drag-preview");
  await touch("touchEnd", []);
  assert.equal(await view(), "accounts");
  assert.equal(await selected(), "accounts");
  assert.equal(await candidate(), null);
  assert.deepEqual(await actions(), ["accounts"]);
  assert.equal(await evaluate(`document.querySelector('#dialog').open`), false);
  assert.equal(
    await evaluate(`document.querySelectorAll('.account-card').length`),
    2,
  );
  await screenshot("nav-accounts-page");
  await evaluate(
    `document.querySelector('.phone-nav [data-action="mobile-home"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1}))`,
  );
  assert.equal(await view(), "accounts");
  assert.deepEqual(await actions(), ["accounts"]);
  checks.push(
    "real touch previews three destinations with stable page/scroll/aria-current; release commits once; ghost click blocked across rerender",
  );

  await mouseClick("mobile-home");
  assert.equal(await view(), "home");
  assert.equal(
    await evaluate(`document.querySelector('.phone-overview').scrollTop`),
    await evaluate(`window.__originalScroll`),
  );
  await resetActions();
  await synthetic("pointerdown", home);
  await synthetic("pointerup", account); // No pointermove at the final coordinate.
  assert.equal(await view(), "accounts");
  assert.deepEqual(await actions(), ["accounts"]);
  await resetActions();
  await touch("touchStart", [{ ...inbox, id: 1 }]);
  for (const p of [account, home, compose, home])
    await touch("touchMove", [{ ...p, id: 1 }]);
  await touch("touchEnd", []);
  assert.equal(await view(), "home");
  assert.deepEqual(await actions(), ["mobile-home"]);
  checks.push(
    "ordinary mouse click, final-coordinate re-hit without move, and reversing touch path",
  );

  const outside = { x: inbox.x, y: (await barRect()).top - 20 };
  for (const end of [
    "outside",
    "pointercancel",
    "lostpointercapture",
    "blur",
  ]) {
    await resetActions();
    await synthetic("pointerdown", inbox);
    await synthetic("pointermove", account);
    if (end === "outside") await synthetic("pointerup", outside);
    else if (end === "blur") {
      await evaluate(`window.dispatchEvent(new Event('blur'))`);
      await synthetic("pointerup", account);
    } else {
      await synthetic(end, account);
      await synthetic("pointerup", account);
    }
    assert.equal(await view(), "home", end);
    assert.equal(await selected(), "mobile-home", end);
    assert.equal(await candidate(), null, end);
    assert.deepEqual(await actions(), [], end);
  }
  await touch("touchStart", [{ ...inbox, id: 1 }]);
  await touch("touchMove", [{ ...outside, id: 1 }]);
  await touch("touchEnd", []);
  assert.equal(await view(), "home");
  assert.deepEqual(await actions(), []);
  checks.push(
    "outside release, pointercancel, lost capture and blur cancel and restore active selection",
  );

  await resetActions();
  await touch("touchStart", [{ ...inbox, id: 1 }]);
  await touch("touchStart", [
    { ...inbox, id: 1 },
    { ...account, id: 2 },
  ]);
  await touch("touchMove", [
    { ...inbox, id: 1 },
    { ...home, id: 2 },
  ]);
  assert.equal(await candidate(), "mobile-inbox");
  assert.equal(await view(), "home");
  await touch("touchMove", [{ ...inbox, id: 1 }]); // Drop the second touch; TouchEnd ends the entire CDP sequence.
  assert.equal(await candidate(), "mobile-inbox");
  assert.deepEqual(await actions(), []);
  await touch("touchMove", [{ ...account, id: 1 }]);
  await touch("touchEnd", []);
  assert.equal(await view(), "accounts");
  assert.deepEqual(await actions(), ["accounts"]);
  checks.push(
    "secondary finger motion and release do not steal the first pointer",
  );

  await tap("mobile-home");
  await resetActions();
  const gap = await evaluate(
    `(()=>{const a=document.querySelectorAll('.phone-nav button');const l=a[0].getBoundingClientRect(),r=a[1].getBoundingClientRect();return {x:l.right+(r.left-l.right)*.8,y:l.top+l.height/2};})()`,
  );
  await touch("touchStart", [{ ...gap, id: 1 }]);
  await touch("touchEnd", []);
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  assert.equal(await view(), "mail");
  assert.deepEqual(await actions(), ["mobile-inbox"]);
  await tap("mobile-home");
  await resetActions();
  await evaluate(
    `document.querySelector('.phone-nav [data-action="compose"]').disabled=true`,
  );
  await touch("touchStart", [{ ...home, id: 1 }]);
  await touch("touchMove", [{ ...compose, id: 1 }]);
  await touch("touchEnd", []);
  assert.equal(await view(), "home");
  assert.deepEqual(await actions(), []);
  await evaluate(
    `document.querySelector('.phone-nav [data-action="compose"]').disabled=false`,
  );
  checks.push(
    "gaps resolve to nearest slot; disabled targets cancel rather than redirect",
  );

  await tap("compose");
  await wait(`!!document.querySelector('#compose-form')`);
  assert.equal(await view(), "compose");
  assert.equal(await selected(), "compose");
  assert.equal(
    await evaluate(
      `!!document.querySelector('#compose-form') && !document.querySelector('#dialog').open`,
    ),
    true,
  );
  await fill('[name="subject"]', "手势测试草稿");
  await fill('[name="text"]', "保留未保存内容。");
  await evaluate(
    `window.__savedConfirm=window.confirm;window.confirm=()=>false`,
  );
  await tap("accounts");
  assert.equal(await view(), "compose");
  assert.equal(await selected(), "compose");
  assert.equal(
    await evaluate(`document.querySelector('[name="text"]').value`),
    "保留未保存内容。",
  );
  await click('[data-action="save-draft"]');
  await wait(
    `document.querySelector('#draft-status').textContent.includes('已保存')`,
  );
  await evaluate(`window.confirm=window.__savedConfirm`);
  await screenshot("nav-compose-page");
  await tap("accounts");
  assert.equal(await view(), "accounts");
  await click('[data-action="add-account"]');
  assert.equal(await evaluate(`document.querySelector('#dialog').open`), true);
  await click('[data-action="close-dialog"]');
  assert.equal(await view(), "accounts");
  await click('[data-action="accounts-exit"]');
  assert.equal(await view(), "home");
  await tap("accounts");
  await tap("compose");
  await wait(`!!document.querySelector('#compose-form')`);
  await click('[data-action="compose-exit"]');
  assert.equal(await view(), "accounts");
  await click('[data-action="accounts-exit"]');
  assert.equal(await view(), "home");
  checks.push(
    "compose and accounts are independent pages; dirty cancellation restores current selection; account add remains available",
  );

  await tap("mobile-home");
  await resetActions();
  await evaluate(`document.querySelector('.phone-overview').scrollTop=0`);
  await touch("touchStart", [{ x: 185, y: 625, id: 1 }]);
  for (const y of [590, 530, 470, 400])
    await touch("touchMove", [{ x: 185, y, id: 1 }]);
  await touch("touchEnd", []);
  await delay(150);
  assert.equal(
    await evaluate(`document.querySelector('.phone-overview').scrollTop>40`),
    true,
  );
  assert.deepEqual(await actions(), []);
  checks.push("content pan scrolls normally and never starts navigation");

  await evaluate(
    `document.querySelector('.phone-nav [data-action="mobile-home"]').focus()`,
  );
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  await cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  assert.equal(
    await evaluate(`document.activeElement.dataset.action`),
    "mobile-inbox",
  );
  assert.equal(await view(), "home");
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
    windowsVirtualKeyCode: 13,
  });
  await cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  assert.equal(await view(), "mail");
  await evaluate(
    `document.querySelector('.phone-nav [data-action="accounts"]').focus()`,
  );
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    text: " ",
    unmodifiedText: " ",
    windowsVirtualKeyCode: 32,
  });
  await cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  assert.equal(await view(), "accounts");
  checks.push(
    "arrow keys move focus without switching; Enter and Space activate real pages",
  );

  for (const [width, height] of [
    [320, 740],
    [430, 932],
    [768, 1024],
    [1180, 820],
  ]) {
    await cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(await measureOverflow(), false);
    await screenshot("nav-accounts-" + width);
  }
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.phone-nav')).flexDirection`,
    ),
    "column",
  );
  await tap("mobile-home");
  await resetActions();
  const railStart = await point("mobile-home"),
    railEnd = await point("accounts");
  await touch("touchStart", [{ ...railStart, id: 1 }]);
  await touch("touchMove", [{ ...railEnd, id: 1 }]);
  assert.equal(await view(), "home");
  assert.equal(await candidate(), "accounts");
  await touch("touchEnd", []);
  assert.equal(await view(), "accounts");
  assert.deepEqual(await actions(), ["accounts"]);
  await tap("mobile-inbox");
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  await click('[data-id="m1"]');
  await wait(`!!document.querySelector('.message-body')`);
  assert.equal(
    await evaluate(
      `document.querySelector('.list-pane').inert || document.querySelector('.phone-nav').inert`,
    ),
    false,
  );
  await screenshot("nav-tablet-mail-detail");
  checks.push(
    "phone bottom navigation adapts to vertical rail and wide list/detail; 48px targets and no overflow",
  );

  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await evaluate(`window.__postofficeBack()`);
  await tap("mobile-home");
  await cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await mouse("mouseMoved", await point("accounts"));
  await delay(90);
  await screenshot("nav-light-dark");
  await cdp("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "dark" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.phone-nav'),'::before').transitionDuration`,
    ),
    "0s",
  );
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.phone-nav'),'::before').animationName`,
    ),
    "none",
  );
  await mouse("mouseMoved", { x: 4, y: 4 });
  await delay(35);
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.phone-nav'),'::before').opacity`,
    ),
    "0",
  );
  await cdp("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "no-preference" },
    ],
  });
  checks.push(
    "dark/local light and reduced-motion immediate fade without looping animations",
  );

  // Force feature detection down the Touch Events branch in a fresh document.
  const override = await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.PointerEvent=undefined;",
  });
  await cdp("Page.navigate", { url: base + "/?android=1" });
  await wait(
    `document.querySelector('[data-mailbox-count="inbox"]')?.textContent==='4'`,
  );
  await observeActions();
  const fallbackHome = await point("mobile-home"),
    fallbackAccounts = await point("accounts");
  await touch("touchStart", [{ ...fallbackHome, id: 1 }]);
  await touch("touchMove", [{ ...fallbackAccounts, id: 1 }]);
  assert.equal(await view(), "home");
  assert.equal(await candidate(), "accounts");
  await touch("touchEnd", []);
  assert.equal(await view(), "accounts");
  assert.deepEqual(await actions(), ["accounts"]);
  await cdp("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: override.identifier,
  });
  checks.push("Touch Events fallback preserves preview/commit contract");

  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 650,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Page.navigate", { url: base });
  await wait(`document.querySelectorAll('.mail-row').length===4`);
  await mouse("mouseMoved", { x: 115, y: 300 });
  await delay(100);
  assert.equal(
    await evaluate(
      `document.querySelector('.sidebar').hasAttribute('data-light-on')`,
    ),
    true,
  );
  await screenshot("nav-desktop-sidebar-light");
  await evaluate(
    `window.__scrollCancelledPointer=false;document.addEventListener('pointercancel',e=>{if(e.target.closest('.sidebar'))window.__scrollCancelledPointer=true;});document.querySelector('.sidebar').scrollTop=0`,
  );
  await touch("touchStart", [{ x: 110, y: 560, id: 1 }]);
  for (const y of [520, 470, 410, 350])
    await touch("touchMove", [{ x: 110, y, id: 1 }]);
  assert.equal(
    await evaluate(
      `document.querySelector('.sidebar').scrollTop>20 && window.__scrollCancelledPointer`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.sidebar').hasAttribute('data-light-on')`,
    ),
    true,
  );
  const sidebarY = await evaluate(
    `document.querySelector('.sidebar').style.getPropertyValue('--light-y')`,
  );
  await touch("touchMove", [{ x: 110, y: 305, id: 1 }]);
  assert.notEqual(
    await evaluate(
      `document.querySelector('.sidebar').style.getPropertyValue('--light-y')`,
    ),
    sidebarY,
  );
  await touch("touchEnd", []);
  await delay(260);
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.sidebar'),'::before').opacity`,
    ),
    "0",
  );
  checks.push(
    "sidebar native pan keeps passive touch lighting alive after pointercancel, follows movement and fades on release",
  );
  await click('.sidebar [data-action="accounts"]');
  assert.equal(
    await evaluate(
      `!!document.querySelector('.accounts-shell') && !document.querySelector('#dialog').open`,
    ),
    true,
  );
  await screenshot("nav-desktop-accounts");
  checks.push("Windows sidebar hover material and independent account page");
  return checks;
};
