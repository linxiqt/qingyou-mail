(() => {
  let h,
    tab = "links",
    query = "",
    editor = null,
    newLink = false,
    data = {},
    timer,
    publicVersion = 0;
  let batchMode = "generate",
    batchResults = [];
  const $ = (selector, root = document) => root.querySelector(selector);
  const val = (form, name) => form.elements.namedItem(name)?.value || "";
  const checked = (form, name) =>
    Boolean(form.elements.namedItem(name)?.checked);
  const e = (value) => h.esc(value);
  const button = (label, action, extra = "", kind = "") =>
    `<button type="button" class="tool-button ${kind}" data-tool-action="${action}" ${extra}>${label}</button>`;
  const input = (name, label, value = "", type = "text", attrs = "") =>
    `<label class="tool-field"><span>${label}</span><input name="${name}" type="${type}" value="${e(value)}" ${attrs}></label>`;
  const toggle = (name, label, on = true) =>
    `<label class="tool-switch"><input type="checkbox" name="${name}" ${on ? "checked" : ""}><span class="tool-switch-track"></span><span>${label}</span></label>`;
  const check = (name, label, on = true) =>
    `<label class="tool-check"><input type="checkbox" name="${name}" ${on ? "checked" : ""}>${label}</label>`;
  const empty = (message) => `<div class="tool-empty">${message}</div>`;
  const errorBox = (message) => `<p class="form-error">${e(message)}</p>`;
  const fmt = (date) =>
    new Date(date).toLocaleString("zh-CN", { hour12: false });
  function clearTimer() {
    clearInterval(timer);
    timer = null;
  }
  const publicToken = () => /^#\/?msg(?:#(.*))?$/.exec(location.hash);
  function table(headings, rows, message = "暂无记录") {
    return `<div class="table-wrap"><table><thead><tr>${headings.map((label) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${headings.length}" class="table-empty">${message}</td></tr>`}</tbody></table></div>`;
  }
  function codesTable(items, original = false) {
    return table(
      ["验证码", "邮箱 / 邮件", "接收时间", "操作"],
      items.map(
        (item) =>
          `<tr><td><code class="tool-code">${e(item.code)}</code></td><td><b>${e(item.mailbox)}</b><div class="muted">${e(item.subject)} · ${e(item.from_email)}</div></td><td>${fmt(item.created_at)}</td><td>${button("复制", "copy", `data-value="${e(item.code)}"`, "small ghost")}${original ? `<button class="tool-button small ghost" data-action="open-mail" data-id="${item.id}">原邮件</button>` : ""}</td></tr>`,
      ),
      "暂未识别到验证码，新邮件到达后可刷新查看",
    );
  }
  function settingsView(settings, codes) {
    return `<form data-tool-form="code-settings" class="tool-card tool-settings"><h2>接码设置</h2><div class="tool-toggle-row">${toggle("enabled", "启用验证码提取", settings.enabled)}${toggle("allowPublicLinks", "允许接码链接访问", settings.allowPublicLinks)}</div><div class="tool-grid">${input("lookbackHours", "读取最近邮件（小时）", settings.lookbackHours, "number", 'min="1" max="168" required')}${input("maxResults", "管理员最多显示条数", settings.maxResults, "number", 'min="1" max="100" required')}${input("refreshSeconds", "自动刷新间隔（秒）", settings.refreshSeconds, "number", 'min="5" max="300" required')}${input("linkHours", "链接默认有效期（小时）", settings.linkHours, "number", 'min="1" max="720" required')}</div><button class="tool-button" type="submit">保存设置</button></form><section class="tool-card"><div class="tool-card-heading"><h2>最近验证码</h2>${button("刷新", "refresh", "", "ghost")}</div><div id="tool-code-feed">${codesTable(codes.items, true)}</div></section>`;
  }
  function linkForm() {
    return `<form data-tool-form="code-link" class="tool-card"><div class="tool-card-heading"><h2>创建接码链接</h2>${button("取消", "cancel-link", "", "ghost")}</div><p class="hint">持有链接的人可查看所选邮箱最近的验证码。请只分享给可信的人。</p><div class="tool-grid"><label class="tool-field"><span>绑定邮箱</span><select name="email" required>${data.users
      .filter(
        (user) =>
          user.active &&
          data.domains.some(
            (domain) =>
              domain.id === user.domain_id ||
              (domain.name === user.domain && domain.enabled),
          ),
      )
      .map(
        (user) =>
          `<option value="${e(user.email)}">${e(user.display_email || user.email)}</option>`,
      )
      .join(
        "",
      )}</select></label>${input("hours", "有效期（小时）", data.settings.linkHours, "number", 'min="1" max="720" required')}${input("label", "备注（可选）", "", "text", 'maxlength="80"')}</div><button class="tool-button" type="submit">创建链接</button></form>`;
  }
  function linksView() {
    const items = data.links.items;
    return `<div class="tool-page-heading"><div><h1>接码链接管理</h1><p>固定格式：<code>/#/msg#&lt;token&gt;</code>　用户可访问 <code>/#/msg</code> 输入 token，或直接打开链接</p></div><div class="row-actions">${button("创建", "create-link")}${button("刷新", "refresh", "", "ghost")}</div></div>${newLink ? linkForm() : ""}<form data-tool-form="link-search" class="tool-card tool-search"><span>共 <b>${data.links.total}</b> 条 <span class="tool-divider">|</span> token 为 8 位 <code>[A-Za-z0-9]</code></span><div class="flex"><input name="q" value="${e(query)}" placeholder="搜索 token 或邮箱" aria-label="搜索 token 或邮箱"><button class="tool-button ghost" type="submit">搜索</button></div></form><section class="tool-card tool-table-card">${
      items.length
        ? table(
            ["Token / 备注", "绑定邮箱", "有效期", "状态", "操作"],
            items.map(
              (link) =>
                `<tr><td><code>${e(link.token)}</code><div class="muted">${e(link.label)}</div></td><td>${e(link.email)}</td><td>${fmt(link.expires_at)}</td><td><span class="pill ${!link.enabled || link.expires_at <= Date.now() ? "gray" : ""}">${!link.enabled ? "已停用" : link.expires_at <= Date.now() ? "已过期" : "生效中"}</span></td><td><div class="row-actions">${button("复制链接", "copy-link", `data-token="${e(link.token)}"`, "small ghost")}${button("打开", "open-link", `data-token="${e(link.token)}"`, "small ghost")}${button(link.enabled ? "停用" : "启用", "toggle-link", `data-id="${link.id}" data-enabled="${link.enabled ? "0" : "1"}"`, "small ghost")}${button("续期", "renew-link", `data-id="${link.id}"`, "small ghost")}${button("删除", "delete-link", `data-id="${link.id}"`, "small danger")}</div></td></tr>`,
            ),
          )
        : empty(`没有接码链接？ ${button("去创建", "create-link", "", "link")}`)
    }</section>`;
  }
  function ruleForm() {
    const rule = {
      name: "",
      pattern: "",
      flags: "i",
      priority: 10,
      enabled: 1,
      ...editor,
    };
    return `<form data-tool-form="code-rule" class="tool-card"><div class="tool-card-heading"><h2>${rule.id ? "编辑规则" : "创建规则"}</h2>${button("取消", "cancel-rule", "", "ghost")}</div><div class="tool-grid">${input("name", "规则名称", rule.name, "text", 'required maxlength="80"')}${input("priority", "执行顺序（越小越优先）", rule.priority, "number", 'min="1" max="10000" required')}${input("sender_filter", "发件人包含（可选）", rule.sender_filter)}${input("subject_filter", "主题包含（可选）", rule.subject_filter)}</div>${input("pattern", "正则表达式", rule.pattern, "text", 'required maxlength="256" placeholder="例如：验证码[:： ]*([0-9]{6})"')}${input("flags", "匹配标志", rule.flags, "text", 'maxlength="3" placeholder="i：忽略大小写；m：多行；u：Unicode"')}<p class="hint">优先取第一个捕获组；没有捕获组则取完整匹配。规则按顺序执行，首个匹配结果作为验证码。</p>${check("enabled", "启用这条规则", Boolean(rule.enabled))}<div class="tool-form-actions"><button class="tool-button" type="submit">保存规则</button></div></form>`;
  }
  function rulesView() {
    return `<div class="tool-page-heading"><div><h1>验证码规则管理</h1><p>按发件人、主题和表达式提取验证码，保存后对接码页面及 API 同时生效。</p></div>${button("创建规则", "create-rule")}</div>${editor !== null ? ruleForm() : ""}<section class="tool-card tool-table-card">${table(
      ["规则", "表达式", "顺序", "状态", "操作"],
      data.rules.items.map(
        (rule) =>
          `<tr><td><b>${e(rule.name)}</b><div class="muted">${e(rule.sender_filter || "全部发件人")} · ${e(rule.subject_filter || "全部主题")}</div></td><td class="tool-pattern"><code>${e(rule.pattern)}</code> <span class="muted">${e(rule.flags)}</span></td><td>${rule.priority}</td><td>${rule.enabled ? "启用" : "停用"}</td><td><div class="row-actions">${button("编辑", "edit-rule", `data-id="${rule.id}"`, "small ghost")}${button(rule.enabled ? "停用" : "启用", "toggle-rule", `data-id="${rule.id}" data-enabled="${rule.enabled ? "0" : "1"}"`, "small ghost")}${button("删除", "delete-rule", `data-id="${rule.id}"`, "small danger")}</div></td></tr>`,
      ),
    )}</section>`;
  }
  function testsView() {
    return `<div class="tool-page-heading"><div><h1>批量规则测试</h1><p>使用已启用的规则试跑文本，测试不会发送邮件或修改收件箱。</p></div></div><form data-tool-form="code-test" class="tool-card"><div class="tool-grid">${input("from_email", "测试发件人（可选）")}${input("subject", "测试主题（可选）")}</div><label class="tool-field"><span>测试文本（每行一条，最多 50 条）</span><textarea name="samples" rows="8" required placeholder="您的验证码为 123456，5 分钟内有效。&#10;Your verification code is 482915"></textarea></label><button class="tool-button" type="submit">开始测试</button></form><section id="tool-test-results" class="tool-card">${empty("输入测试文本后，查看匹配到的验证码和规则。")}</section>`;
  }
  async function renderCodes() {
    clearTimer();
    const [settings, links, rules, users, domains] = await Promise.all([
      h.api("/admin/code-settings"),
      h.api(`/admin/code-links?${new URLSearchParams({ q: query })}`),
      h.api("/admin/code-rules"),
      h.api("/admin/users"),
      h.api("/admin/domains"),
    ]);
    data = {
      settings,
      links,
      rules,
      users: users.items,
      domains: domains.items,
    };
    const tabs = [
      ["settings", "settings", "接码设置"],
      ["links", "attach", "接码链接管理"],
      ["rules", "draft", "验证码规则管理"],
      ["tests", "info", "批量规则测试"],
    ];
    let body;
    if (tab === "settings")
      body = settingsView(settings, await h.api("/admin/codes"));
    else if (tab === "links") body = linksView();
    else if (tab === "rules") body = rulesView();
    else body = testsView();
    return `<div class="tool-page"><nav class="tool-tabs" aria-label="接码功能">${tabs.map(([id, icon, label]) => `<button class="tool-tab ${tab === id ? "selected" : ""}" data-tool-action="code-tab" data-tab="${id}">${h.icon(icon)}${label}</button>`).join("")}</nav>${body}</div>`;
  }
  function range(name, label, value, min, max) {
    return `<div class="tool-range-row"><b>${label}：<span data-range-value="${name}">${value}</span>位</b><input type="range" name="${name}" value="${value}" min="${min}" max="${max}" aria-label="${label}"></div>`;
  }
  async function renderBatch() {
    clearTimer();
    const { items } = await h.api("/admin/domains");
    return `<div class="tool-page"><div class="tool-page-heading"><div><h1>批量注册</h1><p>配置用户名和密码，一次创建 1–100 个邮箱账号。</p></div><div class="tool-segment">${button("按规则生成", "batch-mode", 'data-mode="generate"', batchMode === "generate" ? "" : "ghost")}${button("导入账号列表", "batch-mode", 'data-mode="import"', batchMode === "import" ? "" : "ghost")}</div></div><form class="tool-card tool-batch" data-tool-form="batch"><h2 class="tool-section-title blue">基础设置</h2><div class="tool-grid">${batchMode === "generate" ? input("count", "创建数量", 50, "number", 'min="1" max="100" required') : ""}<label class="tool-field"><span>使用域名</span><select name="domain" required>${items
      .filter((domain) => domain.enabled)
      .map(
        (domain) =>
          `<option value="${e(domain.name)}">@${e(domain.name)}</option>`,
      )
      .join(
        "",
      )}</select></label></div>${batchMode === "import" ? `<label class="tool-field"><span>账号列表</span><textarea name="entries" rows="8" required placeholder="每行：用户名,密码,显示名称&#10;alice,,小王&#10;bob,设置至少12位密码,小陈"></textarea></label><p class="hint">省略密码时生成独立随机密码。</p>` : `<section class="tool-section"><div class="tool-card-heading"><h2 class="tool-section-title green">用户名设置</h2>${toggle("randomUsername", "使用随机用户名")}</div><div class="tool-option-box" id="tool-random-username">${range("usernameLength", "用户名长度", 8, 4, 32)}<div class="tool-checks">${check("usernameNumbers", "包含数字")}${check("usernameUppercase", "包含大写字母", false)}</div><div class="tool-preview">预览：<code id="tool-username-preview"></code></div></div><div class="tool-option-box tool-hidden" id="tool-prefix-username"><div class="tool-grid">${input("prefix", "用户名前缀", "user", "text", 'maxlength="32"')}${input("startNumber", "起始序号", 1, "number", 'min="0" max="999999999"')}</div><p class="hint">按前缀与连续序号生成，例如 user01、user02。</p></div></section><section class="tool-section"><div class="tool-card-heading"><h2 class="tool-section-title amber">密码设置</h2>${toggle("randomPassword", "使用随机密码")}</div><div class="tool-option-box" id="tool-random-password">${range("passwordLength", "密码长度", 12, 12, 64)}<div class="tool-checks">${check("passwordUppercase", "包含大写字母")}${check("passwordNumbers", "包含数字")}${check("passwordSymbols", "包含特殊字符")}</div><div class="tool-preview">预览：<code id="tool-password-preview"></code></div></div><div class="tool-option-box tool-hidden" id="tool-fixed-password">${input("password", "统一密码", "", "password", 'minlength="12" maxlength="256" autocomplete="new-password"')}<p class="hint">为本批账号设置相同密码，至少 12 位。</p></div></section>`}<p class="hint">邮箱登录不区分大小写；生成的大写格式会保留在账号列表和导出结果中。</p><div class="tool-batch-buttons"><button class="tool-button" type="submit">批量创建</button>${button("导出信息", "export-batch", batchResults.length ? "" : "disabled", "success")}</div></form><section class="tool-card ${batchResults.length ? "" : "tool-hidden"}" id="tool-batch-results">${batchResults.length ? batchTable() : ""}</section></div>`;
  }
  function batchTable() {
    return `<div class="tool-card-heading"><h2>已创建 ${batchResults.filter((item) => !item.error).length} / ${batchResults.length} 个账号</h2><span class="muted">密码仅在本次结果中显示，请及时导出。</span></div>${table(
      ["邮箱账号", "密码"],
      batchResults.map(
        (item) =>
          `<tr><td class="mono">${e(item.email)}</td><td class="mono">${e(item.error ? "失败：" + item.error : item.password)}</td></tr>`,
      ),
    )}`;
  }
  function randomPreview(length, groups) {
    const pick = (alphabet) =>
      alphabet[crypto.getRandomValues(new Uint32Array(1))[0] % alphabet.length];
    const chars = groups.map(pick),
      alphabet = groups.join("");
    while (chars.length < length) chars.push(pick(alphabet));
    return chars
      .sort(() => crypto.getRandomValues(new Uint8Array(1))[0] - 127)
      .join("");
  }
  function updateBatch() {
    const form = $('form[data-tool-form="batch"]');
    if (!form || batchMode !== "generate") return;
    const randomUsername = checked(form, "randomUsername"),
      randomPassword = checked(form, "randomPassword");
    for (const [id, visible] of [
      ["random-username", randomUsername],
      ["prefix-username", !randomUsername],
      ["random-password", randomPassword],
      ["fixed-password", !randomPassword],
    ])
      $(`#tool-${id}`)?.classList.toggle("tool-hidden", !visible);
    form.elements.password.disabled = randomPassword;
    form.elements.password.required = !randomPassword;
    document.querySelectorAll("[data-range-value]").forEach((node) => {
      node.textContent = val(form, node.dataset.rangeValue);
    });
    const users = ["abcdefghijklmnopqrstuvwxyz"],
      passwords = ["abcdefghijklmnopqrstuvwxyz"];
    if (checked(form, "usernameNumbers")) users.push("0123456789");
    if (checked(form, "usernameUppercase"))
      users.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    if (checked(form, "passwordUppercase"))
      passwords.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    if (checked(form, "passwordNumbers")) passwords.push("0123456789");
    if (checked(form, "passwordSymbols")) passwords.push("!@#$%^&*_-+=?");
    $("#tool-username-preview").textContent = randomPreview(
      Number(val(form, "usernameLength")),
      users,
    );
    $("#tool-password-preview").textContent = randomPreview(
      Number(val(form, "passwordLength")),
      passwords,
    );
  }
  async function publicRoute() {
    clearTimer();
    const match = publicToken();
    if (!match) return false;
    const version = ++publicVersion,
      token = match[1] || "";
    document.title = "接码 · 青邮";
    $("#app").innerHTML =
      `<main class="tool-page tool-public"><div class="tool-public-brand">${h.icon("mail")} 青邮 · 接码</div><section class="tool-card"><h1>邮箱验证码</h1><p class="muted">输入 8 位 token，查看该链接绑定邮箱的验证码。</p><form data-tool-form="public-token" class="tool-public-form"><input name="token" value="${e(token)}" pattern="[A-Za-z0-9]{8}" minlength="8" maxlength="8" required autocomplete="off" aria-label="接码 token" placeholder="输入 8 位 token"><button type="submit" class="tool-button">查看验证码</button></form></section><section class="tool-card" id="tool-public-feed">${empty(token ? "正在读取…" : "请输入 token，或打开管理员提供的完整接码链接。")}</section><a href="#overview" class="tool-admin-entry">管理员登录</a></main>`;
    async function refresh() {
      if (
        version !== publicVersion ||
        !publicToken() ||
        !token ||
        document.hidden
      )
        return;
      try {
        const result = await h.api("/code-links/read", {
          method: "POST",
          body: { token },
        });
        if (version !== publicVersion || !$("#tool-public-feed")) return;
        $("#tool-public-feed").innerHTML =
          `<div class="tool-card-heading"><h2>${e(result.mailbox)}</h2>${button("刷新", "public-refresh", "", "ghost")}</div>${codesTable(result.items)}<p class="hint">自动刷新间隔 ${result.refreshSeconds} 秒 · 最近更新 ${fmt(Date.now())}</p>`;
        clearTimer();
        timer = setInterval(refresh, result.refreshSeconds * 1000);
      } catch (error) {
        if (version === publicVersion && $("#tool-public-feed"))
          $("#tool-public-feed").innerHTML = errorBox(error.message);
        clearTimer();
      }
    }
    window.PostOfficeTools.refreshPublic = refresh;
    if (token) await refresh();
    return true;
  }
  const actions = {
    "code-tab": (node) => {
      tab = node.dataset.tab;
      editor = null;
      newLink = false;
      h.render();
    },
    refresh: () => h.render(),
    "create-link": () => {
      newLink = true;
      h.render();
    },
    "cancel-link": () => {
      newLink = false;
      h.render();
    },
    "copy-link": (node) =>
      h.copy(`${location.origin}/#/msg#${node.dataset.token}`),
    "open-link": (node) => {
      location.hash = `/msg#${node.dataset.token}`;
    },
    copy: (node) => h.copy(node.dataset.value),
    "toggle-link": async (node) => {
      await h.api(`/admin/code-links/${node.dataset.id}`, {
        method: "PATCH",
        body: { enabled: node.dataset.enabled === "1" },
      });
      h.render();
    },
    "renew-link": async (node) => {
      await h.api(`/admin/code-links/${node.dataset.id}`, {
        method: "PATCH",
        body: { hours: data.settings.linkHours, enabled: true },
      });
      h.toast("链接有效期已更新");
      h.render();
    },
    "delete-link": (node) =>
      h.confirmAction("删除接码链接", "删除后，原链接立即失效。", async () => {
        await h.api(`/admin/code-links/${node.dataset.id}`, {
          method: "DELETE",
        });
        h.render();
      }),
    "create-rule": () => {
      editor = {};
      h.render();
    },
    "edit-rule": (node) => {
      editor = data.rules.items.find(
        (rule) => rule.id === Number(node.dataset.id),
      );
      h.render();
    },
    "cancel-rule": () => {
      editor = null;
      h.render();
    },
    "toggle-rule": async (node) => {
      await h.api(`/admin/code-rules/${node.dataset.id}`, {
        method: "PATCH",
        body: { enabled: node.dataset.enabled === "1" },
      });
      h.render();
    },
    "delete-rule": (node) =>
      h.confirmAction(
        "删除验证码规则",
        "删除后，该规则将不再参与提取。",
        async () => {
          await h.api(`/admin/code-rules/${node.dataset.id}`, {
            method: "DELETE",
          });
          h.render();
        },
      ),
    "batch-mode": (node) => {
      batchMode = node.dataset.mode;
      h.render();
    },
    "export-batch": () => {
      if (!batchResults.length) return;
      h.download(
        "邮箱账号.txt",
        "\uFEFF邮箱\t密码\r\n" +
          batchResults
            .filter((item) => item.password && !item.error)
            .map((item) => `${item.email}\t${item.password}`)
            .join("\r\n"),
      );
    },
    "public-refresh": () => window.PostOfficeTools.refreshPublic(),
  };
  document.addEventListener("click", async (event) => {
    const node = event.target.closest("[data-tool-action]");
    if (!node || node.disabled || !actions[node.dataset.toolAction]) return;
    event.preventDefault();
    node.disabled = true;
    try {
      await actions[node.dataset.toolAction](node);
    } catch (error) {
      h.toast(error.message, true);
    } finally {
      node.disabled = false;
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.closest('form[data-tool-form="batch"]')) updateBatch();
  });
  document.addEventListener("change", (event) => {
    if (event.target.closest('form[data-tool-form="batch"]')) updateBatch();
  });
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-tool-form]");
    if (!form) return;
    event.preventDefault();
    const submit = $('button[type="submit"]', form);
    if (submit?.disabled) return;
    if (submit) submit.disabled = true;
    form.querySelector(".form-error")?.remove();
    try {
      const input = Object.fromEntries(new FormData(form));
      switch (form.dataset.toolForm) {
        case "link-search":
          query = input.q;
          await h.render();
          break;
        case "code-link":
          await h.api("/admin/code-links", { method: "POST", body: input });
          newLink = false;
          h.toast("接码链接已创建");
          await h.render();
          break;
        case "code-settings":
          await h.api("/admin/code-settings", {
            method: "PUT",
            body: {
              ...input,
              enabled: checked(form, "enabled"),
              allowPublicLinks: checked(form, "allowPublicLinks"),
            },
          });
          h.toast("接码设置已保存");
          await h.render();
          break;
        case "code-rule":
          await h.api(`/admin/code-rules${editor?.id ? `/${editor.id}` : ""}`, {
            method: editor?.id ? "PATCH" : "POST",
            body: { ...input, enabled: checked(form, "enabled") },
          });
          editor = null;
          h.toast("规则已保存");
          await h.render();
          break;
        case "code-test": {
          const result = await h.api("/admin/code-rules/test", {
            method: "POST",
            body: {
              from_email: input.from_email,
              subject: input.subject,
              samples: input.samples
                .split(/\r?\n/)
                .filter((line) => line.trim()),
            },
          });
          $("#tool-test-results").innerHTML = `<h2>测试结果</h2>${table(
            ["测试文本", "验证码", "匹配规则"],
            result.items.map(
              (item) =>
                `<tr><td class="tool-pattern">${e(item.input)}</td><td><code>${e(item.code || "未匹配")}</code></td><td>${e(item.rule_name || "—")}</td></tr>`,
            ),
          )}`;
          break;
        }
        case "public-token":
          if (location.hash === `#/msg#${input.token}`) await publicRoute();
          else location.hash = `/msg#${input.token}`;
          break;
        case "batch": {
          let body;
          if (batchMode === "import")
            body = {
              domain: input.domain,
              entries: input.entries
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [local, password, name] = line
                    .split(/[,，\t]/)
                    .map((part) => part.trim());
                  return { local, password, name };
                }),
            };
          else {
            body = { ...input };
            for (const name of [
              "randomUsername",
              "randomPassword",
              "usernameNumbers",
              "usernameUppercase",
              "passwordUppercase",
              "passwordNumbers",
              "passwordSymbols",
            ])
              body[name] = checked(form, name);
          }
          const result = await h.api("/admin/users/batch", {
            method: "POST",
            body,
          });
          batchResults = result.items;
          $("#tool-batch-results").classList.remove("tool-hidden");
          $("#tool-batch-results").innerHTML = batchTable();
          const succeeded = batchResults.filter(
            (item) => item.password && !item.error,
          ).length;
          $('[data-tool-action="export-batch"]', form).disabled = !succeeded;
          h.toast(`已创建 ${succeeded} / ${batchResults.length} 个账号`);
          break;
        }
      }
    } catch (error) {
      form.insertAdjacentHTML("afterbegin", errorBox(error.message));
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  function afterRender() {
    clearTimer();
    updateBatch();
    if (location.hash === "#codes" && tab === "settings")
      timer = setInterval(async () => {
        if (document.hidden || !$("#tool-code-feed")) return;
        try {
          const result = await h.api("/admin/codes");
          if ($("#tool-code-feed"))
            $("#tool-code-feed").innerHTML = codesTable(result.items, true);
        } catch {
          clearTimer();
        }
      }, data.settings.refreshSeconds * 1000);
  }
  window.PostOfficeTools = {
    configure: (helpers) => {
      h = helpers;
    },
    renderCodes,
    renderBatch,
    publicRoute,
    afterRender,
    isPublicRoute: () => Boolean(publicToken()),
  };
})();
