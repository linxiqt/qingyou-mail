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
      checked,
      values,
    } = w;
  let managers = [],
    domains = [],
    keys = [],
    featureRows = [];
  const refresh = async () => {
    await w.loadPreferences();
    w.h.shell();
    await w.h.render();
  };
  w.pages.connections = async () =>
    title("多邮局管理暂时停用", "当前仅管理本机邮局，原有连接配置已保留。") +
    note("后续恢复该功能后，可继续使用已保存的连接。");

  let permissionCatalog = { capabilities: [], presets: [] };
  const roleName = (m) =>
    m.client_manager
      ? "普通用户 · 域名管理"
      : m.admin_scope !== "scoped"
        ? "超级管理员"
        : permissionCatalog.presets.find((p) => p.id === m.role_preset)?.name ||
          "自定义管理员";
  w.pages.managers = async () => {
    [managers, domains, permissionCatalog] = await Promise.all([
      w.h.api("/admin/managers").then((r) => r.items),
      w.h.api("/admin/manage/domains").then((r) => r.items),
      w.h.api("/admin/permission-catalog"),
    ]);
    return (
      title(
        "权限管理",
        "管理员使用后台；普通用户在客户端管理被分配的域名和功能。",
        button("添加授权成员", "manager-create", "", ""),
      ) +
      '<div class="management-metrics">' +
      metric("管理账号", managers.length, "所有管理成员") +
      metric(
        "超级管理员",
        managers.filter((m) => m.role === "admin" && m.admin_scope !== "scoped")
          .length,
        "可配置系统与分配权限",
      ) +
      metric(
        "按域名授权成员",
        managers.filter((m) => m.admin_scope === "scoped" || m.client_manager)
          .length,
        "功能权限与域名范围同时生效",
      ) +
      "</div>" +
      '<section class="card"><div class="card-header"><h2>管理成员</h2><span class="hint">权限修改后，该成员需重新登录</span></div>' +
      table(
        ["成员", "管理级别", "授权范围", "状态", "操作"],
        managers.map(
          (m) =>
            '<tr><td><div class="member-identity"><span class="mail-avatar">' +
            e((m.name || m.email).slice(0, 1)) +
            "</span><div><strong>" +
            e(m.name) +
            '</strong><div class="subline mono">' +
            e(m.email) +
            '</div></div></div></td><td><span class="pill ' +
            (m.admin_scope === "scoped" ? "gray" : "") +
            '">' +
            e(roleName(m)) +
            "</span>" +
            (m.id === w.h.state.user.id
              ? '<span class="subline">当前账号</span>'
              : "") +
            "</td><td>" +
            (m.admin_scope === "scoped"
              ? "<strong>" +
                m.permissions.length +
                ' 个域名</strong><div class="subline">' +
                m.capabilities.length +
                " 项功能权限</div>"
              : "全部域名与系统设置") +
            "</td><td>" +
            status(m.active) +
            "</td><td>" +
            button(
              "编辑权限",
              "manager-edit",
              'data-id="' + m.id + '"',
              "secondary small",
            ) +
            "</td></tr>",
        ),
      ) +
      "</section>" +
      note(
        "普通用户只能在客户端管理已授权域名。邮箱地址所属域名不会自动获得管理权限；请通过邮箱用户列表的「分配权限」配置已有账号。",
      )
    );
  };
  function metric(label, value, caption) {
    return (
      '<section class="management-metric"><span>' +
      e(label) +
      "</span><strong>" +
      e(value) +
      "</strong><small>" +
      e(caption) +
      "</small></section>"
    );
  }
  function managerDialog(row) {
    const preset =
      row?.role_preset && row.role_preset !== "legacy"
        ? row.role_preset
        : "custom";
    const chosen = row
      ? row.capabilities || []
      : permissionCatalog.presets.find((p) => p.id === "client_manager")
          ?.capabilities || [];
    const groups = [
      ...new Set(permissionCatalog.capabilities.map((c) => c.group)),
    ];
    dialog(
      row ? "编辑成员权限" : "添加授权成员",
      '<div class="form-grid">' +
        input(
          "email",
          row?.management_only ? "管理账号" : "登录邮箱",
          row?.email || "",
          row?.management_only ? "text" : "email",
          "required " + (row ? "readonly" : ""),
        ) +
        input("name", "显示名称", row?.name || "") +
        input(
          "password",
          row ? "新密码（留空保留）" : "密码",
          "",
          "password",
          'minlength="12" autocomplete="new-password" ' +
            (row ? "" : "required"),
        ) +
        select(
          "scope",
          "管理级别",
          [
            ...(!row?.management_only
              ? [
                  ["client", "普通用户 · 客户端域名管理"],
                  ["scoped", "受限管理员 · 后台按域名授权"],
                ]
              : []),
            ["global", "超级管理员 · 全部权限"],
            ...(row && !row.management_only && row.id !== w.h.state.user.id
              ? [["user", "普通用户 · 撤销管理权限"]]
              : []),
          ],
          row?.client_manager
            ? "client"
            : row?.role === "user"
              ? "user"
              : row?.admin_scope || "client",
          row?.id === w.h.state.user.id ? "disabled" : "",
        ) +
        "</div>" +
        '<div data-scoped-editor><div class="permission-section-heading"><h3>01 / 功能权限</h3><span class="hint">选择模板后可逐项调整</span></div>' +
        select(
          "rolePreset",
          "权限模板",
          permissionCatalog.presets.map((p) => [p.id, p.name]),
          row ? preset : "client_manager",
        ) +
        '<p class="hint" data-preset-description></p><div class="permission-groups">' +
        groups
          .map(
            (group) =>
              '<fieldset class="permission-group"><legend>' +
              e(group) +
              "</legend>" +
              permissionCatalog.capabilities
                .filter((c) => c.group === group)
                .map((c) =>
                  check(
                    "capabilities",
                    c.name,
                    chosen.includes(c.id),
                    'value="' + e(c.id) + '"',
                  ),
                )
                .join("") +
              "</fieldset>",
          )
          .join("") +
        "</div>" +
        '<div class="permission-section-heading"><h3>02 / 域名范围</h3><span class="hint">功能权限与下方操作权限取交集</span></div>' +
        table(
          ["域名", "查看", "新增", "修改", "删除"],
          domains.map((d) => {
            const grant =
              row?.permissions?.find((p) => p.domain_id === d.id) || {};
            return (
              '<tr data-grant="' +
              d.id +
              '"><td><strong>' +
              e(d.name) +
              "</strong></td>" +
              ["read", "create", "update", "delete"]
                .map(
                  (k, i) =>
                    "<td>" +
                    check(
                      "grant-" + d.id + "-" + k,
                      "",
                      Boolean(grant["can_" + k]),
                      'aria-label="' +
                        e(d.name) +
                        " " +
                        ["查看", "新增", "修改", "删除"][i] +
                        '"',
                    ) +
                    "</td>",
                )
                .join("") +
              "</tr>"
            );
          }),
          "请先添加邮件域名",
        ) +
        "</div><div data-global-summary>" +
        note(
          "超级管理员拥有全部功能，可修改其他管理员权限、域名数量上限与系统配置。",
        ) +
        "</div><div data-user-summary>" +
        note("撤销后保留个人邮箱，不能访问管理后台。") +
        "</div>" +
        '<div class="permission-section-heading"><h3>账号状态</h3></div>' +
        check(
          "active",
          "启用账号",
          Boolean(row?.active ?? true),
          row?.id === w.h.state.user.id ? "disabled" : "",
        ) +
        input("note", "备注", row?.note || "", "text", 'maxlength="500"'),
      async (data, form) => {
        const permissions = $$("[data-grant]", form)
          .map((tr) => ({
            domain_id: Number(tr.dataset.grant),
            ...Object.fromEntries(
              ["read", "create", "update", "delete"].map((k) => [
                "can_" + k,
                checked(form, "grant-" + tr.dataset.grant + "-" + k),
              ]),
            ),
          }))
          .filter(
            (p) => p.can_read || p.can_create || p.can_update || p.can_delete,
          );
        await w.h.api(row ? "/admin/managers/" + row.id : "/admin/managers", {
          method: row ? "PATCH" : "POST",
          body: {
            ...data,
            scope: form.elements.scope.value,
            rolePreset: data.rolePreset || preset,
            capabilities: values(form, "capabilities"),
            active: checked(form, "active"),
            permissions,
          },
        });
        w.closeDialog();
        w.h.toast("管理权限已保存，其他成员的旧登录会话已撤销");
        await w.h.render();
      },
    );
    updatePermissionEditor($("#modal-root form"));
  }
  function updatePermissionEditor(form) {
    if (!form?.elements.scope) return;
    const scope = form.elements.scope.value;
    const clientAllowed =
      permissionCatalog.clientCapabilities ||
      permissionCatalog.capabilities
        .map((c) => c.id)
        .filter((id) => !["domains.update", "domains.delete"].includes(id));
    $$('input[name="capabilities"]', form).forEach((input) => {
      input.disabled =
        scope === "client" && !clientAllowed.includes(input.value);
      if (input.disabled) input.checked = false;
    });
    $("[data-scoped-editor]", form).hidden = !["scoped", "client"].includes(
      scope,
    );
    $("[data-global-summary]", form).hidden = scope !== "global";
    $("[data-user-summary]", form).hidden = scope !== "user";
    const preset = permissionCatalog.presets.find(
      (p) => p.id === form.elements.rolePreset.value,
    );
    $("[data-preset-description]", form).textContent =
      preset?.description || "逐项选择这个成员需要的功能。";
  }
  document.addEventListener("change", (event) => {
    const form = event.target.form;
    if (!form?.querySelector("[data-scoped-editor]")) return;
    if (event.target.name === "rolePreset" && event.target.value !== "custom") {
      const preset = permissionCatalog.presets.find(
        (p) => p.id === event.target.value,
      );
      $$('input[name="capabilities"]', form).forEach((input) => {
        input.checked = Boolean(preset?.capabilities.includes(input.value));
      });
    }
    if (event.target.name === "capabilities")
      form.elements.rolePreset.value = "custom";
    updatePermissionEditor(form);
  });
  w.actions["manager-create"] = () => managerDialog();
  w.actions["manager-edit"] = (node) =>
    managerDialog(managers.find((r) => r.id === Number(node.dataset.id)));
  w.editClientPermissions = async (account) => {
    if (!w.isGlobal() || w.remote())
      throw new Error("仅本机超级管理员可分配权限");
    [managers, domains, permissionCatalog] = await Promise.all([
      w.h.api("/admin/managers").then((r) => r.items),
      w.h.api("/admin/manage/domains").then((r) => r.items),
      w.h.api("/admin/permission-catalog"),
    ]);
    const existing = managers.find((row) => row.id === account.id);
    managerDialog(
      existing || {
        ...account,
        client_manager: true,
        admin_scope: "scoped",
        role_preset: "client_manager",
        permissions: [],
        capabilities:
          permissionCatalog.presets.find((p) => p.id === "client_manager")
            ?.capabilities || [],
      },
    );
  };

  w.pages.api = async () => {
    keys = (await w.h.api("/admin/api-keys")).items;
    return (
      title(
        "邮件推送 API",
        "按密钥设置发件身份、收件范围、IP 和每日额度。",
        button("创建密钥", "key-create", "", ""),
      ) +
      `<section class="card">${table(
        ["名称", "权限", "额度与范围", "操作"],
        keys.map(
          (k) =>
            `<tr><td>${e(k.name)}<div class="subline mono">${e(k.prefix)}…</div></td><td>${e(k.scopes.join(", "))}</td><td>每日 ${k.policy.dailyLimit || "不限"}<div class="subline">${e(k.policy.defaultSender || "管理员邮箱")}</div></td><td>${button("策略", "key-edit", `data-id="${k.id}"`, "secondary small")}${button("撤销", "key-delete", `data-id="${k.id}"`, "danger small")}</td></tr>`,
        ),
      )}</section><section class="card form-card"><h2>调用示例</h2><p>密钥仅创建时显示一次，放在 Authorization 中。每日额度按 UTC 日期和不同收件地址数量计数，抄送、密送也会检查。</p><pre class="message-source">${e(`curl '${location.origin}/api/v1/send' \\\n  -H 'Authorization: Bearer po_你的密钥' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"to":"user@example.com","subject":"你好","text":"邮件正文"}'`)}</pre><p class="hint">兼容 POST /api/send_mail 的 apiKey、content 和 subtype 字段。management 权限允许管理邮局，请只授予可信平台。</p></section>`
    );
  };
  function keyDialog(row) {
    const p = row?.policy || {};
    dialog(
      row ? "编辑密钥策略" : "创建 API 密钥",
      input("name", "名称", row?.name || "", "text", "required") +
        (!row
          ? `<div class="form-section">${["mail:send", "mail:read", "codes:read", "management"].map((scope) => check("scopes", scope, scope === "mail:send", `value="${scope}"`)).join("")}</div>`
          : "") +
        input("defaultSender", "默认发件邮箱", p.defaultSender || "") +
        textarea(
          "allowedSenders",
          "允许发件邮箱（留空表示全部）",
          (p.allowedSenders || []).join("\n"),
        ) +
        textarea(
          "allowedRecipientDomains",
          "允许收件域名（留空表示全部）",
          (p.allowedRecipientDomains || []).join("\n"),
        ) +
        input(
          "dailyLimit",
          "每日收件地址额度（0为不限）",
          p.dailyLimit || 0,
          "number",
          'min="0" max="100000"',
        ) +
        textarea(
          "ipAllowlist",
          "允许 IP / CIDR（留空表示全部）",
          p.ipAllowlist || "",
        ),
      async (data, form) => {
        const policy = { ...data, dailyLimit: Number(data.dailyLimit) };
        const result = await w.h.api(
          row ? `/admin/api-keys/${row.id}` : "/admin/api-keys",
          {
            method: row ? "PATCH" : "POST",
            body: { name: data.name, scopes: values(form, "scopes"), policy },
          },
        );
        w.closeDialog();
        await w.h.render();
        if (result.token)
          dialog(
            "保存 API 密钥",
            note("完整密钥只显示这一次，请立即复制保存。") +
              `<pre class="message-source">${e(result.token)}</pre>` +
              button(
                "复制密钥",
                "copy-value",
                `data-value="${e(result.token)}"`,
              ),
          );
      },
    );
  }
  w.actions["key-create"] = () => keyDialog();
  w.actions["key-edit"] = (node) =>
    keyDialog(keys.find((r) => r.id === Number(node.dataset.id)));
  w.actions["key-delete"] = (node) =>
    w.h.confirmAction(
      "撤销密钥",
      "使用此密钥的程序将立即失去访问权限。",
      async () => {
        await w.h.api(`/admin/api-keys/${node.dataset.id}`, {
          method: "DELETE",
        });
        await w.h.render();
      },
    );

  w.pages.platform = async () => {
    const [p, d] = await Promise.all([
      w.h.api("/admin/platform"),
      w.h.api("/admin/manage/domains"),
    ]);
    return (
      title(
        "平台设置",
        "外观、访问体验与邮件保留策略。",
        button("备份管理", "platform-backups"),
      ) +
      `<form class="card form-card" data-m-form="platform"><h2>品牌与外观</h2><div class="form-grid">${input("name", "系统名称", p.name, "text", "required")}${input("copyright", "页脚版权", p.copyright)}${input("logoUrl", "Logo 图片地址", p.logoUrl)}${input("icpText", "备案文字（可选）", p.icpText)}${input("icpUrl", "备案链接", p.icpUrl, "url")}${select(
        "theme",
        "默认主题",
        [
          ["auto", "跟随系统"],
          ["light", "浅色"],
          ["dark", "深色"],
        ],
        p.theme,
      )}${select(
        "layout",
        "导航布局",
        [
          ["vertical", "左侧导航"],
          ["horizontal", "顶部导航"],
        ],
        p.layout,
      )}${select(
        "backgroundType",
        "背景类型",
        [
          ["color", "纯色"],
          ["image", "图片"],
        ],
        p.backgroundType,
      )}${input("backgroundColor", "背景颜色", p.backgroundColor, "color")}${input("backgroundImage", "背景图片地址", p.backgroundImage)}${input("backgroundOpacity", "背景图片可见度（0–100）", p.backgroundOpacity, "number", 'min="10" max="100"')}</div><label class="btn secondary">上传品牌图片<input type="file" class="sr-only" data-brand-upload accept="image/png,image/jpeg,image/webp,image/gif"></label>${button("图片管理", "brand-assets")}<span class="hint" data-upload-result></span>${textarea("announcement", "公告", p.announcement)}<h2>性能</h2>${check("cacheEnabled", "缓存账号与域名列表", p.cacheEnabled)}${input("cacheSeconds", "缓存秒数", p.cacheSeconds, "number", 'min="0" max="300"')}${input("batchConcurrency", "批量任务并发数", p.batchConcurrency, "number", 'min="1" max="8"')}${button("清除缓存", "cache-clear")}<h2>自动清理</h2>${note("默认关闭。启用后每小时将过期邮件移入垃圾箱；永久删除仅处理已在垃圾箱停留达到期限的邮件。")}${check("retentionEnabled", "启用自动清理", p.retentionEnabled)}${input("retentionDays", "邮件保留天数", p.retentionDays, "number", 'min="1" max="3650"')}${input("purgeTrashDays", "垃圾箱保留天数（0不永久删除）", p.purgeTrashDays, "number", 'min="0" max="3650"')}<label>清理域名范围（不选表示全部）</label>${picker(
        "retentionDomains",
        d.items.map((x) => x.name),
        p.retentionDomains,
      )}${check("confirmRetention", "我已核对自动清理范围和期限")}<div class="form-actions"><button class="btn" type="submit">保存设置</button>${button("手动清理预览", "cleanup-preview")}</div></form>`
    );
  };
  w.forms.platform = async (data, form) => {
    const body = {
      ...data,
      retentionDomains: values(form, "retentionDomains"),
    };
    for (const key of ["cacheEnabled", "retentionEnabled", "confirmRetention"])
      body[key] = checked(form, key);
    await w.h.api("/admin/platform", { method: "PUT", body });
    await refresh();
    w.h.toast("平台设置已保存");
  };
  w.actions["cache-clear"] = async () => {
    await w.h.api("/admin/platform/cache/clear", { method: "POST", body: {} });
    w.h.toast("缓存已清除");
  };
  async function backups() {
    const result = await w.h.api("/admin/platform/backups");
    dialog(
      "数据备份",
      note(
        "数据库备份包含邮件、账号密码哈希、邮局连接凭据与 DKIM 私钥，请保存在可信设备。服务器环境配置和 TLS 证书需另行备份。",
      ) +
        button("创建在线备份", "backup-create", "", "") +
        table(
          ["备份文件", "大小", "操作"],
          result.items.map(
            (row) =>
              `<tr><td class="mono wrap-anywhere">${e(row.name)}</td><td>${(row.size / 1048576).toFixed(1)} MB</td><td><a class="btn secondary small" href="${e(row.url)}" download>下载</a></td></tr>`,
          ),
        ),
    );
  }
  w.actions["platform-backups"] = backups;
  w.actions["backup-create"] = async () => {
    await w.h.api("/admin/platform/backup", { method: "POST", body: {} });
    await backups();
    w.h.toast("备份已创建");
  };
  w.actions["brand-assets"] = async () => {
    const result = await w.h.api("/admin/platform/assets");
    dialog(
      "品牌图片",
      table(
        ["图片", "地址", "操作"],
        result.items.map(
          (row) =>
            `<tr><td><img src="${e(row.url)}" width="70" height="45" style="object-fit:contain" alt="品牌图片预览"></td><td class="mono wrap-anywhere">${e(row.url)}</td><td>${button("复制地址", "copy-value", `data-value="${e(row.url)}"`, "secondary small")}${button("删除", "brand-asset-delete", `data-id="${e(row.id)}"`, "danger small")}</td></tr>`,
        ),
      ),
    );
  };
  w.actions["brand-asset-delete"] = (node) =>
    w.h.confirmAction("删除图片", "确定删除未使用的品牌图片？", async () => {
      await w.h.api(`/admin/platform/assets/${node.dataset.id}`, {
        method: "DELETE",
      });
      w.closeDialog();
      w.h.toast("图片已删除");
    });
  document.addEventListener("change", async (event) => {
    if (!event.target.matches("[data-brand-upload]") || !event.target.files[0])
      return;
    try {
      const file = event.target.files[0];
      if (file.size > 5 * 1024 * 1024) throw new Error("图片需小于5MB");
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const result = await w.h.api("/admin/platform/assets", {
        method: "POST",
        body: { content },
      });
      $("[data-upload-result]").textContent =
        `图片地址：${result.url}（填入 Logo 或背景图片地址）`;
      await w.h.copy(result.url);
    } catch (error) {
      w.h.toast(error.message, true);
    }
  });
  w.actions["cleanup-preview"] = () =>
    dialog(
      "邮件清理预览",
      select("mode", "清理方式", [
        ["trash", "移入垃圾箱"],
        ["purge", "永久删除垃圾箱邮件"],
      ]) +
        input(
          "days",
          "创建超过多少天（0为全部）",
          90,
          "number",
          'min="0" max="3650"',
        ) +
        textarea("domains", "限制域名（留空表示全部）"),
      async (data) => {
        const result = await w.h.api("/admin/platform/cleanup/preview", {
            method: "POST",
            body: data,
          }),
          phrase = result.mode === "purge" ? "永久删除" : "移入垃圾箱";
        dialog(
          "确认清理范围",
          note(
            `本次将${phrase} ${result.count} 封邮件。此预览5分钟内有效，最多5000封。`,
          ) +
            input(
              "confirmation",
              `输入「${phrase}」确认`,
              "",
              "text",
              "required",
            ),
          async (value) => {
            await w.h.api("/admin/platform/cleanup/execute", {
              method: "POST",
              body: { token: result.token, confirmText: value.confirmation },
            });
            w.closeDialog();
            w.h.toast("清理完成");
          },
          "执行清理",
        );
      },
      "生成预览",
    );

  w.pages.features = async () => {
    featureRows = (await w.h.api("/admin/features")).items;
    return (
      title("功能管理", "调整导航入口的顺序、显示状态与功能开关。") +
      note(
        "权限管理归入用户列表，其余系统功能归入系统设置；显示开关控制对应入口或页签。隐藏后仍可通过地址访问，停用会关闭对应页面和工具接口。多邮局管理暂时停用。",
      ) +
      `<form class="card" data-m-form="features">${table(
        ["功能", "显示入口", "启用功能", "排序"],
        featureRows.map(
          (f, i) =>
            `<tr><td>${e(f.name)} ${f.paused ? '<span class="pill orange">暂时停用</span>' : f.core ? '<span class="pill gray">核心</span>' : ""}</td><td>${check(`show-${f.id}`, "显示", f.show, f.core || f.paused ? "disabled" : "")}</td><td>${check(`enable-${f.id}`, "启用", f.enabled, f.core || f.paused ? "disabled" : "")}</td><td>${button("↑", "feature-move", `data-index="${i}" data-step="-1" ${i === 0 ? "disabled" : ""}`, "secondary small")}${button("↓", "feature-move", `data-index="${i}" data-step="1" ${i === featureRows.length - 1 ? "disabled" : ""}`, "secondary small")}</td></tr>`,
        ),
      )}<div class="form-actions"><button class="btn" type="submit">保存功能设置</button></div></form>`
    );
  };
  w.actions["feature-move"] = (node) => {
    const i = Number(node.dataset.index),
      j = i + Number(node.dataset.step);
    const form = node.closest("form");
    featureRows.forEach((f) => {
      f.show = !f.paused && (f.core || checked(form, `show-${f.id}`));
      f.enabled = !f.paused && (f.core || checked(form, `enable-${f.id}`));
    });
    [featureRows[i], featureRows[j]] = [featureRows[j], featureRows[i]];
    const rows = $$("tbody tr", form);
    if (j < i) rows[j].before(rows[i]);
    else rows[j].after(rows[i]);
    $$('[data-m-action="feature-move"]', form).forEach((b) => {
      const row = b.closest("tr"),
        index = $$("tbody tr", form).indexOf(row);
      b.dataset.index = index;
      b.disabled =
        Number(b.dataset.step) < 0
          ? index === 0
          : index === featureRows.length - 1;
    });
  };
  w.forms.features = async (_data, form) => {
    await w.h.api("/admin/features", {
      method: "PUT",
      body: {
        items: featureRows.map((f) => ({
          id: f.id,
          show: !f.paused && (f.core || checked(form, `show-${f.id}`)),
          enabled: !f.paused && (f.core || checked(form, `enable-${f.id}`)),
        })),
      },
    });
    await refresh();
    w.h.toast("功能设置已保存");
  };
  w.pages.about = async () =>
    title("程序信息", "青邮 · Node.js 自托管邮局") +
    `<section class="card form-card"><h2>自己的域名，自己的邮件</h2><p>网页邮箱、SMTP 收发、Rspamd DKIM、投递队列和管理工具在同一套系统中运行。</p><p>管理工具功能参考用户提供的邮友 v1.4.7-test，使用青邮独立实现。多邮局管理目前暂停，当前仅使用本机邮局。</p><p><a href="/getting-started.html">部署与使用说明</a></p><p class="hint">功能版本：2026.10 · 管理工具扩展</p></section>`;
})();
