(() => {
  const w = MailWorkspace,
    {
      $,
      e,
      button,
      input,
      textarea,
      check,
      select,
      table,
      title,
      note,
      status,
      picker,
      dialog,
      values,
      checked,
    } = w;
  let settings,
    pages = [],
    publicToken = "",
    boxes = [],
    currentBox = null,
    publicPage;
  const date = (value) => new Date(value).toLocaleString("zh-CN");
  w.pages["temp-mail"] = async () => {
    const [s, p, stats] = await Promise.all([
      w.h.api("/admin/temp-mail/settings"),
      w.h.api("/admin/temp-mail/pages"),
      w.h.api("/admin/temp-mail/stats"),
    ]);
    settings = s;
    pages = p.items;
    return (
      title(
        "临时邮箱页面",
        "为访问者分配有期限的收件邮箱。",
        button("创建页面", "temp-page-create", "", ""),
      ) +
      `<div class="stats-grid">${[
        ["页面数", stats.pages],
        ["启用页面", stats.enabledPages],
        ["有效邮箱", stats.activeMailboxes],
        ["今日创建", stats.todayCreated],
      ]
        .map(
          ([name, n]) =>
            `<section class="stat-card"><span>${name}</span><strong>${n}</strong></section>`,
        )
        .join("")}</div><section class="card">${table(
        ["页面", "域名 / 寿命", "访问控制", "状态", "操作"],
        pages.map(
          (p) =>
            `<tr><td><strong>${e(p.name)}</strong></td><td>${e(p.domains.join(", "))}<div class="subline">${p.lifetimeMinutes} 分钟 · 每IP每天 ${p.dailyIpLimit} 个</div></td><td>${p.requirePassword ? "密码保护" : "公开创建"}</td><td>${status(p.enabled)}</td><td>${button("复制链接", "copy-value", `data-value="${e(`${location.origin}/#/temp/${p.token}`)}"`, "secondary small")}<a class="btn secondary small" href="#/temp/${e(p.token)}" target="_blank" rel="noopener">打开</a>${button("编辑", "temp-page-edit", `data-token="${e(p.token)}"`, "secondary small")}${button("删除", "temp-page-delete", `data-token="${e(p.token)}"`, "danger small")}</td></tr>`,
        ),
      )}</section><form class="card form-card" data-m-form="temp-settings"><h2>基础设置</h2>${check("enabled", "启用临时邮箱", s.enabled)}<label>可用域名</label>${picker("domains", s.availableDomains, s.domains)}<div class="form-grid">${input("prefix", "默认前缀", s.prefix, "text", "required")}${input("suffixLength", "随机后缀长度", s.suffixLength, "number", 'min="6" max="24"')}${input("lifetimeMinutes", "默认存活分钟数", s.lifetimeMinutes, "number", 'min="5" max="10080"')}${input("dailyIpLimit", "默认单IP每日额度", s.dailyIpLimit, "number", 'min="1" max="1000"')}${input("mailSaveDays", "过期临时邮箱数据保留天数（0不自动删除）", s.mailSaveDays, "number", 'min="0" max="365"')}${input("backgroundColor", "公开页背景颜色", s.backgroundColor, "color")}</div><button type="submit" class="btn">保存设置</button></form>`
    );
  };
  w.forms["temp-settings"] = async (data, form) => {
    await w.h.api("/admin/temp-mail/settings", {
      method: "PUT",
      body: {
        ...data,
        enabled: checked(form, "enabled"),
        domains: values(form, "domains"),
      },
    });
    w.h.toast("临时邮箱设置已保存");
    await w.h.render();
  };
  function pageDialog(row) {
    dialog(
      row ? "编辑临时邮箱页面" : "创建临时邮箱页面",
      input("name", "页面名称", row?.name || "", "text", "required") +
        picker("domains", settings.domains, row?.domains || settings.domains) +
        `<div class="form-grid">${input("prefix", "邮箱前缀", row?.prefix || settings.prefix, "text", "required")}${input("suffixLength", "随机长度", row?.suffixLength || settings.suffixLength, "number", 'min="6" max="24"')}${input("lifetimeMinutes", "存活分钟数", row?.lifetimeMinutes || settings.lifetimeMinutes, "number", 'min="5" max="10080"')}${input("dailyIpLimit", "单IP每日创建数量", row?.dailyIpLimit || settings.dailyIpLimit, "number", 'min="1" max="1000"')}</div>${check("enabled", "启用页面", Boolean(row?.enabled ?? true))}${check("requirePassword", "使用访问密码", Boolean(row?.requirePassword))}${input("password", row ? "访问密码（留空保留）" : "访问密码", "", "password", 'minlength="12"')}<p class="hint">修改页面后，原访问会话失效，访问者需要重新验证。</p>`,
      async (data, form) => {
        await w.h.api(
          row
            ? `/admin/temp-mail/pages/${row.token}`
            : "/admin/temp-mail/pages",
          {
            method: row ? "PATCH" : "POST",
            body: {
              ...data,
              domains: values(form, "domains"),
              enabled: checked(form, "enabled"),
              requirePassword: checked(form, "requirePassword"),
            },
          },
        );
        w.closeDialog();
        await w.h.render();
      },
    );
  }
  w.actions["temp-page-create"] = () => pageDialog();
  w.actions["temp-page-edit"] = (node) =>
    pageDialog(pages.find((p) => p.token === node.dataset.token));
  w.actions["temp-page-delete"] = (node) =>
    w.h.confirmAction(
      "删除临时邮箱页面",
      "此页面将停止访问，其临时邮箱也将立即停用。",
      async () => {
        await w.h.api(`/admin/temp-mail/pages/${node.dataset.token}`, {
          method: "DELETE",
        });
        await w.h.render();
      },
    );
  const base = () => `/temp/${publicToken}`;
  async function renderPublic(hash) {
    publicToken = hash.split("/")[2];
    currentBox = null;
    try {
      publicPage = await w.h.api(base());
      $("#app").innerHTML =
        `<main class="public-workspace"><div class="public-heading"><span class="public-badge">TEMPORARY MAIL</span><h1>${e(publicPage.name)}</h1><p>临时接收邮件 · ${publicPage.lifetimeMinutes} 分钟有效 · 每IP每日 ${publicPage.dailyIpLimit} 个</p><a href="#inbox">返回邮局</a></div><div id="temp-public-content"></div></main>`;
      document.body.style.backgroundColor = publicPage.backgroundColor;
      try {
        boxes = (await w.h.api(base() + "/mailboxes")).items;
        renderBoxes();
      } catch {
        if (publicPage.requirePassword)
          $("#temp-public-content").innerHTML =
            `<form class="card form-card" data-m-form="temp-unlock"><h2>访问验证</h2>${input("password", "页面访问密码", "", "password", "required")}<button class="btn" type="submit">进入页面</button></form>`;
        else {
          await w.h.api(base() + "/verify", { method: "POST", body: {} });
          boxes = [];
          renderBoxes();
        }
      }
    } catch (error) {
      $("#app").innerHTML =
        `<main class="public-workspace">${title("临时邮箱", error.message)}<a href="#inbox">返回邮局</a></main>`;
    }
  }
  function renderBoxes() {
    const target = $("#temp-public-content");
    if (!target) return;
    target.innerHTML = `<form class="card form-card" data-m-form="temp-create"><div class="toolbar">${select(
      "domain",
      "邮箱域名",
      publicPage.domains.map((d) => [d, d]),
    )}<button type="submit" class="btn">创建临时邮箱</button>${button("刷新", "temp-refresh")}</div></form><div class="temp-columns"><section class="card">${boxes.map((b) => `<div class="temp-mailbox"><button class="mail-open" data-m-action="temp-open" data-id="${b.id}"><strong>${e(b.email)}</strong><span class="subline">到期：${date(b.expires_at)} · 剩余 ${Math.max(0, Math.ceil((b.expires_at - Date.now()) / 60000))} 分钟</span></button>${button("复制", "copy-value", `data-value="${e(b.email)}"`, "secondary small")}${button("销毁", "temp-destroy", `data-id="${b.id}"`, "danger small")}</div>`).join("") || '<div class="table-empty">创建一个邮箱开始收信</div>'}</section><section class="card" id="temp-messages"><div class="table-empty">选择一个邮箱查看收件</div></section></div>`;
  }
  w.forms["temp-unlock"] = async (data) => {
    await w.h.api(base() + "/verify", { method: "POST", body: data });
    boxes = (await w.h.api(base() + "/mailboxes")).items;
    renderBoxes();
  };
  w.forms["temp-create"] = async (data) => {
    const b = await w.h.api(base() + "/mailboxes", {
      method: "POST",
      body: data,
    });
    boxes = (await w.h.api(base() + "/mailboxes")).items;
    renderBoxes();
    await openBox(b.id);
  };
  async function openBox(id) {
    currentBox = Number(id);
    const result = await w.h.api(base() + `/mailboxes/${currentBox}/messages`);
    $("#temp-messages").innerHTML =
      `<div class="toolbar"><strong>收件箱</strong>${button("刷新收件", "temp-messages-refresh")}</div>${result.items.map((m) => `<button class="temp-message" data-m-action="temp-message" data-id="${m.id}"><strong>${e(m.subject || "（无主题）")}</strong><span>${e(m.from_email)}</span><span class="subline">${date(m.created_at)}</span></button>`).join("") || '<div class="table-empty">暂无来信</div>'}`;
  }
  w.actions["temp-open"] = (node) => openBox(node.dataset.id);
  w.actions["temp-messages-refresh"] = () => openBox(currentBox);
  w.actions["temp-refresh"] = async () => {
    boxes = (await w.h.api(base() + "/mailboxes")).items;
    renderBoxes();
    if (currentBox && boxes.some((b) => b.id === currentBox))
      await openBox(currentBox);
  };
  w.actions["temp-message"] = async (node) => {
    const m = await w.h.api(
      base() + `/mailboxes/${currentBox}/messages/${node.dataset.id}`,
    );
    dialog(
      m.subject || "邮件正文",
      `<p class="hint">${e(m.from_email)}</p><div class="message-body ${m.body_html ? "" : "plain"}">${m.body_html || e(m.body_text)}</div><div class="attachments">${(m.attachments || []).map((a) => `<a class="attachment" href="/api${base()}/mailboxes/${currentBox}/attachments/${a.id}">${e(a.filename)}</a>`).join("")}</div>`,
    );
  };
  w.actions["temp-destroy"] = (node) =>
    w.h.confirmAction(
      "销毁临时邮箱",
      "销毁后立即停止收件，不能恢复。",
      async () => {
        await w.h.api(base() + `/mailboxes/${node.dataset.id}`, {
          method: "DELETE",
        });
        boxes = (await w.h.api(base() + "/mailboxes")).items;
        renderBoxes();
      },
    );
  w.publicRoutes.push({
    match: (hash) => /^#\/temp\/[A-Za-z0-9_-]{24}$/.test(hash),
    render: renderPublic,
  });
})();
