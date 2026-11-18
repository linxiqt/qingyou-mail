(() => {
  let h,
    platform = { name: "青邮", theme: "auto", layout: "vertical" },
    features = [],
    connectionId = 0,
    connections = [],
    dialogSubmit = null;
  const pages = {},
    actions = {},
    forms = {},
    publicRoutes = [];
  const root = (r) => (typeof r === "string" ? document.querySelector(r) : r);
  const $ = (s, r = document) => root(r)?.querySelector(s),
    $$ = (s, r = document) => Array.from(root(r)?.querySelectorAll(s) || []);
  const e = (value) => h.esc(value);
  const actionPermissions = {
    "forward-create": ["forwards.write", "create"],
    "forward-batch": ["forwards.write", "create"],
    "forward-edit": ["forwards.write", "update"],
    "forward-delete": ["forwards.write", "delete"],
    "forwards-delete": ["forwards.write", "delete"],
    "write-mail": ["mail.send", "create"],
    "template-create": ["templates.manage"],
    "template-edit": ["templates.manage"],
    "template-delete": ["templates.manage"],
    "template-from-compose": ["templates.manage"],
    "template-use": ["mail.send", "create"],
  };
  const button = (label, action, attrs = "", kind = "secondary") => {
    const permission =
      action === "mail-batch"
        ? [
            /(?:trash|delete)/.test(attrs) ? "mail.delete" : "mail.update",
            /(?:trash|delete)/.test(attrs) ? "delete" : "update",
          ]
        : actionPermissions[action];
    if (
      h &&
      permission &&
      !(isAdmin()
        ? can(permission[0], undefined, permission[1] || "read")
        : canPersonal(permission[0]))
    )
      return "";
    if (
      h &&
      isAdmin() &&
      !isGlobal() &&
      action === "mail-batch" &&
      /(?:trash|delete)/.test(attrs) &&
      !(h.state.user.permissions || []).some(
        (grant) => grant.can_update && grant.can_delete,
      )
    )
      return "";
    return `<button type="button" class="btn ${kind}" data-m-action="${action}" ${attrs}>${e(label)}</button>`;
  };
  const input = (name, label, value = "", type = "text", attrs = "") =>
    `<div class="field"><label>${e(label)}<input name="${name}" type="${type}" value="${e(value)}" ${attrs}></label></div>`;
  const textarea = (name, label, value = "", attrs = "") =>
    `<div class="field"><label>${e(label)}<textarea name="${name}" ${attrs}>${e(value)}</textarea></label></div>`;
  const check = (name, label, on = false, attrs = "") =>
    `<label class="check-label"><input type="checkbox" name="${name}" ${on ? "checked" : ""} ${attrs}>${e(label)}</label>`;
  const select = (name, label, options, value = "", attrs = "") =>
    `<div class="field"><label>${e(label)}<select name="${name}" ${attrs}>${options.map(([id, text]) => `<option value="${e(id)}" ${String(id) === String(value) ? "selected" : ""}>${e(text)}</option>`).join("")}</select></label></div>`;
  const table = (head, rows, empty = "暂无记录") =>
    `<div class="table-wrap"><table><thead><tr>${head.map((value) => `<th>${value}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td class="table-empty" colspan="${head.length}">${e(empty)}</td></tr>`}</tbody></table></div>`;
  const title = (name, description = "", buttons = "") =>
    `<div class="page-title"><div><div class="eyebrow">${h.mailboxClient ? "YOUR PERSONAL MAILBOX" : "POST OFFICE WORKSPACE"}</div><h1>${e(name)}</h1><p>${e(description)}</p></div><div class="row-actions">${buttons}</div></div>`;
  const note = (text) =>
    `<div class="notice">${h.icon("info")}<span>${e(text)}</span></div>`;
  const status = (on, yes = "启用", no = "停用") =>
    `<span class="pill ${on ? "" : "gray"}">${e(on ? yes : no)}</span>`;
  const data = (form) => Object.fromEntries(new FormData(form));
  const checked = (form, name) =>
    Boolean(form.elements.namedItem(name)?.checked);
  const values = (form, name) =>
    Array.from(form.querySelectorAll('input[type="checkbox"]:checked'))
      .filter((element) => element.name === name)
      .map((element) => element.value);
  const isClientManager = () =>
    Boolean(h.mailboxClient && h.state.user?.client_manager);
  const isAdmin = () =>
    (!h.mailboxClient && h.state.user?.role === "admin") ||
    Boolean(h.clientWorkspace?.());
  const isGlobal = () =>
    !h.mailboxClient && isAdmin() && h.state.user.admin_scope !== "scoped";
  const canPersonal = (capability) =>
    !isClientManager() ||
    (h.state.user.capabilities || []).includes(capability);
  const navigate = (route) => (h.go ? h.go(route) : (location.hash = route));
  const personalRouteAllowed = (route) =>
    route === "access" ||
    canPersonal(
      route === "compose" || route === "drafts"
        ? "mail.send"
        : route === "templates"
          ? "templates.manage"
          : "mail.read",
    );
  function can(capability, domainId, operation = "read") {
    if (!isAdmin()) return false;
    if (isGlobal()) return true;
    const user = h.state.user;
    if (
      Array.isArray(user.capabilities) &&
      !user.capabilities.includes(capability)
    )
      return false;
    if (capability === "templates.manage") return true;
    return (user.permissions || []).some(
      (grant) =>
        (domainId == null || Number(grant.domain_id) === Number(domainId)) &&
        Boolean(grant[`can_${operation}`]),
    );
  }
  const routePermissions = {
    users: ["accounts.read"],
    domains: ["domains.read"],
    "batch-register": ["accounts.create", "create"],
    "batch-password": ["accounts.password", "update"],
    compose: ["mail.send", "create"],
    "bulk-send": ["mail.send", "create"],
    inbox: ["mail.read"],
    sent: ["mail.read"],
    trash: ["mail.read"],
    drafts: ["mail.send", "create"],
    forwards: ["forwards.read"],
    templates: ["templates.manage"],
  };
  const capabilityNames = {
    "accounts.read": "查看邮箱",
    "accounts.create": "创建邮箱",
    "accounts.update": "编辑邮箱",
    "accounts.delete": "删除邮箱",
    "accounts.password": "重置邮箱密码",
    "domains.read": "查看域名与解析",
    "domains.update": "修改域名",
    "domains.delete": "删除域名",
    "mail.read": "阅读邮件",
    "mail.send": "发送邮件",
    "mail.update": "整理邮件",
    "mail.delete": "删除邮件",
    "forwards.read": "查看转发",
    "forwards.write": "管理转发",
    "templates.manage": "管理个人模板",
  };
  pages.access = async () =>
    title("我的管理权限", "以下是当前账号可用的功能与授权范围。") +
    `<section class="card form-card"><h2>功能权限</h2><div class="permission-tags">${(h.state.user.capabilities || []).map((id) => `<span class="pill gray">${e(capabilityNames[id] || id)}</span>`).join("") || '<p class="hint">尚未分配功能权限，请联系超级管理员。</p>'}</div><h2>域名范围</h2>${table(
      ["域名", "查看", "新增", "修改", "删除"],
      (h.state.user.permissions || []).map(
        (p) =>
          `<tr><td>${e(p.domain)}</td>${["read", "create", "update", "delete"].map((op) => `<td>${p[`can_${op}`] ? "允许" : "—"}</td>`).join("")}</tr>`,
      ),
      "尚未分配域名",
    )}${note("操作需同时具备功能权限和对应域名权限。权限调整后请重新登录。")}</section>`;
  function allowedRoute(route) {
    if (route === "access") return true;
    const permission = routePermissions[route];
    return Boolean(
      permission && can(permission[0], undefined, permission[1] || "read"),
    );
  }
  const sections = {
    users: [
      ["users", "users", "邮箱用户"],
      ["managers", "shield", "权限管理"],
    ],
    system: [
      ["system", "server", "运行状态"],
      ["platform", "settings", "平台设置"],
      ["features", "settings", "功能管理"],
      ["about", "info", "程序信息"],
      ["license", "key", "程序授权"],
    ],
  };
  const navigationGroup = (route) =>
    isGlobal()
      ? Object.keys(sections).find((id) =>
          sections[id].some(([child]) => child === route),
        ) || route
      : route;
  const pageLabel = (route) =>
    Object.values(sections)
      .flat()
      .find(([id]) => id === route)?.[2];
  const visibleSectionRoutes = (id) =>
    (sections[id] || []).filter(
      ([route]) =>
        canRoute(route) &&
        (route !== "license" || h.state.license?.required) &&
        features.find((f) => f.id === route)?.show !== false,
    );
  function sectionNavigation(route) {
    if (!isGlobal()) return "";
    const group = navigationGroup(route),
      routes = visibleSectionRoutes(group);
    if (routes.length < 2) return "";
    return `<nav class="workspace-section-tabs" aria-label="${group === "users" ? "用户管理" : "系统设置"}">${routes.map(([id, icon, label]) => `<a href="#${id}" class="${id === route ? "selected" : ""}"${id === route ? ' aria-current="page"' : ""}>${h.icon(icon)}<span>${e(label)}</span></a>`).join("")}</nav>`;
  }
  const remote = () => isGlobal() && connectionId > 0;
  const current = () => connections.find((c) => c.id === connectionId);
  const pager = (page, total, limit, action) =>
    `<div class="table-foot"><span>共 ${total} 条 · 第 ${page} / ${Math.max(1, Math.ceil(total / limit))} 页</span><div class="row-actions">${button("上一页", action, `data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}`, "secondary small")}${button("下一页", action, `data-page="${page + 1}" ${page * limit >= total ? "disabled" : ""}`, "secondary small")}</div></div>`;
  function picker(name, items, selected = [], purpose = "") {
    const options = items.map((item) =>
      typeof item === "string"
        ? { value: item, label: item }
        : {
            value: String(item.value ?? item.email ?? item.name),
            label: item.label ?? item.email ?? item.name,
          },
    );
    for (const value of selected.map(String))
      if (!options.some((item) => String(item.value) === value))
        options.unshift({ value, label: value });
    return `<div class="mail-picker" data-picker="${e(name)}" ${purpose && !remote() ? `data-account-purpose="${e(purpose)}"` : ""}><div class="picker-toolbar"><input type="search" data-picker-search placeholder="搜索邮箱或名称" aria-label="搜索可选项"><span data-picker-count>已选 ${selected.length}</span></div><div class="picker-actions">${button("全选当前结果", "picker-all", "", "secondary small")}${button("反选当前", "picker-invert", "", "secondary small")}${button("清空", "picker-clear", "", "secondary small")}</div>${purpose && !remote() ? '<p class="hint">显示最多 200 个匹配邮箱，输入关键词搜索更多邮箱；已选项会保留。</p>' : ""}<div class="picker-options">${options.map((item) => `<label class="picker-option"><input type="checkbox" name="${e(name)}" value="${e(item.value)}" ${selected.map(String).includes(String(item.value)) ? "checked" : ""}><span>${e(item.label)}</span></label>`).join("") || '<p class="hint">没有可选项</p>'}</div></div>`;
  }
  function updatePicker(picker) {
    const count = $$('input[type="checkbox"]:checked', picker).length;
    $("[data-picker-count]", picker).textContent = `已选 ${count}`;
  }
  function closeDialog() {
    dialogSubmit = null;
    h.closeModal();
  }
  function dialog(name, body, submit, label = "保存") {
    dialogSubmit = submit;
    $("#modal-root").innerHTML =
      `<div class="modal-overlay"><section class="modal management-modal" role="dialog" aria-modal="true" aria-label="${e(name)}"><header class="modal-header"><h2>${e(name)}</h2>${button("关闭", "dialog-close", "", "secondary small")}</header><form class="modal-body" data-m-form="dialog">${body}${submit ? `<div class="modal-foot">${button("取消", "dialog-close")}<button class="btn" type="submit">${e(label)}</button></div>` : ""}</form></section></div>`;
    $(
      'input:not([type="checkbox"]),textarea,select',
      $("#modal-root"),
    )?.focus();
  }
  function exportRows(filename, rows, columns, format = "csv") {
    const safe = (value) => {
      const text = String(value ?? "");
      return /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
    };
    const text = rows.map((row) => columns.map(([key]) => safe(row[key])));
    if (format === "json")
      return h.download(filename, JSON.stringify(rows, null, 2));
    const lines = [columns.map(([, label]) => label), ...text];
    h.download(
      filename,
      "\uFEFF" +
        lines
          .map((row) =>
            row
              .map((v) => `"${String(v).replaceAll('"', '""')}"`)
              .join(format === "csv" ? "," : "\t"),
          )
          .join("\r\n"),
    );
  }
  async function resource(name, query = {}) {
    if (remote()) {
      if (
        ![
          "accounts",
          "domains",
          "forwards",
          "templates",
          "inbox",
          "sent",
        ].includes(name)
      )
        throw new Error(
          "当前远程适配器不提供此文件夹，请切换本机邮局或在原面板查看",
        );
      if (
        name === "accounts" ||
        name === "domains" ||
        name === "forwards" ||
        name === "templates"
      )
        return h.api(
          `/admin/connections/${connectionId}/data/${name}?${new URLSearchParams(query)}`,
        );
      if (["inbox", "sent"].includes(name)) {
        const selected = query.emails || [];
        if (!selected.length)
          return {
            items: [],
            total: 0,
            page: Number(query.page) || 1,
            limit: Number(query.limit) || 30,
            needsSelection: true,
          };
        if (selected.length > 10)
          throw new Error("远程邮件每次最多选择10个邮箱");
        const results = [];
        for (const email of selected)
          results.push(
            await h.api(
              `/admin/connections/${connectionId}/data/${name}?${new URLSearchParams({ ...query, emails: undefined, email })}`,
            ),
          );
        return {
          items: results.flatMap((r) => r.items),
          total: results.reduce((sum, r) => sum + r.total, 0),
          page: Number(query.page) || 1,
          limit: (Number(query.limit) || 30) * selected.length,
        };
      }
    }
    if (name === "templates") return h.api("/templates");
    if (name === "accounts" || name === "domains" || name === "forwards")
      return h.api(`/admin/manage/${name}?${new URLSearchParams(query)}`);
    const params = new URLSearchParams({
      ...query,
      folder: name,
      emails: (query.emails || []).join(","),
    });
    return h.api(`${isAdmin() ? "/admin/manage" : ""}/messages?${params}`);
  }
  async function operation(name, input = {}) {
    if (remote())
      return h.api(`/admin/connections/${connectionId}/action`, {
        method: "POST",
        body: { operation: name, input },
      });
    const id = input.id;
    const options = {
      "account.create": ["/admin/manage/accounts", "POST", input],
      "account.update": [`/admin/manage/accounts/${id}`, "PATCH", input],
      "account.delete": [
        "/admin/manage/accounts/delete",
        "POST",
        { ids: [id], confirm: true },
      ],
      "domain.create": [
        "/admin/manage/domains",
        "POST",
        { name: input.domain, mailboxLimit: input.mailboxLimit },
      ],
      "domain.update": [`/admin/manage/domains/${id}`, "PATCH", input],
      "domain.delete": [
        `/admin/manage/domains/${id}`,
        "DELETE",
        { cascade: true, confirmDomain: input.domain },
      ],
      "domain.catchall": [
        `/admin/manage/domains/${id}/catchall`,
        "PUT",
        { email: input.target, enabled: input.enabled },
      ],
      "forward.create": ["/admin/manage/forwards", "POST", input],
      "forward.update": [`/admin/manage/forwards/${id}`, "PATCH", input],
      "forward.delete": [
        "/admin/manage/forwards/delete",
        "POST",
        { ids: [id] },
      ],
      send: [isAdmin() ? "/admin/manage/send" : "/send", "POST", input],
      "bulk-send": ["/admin/manage/bulk-send", "POST", input],
    };
    const value = options[name];
    if (!value) throw new Error("操作不存在");
    return h.api(value[0], { method: value[1], body: value[2] });
  }
  async function accountOptions(purpose, query = {}) {
    return remote()
      ? resource("accounts", query)
      : h.api(
          `/admin/manage/account-options?${new URLSearchParams({ purpose, limit: 200, ...query })}`,
        );
  }
  async function context() {
    // Remote management is paused. Ignore saved selection, preserving its data.
    connections = [];
    connectionId = 0;
  }
  function applyAppearance() {
    const root = document.documentElement;
    let preference;
    try {
      preference = localStorage.getItem("postoffice-theme") || platform.theme;
    } catch {
      preference = platform.theme;
    }
    const mode =
      preference === "auto"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : preference;
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
    const color =
      mode === "dark" ? "#111827" : platform.backgroundColor || "#f4f6fb";
    root.style.setProperty("--workspace-background", color);
    root.style.setProperty("--bg", color);
    document.body.style.backgroundColor = color;
    const alpha = Math.round(((100 - platform.backgroundOpacity) / 100) * 255)
      .toString(16)
      .padStart(2, "0");
    document.body.style.backgroundImage =
      platform.backgroundType === "image" && platform.backgroundImage
        ? `linear-gradient(${color}${alpha},${color}${alpha}),url(${JSON.stringify(platform.backgroundImage)})`
        : "";
    document.body.classList.toggle(
      "image-background",
      platform.backgroundType === "image" && Boolean(platform.backgroundImage),
    );
    $$(".brand-name").forEach(
      (el) => (el.textContent = platform.name || "青邮"),
    );
    if (platform.logoUrl)
      $$(".brand-mark").forEach((el) => {
        el.innerHTML = `<img src="${e(platform.logoUrl)}" alt="" class="brand-image">`;
      });
    else
      $$(".brand-mark:has(img)").forEach(
        (el) => (el.innerHTML = h.icon("mail")),
      );
    $(".layout")?.classList.toggle(
      "horizontal-layout",
      platform.layout === "horizontal",
    );
    const top = $(".topbar-right");
    if (top && !$(".appearance-select", top))
      top.insertAdjacentHTML(
        "afterbegin",
        `<select class="appearance-select" aria-label="页面主题" data-m-theme><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select>`,
      );
    if ($("[data-m-theme]")) $("[data-m-theme]").value = preference || "auto";
    if (top) $("[data-m-context]", top)?.remove();
    const auth = $(".auth-form");
    if (auth && !$(".brand-footer", auth))
      auth.insertAdjacentHTML(
        "beforeend",
        `<div class="brand-footer">${e(platform.copyright)}${platform.icpText ? `<a href="${e(platform.icpUrl)}" target="_blank" rel="noopener noreferrer">${e(platform.icpText)}</a>` : ""}</div>`,
      );
    document.title = `${platform.name || "青邮"} · ${h.mailboxClient ? "网页邮箱" : "Post Office"}`;
  }
  async function loadPublic() {
    try {
      platform = await h.api("/platform");
    } catch {}
    applyAppearance();
  }
  async function loadPreferences() {
    const result = await h.api("/preferences");
    platform = result.platform;
    features = result.features;
    if (h.state.license?.required && !h.state.license.valid) {
      connections = [];
      connectionId = 0;
    } else await context();
    applyAppearance();
  }
  function navigation(adminNav, userNav) {
    if (!isAdmin())
      return [
        ...userNav.filter(
          ([id]) =>
            personalRouteAllowed(id) &&
            features.find((f) => f.id === id)?.enabled !== false,
        ),
        ...(canPersonal("templates.manage") &&
        features.find((f) => f.id === "templates" && f.enabled)
          ? [["templates", "draft", "邮件模板"]]
          : []),
        ...(isClientManager() ? [["access", "shield", "我的权限"]] : []),
      ];
    if (h.state.license?.required && !h.state.license.valid)
      return isGlobal()
        ? [["license", "key", "程序授权"]]
        : [["service-unavailable", "lock", "服务状态"]];
    const allowed = new Set([
      "users",
      "domains",
      "compose",
      "inbox",
      "sent",
      "forwards",
      "batch-register",
      "bulk-send",
      "batch-password",
      "templates",
    ]);
    const values = features.length
      ? features
      : adminNav.map(([id, icon, name], order) => ({
          id,
          icon,
          name,
          order,
          enabled: true,
          show: true,
        }));
    const navigation = values
      .filter(
        (f) =>
          f.enabled &&
          f.show &&
          f.id !== "connections" &&
          (isGlobal() || (allowed.has(f.id) && allowedRoute(f.id))),
      )
      .sort((a, b) => a.order - b.order)
      .map((f) => [f.id, f.icon, f.name]);
    if (isGlobal() && h.state.license?.required)
      navigation.push(["license", "key", "程序授权"]);
    if (!isGlobal()) navigation.push(["access", "shield", "我的权限"]);
    const groups = new Set();
    return navigation.flatMap(([id, icon, label]) => {
      const group = navigationGroup(id);
      if (groups.has(group)) return [];
      groups.add(group);
      return [
        [
          id,
          group === "system" ? "settings" : group === "users" ? "users" : icon,
          group === "system"
            ? "系统设置"
            : group === "users"
              ? "用户列表"
              : label,
        ],
      ];
    });
  }
  function defaultRoute() {
    if (isAdmin() && h.state.license?.required && !h.state.license.valid)
      return isGlobal() ? "license" : "service-unavailable";
    return isAdmin()
      ? isGlobal()
        ? "overview"
        : [
            "users",
            "domains",
            "inbox",
            "compose",
            "forwards",
            "templates",
          ].find(
            (route) =>
              allowedRoute(route) &&
              features.find((f) => f.id === route)?.enabled !== false,
          ) || "access"
      : !personalRouteAllowed("inbox")
        ? "access"
        : features.find((f) => f.id === "inbox")?.enabled === false
          ? "archive"
          : "inbox";
  }
  function canRoute(route) {
    if (route === "connections") return false;
    if (h.clientWorkspace?.() && route === "drafts") return false;
    if (route === "license") return isGlobal();
    if (route === "service-unavailable")
      return (
        isAdmin() &&
        !isGlobal() &&
        h.state.license?.required &&
        !h.state.license.valid
      );
    if (isAdmin() && h.state.license?.required && !h.state.license.valid)
      return false;
    if (features.find((f) => f.id === route)?.enabled === false) return false;
    if (isClientManager() && !isAdmin() && route === "access") return true;
    if (!isAdmin())
      return (
        [
          "compose",
          "inbox",
          "sent",
          "starred",
          "archive",
          "spam",
          "templates",
          "drafts",
          "trash",
        ].includes(route) && personalRouteAllowed(route)
      );
    return (
      isGlobal() ||
      ([
        "users",
        "domains",
        "compose",
        "inbox",
        "sent",
        "forwards",
        "batch-register",
        "bulk-send",
        "batch-password",
        "templates",
        "drafts",
        "trash",
      ].includes(route) &&
        allowedRoute(route)) ||
      route === "access"
    );
  }
  function showProgress(label, total) {
    dialog(
      label,
      `<div class="operation-progress"><strong data-progress-label>准备处理中…</strong><progress max="${total}" value="0"></progress><div data-progress-result></div></div>`,
    );
  }
  function progress(done, total, text) {
    const p = $("progress", $("#modal-root"));
    if (p) {
      p.max = total;
      p.value = done;
      $("[data-progress-label]", $("#modal-root")).textContent =
        `${done} / ${total} · ${text}`;
    }
  }
  actions["dialog-close"] = closeDialog;
  actions["open-connections"] = () => {
    h.toast("多邮局管理暂时停用");
  };
  for (const action of ["all", "invert", "clear"])
    actions[`picker-${action}`] = (node) => {
      const picker = node.closest("[data-picker]");
      $$(".picker-option:not([hidden]) input", picker).forEach(
        (input) =>
          (input.checked =
            action === "all"
              ? true
              : action === "clear"
                ? false
                : !input.checked),
      );
      updatePicker(picker);
    };
  document.addEventListener("click", async (event) => {
    const node = event.target.closest("[data-m-action]");
    if (!node || !actions[node.dataset.mAction]) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (node.disabled) return;
    node.disabled = true;
    node.setAttribute("aria-busy", "true");
    try {
      await actions[node.dataset.mAction](node);
    } catch (error) {
      h.toast(error.message, true);
    } finally {
      if (node.isConnected) {
        node.disabled = false;
        node.removeAttribute("aria-busy");
      }
    }
  });
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-m-form]");
    if (!form) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const submit = $('button[type="submit"]', form);
    if (submit?.disabled) return;
    if (submit) {
      submit.disabled = true;
      submit.setAttribute("aria-busy", "true");
    }
    $(".form-error", form)?.remove();
    try {
      const fn =
        form.dataset.mForm === "dialog"
          ? dialogSubmit
          : forms[form.dataset.mForm];
      if (fn) await fn(data(form), form);
    } catch (error) {
      form.insertAdjacentHTML(
        "afterbegin",
        `<div class="form-error">${e(error.message)}</div>`,
      );
    } finally {
      if (submit?.isConnected) {
        submit.disabled = false;
        submit.removeAttribute("aria-busy");
      }
    }
  });
  const pickerTimers = new WeakMap();
  const pickerVersions = new WeakMap();
  document.addEventListener("input", (event) => {
    const input = event.target.closest("[data-picker-search]");
    if (input) {
      const picker = input.closest("[data-picker]"),
        q = input.value.trim().toLowerCase();
      if (picker.dataset.accountPurpose) {
        clearTimeout(pickerTimers.get(picker));
        const version = (pickerVersions.get(picker) || 0) + 1;
        pickerVersions.set(picker, version);
        pickerTimers.set(
          picker,
          setTimeout(async () => {
            try {
              const result = await accountOptions(
                picker.dataset.accountPurpose,
                { q },
              );
              if (!picker.isConnected || pickerVersions.get(picker) !== version)
                return;
              const selected = $$('input[type="checkbox"]:checked', picker).map(
                (el) => el.value,
              );
              const options = [
                ...new Set([
                  ...selected,
                  ...result.items.map((item) => item.email),
                ]),
              ];
              $(".picker-options", picker).innerHTML =
                options
                  .map(
                    (email) =>
                      `<label class="picker-option"><input type="checkbox" name="${e(picker.dataset.picker)}" value="${e(email)}" ${selected.includes(email) ? "checked" : ""}><span>${e(email)}</span></label>`,
                  )
                  .join("") || '<p class="hint">没有匹配的邮箱</p>';
              updatePicker(picker);
            } catch (error) {
              if (picker.isConnected) h.toast(error.message, true);
            }
          }, 300),
        );
        return;
      }
      $$(".picker-option", picker).forEach(
        (label) =>
          (label.hidden = !label.textContent.toLowerCase().includes(q)),
      );
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target.closest("[data-picker]"))
      updatePicker(event.target.closest("[data-picker]"));
    if (event.target.matches("[data-m-theme]")) {
      try {
        localStorage.setItem("postoffice-theme", event.target.value);
      } catch {}
      applyAppearance();
    }
    if (event.target.matches("[data-select-all]")) {
      const container = event.target.closest(".selection-panel");
      $$("[data-row-select]", container).forEach(
        (input) => (input.checked = event.target.checked),
      );
    }
    if (event.target.matches("[data-select-all], [data-row-select]")) {
      const container = event.target.closest(".selection-panel");
      const rows = $$("[data-row-select]", container),
        count = rows.filter((row) => row.checked).length;
      const label = $("[data-selection-count]", container),
        all = $("[data-select-all]", container);
      if (label) label.textContent = count;
      if (all) {
        all.checked = rows.length > 0 && count === rows.length;
        all.indeterminate = count > 0 && count < rows.length;
      }
    }
  });
  let drag = null;
  document.addEventListener("pointerdown", (event) => {
    if (
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      !event.target.matches(".picker-options")
    )
      return;
    const box = event.target,
      rect = box.getBoundingClientRect(),
      selection = document.createElement("div");
    selection.className = "picker-drag-box";
    box.append(selection);
    drag = {
      box,
      selection,
      x: event.clientX,
      y: event.clientY,
      rect,
      initial: new Map(
        $$(".picker-option input", box).map((i) => [i, i.checked]),
      ),
    };
    box.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  document.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const x = Math.min(drag.x, event.clientX),
      y = Math.min(drag.y, event.clientY),
      width = Math.abs(drag.x - event.clientX),
      height = Math.abs(drag.y - event.clientY);
    Object.assign(drag.selection.style, {
      left: `${x - drag.rect.left + drag.box.scrollLeft}px`,
      top: `${y - drag.rect.top + drag.box.scrollTop}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    $$(".picker-option:not([hidden])", drag.box).forEach((label) => {
      const rect = label.getBoundingClientRect(),
        input = $("input", label);
      const inside =
        rect.left < x + width &&
        rect.right > x &&
        rect.top < y + height &&
        rect.bottom > y;
      input.checked = inside
        ? !drag.initial.get(input)
        : drag.initial.get(input);
    });
    updatePicker(drag.box.closest("[data-picker]"));
  });
  document.addEventListener("pointerup", () => {
    if (drag) {
      drag.selection.remove();
      drag = null;
    }
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (h) applyAppearance();
  });
  window.MailWorkspace = {
    configure: (helpers) => {
      h = helpers;
    },
    get h() {
      return h;
    },
    get platform() {
      return platform;
    },
    get features() {
      return features;
    },
    get connectionId() {
      return connectionId;
    },
    current,
    remote,
    isAdmin,
    isClientManager,
    canPersonal,
    navigate,
    isGlobal,
    can,
    context,
    resource,
    accountOptions,
    operation,
    pages,
    actions,
    forms,
    publicRoutes,
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
    data,
    checked,
    values,
    picker,
    pager,
    dialog,
    closeDialog,
    exportRows,
    showProgress,
    progress,
    loadPublic,
    loadPreferences,
    navigation,
    navigationGroup,
    pageLabel,
    sectionNavigation,
    defaultRoute,
    canRoute,
    applyAppearance,
    async publicRoute() {
      for (const route of publicRoutes) {
        if (route.match(location.hash)) {
          await route.render(location.hash);
          return true;
        }
      }
      return false;
    },
    afterRender() {
      applyAppearance();
      window.MailWorkspace.afterCompose?.();
      const content = $("#content");
      if (
        content &&
        platform.announcement &&
        !$(".workspace-announcement", content)
      )
        content.insertAdjacentHTML(
          "afterbegin",
          `<div class="notice workspace-announcement">${e(platform.announcement)}</div>`,
        );
    },
  };
})();
