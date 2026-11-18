(() => {
  const w = MailWorkspace,
    {
      $,
      $$,
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
  let accounts = [],
    domains = [],
    forwards = [],
    userFilter = { q: "", domain: "", page: 1, limit: 30 };
  const formatBytes = (n) =>
    n >= 1073741824
      ? `${(n / 1073741824).toFixed(1)} GB`
      : n >= 1048576
        ? `${(n / 1048576).toFixed(1)} MB`
        : `${Math.round(n / 1024)} KB`;
  const date = (v) =>
    v
      ? new Date(v).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "—";
  const contextNote = () =>
    w.remote()
      ? note(`当前管理邮局：${w.current()?.name} · ${w.current()?.type}`)
      : "";
  const selected = () =>
    $$("[data-row-select]:checked", "#content").map((el) => el.value);
  const rowCheck = (id) =>
    `<input type="checkbox" data-row-select value="${e(id)}" aria-label="选择此行">`;
  const allCheck =
    '<input type="checkbox" data-select-all aria-label="全选当前页">';
  const accountKey = (row) => String(row.id ?? row.email);
  function accountDialog(row) {
    const editing = Boolean(row);
    dialog(
      editing ? "编辑邮箱" : "添加邮箱",
      `<div class="form-grid">${input("email", "邮箱地址", row?.email || "", "email", `required ${editing ? "readonly" : ""}`)}${input("name", "显示名称", row?.name || "")}${!editing || w.can("accounts.password", row.domain_id, "update") ? input("password", editing ? "新密码（留空保留）" : "密码", "", "password", `${editing ? "" : "required"} minlength="12" autocomplete="new-password"`) : ""}${input("quotaMB", "配额（MB）", Math.round((row?.quota_bytes || 1073741824) / 1048576), "number", 'min="1" max="1048576"')}</div>${editing ? check("active", "启用此邮箱", Boolean(row.active)) : ""}${!w.remote() ? input("note", "备注", row?.note || "") : ""}`,
      async (data, form) => {
        await w.operation(editing ? "account.update" : "account.create", {
          ...data,
          id: row?.id,
          active: editing ? checked(form, "active") : true,
        });
        w.closeDialog();
        w.h.toast("邮箱已保存");
        await w.h.render();
      },
    );
  }
  let usersRevision = 0,
    userSearchTimer;
  const canUser = (permission, row, operation = "read") =>
    (w.remote() ||
      (row.role !== "admin" && !row.client_manager) ||
      w.isGlobal()) &&
    w.can(permission, row.domain_id, operation);
  w.resetMailbox = () => {
    mailFilter = { folder: "", q: "", emails: [], page: 1 };
    userFilter = { q: "", domain: "", page: 1, limit: 30 };
  };
  w.pages.users = async () => {
    const revision = ++usersRevision,
      filter = { ...userFilter };
    const [users, allDomains] = await Promise.all([
      w.resource("accounts", filter),
      w.remote()
        ? w.resource("domains")
        : w.h.api("/admin/manage/domain-options?purpose=accounts"),
    ]);
    if (revision !== usersRevision) return "";
    accounts = users.items;
    domains = allDomains.items;
    let rows = accounts,
      count = users.total;
    if (w.remote()) {
      rows = accounts.filter(
        (u) =>
          (!filter.q ||
            (u.email + " " + u.name)
              .toLowerCase()
              .includes(filter.q.toLowerCase())) &&
          (!filter.domain || u.domain === filter.domain),
      );
      count = rows.length;
      rows = rows.slice(
        (filter.page - 1) * filter.limit,
        filter.page * filter.limit,
      );
    }
    count ??= rows.length;
    if (w.remote()) accounts = rows;
    if (filter.page > 1 && !rows.length && count > 0) {
      userFilter.page = Math.max(1, Math.ceil(count / filter.limit));
      return w.pages.users();
    }
    return (
      title(
        "邮箱用户",
        "按域名管理账号，控制邮箱空间与访问状态。",
        w.can("accounts.create", undefined, "create")
          ? button("批量注册", "open-register") +
              button("添加邮箱", "account-create", "", "")
          : "",
      ) +
      contextNote() +
      '<section class="card selection-panel account-management"><form class="toolbar" data-m-form="user-filter"><div class="account-filter-fields">' +
      input(
        "q",
        "搜索邮箱或姓名",
        filter.q,
        "search",
        'data-account-search placeholder="输入关键词搜索" maxlength="100"',
      ) +
      select(
        "domain",
        "域名范围",
        [["", "全部授权域名"], ...domains.map((d) => [d.name, d.name])],
        filter.domain,
        "data-account-filter",
      ) +
      select(
        "limit",
        "每页条数",
        [
          [30, "30 条"],
          [50, "50 条"],
          [100, "100 条"],
        ],
        filter.limit,
        "data-account-filter",
      ) +
      '</div><button type="submit" class="btn secondary">搜索</button>' +
      button("重置", "users-reset") +
      "</form>" +
      '<div class="selection-toolbar">' +
      button("导出当前页", "users-export", "", "secondary small") +
      (w.can("accounts.delete", undefined, "delete")
        ? button("删除所选", "users-delete", "", "danger small")
        : "") +
      '<span class="hint">共 ' +
      count +
      " 个匹配邮箱 · 已选 <strong data-selection-count>0</strong> 个</span></div>" +
      table(
        [allCheck, "邮箱用户", "空间用量", "状态", "操作"],
        rows.map(
          (u) =>
            "<tr><td>" +
            rowCheck(accountKey(u)) +
            '</td><td><div class="member-identity"><span class="mail-avatar">' +
            e((u.name || u.email || "?").slice(0, 1)) +
            "</span><div><strong>" +
            e(u.name) +
            '</strong><div class="subline mono">' +
            e(u.display_email || u.email) +
            "</div>" +
            (u.role === "admin"
              ? '<span class="pill gray">管理员</span>'
              : "") +
            '</div></div></td><td><span class="subline">' +
            formatBytes(u.used_bytes || 0) +
            " / " +
            formatBytes(u.quota_bytes || 0) +
            '</span><progress class="capacity-progress" max="100" value="' +
            Math.min(100, ((u.used_bytes || 0) / (u.quota_bytes || 1)) * 100) +
            '" aria-label="邮箱空间使用率"></progress></td><td>' +
            status(u.active, "正常", "停用") +
            '</td><td><div class="row-actions">' +
            (w.isGlobal() && !w.remote() && u.id !== w.h.state.user.id
              ? button(
                  "分配权限",
                  "account-permissions",
                  'data-id="' + e(accountKey(u)) + '"',
                  "secondary small",
                )
              : "") +
            (canUser("mail.read", u)
              ? button(
                  "邮件",
                  "account-mails",
                  'data-id="' + e(accountKey(u)) + '"',
                  "secondary small",
                )
              : "") +
            (canUser("accounts.update", u, "update")
              ? button(
                  "编辑",
                  "account-edit",
                  'data-id="' + e(accountKey(u)) + '"',
                  "secondary small",
                )
              : "") +
            (canUser("accounts.delete", u, "delete") &&
            u.id !== w.h.state.user.id
              ? button(
                  "删除",
                  "account-delete",
                  'data-id="' + e(accountKey(u)) + '"',
                  "danger small",
                )
              : "") +
            "</div></td></tr>",
        ),
        filter.q || filter.domain
          ? "没有匹配的邮箱，请调整筛选条件"
          : "还没有邮箱，可从上方添加邮箱或批量注册",
      ) +
      w.pager(filter.page, count, filter.limit, "users-page") +
      "</section>"
    );
  };
  w.forms["user-filter"] = async (data) => {
    clearTimeout(userSearchTimer);
    userFilter = {
      ...userFilter,
      q: data.q,
      domain: data.domain,
      limit: Number(data.limit) || 30,
      page: 1,
    };
    await w.h.render();
  };
  w.actions["users-reset"] = async () => {
    clearTimeout(userSearchTimer);
    userFilter = { q: "", domain: "", page: 1, limit: 30 };
    await w.h.render();
  };
  w.actions["users-page"] = async (node) => {
    clearTimeout(userSearchTimer);
    userFilter.page = Number(node.dataset.page);
    await w.h.render();
  };
  document.addEventListener("input", (event) => {
    if (!event.target.matches("[data-account-search]")) return;
    const field = event.target;
    clearTimeout(userSearchTimer);
    userSearchTimer = setTimeout(async () => {
      if (!field.isConnected) return;
      const value = field.value,
        cursor = field.selectionStart;
      try {
        await w.forms["user-filter"](w.data(field.form));
        const next = $("[data-account-search]");
        if (next && next.value === value) {
          next.focus();
          next.setSelectionRange(cursor, cursor);
        }
      } catch (error) {
        w.h.toast(error.message, true);
      }
    }, 350);
  });
  document.addEventListener("change", async (event) => {
    if (event.target.matches("[data-account-filter]")) {
      try {
        await w.forms["user-filter"](w.data(event.target.form));
      } catch (error) {
        w.h.toast(error.message, true);
      }
    }
  });
  w.actions["account-create"] = () => accountDialog();
  w.actions["account-edit"] = (node) =>
    accountDialog(accounts.find((row) => accountKey(row) === node.dataset.id));
  w.actions["account-permissions"] = (node) =>
    w.editClientPermissions(
      accounts.find((row) => accountKey(row) === node.dataset.id),
    );
  async function deleteUsers(items) {
    if (!items.length) throw new Error("请先选择邮箱");
    if (items.length > 100) throw new Error("一次最多删除100个邮箱");
    w.h.confirmAction(
      "删除邮箱账号",
      `确定删除以下 ${items.length} 个邮箱及其全部邮件？\n${items.map((row) => row.email).join("\n")}`,
      async () => {
        if (w.remote()) {
          for (const row of items)
            await w.operation("account.delete", {
              id: row.id,
              email: row.email,
              confirm: true,
            });
        } else
          await w.h.api("/admin/manage/accounts/delete", {
            method: "POST",
            body: { ids: items.map((row) => row.id), confirm: true },
          });
        w.h.toast("所选邮箱已删除");
        await w.h.render();
      },
    );
  }
  w.actions["account-delete"] = (node) =>
    deleteUsers(accounts.filter((row) => accountKey(row) === node.dataset.id));
  w.actions["users-delete"] = () =>
    deleteUsers(accounts.filter((row) => selected().includes(accountKey(row))));
  w.actions["users-export"] = () =>
    w.exportRows("邮箱列表.csv", accounts, [
      ["email", "邮箱"],
      ["name", "显示名称"],
      ["domain", "域名"],
      ["quota_bytes", "配额字节"],
      ["active", "启用状态"],
    ]);
  w.actions["open-register"] = () => {
    w.navigate("batch-register");
  };
  w.actions["account-mails"] = (node) => {
    const row = accounts.find((row) => accountKey(row) === node.dataset.id);
    mailFilter = {
      folder: "inbox",
      page: 1,
      limit: 30,
      q: "",
      emails: [row.email],
    };
    w.navigate("inbox");
  };

  const limitInput = (row = {}) =>
    check(
      "unlimited",
      "不限制邮箱数量",
      row.mailbox_limit == null,
      "data-quota-unlimited",
    ) +
    input(
      "mailboxLimit",
      "邮箱数量上限",
      row.mailbox_limit ?? "",
      "number",
      'min="0" max="1000000" step="1" placeholder="例如 100" data-quota-limit ' +
        (row.mailbox_limit == null ? "disabled" : "required"),
    ) +
    '<p class="hint">计入管理员邮箱、停用邮箱及临时邮箱；0 表示禁止新增。已存在的邮箱不会自动删除。</p>';
  const readLimit = (data, form) => {
    if (checked(form, "unlimited")) return null;
    if (!/^\d+$/.test(data.mailboxLimit || ""))
      throw new Error("请输入有效的邮箱数量上限");
    return Number(data.mailboxLimit);
  };
  document.addEventListener("change", (event) => {
    if (!event.target.matches("[data-quota-unlimited]")) return;
    const field = $("[data-quota-limit]", event.target.form);
    field.disabled = event.target.checked;
    field.required = !event.target.checked;
    if (!field.disabled) field.focus();
  });
  function capacity(row) {
    const used = row.mailbox_count ?? row.user_count ?? row.mailboxes ?? 0,
      limit = row.mailbox_limit;
    const percent =
      limit == null
        ? 0
        : limit === 0
          ? 100
          : Math.min(100, (used / limit) * 100);
    return (
      '<div class="domain-capacity ' +
      (limit != null && used >= limit ? "at-capacity" : "") +
      '"><strong>' +
      used +
      "</strong><span> / " +
      (limit == null ? "不限" : limit) +
      '</span><progress class="capacity-progress" max="100" value="' +
      percent +
      '" aria-label="域名邮箱数量使用率"></progress><small>' +
      (limit == null
        ? "未设置数量上限"
        : "还可创建 " + Math.max(0, limit - used) + " 个") +
      "</small></div>"
    );
  }
  w.pages.domains = async () => {
    const [domainResult, settings] = await Promise.all([
      w.resource("domains"),
      !w.remote() && w.isGlobal() ? w.h.api("/admin/mail-settings") : null,
    ]);
    domains = domainResult.items;
    const total = domains.reduce(
      (sum, d) => sum + (d.mailbox_count ?? d.user_count ?? d.mailboxes ?? 0),
      0,
    );
    const full = domains.filter(
      (d) =>
        d.mailbox_limit != null && (d.mailbox_count || 0) >= d.mailbox_limit,
    ).length;
    return (
      title(
        "域名与容量",
        "配置收发域名、查看解析状态，规划每个域名的邮箱数量。",
        button("导出", "domains-export") +
          (w.isGlobal() ? button("添加域名", "domain-create", "", "") : ""),
      ) +
      contextNote() +
      '<div class="management-metrics"><section class="management-metric"><span>邮件域名</span><strong>' +
      domains.length +
      '</strong><small>当前可管理的域名</small></section><section class="management-metric"><span>已创建邮箱</span><strong>' +
      total +
      '</strong><small>包含停用及临时邮箱</small></section><section class="management-metric"><span>已达数量上限</span><strong>' +
      full +
      "</strong><small>可调整上限后继续创建</small></section></div>" +
      '<section class="card domain-management">' +
      table(
        ["邮件域名", "状态", "邮箱数量 / 上限", "邮件捕获", "操作"],
        domains.map(
          (row) =>
            '<tr><td><strong class="mono">' +
            e(row.name) +
            '</strong><div class="subline">用户名@' +
            e(row.name) +
            "</div></td><td>" +
            status(row.enabled, "正常", "停用") +
            "</td><td>" +
            capacity(row) +
            "</td><td>" +
            (row.catchall_target || row.catchall_email
              ? e(row.catchall_target || row.catchall_email) +
                (row.catchall_target
                  ? `<div class="subline">Catch-all 转发${row.catchall_forward_enabled ? "" : "（已停用）"}</div>`
                  : "")
              : '<span class="muted">未启用</span>') +
            '</td><td><div class="row-actions">' +
            button(
              "DNS 解析",
              "domain-dns",
              'data-id="' + e(row.id ?? row.name) + '"',
              "secondary small",
            ) +
            (w.isGlobal() && !w.remote()
              ? button(
                  "数量上限",
                  "domain-limit",
                  'data-id="' + row.id + '"',
                  "secondary small",
                )
              : "") +
            (w.can("domains.update", row.id, "update")
              ? button(
                  "捕获设置",
                  "domain-catchall",
                  'data-id="' + e(row.id ?? row.name) + '"',
                  "secondary small",
                ) +
                button(
                  row.enabled ? "停用" : "启用",
                  "domain-toggle",
                  'data-id="' + e(row.id ?? row.name) + '"',
                  "secondary small",
                )
              : "") +
            (w.can("domains.delete", row.id, "delete") &&
            (!(row.mailbox_count ?? row.user_count) ||
              w.can("accounts.delete", row.id, "delete"))
              ? button(
                  "删除",
                  "domain-delete",
                  'data-id="' + e(row.id ?? row.name) + '"',
                  "danger small",
                )
              : "") +
            "</div></td></tr>",
        ),
        "还没有邮件域名，添加后即可创建邮箱",
      ) +
      "</section>" +
      (settings
        ? '<section class="card smtp-settings"><details><summary><strong>SMTP 主机名</strong><span class="mono">' +
          e(settings.hostname || "待配置") +
          '</span></summary><div class="card-body"><p class="hint">添加第一个域名时自动填入 mail.域名。主机名用于 SMTP 连接与外发 EHLO，修改后请同步配置 DNS 和证书。</p><form data-m-form="mail-hostname"><div class="form-grid">' +
          input(
            "hostname",
            "邮件服务器主机名",
            settings.hostname,
            "text",
            'placeholder="mail.example.com" required maxlength="253"',
          ) +
          '</div><button class="btn" type="submit">保存主机名</button></form></div></details></section>'
        : "")
    );
  };
  w.actions["domain-limit"] = (node) => {
    const row = domainRow(node);
    dialog(
      "域名邮箱数量上限",
      '<div class="quota-dialog-summary"><strong>' +
        e(row.name) +
        "</strong>" +
        capacity(row) +
        "</div>" +
        limitInput(row),
      async (data, form) => {
        const mailboxLimit = readLimit(data, form);
        if (mailboxLimit != null && mailboxLimit < row.mailbox_count)
          throw new Error(
            "上限不能低于已创建的 " + row.mailbox_count + " 个邮箱",
          );
        await w.operation("domain.update", { id: row.id, mailboxLimit });
        w.closeDialog();
        w.h.toast("域名邮箱数量上限已更新");
        await w.h.render();
      },
    );
  };
  const domainRow = (node) =>
    domains.find((row) => String(row.id ?? row.name) === node.dataset.id);
  w.forms["mail-hostname"] = async (data) => {
    await w.h.api("/admin/mail-settings", { method: "PUT", body: data });
    w.h.toast("SMTP 主机名已保存");
    await w.h.render();
  };
  w.actions["domain-create"] = () =>
    dialog(
      "添加域名",
      input(
        "domain",
        "邮箱域名",
        "",
        "text",
        'placeholder="example.com" required',
      ) +
        note(
          "这里填写邮箱地址 @ 后面的域名。例如 user@example.com 填 example.com；SMTP 主机名 mail.example.com 可在域名页的主机名设置中修改。",
        ) +
        (!w.remote() ? limitInput() : ""),
      async (data, form) => {
        const result = await w.operation("domain.create", {
          ...data,
          ...(!w.remote() ? { mailboxLimit: readLimit(data, form) } : {}),
        });
        w.closeDialog();
        w.h.toast("域名已添加");
        await w.h.render();
        if (!w.remote() && result.id) await showDns(result.id);
      },
    );
  w.actions["domains-export"] = () =>
    w.exportRows(
      "域名列表.csv",
      domains.map((row) => ({
        ...row,
        mailbox_count:
          row.mailbox_count ?? row.user_count ?? row.mailboxes ?? 0,
        mailbox_limit: row.mailbox_limit ?? "不限",
      })),
      [
        ["name", "域名"],
        ["enabled", "启用状态"],
        ["mailbox_count", "邮箱数量（含停用和临时邮箱）"],
        ["mailbox_limit", "邮箱数量上限"],
        ["catchall_email", "捕获邮箱"],
        ["catchall_target", "Catch-all 转发目标"],
      ],
    );
  w.actions["domain-toggle"] = async (node) => {
    const row = domainRow(node);
    await w.operation("domain.update", {
      id: row.id,
      domain: row.name,
      enabled: !row.enabled,
    });
    await w.h.render();
  };
  w.actions["domain-delete"] = (node) => {
    const row = domainRow(node);
    dialog(
      "删除域名",
      note("会删除该域名及其邮箱、邮件。请输入完整域名确认。") +
        input("confirmation", "完整域名", "", "text", "required"),
      async (data) => {
        if (data.confirmation !== row.name) throw new Error("域名不匹配");
        await w.operation("domain.delete", {
          id: row.id,
          domain: row.name,
          confirmDomain: row.name,
        });
        w.closeDialog();
        w.h.toast("域名已删除");
        await w.h.render();
      },
      "删除域名",
    );
  };
  async function showDns(id, options = {}) {
    const plan = await w.h.api(
      `/admin/manage/domains/${id}/dns?${new URLSearchParams(options)}`,
    );
    dialog(
      `DNS解析记录 · ${plan.domain}`,
      `<p class="hint">邮箱地址格式：用户名@${e(plan.domain)}。MX 和 TXT 在此邮箱域名下配置；邮件服务器主机名为 ${e(plan.hostname)}。下方输入用于本次指引与验证，不会修改服务器配置。</p><div class="form-grid">${input("hostname", "邮件服务器主机名", plan.hostname, "text", "required")}${input("ip", "邮件服务器公网 IP", plan.ip, "text", 'placeholder="例如：203.0.113.25"')}</div>${plan.ipSource === "web-address" ? '<p class="hint">公网 IP 已从网页入口自动带入；邮件出口 IP 不同时请在上方调整。</p>' : ""}${table(
        ["类型", "主机记录 / 完整名称", "记录值", "操作"],
        plan.records.map(
          (record) =>
            `<tr><td>${e(record.type)}</td><td class="mono">${e(record.host)}<div class="subline">${e(record.name)}</div></td><td class="dns-value mono">${e(record.value || record.pending || "待配置")}</td><td>${button("复制", "copy-value", `data-value="${e(record.value || "")}"`, "secondary small")}</td></tr>`,
        ),
      )}<div class="form-actions">${button("验证解析", "verify-dns", `data-id="${id}"`, "")}<span data-dns-status></span></div><div data-dns-result></div>`,
      async (data) => showDns(id, { hostname: data.hostname, ip: data.ip }),
      "重新生成指引",
    );
  }
  w.actions["copy-value"] = (node) => w.h.copy(node.dataset.value);
  w.actions["verify-dns"] = async (node) => {
    node.disabled = true;
    const target = $("[data-dns-result]", "#modal-root");
    target.textContent = "正在查询 DNS…";
    try {
      const result = await w.h.api(
        `/admin/manage/domains/${node.dataset.id}/dns/check`,
        {
          method: "POST",
          body: {
            hostname: $("[name=hostname]", "#modal-root")?.value || "",
            ip: $("[name=ip]", "#modal-root")?.value || "",
          },
        },
      );
      if (!target.isConnected) return;
      const labels = {
        passed: "已生效",
        missing: "未查到记录",
        mismatch: "记录不匹配",
        review: "待核对",
        error: "查询失败",
      };
      target.innerHTML =
        table(
          ["完整查询名称", "验证结果", "本次建议值", "实际解析值"],
          (result.items || []).map(
            (r) =>
              `<tr><td>${e(r.type)}<div class="mono dns-value">${e(r.name)}</div></td><td><span class="pill ${r.status === "passed" ? "" : ["missing", "review"].includes(r.status) ? "orange" : "red"}">${e(labels[r.status] || r.status)}</span><p class="hint">${e(r.detail || "")}</p></td><td class="mono dns-value">${e(r.value || "未指定")}</td><td class="mono dns-value">${e((r.found || []).map((v) => (typeof v === "object" ? `${v.priority} ${v.exchange}` : v)).join("\n") || "—")}</td></tr>`,
          ),
        ) +
        `<p class="hint">${e(result.note || "")}<br>检测时间：${e(date(result.checkedAt))}</p>`;
    } catch (error) {
      if (target.isConnected) target.textContent = error.message;
      throw error;
    } finally {
      node.disabled = false;
    }
  };
  w.actions["domain-dns"] = async (node) => {
    const row = domainRow(node);
    if (!w.remote()) return showDns(row.id);
    const records = row.dns_records || {};
    dialog(
      `${row.name} DNS记录`,
      Object.keys(records).length
        ? table(
            ["类型", "主机记录", "记录值"],
            Object.values(records)
              .filter((r) => r && typeof r === "object")
              .map(
                (r) =>
                  `<tr><td>${e(r.type)}</td><td>${e(r.host)}</td><td class="dns-value mono">${e(r.value)}</td></tr>`,
              ),
          )
        : note("当前面板未返回DNS记录，请在该邮局域名控制台查看。"),
    );
  };
  w.actions["domain-catchall"] = async (node) => {
    const row = domainRow(node),
      users = (await w.accountOptions("catchall", { domain: row.name })).items;
    if (w.remote() && w.current()?.type === "billionmail")
      throw new Error(
        "此适配器暂不提供BillionMail捕获设置，请在邮局域名控制台配置",
      );
    dialog(
      "邮件捕获",
      note(
        "将此域名下不存在的收件地址投递到选中的邮箱；已停用的现有邮箱继续拒收。需要转发到外部邮箱时，请到「邮件转发」添加 Catch-all 规则。" +
          (row.catchall_target
            ? " 当前已设置 Catch-all 转发，启用本地捕获将替换该转发规则。"
            : ""),
      ) +
        check("enabled", "启用邮件捕获", Boolean(row.catchall_email)) +
        emailOptionInput(
          "target",
          "捕获目标（可搜索或输入完整邮箱）",
          users,
          row.catchall_email || users[0]?.email,
          "catchall",
          row.name,
        ),
      async (data, form) => {
        await w.operation("domain.catchall", {
          id: row.id,
          domain: row.name,
          target: data.target,
          enabled: checked(form, "enabled"),
        });
        w.closeDialog();
        await w.h.render();
      },
    );
  };

  w.pages.forwards = async () => {
    const result = await w.resource("forwards");
    forwards = result.items;
    return (
      title(
        "邮件转发",
        "支持邮箱转发与 Catch-all：接住域名下不存在地址的来信，转发到指定邮箱。",
        button("批量创建", "forward-batch") +
          button("添加规则", "forward-create", "", ""),
      ) +
      contextNote() +
      `<section class="card selection-panel"><div class="selection-toolbar">${button("删除所选", "forwards-delete", "", "danger small")}</div>${table(
        [allCheck, "类型", "来源", "转发到", "副本", "状态", "操作"],
        forwards.map(
          (row) =>
            `<tr><td>${w.can("forwards.write", row.domain_id, "delete") ? rowCheck(row.id ?? row.address) : ""}</td><td><span class="pill ${isCatchallForward(row) ? "" : "gray"}">${isCatchallForward(row) ? "Catch-all" : "邮箱转发"}</span></td><td class="mono">${e(row.email || row.address)}${isCatchallForward(row) ? '<div class="subline">仅不存在的收件地址</div>' : ""}</td><td class="mono">${e(row.target || row.goto)}</td><td>${isCatchallForward(row) || row.keep_copy === undefined ? "—" : row.keep_copy ? "保留" : "不保留"}</td><td>${status(row.enabled ?? row.active)}</td><td>${w.can("forwards.write", row.domain_id, "update") ? button("编辑", "forward-edit", `data-id="${e(row.id ?? row.address)}"`, "secondary small") : ""}${w.can("forwards.write", row.domain_id, "delete") ? button("删除", "forward-delete", `data-id="${e(row.id ?? row.address)}"`, "danger small") : ""}</td></tr>`,
        ),
      )}</section>`
    );
  };
  const isCatchallForward = (row) =>
    row?.kind === "catchall" || (row?.email || "").startsWith("*@");
  function syncForwardKind(form) {
    if (!form) return;
    const kind = form.elements.namedItem("kind")?.value || "mailbox";
    $$("[data-forward-section]", form).forEach((section) => {
      const hidden = section.dataset.forwardSection !== kind;
      section.hidden = hidden;
      $$("input,select,textarea", section).forEach((field) => {
        field.disabled = hidden;
      });
    });
  }
  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-forward-kind]"))
      syncForwardKind(event.target.form);
  });
  async function forwardDialog(row, batch = false) {
    const kind = isCatchallForward(row) ? "catchall" : "mailbox",
      allowCatchall = !batch && !w.remote(),
      [userOptions, domainOptions] = await Promise.all([
        kind === "catchall" ? { items: [] } : w.accountOptions("forward"),
        allowCatchall && (!row || kind === "catchall")
          ? w.h.api(
              `/admin/manage/domain-options?purpose=forward-catchall${row ? "-update" : ""}`,
            )
          : { items: [] },
      ]),
      users = userOptions.items,
      catchallDomain = (row?.email || "").replace(/^\*@/, ""),
      domainChoices = domainOptions.items.filter((d) =>
        w.can("forwards.write", d.id, row ? "update" : "create"),
      );
    dialog(
      batch ? "批量添加转发" : row ? "编辑转发规则" : "添加转发规则",
      `${
        allowCatchall && !row
          ? select(
              "kind",
              "转发类型",
              [
                ["mailbox", "邮箱转发"],
                ["catchall", "Catch-all（域名兜底）"],
              ],
              kind,
              "data-forward-kind",
            )
          : `<input type="hidden" name="kind" value="${kind}">`
      }<div data-forward-section="mailbox" ${kind !== "mailbox" ? "hidden" : ""}>${
        batch
          ? picker("emails", users, [], "forward")
          : emailOptionInput(
              "email",
              "来源邮箱（可搜索或输入完整邮箱）",
              users,
              row?.email || row?.address,
              "forward",
            )
      }${check("keepCopy", "在来源邮箱保留副本", Boolean(row?.keep_copy ?? true))}</div>${allowCatchall && (!row || kind === "catchall") ? `<div data-forward-section="catchall" ${kind !== "catchall" ? "hidden" : ""}>${select("catchallDomain", "来源域名", [["", "请选择域名"], ...domainChoices.map((d) => [d.name, `*@${d.name}`])], catchallDomain, "required")}${note("仅转发所选域名下不存在地址的来信。已有邮箱按原规则收件，停用邮箱仍拒收。Catch-all 不保存来源副本，每个域名只能设置一条，启用后会替换原有的本地邮件捕获设置。")}</div>` : ""}${input("target", "转发目标邮箱（本地或外部邮箱）", row?.target || row?.goto || "", "email", "required")}${check("enabled", "启用此规则", Boolean(row?.enabled ?? row?.active ?? true))}`,
      async (data, form) => {
        const selectedKind = row ? kind : data.kind || "mailbox";
        if (selectedKind === "catchall" && !data.catchallDomain)
          throw new Error("请选择 Catch-all 来源域名");
        const input = {
          email:
            selectedKind === "catchall"
              ? `*@${data.catchallDomain}`
              : data.email,
          target: data.target,
          id: row?.id,
          enabled: checked(form, "enabled"),
          keepCopy:
            selectedKind === "catchall" ? false : checked(form, "keepCopy"),
        };
        if (batch) {
          const selected = values(form, "emails");
          if (!selected.length) throw new Error("请先选择邮箱");
          if (selected.length > 100) throw new Error("一次最多选择100个邮箱");
          if (!w.remote())
            await w.h.api("/admin/manage/forwards/batch", {
              method: "POST",
              body: { ...input, emails: selected },
            });
          else
            for (const email of selected)
              await w.operation("forward.create", { ...input, email });
        } else
          await w.operation(row ? "forward.update" : "forward.create", input);
        w.closeDialog();
        w.h.toast("转发规则已保存");
        await w.h.render();
      },
    );
    syncForwardKind($('form[data-m-form="dialog"]', "#modal-root"));
  }
  w.actions["forward-create"] = () => forwardDialog();
  w.actions["forward-batch"] = () => forwardDialog(null, true);
  w.actions["forward-edit"] = (node) =>
    forwardDialog(
      forwards.find((row) => String(row.id ?? row.address) === node.dataset.id),
    );
  function removeForwards(items) {
    if (!items.length) throw new Error("请先选择转发规则");
    w.h.confirmAction(
      "删除转发规则",
      `确认删除 ${items.length} 条转发规则？`,
      async () => {
        if (!w.remote())
          await w.h.api("/admin/manage/forwards/delete", {
            method: "POST",
            body: { ids: items.map((r) => r.id) },
          });
        else
          for (const row of items)
            await w.operation("forward.delete", {
              id: row.id,
              email: row.email || row.address,
            });
        await w.h.render();
      },
    );
  }
  w.actions["forward-delete"] = (node) =>
    removeForwards(
      forwards.filter(
        (row) => String(row.id ?? row.address) === node.dataset.id,
      ),
    );
  w.actions["forwards-delete"] = () =>
    removeForwards(
      forwards.filter((row) =>
        selected().includes(String(row.id ?? row.address)),
      ),
    );

  let mailFilter = { folder: "inbox", page: 1, limit: 30, q: "", emails: [] };
  let mailRows = [],
    templates = [];
  w.mailbox = async (folder) => {
    if (mailFilter.folder !== folder)
      mailFilter = { ...mailFilter, folder, page: 1 };
    const admin = w.isAdmin() && ["inbox", "sent", "trash"].includes(folder);
    if (admin) accounts = (await w.accountOptions("read")).items;
    const result = admin
      ? await w.resource(folder, mailFilter)
      : await w.h.api(
          `/messages?${new URLSearchParams({ folder, page: mailFilter.page, q: mailFilter.q })}`,
        );
    mailRows = result.items;
    const names = {
      inbox: "收件箱",
      sent: "发件箱",
      drafts: "草稿箱",
      trash: "垃圾箱",
      starred: "星标邮件",
      archive: "归档邮件",
      spam: "垃圾邮件",
    };
    return (
      title(
        names[folder] || folder,
        "搜索、选择和整理邮件。",
        button("写邮件", "write-mail", "", ""),
      ) +
      contextNote() +
      `<section class="card selection-panel"><form class="toolbar mail-filter" data-m-form="mail-filter">${input("q", "搜索邮件", mailFilter.q, "search")}${admin ? `<details><summary>邮箱范围（${mailFilter.emails.length || "全部"}）</summary>${picker("emails", accounts, mailFilter.emails, "read")}</details>` : ""}<button class="btn secondary" type="submit">筛选</button>${button("刷新", "mail-refresh")}</form><div class="selection-toolbar">${allCheck}<span class="hint">选择当前页</span>${button("标为已读", "mail-batch", 'data-kind="read"', "secondary small")}${button("归档", "mail-batch", 'data-kind="archive"', "secondary small")}${button(folder === "trash" ? "恢复" : "移入垃圾箱", "mail-batch", `data-kind="${folder === "trash" ? "restore" : "trash"}"`, "secondary small")}</div>${result.needsSelection ? note("远程邮局请先选择要查看的邮箱。") : ""}${mailRows.map((m) => `<article class="managed-mail ${m.is_read ? "" : "unread"}"><span>${rowCheck(m.id)}</span><button class="mail-open" data-m-action="mail-open" data-id="${e(m.id)}"><span class="mail-avatar">${e((m.from_name || m.from_email || "?").slice(0, 1))}</span><span class="mail-info"><span class="mail-line"><strong>${e(m.from_name || m.from_email || m.sender)}</strong><time>${date(m.created_at || m.time)}</time></span><span class="mail-subject">${e(m.subject || "（无主题）")}</span><span class="mail-snippet">${e(m.snippet || m.body_text || "")}</span><span class="subline">${e(m.mailbox || "")} ${m.delivery_status ? `· ${e(m.delivery_status)}` : ""} ${m.attachment_count ? "· 有附件" : ""}</span></span></button></article>`).join("") || '<div class="table-empty">暂无邮件</div>'}${w.pager(result.page || mailFilter.page, result.total || 0, result.limit || 30, "mail-page")}</section>`
    );
  };
  w.forms["mail-filter"] = async (data, form) => {
    mailFilter = {
      ...mailFilter,
      q: data.q,
      emails: values(form, "emails"),
      page: 1,
    };
    await w.h.render();
  };
  w.actions["mail-refresh"] = () => w.h.render();
  w.actions["mail-page"] = async (node) => {
    mailFilter.page = Number(node.dataset.page);
    await w.h.render();
  };
  w.actions["write-mail"] = () => {
    w.h.state.draft = null;
    w.h.state.files = [];
    w.navigate("compose");
  };
  w.actions["mail-open"] = async (node) => {
    if (!w.remote() || !["inbox", "sent"].includes(mailFilter.folder))
      return w.h.openMail(node.dataset.id);
    if (w.current()?.type === "node")
      return w.h.openMail(
        node.dataset.id,
        `/admin/connections/${w.connectionId}`,
      );
    const row = mailRows.find((m) => String(m.id) === node.dataset.id);
    dialog(
      row.subject || "邮件详情",
      note("远程列表返回的邮件内容；完整附件与原文请在对应邮局查看。") +
        `<pre class="message-source">${e(row.body_text || row.content || row.snippet || "此接口未返回正文")}</pre>`,
    );
  };
  w.actions["mail-batch"] = async (node) => {
    const ids = selected().map(Number);
    if (!ids.length) throw new Error("请先选择邮件");
    if (w.remote())
      throw new Error("远程适配器暂未提供邮件批量修改接口，请在该邮局操作");
    await w.h.api(
      w.isAdmin() ? "/admin/manage/messages/batch" : "/messages/batch",
      {
        method: "POST",
        body: { ids, action: node.dataset.kind },
      },
    );
    await w.h.render();
  };
  w.decorateMessage = (message) => {
    const body = $(".message-body");
    if (!body) return;
    body.insertAdjacentHTML(
      "beforebegin",
      `<div class="message-tabs tabs">${["正文", "纯文本", "HTML源码"].map((text, i) => button(text, "message-format", `data-format="${i}"`, "secondary small")).join("")}</div>`,
    );
  };
  w.actions["message-format"] = (node) => {
    const m = w.h.state.message,
      body = $(".message-body");
    body.classList.toggle("plain", node.dataset.format !== "0" || !m.body_html);
    body.innerHTML =
      node.dataset.format === "2"
        ? `<pre class="message-source">${e(m.body_html || "无HTML正文")}</pre>`
        : node.dataset.format === "1"
          ? e(m.body_text || "无纯文本正文")
          : m.body_html || e(m.body_text);
  };
  const editor = (html) =>
    `<div class="rich-tools">${[
      ["bold", "粗体"],
      ["italic", "斜体"],
      ["underline", "下划线"],
      ["insertUnorderedList", "列表"],
      ["undo", "撤销"],
    ]
      .map(([command, label]) =>
        button(
          label,
          "editor-command",
          `data-command="${command}"`,
          "secondary small",
        ),
      )
      .join(
        "",
      )}${button("插入链接", "editor-link", "", "secondary small")}</div><div class="rich-editor" contenteditable="true" role="textbox" aria-label="HTML正文" aria-multiline="true">${html || ""}</div><details><summary>编辑 HTML 源码</summary><textarea class="html-source" aria-label="HTML源码"></textarea>${button("应用源码", "editor-source", "", "secondary small")}</details>`;
  const bodyInput = (form) => {
    const html = $(".rich-editor", form)?.innerHTML || "";
    return { html, text: $('[name="text"]', form)?.value || "" };
  };
  const fileList = () =>
    w.h.state.files
      .map(
        (f, i) =>
          `<span class="file-chip">${e(f.filename)} ${button("移除", "attachment-remove", `data-index="${i}"`, "secondary small")}</span>`,
      )
      .join("");
  const emailOptionInput = (name, label, items, value, purpose, domain = "") =>
    input(
      name,
      label,
      value || items[0]?.email || "",
      "email",
      'required list="email-options-' +
        name +
        '" data-email-options="' +
        purpose +
        '" data-domain="' +
        e(domain) +
        '" autocomplete="off"',
    ) +
    '<datalist id="email-options-' +
    name +
    '">' +
    items.map((a) => '<option value="' + e(a.email) + '"></option>').join("") +
    "</datalist>";
  const senderInput = (items, value) =>
    !w.isAdmin()
      ? input("from", "发件邮箱", w.h.state.user.email, "email", "readonly")
      : emailOptionInput(
          "from",
          "发件邮箱（可搜索或输入完整地址）",
          items,
          items.some((a) => a.email === value) ? value : items[0]?.email,
          "send",
        );
  const emailTimers = new WeakMap(),
    emailVersions = new WeakMap();
  document.addEventListener("input", (event) => {
    if (
      !event.target.matches("[data-email-options]") ||
      !w.isAdmin() ||
      w.remote()
    )
      return;
    const field = event.target,
      version = (emailVersions.get(field) || 0) + 1;
    emailVersions.set(field, version);
    clearTimeout(emailTimers.get(field));
    emailTimers.set(
      field,
      setTimeout(async () => {
        try {
          const result = await w.accountOptions(field.dataset.emailOptions, {
            q: field.value,
            ...(field.dataset.domain ? { domain: field.dataset.domain } : {}),
          });
          if (field.isConnected && version === emailVersions.get(field))
            $("#email-options-" + field.name, field.form).innerHTML =
              result.items
                .filter((a) => a.active)
                .map((a) => '<option value="' + e(a.email) + '"></option>')
                .join("");
        } catch (error) {
          if (field.isConnected) w.h.toast(error.message, true);
        }
      }, 300),
    );
  });
  w.compose = async () => {
    templates = (await w.h.api("/templates").catch(() => ({ items: [] })))
      .items;
    const draft = w.h.state.draft || {},
      senders = w.isAdmin()
        ? (await w.accountOptions("send")).items.filter((a) => a.active)
        : [w.h.state.user];
    if (!senders.length)
      return (
        title("写一封邮件", "先添加邮件域名和邮箱，即可选择发件账号。") +
        note("请到「域名列表」添加域名，再到「用户列表」创建邮箱。")
      );
    return (
      title("写一封邮件", "选择发件邮箱，使用模板或编写自己的内容。") +
      contextNote() +
      `<form class="card compose-form managed-compose" data-m-form="compose-rich"><div class="form-grid">${senderInput(senders, draft.from || w.h.state.user.email)}${select("template", "邮件模板", [["", "不使用模板"], ...templates.map((t) => [t.id, t.name])])}</div>${input("to", "收件人", draft.to || "", "text", 'required placeholder="多个邮箱用逗号或换行分隔"')}${input("cc", "抄送", draft.cc || "")}${input("bcc", "密送", draft.bcc || "")}${input("subject", "主题", draft.subject || "", "text", 'maxlength="500"')}<div class="compose-editor">${editor(draft.html)}<details ${!draft.html && draft.text ? "open" : ""}><summary>纯文本正文（兼容不显示 HTML 的客户端）</summary>${textarea("text", "纯文本", draft.text || "")}</details></div><div class="file-list" id="managed-files">${fileList()}</div><div class="compose-footer"><div class="row-actions"><button class="btn" type="submit">发送邮件</button>${!w.remote() && !w.h.clientWorkspace?.() ? button("保存草稿", "draft-save") : ""}<label class="btn secondary">添加附件<input class="sr-only" type="file" data-m-files multiple></label>${button("另存为模板", "template-from-compose")}</div></div></form>`
    );
  };
  w.afterCompose = () => {
    const source = $(".html-source"),
      body = $(".rich-editor");
    if (source && body) source.value = body.innerHTML;
  };
  w.actions["editor-command"] = (node) => {
    const editor = node.closest("form").querySelector(".rich-editor");
    editor.focus();
    document.execCommand(node.dataset.command, false, null);
  };
  w.actions["editor-link"] = () => {
    const url = prompt("链接地址（https://）");
    if (url && !/^https?:\/\//i.test(url))
      throw new Error("请输入HTTP或HTTPS链接");
    if (url) document.execCommand("createLink", false, url);
  };
  w.actions["editor-source"] = (node) => {
    const form = node.closest("form");
    const source = $(".html-source", form).value;
    const parsed = new DOMParser().parseFromString(source, "text/html");
    for (const tag of parsed.querySelectorAll(
      "script,iframe,object,embed,style,link,meta,svg,math",
    ))
      tag.remove();
    for (const element of parsed.body.querySelectorAll("*"))
      for (const attribute of [...element.attributes])
        if (
          attribute.name.startsWith("on") ||
          !["href", "title", "colspan", "rowspan"].includes(attribute.name) ||
          (attribute.name === "href" && !/^https?:\/\//i.test(attribute.value))
        )
          element.removeAttribute(attribute.name);
    $(".rich-editor", form).replaceChildren(...parsed.body.childNodes);
  };
  w.forms["compose-rich"] = async (data, form) => {
    await w.operation("send", {
      ...data,
      ...bodyInput(form),
      attachments: w.h.state.files,
      draftId: !w.remote() ? w.h.state.draft?.id : undefined,
    });
    w.h.state.files = [];
    w.h.state.draft = null;
    w.h.toast("邮件已接收，外部投递状态可在发件箱查看");
    w.navigate("sent");
  };
  w.actions["draft-save"] = async (node) => {
    const form = node.closest("form"),
      data = w.data(form),
      id = w.h.state.draft?.id;
    const result = await w.h.api("/drafts", {
      method: "POST",
      body: { ...data, ...bodyInput(form), id, attachments: w.h.state.files },
    });
    w.h.state.draft = { ...data, ...bodyInput(form), id: result.id || id };
    w.h.toast("草稿已保存在当前登录邮箱");
  };
  w.actions["attachment-remove"] = (node) => {
    w.h.state.files.splice(Number(node.dataset.index), 1);
    $("#managed-files").innerHTML = fileList();
  };
  document.addEventListener("change", async (event) => {
    if (event.target.matches("[data-m-files]")) {
      try {
        for (const file of event.target.files) {
          if (file.size > 15 * 1024 * 1024)
            throw new Error("单个附件不能超过15MB");
          const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          w.h.state.files.push({
            filename: file.name,
            contentType: file.type,
            content,
          });
        }
        $("#managed-files").innerHTML = fileList();
      } catch (error) {
        w.h.toast(error.message, true);
      }
      event.target.value = "";
    }
    if (
      event.target.name === "template" &&
      event.target.closest(
        '[data-m-form="compose-rich"],[data-m-form="bulk-rich"]',
      )
    ) {
      const template = templates.find(
        (t) => String(t.id) === event.target.value,
      );
      if (template) {
        const form = event.target.form;
        form.elements.subject.value = template.subject;
        $(".rich-editor", form).innerHTML = template.body_html || "";
        form.elements.text.value = template.body_text || "";
        w.afterCompose();
      }
    }
  });
  function templateDialog(row) {
    dialog(
      row ? "编辑模板" : "创建模板",
      input("name", "模板名称", row?.name || "", "text", "required") +
        input("subject", "主题", row?.subject || "") +
        textarea("html", "HTML正文", row?.body_html || "", 'rows="10"') +
        textarea("text", "纯文本备用正文", row?.body_text || ""),
      async (data) => {
        await w.h.api(row ? `/templates/${row.id}` : "/templates", {
          method: row ? "PATCH" : "POST",
          body: data,
        });
        w.closeDialog();
        await w.h.render();
      },
    );
  }
  w.pages.templates = async () => {
    templates = (await w.h.api("/templates").catch(() => ({ items: [] })))
      .items;
    return (
      title(
        "邮件模板",
        "当前账号的常用邮件内容。",
        button("创建模板", "template-create", "", ""),
      ) +
      `<section class="card">${table(
        ["名称", "主题", "更新时间", "操作"],
        templates.map(
          (t) =>
            `<tr><td>${e(t.name)}</td><td>${e(t.subject)}</td><td>${date(t.updated_at)}</td><td>${button("使用", "template-use", `data-id="${t.id}"`, "secondary small")}${button("编辑", "template-edit", `data-id="${t.id}"`, "secondary small")}${button("删除", "template-delete", `data-id="${t.id}"`, "danger small")}</td></tr>`,
        ),
      )}</section>`
    );
  };
  w.actions["template-create"] = () => templateDialog();
  w.actions["template-edit"] = (node) =>
    templateDialog(templates.find((t) => t.id === Number(node.dataset.id)));
  w.actions["template-delete"] = (node) =>
    w.h.confirmAction("删除模板", "确定删除此模板？", async () => {
      await w.h.api(`/templates/${node.dataset.id}`, { method: "DELETE" });
      await w.h.render();
    });
  w.actions["template-use"] = (node) => {
    const t = templates.find((t) => t.id === Number(node.dataset.id));
    w.h.state.draft = {
      subject: t.subject,
      html: t.body_html,
      text: t.body_text,
    };
    w.navigate("compose");
  };
  w.actions["template-from-compose"] = (node) => {
    const form = node.closest("form"),
      content = { ...w.data(form), ...bodyInput(form) };
    dialog(
      "另存为模板",
      input("name", "模板名称", "", "text", "required"),
      async (data) => {
        await w.h.api("/templates", {
          method: "POST",
          body: { ...content, name: data.name },
        });
        w.closeDialog();
        w.h.toast("模板已保存");
      },
    );
  };
  w.pages["bulk-send"] = async () => {
    accounts = (await w.accountOptions("send")).items;
    templates = (await w.h.api("/templates").catch(() => ({ items: [] })))
      .items;
    return (
      title("批量群发", "为每个收件人分别生成一封邮件。") +
      contextNote() +
      `<form class="card form-card" data-m-form="bulk-rich">${senderInput(
        accounts.filter((a) => a.active),
        w.h.state.user.email,
      )}${!w.remote() ? check("randomSender", "从有权限的普通邮箱中随机分配发件人") : ""}${select("template", "邮件模板", [["", "不使用模板"], ...templates.map((t) => [t.id, t.name])])}${textarea("recipients", "收件邮箱列表", "", 'required rows="5" placeholder="每行一个，或用逗号分隔"')}<label class="btn secondary">导入 TXT / CSV<input type="file" class="sr-only" accept=".txt,.csv" data-recipient-import></label>${input("subject", "主题", "", "text", "required")}${editor("")}${textarea("text", "纯文本备用正文")}<button type="submit" class="btn">开始群发</button></form>`
    );
  };
  document.addEventListener("change", async (event) => {
    if (
      event.target.matches("[data-recipient-import]") &&
      event.target.files[0]
    ) {
      const file = event.target.files[0];
      if (file.size > 1024 * 1024) return w.h.toast("导入文件需小于1MB", true);
      const emails =
        (await file.text()).match(
          /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        ) || [];
      event.target.form.elements.recipients.value = [...new Set(emails)].join(
        "\n",
      );
    }
  });
  w.forms["bulk-rich"] = async (data, form) => {
    const emails = [
      ...new Set(data.recipients.split(/[\s,;，；]+/).filter(Boolean)),
    ];
    if (!emails.length || emails.length > 100)
      throw new Error("每批填写1–100个收件邮箱");
    const content = {
      ...data,
      ...bodyInput(form),
      randomSender: checked(form, "randomSender"),
    };
    w.showProgress("群发进度", emails.length);
    const results = [];
    for (let i = 0; i < emails.length; i += 10) {
      const chunk = emails.slice(i, i + 10);
      try {
        const result = await w.operation("bulk-send", {
          ...content,
          recipients: chunk.join("\n"),
        });
        results.push(
          ...(result.items ||
            chunk.map((email) => ({ email, ok: true, taskId: result.taskId }))),
        );
      } catch (error) {
        results.push(
          ...chunk.map((email) => ({ email, ok: false, error: error.message })),
        );
      }
      w.progress(results.length, emails.length, "系统接收处理中");
    }
    const target = $("[data-progress-result]", "#modal-root");
    if (target)
      target.innerHTML =
        table(
          ["收件人", "结果"],
          results.map(
            (r) =>
              `<tr><td>${e(r.email)}</td><td>${r.ok ? "已接收" : e(r.error)}</td></tr>`,
          ),
        ) + note("接收表示任务已创建，最终送达请查看投递队列或远程邮局。");
  };
  w.pages["batch-password"] = async () => {
    accounts = (await w.accountOptions("password")).items.filter(
      (a) => w.remote() || a.id !== w.h.state.user.id,
    );
    return (
      title("批量改密", "选择邮箱或手动填写，更新后会撤销原登录会话。") +
      contextNote() +
      `<form class="card form-card" data-m-form="password-batch">${picker("emails", accounts, [], "password")}${textarea("manual", "也可手动输入邮箱", "", 'placeholder="每行一个邮箱"')}${check("random", "使用随机密码", true)}${input("password", "固定密码（关闭随机时使用）", "", "password", 'minlength="12"')}${input("length", "随机密码长度", 16, "number", 'min="12" max="64"')}<button class="btn" type="submit">更新密码</button><div data-password-result></div></form>`
    );
  };
  w.forms["password-batch"] = async (data, form) => {
    const emails = [
      ...new Set([
        ...values(form, "emails"),
        ...data.manual.split(/[\s,;]+/).filter(Boolean),
      ]),
    ];
    if (!emails.length || emails.length > 100)
      throw new Error("请选择1–100个邮箱");
    let items;
    if (!w.remote())
      items = (
        await w.h.api("/admin/manage/accounts/passwords", {
          method: "POST",
          body: {
            emails,
            password: checked(form, "random") ? "" : data.password,
            length: Number(data.length),
          },
        })
      ).items;
    else {
      items = [];
      for (const email of emails) {
        const random = Array.from(
          crypto.getRandomValues(new Uint8Array(Number(data.length))),
        )
          .map(
            (n) =>
              "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%"[
                n %
                  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%"
                    .length
              ],
          )
          .join("");
        const password = checked(form, "random") ? random : data.password;
        try {
          await w.operation("account.update", {
            email,
            password,
            id: accounts.find((a) => a.email === email)?.id,
            name: accounts.find((a) => a.email === email)?.name,
            active: Boolean(
              accounts.find((a) => a.email === email)?.active ?? true,
            ),
            quotaMB: Math.max(
              1,
              Math.round(
                (accounts.find((a) => a.email === email)?.quota_bytes ||
                  1073741824) / 1048576,
              ),
            ),
          });
          items.push({ email, password });
        } catch (error) {
          items.push({ email, error: error.message });
        }
      }
    }
    w.h.credentials(items, $("[data-password-result]", form));
    w.h.toast("处理完成，导出后请妥善保管密码");
  };
})();
