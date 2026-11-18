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
  let tab = "links",
    links = [],
    users = [],
    rules = [],
    settings,
    adminAccess,
    domains = [],
    codeToken = "",
    codeItems = [],
    publicInclude = false,
    codePage = 1,
    receivedCount = 0,
    matchedCount = 0,
    codeTimer;
  const url = (token) => `${location.origin}/#/msg#${token}`;
  const codeTable = (items, emptyLabel = "暂无验证码") =>
    table(
      ["邮箱", "验证码", "发件人 / 主题", "时间"],
      items.map(
        (m) =>
          `<tr><td>${e(m.mailbox)}</td><td>${m.code ? button(m.code, "copy-value", `data-value="${e(m.code)}"`, "secondary small") : "未识别验证码"}</td><td>${e(m.from_email)}<div class="subline">${e(m.subject)}</div>${publicInclude ? button("正文", "code-message", `data-id="${m.id}"`, "secondary small") : ""}</td><td>${e(new Date(m.created_at).toLocaleString("zh-CN"))}</td></tr>`,
      ),
      emptyLabel,
    );
  w.pages.codes = async () => {
    [
      settings,
      { items: links },
      { items: rules },
      { items: users },
      { items: domains },
      adminAccess,
    ] = await Promise.all([
      w.h.api("/admin/code-settings"),
      w.h.api("/admin/code-links"),
      w.h.api("/admin/code-rules"),
      w.h.api("/admin/manage/accounts"),
      w.h.api("/admin/manage/domains"),
      w.h.api("/admin/code-admin"),
    ]);
    let body = "";
    if (tab === "links")
      body =
        title(
          "接码链接管理",
          "8位 token，可绑定多个邮箱并设置有效期和 IP 范围。",
          button("导出", "codes-export") +
            button("批量一对一", "code-batch") +
            button("创建链接", "code-create", "", ""),
        ) +
        `<section class="card">${input("linkSearch", "搜索 token、备注或邮箱", "", "search", "data-code-search")}${table(
          ["token / 备注", "绑定邮箱", "有效期", "状态", "操作"],
          links.map(
            (l) =>
              `<tr data-code-row><td class="mono">${e(l.token)}<div class="subline">${e(l.label)}</div></td><td>${l.emails.map(e).join("<br>")}</td><td>${new Date(l.expires_at).toLocaleString("zh-CN")}</td><td>${status(l.enabled && l.expires_at > Date.now(), "有效", "已停用或到期")}</td><td>${button("复制链接", "copy-value", `data-value="${e(url(l.token))}"`, "secondary small")}${button("编辑", "code-edit", `data-id="${l.id}"`, "secondary small")}${button("访问记录", "code-logs", `data-id="${l.id}"`, "secondary small")}${button("删除", "code-delete", `data-id="${l.id}"`, "danger small")}</td></tr>`,
          ),
        )}</section>`;
    if (tab === "settings") {
      const feed = await w.h.api("/admin/codes");
      body =
        title("接码设置", "定义可读取的邮箱域名与邮件历史范围。") +
        `<form class="card form-card" data-m-form="code-settings">${check("enabled", "启用验证码提取", settings.enabled)}${check("allowPublicLinks", "允许接码链接访问", settings.allowPublicLinks)}<label>域名范围（留空表示全部）</label>${picker(
          "domains",
          domains.map((d) => d.name),
          settings.domains || [],
        )}${check("showHistory", "显示历史邮件", settings.showHistory ?? true)}<div class="form-grid">${input("historyDays", "历史天数（0使用小时范围）", settings.historyDays || 0, "number", 'min="0" max="3650"')}${input("lookbackHours", "读取最近小时数", settings.lookbackHours, "number", 'min="1" max="168"')}${input("maxResults", "最多结果数", settings.maxResults, "number", 'min="1" max="100"')}${input("refreshSeconds", "刷新间隔秒数", settings.refreshSeconds, "number", 'min="5" max="300"')}${input("linkHours", "默认链接有效小时数", settings.linkHours, "number", 'min="1" max="720"')}</div><button class="btn" type="submit">保存设置</button></form><section class="card form-card"><h2>管理员专用接码入口</h2>${note("专用链接可查看全部允许域名的接码结果，请只向可信的人提供。默认需要随机密钥。")}${adminAccess.secret ? `<code class="wrap-anywhere">${e(`${location.origin}/#/code-admin/${adminAccess.secret}`)}</code>` : "尚未生成"}<div class="form-actions">${button("重新生成专用链接", "code-secret")}${button(adminAccess.public ? "关闭公开访问" : "允许无密钥公开访问", "code-public", "", "secondary")}</div></section><section class="card">${codeTable(feed.items)}</section>`;
    }
    if (tab === "rules")
      body =
        title(
          "验证码规则管理",
          "按执行顺序提取，支持发件人和主题条件。",
          button("创建规则", "rule-create", "", ""),
        ) +
        `<section class="card">${table(
          ["顺序", "规则", "表达式", "状态", "操作"],
          rules.map(
            (r) =>
              `<tr><td>${r.priority}</td><td>${e(r.name)}<div class="subline">${e(r.description || "")}</div></td><td class="mono wrap-anywhere">${e(r.pattern)} / ${e(r.flags)}</td><td>${status(r.enabled)}</td><td>${button("编辑", "rule-edit", `data-id="${r.id}"`, "secondary small")}${button("删除", "rule-delete", `data-id="${r.id}"`, "danger small")}</td></tr>`,
          ),
        )}</section>`;
    if (tab === "test")
      body =
        title("批量规则测试", "查看每条规则是否匹配及提取结果。") +
        `<form class="card form-card" data-m-form="rules-test"><div class="form-grid">${input("from_email", "发件人条件")}${input("subject", "主题条件")}</div>${textarea("text", "测试内容", "", 'required rows="6"')}${button("填入样本", "rules-sample")}<button class="btn" type="submit">测试全部规则</button><div data-rules-results></div></form>`;
    return (
      `<nav class="tool-tabs">${[
        ["settings", "接码设置"],
        ["links", "接码链接管理"],
        ["rules", "验证码规则管理"],
        ["test", "批量规则测试"],
      ]
        .map(([id, label]) =>
          button(
            label,
            "codes-tab",
            `data-tab="${id}"`,
            tab === id ? "" : "secondary",
          ),
        )
        .join("")}</nav>` + body
    );
  };
  w.actions["codes-tab"] = async (node) => {
    tab = node.dataset.tab;
    await w.h.render();
  };
  function linkDialog(row, batch = false) {
    dialog(
      batch ? "一邮箱一链接" : row ? "编辑接码链接" : "创建接码链接",
      picker("emails", users, row?.emails || []) +
        (batch
          ? ""
          : input(
              "token",
              "8位 token（留空自动生成）",
              row?.token || "",
              "text",
              'pattern="[A-Za-z0-9]{8}" maxlength="8"',
            )) +
        input("label", "备注", row?.label || "") +
        input(
          "hours",
          "从现在起有效小时数",
          row
            ? Math.max(1, Math.ceil((row.expires_at - Date.now()) / 3600000))
            : settings.linkHours,
          "number",
          'min="1" max="720"',
        ) +
        textarea(
          "ipAllowlist",
          "IP / CIDR 白名单（留空不限）",
          row?.ip_allowlist || "",
        ) +
        check(
          "includeMessage",
          "显示普通邮件并允许查看正文",
          Boolean(row?.include_message),
        ) +
        check("enabled", "启用链接", Boolean(row?.enabled ?? true)),
      async (data, form) => {
        await w.h.api(
          batch
            ? "/admin/code-links/batch"
            : row
              ? `/admin/code-links/${row.id}`
              : "/admin/code-links",
          {
            method: row ? "PATCH" : "POST",
            body: {
              ...data,
              emails: values(form, "emails"),
              includeMessage: checked(form, "includeMessage"),
              enabled: checked(form, "enabled"),
            },
          },
        );
        w.closeDialog();
        await w.h.render();
      },
    );
  }
  w.actions["code-create"] = () => linkDialog();
  w.actions["code-batch"] = () => linkDialog(null, true);
  w.actions["code-edit"] = (node) =>
    linkDialog(links.find((l) => l.id === Number(node.dataset.id)));
  w.actions["code-delete"] = (node) =>
    w.h.confirmAction("删除接码链接", "链接会立即失效。", async () => {
      await w.h.api(`/admin/code-links/${node.dataset.id}`, {
        method: "DELETE",
      });
      await w.h.render();
    });
  w.actions["codes-export"] = () =>
    w.exportRows(
      "接码链接.csv",
      links.map((l) => ({
        ...l,
        emails: l.emails.join(" "),
        url: url(l.token),
      })),
      [
        ["token", "token"],
        ["emails", "邮箱"],
        ["label", "备注"],
        ["url", "链接"],
        ["expires_at", "到期时间戳"],
      ],
    );
  async function logs(id, page = 1) {
    const r = await w.h.api(`/admin/code-links/${id}/logs?page=${page}`);
    dialog(
      "访问记录",
      table(
        ["时间", "IP", "动作", "结果 / 原因"],
        r.items.map(
          (l) =>
            `<tr><td>${e(l.created_at)}</td><td>${e(l.ip)}</td><td>${e(l.action)}</td><td>${e(l.result)} ${e(l.reason)}</td></tr>`,
        ),
      ) +
        `<div data-log-id="${id}">${w.pager(page, r.total, r.limit, "code-log-page")}</div>`,
    );
  }
  w.actions["code-logs"] = (node) => logs(node.dataset.id);
  w.actions["code-log-page"] = (node) =>
    logs(
      node.closest("[data-log-id]").dataset.logId,
      Number(node.dataset.page),
    );
  w.forms["code-settings"] = async (data, form) => {
    await w.h.api("/admin/code-settings", {
      method: "PUT",
      body: {
        ...data,
        domains: values(form, "domains"),
        enabled: checked(form, "enabled"),
        allowPublicLinks: checked(form, "allowPublicLinks"),
        showHistory: checked(form, "showHistory"),
      },
    });
    w.h.toast("接码设置已保存");
  };
  w.actions["code-secret"] = () =>
    w.h.confirmAction(
      "刷新专用链接",
      "旧管理员接码链接将立即失效。",
      async () => {
        await w.h.api("/admin/code-admin/refresh", {
          method: "POST",
          body: {},
        });
        await w.h.render();
      },
    );
  w.actions["code-public"] = () =>
    w.h.confirmAction(
      adminAccess.public ? "关闭公开访问" : "公开管理员接码",
      adminAccess.public
        ? "关闭后需使用带密钥的专用链接。"
        : "任何知道入口的人将可以查看全部接码结果，确认公开？",
      async () => {
        await w.h.api("/admin/code-admin", {
          method: "PUT",
          body: { public: !adminAccess.public, confirmPublicAccess: true },
        });
        await w.h.render();
      },
    );
  function ruleDialog(row) {
    dialog(
      row ? "编辑规则" : "创建规则",
      input("name", "名称", row?.name || "", "text", "required") +
        input("description", "说明", row?.description || "") +
        input(
          "priority",
          "执行顺序",
          row?.priority || 10,
          "number",
          'min="1" max="10000"',
        ) +
        input("sender_filter", "发件人包含", row?.sender_filter || "") +
        input("subject_filter", "主题包含", row?.subject_filter || "") +
        input(
          "pattern",
          "正则表达式",
          row?.pattern || "验证码[:： ]*([0-9]{6})",
          "text",
          'required maxlength="256"',
        ) +
        input(
          "flags",
          "匹配标志",
          row?.flags || "i",
          "text",
          'pattern="[gimu]*" maxlength="4"',
        ) +
        check("enabled", "启用规则", Boolean(row?.enabled ?? true)),
      async (data, form) => {
        await w.h.api(
          row ? `/admin/code-rules/${row.id}` : "/admin/code-rules",
          {
            method: row ? "PATCH" : "POST",
            body: { ...data, enabled: checked(form, "enabled") },
          },
        );
        w.closeDialog();
        await w.h.render();
      },
    );
  }
  w.actions["rule-create"] = () => ruleDialog();
  w.actions["rule-edit"] = (node) =>
    ruleDialog(rules.find((r) => r.id === Number(node.dataset.id)));
  w.actions["rule-delete"] = (node) =>
    w.h.confirmAction("删除规则", "确认删除此提取规则？", async () => {
      await w.h.api(`/admin/code-rules/${node.dataset.id}`, {
        method: "DELETE",
      });
      await w.h.render();
    });
  w.actions["rules-sample"] = (node) => {
    node.closest("form").elements.text.value =
      "您的验证码为 123456，5 分钟内有效。\nYour verification code is 482915\nPIN: 9182";
  };
  w.forms["rules-test"] = async (data) => {
    const r = await w.h.api("/admin/code-rules/test-all", {
      method: "POST",
      body: data,
    });
    $("[data-rules-results]").innerHTML =
      `<h3>提取结果：${e(r.code || "未匹配")}</h3><p>${r.stats.totalRules} 条规则 · ${r.stats.matchedRules} 条匹配</p>` +
      table(
        ["规则", "启用", "匹配", "验证码"],
        r.results.map(
          (item) =>
            `<tr><td>${e(item.rule_name || item.rule_id)}</td><td>${status(item.enabled)}</td><td>${status(item.matched, "匹配", "未匹配")}</td><td class="mono">${e(item.code || "—")}</td></tr>`,
        ),
      );
  };
  document.addEventListener("input", (event) => {
    if (event.target.matches("[data-code-search]"))
      w.$$("[data-code-row]").forEach(
        (row) =>
          (row.hidden = !row.textContent
            .toLowerCase()
            .includes(event.target.value.toLowerCase())),
      );
  });
  function stop() {
    clearInterval(codeTimer);
    codeTimer = null;
  }
  window.addEventListener("hashchange", stop);
  async function readPublic(admin = false, secret = "") {
    const result = await w.h.api(
      admin ? "/code-admin/read" : "/code-links/read",
      { method: "POST", body: admin ? { secret } : { token: codeToken } },
    );
    codeItems = result.items;
    publicInclude = !admin && result.includeMessage;
    receivedCount = result.receivedCount ?? codeItems.length;
    matchedCount =
      result.matchedCount ?? codeItems.filter((m) => m.code).length;
    const heading = $("[data-code-heading]");
    if (heading)
      heading.textContent = publicInclude ? "邮件与验证码" : "邮箱验证码";
    const target = $("#public-code-feed");
    const filter = $("[data-code-mailbox]");
    if (filter) {
      const selected = filter.value;
      filter.innerHTML =
        '<option value="">全部邮箱</option>' +
        [...new Set(result.mailboxes || codeItems.map((m) => m.mailbox))]
          .map(
            (mailbox) => `<option value="${e(mailbox)}">${e(mailbox)}</option>`,
          )
          .join("");
      filter.value = selected;
    }
    renderFeed();
    if (!codeTimer)
      codeTimer = setInterval(
        () => {
          if (!document.hidden && $("#public-code-feed"))
            readPublic(admin, secret).catch((error) => {
              stop();
              w.h.toast(error.message, true);
            });
        },
        Math.max(5, result.refreshSeconds || 10) * 1000,
      );
  }
  async function publicRender(hash) {
    stop();
    const admin = hash.startsWith("#/code-admin"),
      secret = hash.split("/")[2] || "";
    codeToken = admin ? "" : hash.split("#")[2] || "";
    $("#app").innerHTML =
      `<main class="public-workspace"><div class="public-heading"><span class="public-badge">MAIL VERIFICATION</span><h1 data-code-heading>邮箱验证码</h1><p>只显示当前链接授权的邮箱和内容</p></div>${!admin ? `<form class="card form-card" data-m-form="public-code"><div class="toolbar">${input("token", "8位 token", codeToken, "text", 'required pattern="[A-Za-z0-9]{8}" maxlength="8"')}<button type="submit" class="btn">查看验证码</button></div></form>` : ""}<section class="card"><div class="toolbar"><select data-code-mailbox aria-label="筛选邮箱"><option value="">全部邮箱</option></select>${button("立即刷新", "public-code-refresh", `data-admin="${admin ? "1" : ""}" data-secret="${e(secret)}"`, "secondary small")}</div><div id="public-code-feed"><div class="table-empty">请输入 token 或打开完整链接</div></div></section><a href="#inbox">返回邮局</a></main>`;
    if (admin || codeToken)
      try {
        await readPublic(admin, secret);
      } catch (error) {
        $("#public-code-feed").innerHTML = note(error.message);
      }
  }
  w.forms["public-code"] = async (data) => {
    codeToken = data.token;
    location.hash = `/msg#${codeToken}`;
    await readPublic();
  };
  w.actions["public-code-refresh"] = (node) =>
    readPublic(node.dataset.admin === "1", node.dataset.secret);
  function renderFeed() {
    const target = $("#public-code-feed");
    if (!target) return;
    const filter = $("[data-code-mailbox]")?.value || "";
    const items = codeItems.filter((m) => !filter || m.mailbox === filter);
    codePage = Math.max(1, Math.min(codePage, Math.ceil(items.length / 20)));
    const summary = `最近已检查 ${receivedCount} 封邮件，其中 ${matchedCount} 封识别到验证码。`;
    target.innerHTML =
      `<p class="hint" role="status">${e(summary)}${publicInclude ? "普通邮件也会显示，可点击正文查看。" : "本链接仅展示验证码；未识别验证码的邮件可登录邮箱查看。"}</p>` +
      codeTable(
        items.slice((codePage - 1) * 20, codePage * 20),
        publicInclude ? "当前范围没有邮件" : "当前范围未识别到验证码",
      ) +
      w.pager(codePage, items.length, 20, "code-public-page");
  }
  w.actions["code-public-page"] = (node) => {
    codePage = Number(node.dataset.page);
    renderFeed();
  };
  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-code-mailbox]")) {
      codePage = 1;
      renderFeed();
    }
  });
  w.actions["code-message"] = async (node) => {
    const m = await w.h.api("/code-links/message", {
      method: "POST",
      body: { token: codeToken, id: Number(node.dataset.id) },
    });
    dialog(
      m.subject || "邮件正文",
      `<div class="message-body ${m.body_html ? "" : "plain"}">${m.body_html || e(m.body_text)}</div>`,
    );
  };
  w.publicRoutes.push({
    match: (hash) =>
      /^#\/msg(?:#[A-Za-z0-9]{8})?$/.test(hash) ||
      /^#\/code-admin(?:\/[A-Za-z0-9_-]+)?$/.test(hash),
    render: publicRender,
  });
})();
