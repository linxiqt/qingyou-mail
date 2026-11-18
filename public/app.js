const mailboxClient = document.documentElement.dataset.client === "webmail";
const $ = (s, r = document) => r.querySelector(s),
  $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  mail: "M3 5h18v14H3z M3 5l9 8 9-8",
  chart: "M4 19V9 M10 19V4 M16 19v-7 M22 19H2",
  edit: "M15 5l4 4 M4 20l4-1L20 7a2.1 2.1 0 0 0-3-3L5 16z",
  inbox: "M4 4h16l2 14H2L4 4z M2 14h6l2 3h4l2-3h6",
  send: "M22 2L9 15 M22 2l-7 20-6-7-7-6z",
  forward: "M13 5l7 6-7 6v-4c-6 0-8 2-10 5 0-7 3-10 10-10z",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.9 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  plus: "M12 5v14 M5 12h14",
  batch: "M4 6h16v15H4z M2 3h20 M9 12h6 M12 9v6",
  bulk: "M3 5h14v12H3z M3 5l7 6 7-6 M7 21h14V9",
  key: "M14 7a5 5 0 1 0-2 4l7 7 3-3-3-3-2 2 M6 7h.01",
  globe:
    "M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0 M3 12h18 M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18",
  code: "M4 4h16v13H4z M8 8l-2 2 2 2 M16 8l2 2-2 2 M9 21h6 M12 17v4",
  api: "M4 3h16v14H4z M8 7l-2 3 2 3 M16 7l2 3-2 3 M13 7l-2 6 M9 21h6 M12 17v4",
  server: "M3 3h18v6H3z M3 15h18v6H3z M7 6h.01 M7 18h.01 M17 6h1 M17 18h1",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z",
  trash: "M3 6h18 M5 6l1 15h12l1-15 M9 6V3h6v3 M9 10v7 M15 10v7",
  archive: "M3 3h18v5H3z M5 8v13h14V8 M10 12h4",
  draft: "M14 2H5v20h14V7z M14 2v6h5 M8 13h8 M8 17h6",
  search: "M21 21l-5-5 M18 10a8 8 0 1 0-16 0 8 8 0 0 0 16 0",
  refresh: "M20 8a8 8 0 1 0 0 8 M20 3v5h-5",
  logout: "M9 3H3v18h6 M9 12h13 M17 7l5 5-5 5",
  back: "M19 12H5 M11 6l-6 6 6 6",
  close: "M6 6l12 12 M18 6L6 18",
  check: "M5 12l4 4L19 6",
  attach: "M8 12l7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9 M7 13l7-7",
  download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
  copy: "M8 8h13v13H8z M16 8V3H3v13h5",
  info: "M12 11v6 M12 7h.01 M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0",
  lock: "M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4",
  menu: "M3 6h18 M3 12h18 M3 18h18",
  shield: "M12 2l9 4v6c0 6-9 10-9 10S3 18 3 12V6z M8 12l3 3 5-6",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  reply: "M10 5l-7 6 7 6v-4c7 0 10 3 11 7 0-9-4-12-11-12z",
};
const icon = (n) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n] || paths.mail}"/></svg>`;
const brand = () =>
  `<div class="brand"><span class="brand-mark">${icon("mail")}</span><div><div class="brand-name">青邮</div><div class="brand-en">POST OFFICE</div></div></div>`;
const bytes = (n) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${n || 0} B`;
const date = (v) =>
  new Date(v).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const states = {
  queued: "排队中",
  sending: "投递中",
  delivered: "已投递",
  received: "已接收",
  failed: "失败",
  partial: "部分失败",
  draft: "草稿",
};
const badge = (s) =>
  `<span class="pill ${["failed", "partial"].includes(s) ? "red" : ["queued", "sending"].includes(s) ? "orange" : ""}">${esc(states[s] || s)}</span>`;
const empty = (t, d = "", i = "inbox") =>
  `<div class="empty"><div class="empty-icon">${icon(i)}</div><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`;
const btn = (t, a, i = "plus", c = "") =>
  `<button class="btn ${c}" data-action="${a}">${icon(i)}${esc(t)}</button>`;
const ib = (i, a, t, extra = "") =>
  `<button class="icon-btn" data-action="${a}" title="${esc(t)}" aria-label="${esc(t)}" ${extra}>${icon(i)}</button>`;
const state = {
  user: null,
  license: null,
  shellLicenseBlocked: null,
  csrf: "",
  route: "",
  page: 1,
  q: "",
  email: "",
  unread: false,
  files: [],
  draft: null,
  version: 0,
};
const adminNav = [
  ["overview", "chart", "总览"],
  ["compose", "edit", "发邮件"],
  ["inbox", "inbox", "收件箱"],
  ["sent", "send", "发件箱"],
  ["forwards", "forward", "邮件转发"],
  ["users", "users", "用户列表"],
  ["batch-register", "batch", "批量注册"],
  ["bulk-send", "bulk", "批量群发"],
  ["batch-password", "key", "批量改密"],
  ["domains", "globe", "域名列表"],
  ["codes", "code", "接码"],
  ["api", "api", "邮件推送API"],
  ["system", "settings", "系统设置"],
];
const userNav = [
  ["inbox", "inbox", "收件箱"],
  ["starred", "star", "星标邮件"],
  ["sent", "send", "已发送"],
  ["drafts", "draft", "草稿箱"],
  ["archive", "archive", "归档邮件"],
  ["spam", "shield", "垃圾邮件"],
  ["trash", "trash", "垃圾箱"],
];
const isClientManager = () =>
  mailboxClient && Boolean(state.user?.client_manager);
const clientWorkspace = () =>
  isClientManager() && location.hash.startsWith("#manage/");
const isAdmin = () =>
  (!mailboxClient && state.user?.role === "admin") || clientWorkspace();
const routeHash = (route) => (clientWorkspace() ? `manage/${route}` : route);
const apiPath = (path) =>
  mailboxClient
    ? `/client${path.replace(/^\/admin\/manage(?=\/|\?|$)/, "/manage")}`
    : path;
const pendingReads = new Map();
async function api(path, { method = "GET", body } = {}) {
  const read = method === "GET";
  if (!read) pendingReads.clear();
  const key = `${state.user?.id || "guest"}:${path}`;
  if (read && pendingReads.has(key))
    return JSON.parse(JSON.stringify(await pendingReads.get(key)));
  const task = requestApi(path, { method, body });
  if (read) pendingReads.set(key, task);
  try {
    const result = await task;
    return read ? JSON.parse(JSON.stringify(result)) : result;
  } finally {
    if (pendingReads.get(key) === task) pendingReads.delete(key);
  }
}
async function requestApi(path, { method, body }) {
  // Only reads time out automatically: a timed-out send could already have
  // been accepted. Writes are never retried behind the user's back.
  const signal =
    method === "GET" && typeof AbortSignal !== "undefined"
      ? AbortSignal.timeout(30000)
      : undefined;
  const r = await fetch(`/api${apiPath(path)}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET" ? {} : { "X-CSRF-Token": state.csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  }).catch((error) => {
    if (error.name === "TimeoutError")
      throw new Error("读取超时，请检查网络后重试");
    throw error;
  });
  const d = await r.json().catch(() => ({ error: "服务器响应异常" }));
  if (!r.ok) {
    if (d.code === "LICENSE_REQUIRED" && isAdmin()) {
      state.license = { ...state.license, required: true, valid: false };
      const recovery = MailWorkspace.defaultRoute();
      if (location.hash !== `#${routeHash(recovery)}`)
        location.hash = routeHash(recovery);
    }
    if (
      r.status === 401 &&
      state.user &&
      !/^\/(?:temp\/|code-links\/|code-admin\/)/.test(path)
    ) {
      state.user = null;
      authView(false);
    }
    throw Object.assign(new Error(d.error || "请求失败"), {
      code: d.code,
      status: r.status,
    });
  }
  if (d.csrfToken) state.csrf = d.csrfToken;
  return d;
}
function toast(t, error = false) {
  const e = document.createElement("div");
  e.className = `toast${error ? " error" : ""}`;
  e.textContent = t;
  $("#toasts").append(e);
  setTimeout(() => e.remove(), 5000);
}
function formError(f, e) {
  f.querySelector(".form-error")?.remove();
  const el = document.createElement("div");
  el.className = "form-error";
  el.textContent = e.message;
  f.prepend(el);
}
const title = (en, t, d, buttons = "") =>
  `<div class="page-title"><div><div class="eyebrow">${en}</div><h1>${t}</h1><p>${d}</p></div><div class="row-actions">${buttons}</div></div>`;
const note = (t) =>
  `<div class="notice">${icon("info")}<span>${t}</span></div>`;
const foot = () =>
  '<div class="bottom-note"><span>青邮 · 每一封邮件，都认真对待。</span><span>POST OFFICE / SELF-HOSTED</span></div>';
const deliveryLabel = (s) =>
  s.outboundMode === "direct"
    ? "直接投递 MX"
    : s.outboundMode === "local"
      ? "仅本地投递"
      : "SMTP 中继";
const table = (heads, rows, no = "暂无记录") =>
  `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${heads.length}" class="table-empty">${no}</td></tr>`}</tbody></table></div>`;
function authView(setup) {
  $("#app").innerHTML =
    `<div class="auth"><aside class="auth-story">${brand()}<div><div class="eyebrow" style="color:#b8caa7">A LITTLE SPACE FOR CONNECTION</div><h1>每一封来信，<br>都有<em>自己的归处。</em></h1><p>连接人与人之间的片刻。<br>简单、从容，在你自己的服务器上。</p><div class="auth-art"><div class="envelope-art"></div><div class="stamp-art">${icon("mail")}</div></div></div><div class="auth-foot">SELF-HOSTED · YOUR DOMAIN · YOUR MAIL</div></aside><main class="auth-form-wrap"><form class="auth-form" data-form="${setup ? "setup" : "login"}"><div class="eyebrow">${setup ? "WELCOME TO YOUR POST OFFICE" : "YOUR MAIL, YOUR SPACE"}</div><h2>${setup ? "建立你的邮局" : "欢迎回来"}</h2><p class="muted">${setup ? "先创建独立管理员，登录后再配置邮件域名。" : "登录你的邮箱，看看今天有哪些新的连接。"}</p>${setup ? field("name", "管理员名称", "text", "", "管理员") : ""}${setup ? field("username", "管理员账号", "text", "admin", "admin") : field("email", "邮箱地址或管理账号", "text", "admin 或 you@example.com")}${field("password", setup ? "设置密码（至少 12 位）" : "密码", "password", "输入账号密码", "", !setup)}<button class="btn" type="submit">${setup ? "创建管理员并登录" : "登录"}${icon("forward")}</button><div class="auth-note">${icon("lock")} 你的邮件保存在自己的服务器上<br>青邮 POST OFFICE · Node.js</div></form></main></div>`;
  if (setup)
    $(".auth-form > .muted").textContent =
      "此处只创建管理账号，无需填写域名。登录后在「域名列表」添加邮件域名、配置 SMTP 主机名和解析。";
  if (mailboxClient) {
    $(".auth-form h2").textContent = "客户端登录";
    $(".auth-form > .muted").textContent =
      "使用邮箱账号登录，管理个人邮件及管理员分配的域名。与后台独立登录。";
    const email = $('.auth-form [name="email"]');
    email.type = "email";
    email.placeholder = "you@example.com";
    email.autocomplete = "username";
    email.closest(".field").querySelector("label").textContent = "邮箱地址";
    $('.auth-form [name="password"]').autocomplete = "current-password";
    $(".auth-form .eyebrow").textContent = "QINGYOU WEBMAIL";
    $(".auth-story h1").innerHTML = "你的每一封信，<br>都<em>触手可及。</em>";
  } else if (!setup) {
    $(".auth-form h2").textContent = "管理员后台登录";
    $(".auth-form > .muted").textContent =
      "仅管理员可登录后台。普通用户请使用客户端入口。";
  }
  $(".auth-form").insertAdjacentHTML(
    "beforeend",
    mailboxClient
      ? '<p class="auth-note"><a href="/">管理员入口</a><span> · 请向管理员申请邮箱账号</span></p>'
      : '<p class="auth-note"><a href="/webmail/">普通用户邮箱客户端 →</a></p><p class="auth-note"><a href="/getting-started.html">查看部署与收发使用步骤 →</a></p>',
  );
  $(".auth-form").insertAdjacentHTML(
    "afterbegin",
    `<div class="auth-mobile-brand">${brand()}</div>`,
  );
  MailWorkspace.applyAppearance();
}
function shell() {
  state.shellClientWorkspace = clientWorkspace();
  state.shellLicenseBlocked = Boolean(
    isAdmin() && state.license?.required && !state.license.valid,
  );
  const nav = MailWorkspace.navigation(adminNav, userNav);
  const navHtml = nav
    .map(([r, i, l], index) => {
      const group = isAdmin()
        ? { 0: "工作空间", 4: "邮箱管理", 10: "工具与服务" }[index]
        : "";
      return `${group ? `<div class="nav-section-label">${group}</div>` : ""}<a class="nav-item" data-route="${r}" href="#${routeHash(r)}">${icon(i)}<span>${l}</span>${r === "inbox" && !isAdmin() ? '<span class="nav-count" id="unread-count">0</span>' : ""}</a>`;
    })
    .join("");
  $("#app").innerHTML =
    `<div class="layout"><aside class="sidebar">${brand()}<div class="workspace-label">${isAdmin() ? "ADMIN WORKSPACE" : "MY MAILBOX"}</div>${!isAdmin() ? `<button class="btn compose-side" data-action="new-mail">${icon("edit")}写邮件</button>` : ""}<nav class="nav-scroll" aria-label="${isAdmin() ? "管理员导航" : "邮箱导航"}"><div class="nav-group">${navHtml}</div>${
      isAdmin() && !state.shellLicenseBlocked
        ? ["drafts", "trash"]
            .filter((route) => MailWorkspace.canRoute(route))
            .map(
              (route) =>
                `<a class="nav-item" href="#${route}" data-route="${route}">${icon(route === "drafts" ? "draft" : "trash")}${route === "drafts" ? "草稿箱" : "垃圾箱"}</a>`,
            )
            .join("")
        : ""
    }</nav><div class="sidebar-foot"><div class="quota-meta"><span>邮箱空间</span><span id="quota-percent">0%</span></div><div class="quota-line"><span id="quota-bar"></span></div><div class="quota-meta" id="quota-meta">正在读取空间…</div><div class="profile"><span class="avatar">${esc(state.user.name.slice(0, 1).toUpperCase())}</span><div><div class="profile-name">${esc(state.user.name)}</div><div class="profile-role">${isAdmin() ? esc({ domain_admin: "域名管理员", operator: "邮箱运营员", auditor: "只读审计员", custom: "自定义管理员" }[state.user.role_preset] || (state.user.admin_scope === "scoped" ? "域名管理员" : "超级管理员")) : "个人邮箱"}</div></div>${ib("settings", "account", "账号设置")}</div></div></aside><main class="main"><header class="topbar"><div class="flex"><button class="icon-btn mobile-menu" data-action="menu" aria-label="展开导航">${icon("menu")}</button><div class="breadcrumb">${isAdmin() ? "管理工作台" : "我的邮箱"}<span>/</span><strong id="crumb"></strong></div></div><div class="topbar-right"><span class="server-status"><i class="dot"></i>服务已连接</span><time class="topbar-date">${new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</time>${ib("logout", "logout", "退出登录")}</div></header><div id="content" class="content"></div></main></div>`;
  $(".sidebar").id = "workspace-navigation";
  if (isClientManager()) {
    $(".workspace-label").textContent = clientWorkspace()
      ? "MY DOMAIN WORKSPACE"
      : "MY MAILBOX";
    $(".profile-role").textContent = "普通用户 · 已分配域名权限";
    $(".breadcrumb").firstChild.textContent = clientWorkspace()
      ? "我的域名管理"
      : "我的邮箱";
    $(".nav-scroll").insertAdjacentHTML(
      "beforebegin",
      `<div class="client-workspace-switch"><a href="#inbox" class="${clientWorkspace() ? "" : "selected"}">个人邮箱</a><a href="#manage/access" class="${clientWorkspace() ? "selected" : ""}">域名管理</a></div>`,
    );
    $$(".nav-item").forEach((node) =>
      node.setAttribute("href", `#${routeHash(node.dataset.route)}`),
    );
    if (!MailWorkspace.canPersonal("mail.send")) $(".compose-side")?.remove();
  }
  $(".mobile-menu").setAttribute("aria-controls", "workspace-navigation");
  $(".mobile-menu").setAttribute("aria-expanded", "false");
  $(".sidebar").insertAdjacentHTML(
    "afterend",
    '<button class="sidebar-backdrop" data-action="menu" aria-label="收起导航" tabindex="-1"></button>',
  );
  refreshMailbox();
  MailWorkspace.applyAppearance();
}
async function refreshMailbox() {
  if (state.user?.management_only) {
    $$(".sidebar-foot > .quota-meta, .sidebar-foot > .quota-line").forEach(
      (node) => node.remove(),
    );
    return;
  }
  try {
    const d = await api("/mailbox");
    const p = Math.min(100, (d.usedBytes / d.quotaBytes) * 100);
    if ($("#quota-bar")) $("#quota-bar").style.width = `${p}%`;
    if ($("#quota-percent"))
      $("#quota-percent").textContent = `${p.toFixed(0)}%`;
    if ($("#quota-meta"))
      $("#quota-meta").innerHTML =
        `<span>${bytes(d.usedBytes)} 已使用</span><span>共 ${bytes(d.quotaBytes)}</span>`;
    if ($("#unread-count"))
      $("#unread-count").textContent =
        d.counts.find((c) => c.folder === "inbox")?.unread || 0;
  } catch (e) {
    if (state.user) toast(e.message, true);
  }
}
function go(r) {
  if (location.hash === `#${routeHash(r)}`) render();
  else location.hash = routeHash(r);
}
async function render() {
  if (!mailboxClient && (await MailWorkspace.publicRoute())) return;
  if (!mailboxClient && (await PostOfficeTools.publicRoute())) return;
  document.title = mailboxClient ? "青邮 · 网页邮箱" : "青邮 · Post Office";
  if (!state.user) return init();
  const r =
    (clientWorkspace() ? location.hash.slice(8) : location.hash.slice(1)) ||
    MailWorkspace.defaultRoute();
  if (Boolean(state.shellClientWorkspace) !== clientWorkspace()) {
    state.route = "";
    state.draft = null;
    state.files = [];
    MailWorkspace.resetMailbox?.();
    shell();
  }
  if (
    isAdmin() &&
    state.license?.required &&
    !state.license.valid &&
    r !== MailWorkspace.defaultRoute()
  ) {
    go(MailWorkspace.defaultRoute());
    return;
  }
  if (!MailWorkspace.canRoute(r)) {
    go(MailWorkspace.defaultRoute());
    return;
  }
  if (state.route !== r) {
    state.page = 1;
    state.q = "";
    state.email = "";
    state.unread = false;
    state.route = r;
  }
  if (
    !isAdmin() &&
    adminNav.some((n) => n[0] === r) &&
    !["compose", "inbox", "sent"].includes(r)
  ) {
    go("inbox");
    return;
  }
  if (
    !$("#content") ||
    state.shellLicenseBlocked !==
      Boolean(isAdmin() && state.license?.required && !state.license.valid)
  )
    shell();
  $$(".nav-item").forEach((e) => {
    const selected =
      MailWorkspace.navigationGroup(e.dataset.route) ===
      MailWorkspace.navigationGroup(r);
    e.classList.toggle("selected", selected);
    if (selected) e.setAttribute("aria-current", "page");
    else e.removeAttribute("aria-current");
  });
  $(".layout").classList.remove("menu-open");
  $(".mobile-menu").setAttribute("aria-expanded", "false");
  $("#crumb").textContent =
    MailWorkspace.pageLabel(r) ||
    [...MailWorkspace.navigation(adminNav, userNav), ...userNav].find(
      (n) => n[0] === r,
    )?.[2] ||
    (r === "compose" ? "写邮件" : "邮件");
  const v = ++state.version;
  $("#content").innerHTML =
    '<div class="loading"><span class="spinner"></span>正在读取…</div>';
  try {
    let html;
    if (r === "overview") html = await overview();
    else if (
      [
        "inbox",
        "sent",
        "drafts",
        "trash",
        "starred",
        "archive",
        "spam",
      ].includes(r)
    )
      html = await MailWorkspace.mailbox(r);
    else if (r === "compose") html = await MailWorkspace.compose();
    else if (pages[r]) html = await pages[r]();
    else html = empty("页面不存在", "请从侧边栏选择功能");
    if (v === state.version && state.user) {
      if (
        state.shellLicenseBlocked !==
        Boolean(isAdmin() && state.license?.required && !state.license.valid)
      )
        shell();
      $("#content").innerHTML =
        MailWorkspace.sectionNavigation(r) + html + foot();
      PostOfficeTools.afterRender();
      MailWorkspace.afterRender();
      refreshMailbox();
    }
  } catch (e) {
    if (v === state.version && $("#content"))
      $("#content").innerHTML =
        empty("暂时无法读取", e.message, "info") +
        `<div style="text-align:center">${btn("重新加载", "refresh", "refresh", "secondary")}</div>`;
  }
}
const actionNames = {
  "system.setup": "初始化邮局",
  "auth.login": "账号登录",
  "auth.password": "更新密码",
  "user.create": "创建邮箱",
  "user.batch_create": "批量注册邮箱",
  "user.batch_password": "批量更新密码",
  "user.update": "更新用户",
  "mail.send": "发送邮件",
  "mail.bulk_send": "批量群发",
  "domain.create": "添加域名",
  "domain.update": "更新域名",
  "domain.delete": "删除域名",
  "forward.create": "新增转发规则",
  "forward.delete": "删除转发规则",
  "api_key.create": "创建 API 密钥",
  "api_key.revoke": "撤销 API 密钥",
  "webhook.create": "创建邮件推送",
  "webhook.delete": "删除邮件推送",
  "queue.retry": "重试投递",
  "webhook.retry": "重试推送",
};
async function overview() {
  const [d, s] = await Promise.all([
    api("/admin/overview"),
    api("/admin/system"),
  ]);
  const stat = (l, n, m, i, f = false) =>
    `<div class="card stat-card ${f ? "featured" : ""}"><div class="stat-label">${l}${icon(i)}</div><div class="stat-value">${Number(n).toLocaleString()}</div><div class="stat-meta">${f ? '<span class="dot"></span>' : ""}${m}</div></div>`;
  const max = Math.max(4, ...d.days.flatMap((x) => [x.received, x.sent]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() - 6 + i);
    return {
      label: `${day.getUTCMonth() + 1}/${day.getUTCDate()}`,
      ...d.days.find((x) => x.day === day.toISOString().slice(0, 10)),
    };
  });
  const quick = [
    ["users", "users", "邮箱用户", "管理账号与空间"],
    ["domains", "globe", "域名管理", "连接你的专属域名"],
    ["bulk-send", "bulk", "批量群发", "让消息有序送达"],
    ["api", "api", "邮件推送", "连接应用与工作流"],
  ];
  const hour = new Date().getHours();
  const greeting =
    hour < 6
      ? "夜深了"
      : hour < 12
        ? "早上好"
        : hour < 18
          ? "下午好"
          : "晚上好";
  return (
    `<section class="workspace-welcome"><div class="welcome-copy"><div class="welcome-label"><span></span> 你的专属邮件工作台</div><h1>${greeting}，${esc(state.user.name)}<span class="welcome-period">。</span></h1><p>收好每一封来信，让每一次连接井然有序。</p><div class="welcome-actions">${btn("写一封邮件", "new-mail", "edit")}<a class="welcome-inbox" href="#inbox">查看收件箱 ${icon("forward")}</a></div></div><div class="welcome-art" aria-hidden="true"><div class="welcome-orbit orbit-one"></div><div class="welcome-orbit orbit-two"></div><div class="welcome-envelope">${icon("mail")}<span>${icon("check")}</span></div><div class="welcome-spark spark-one"></div><div class="welcome-spark spark-two"></div></div><div class="welcome-caption"><span>${icon("globe")}${d.domains} 个接入域名</span><span>${icon("send")}${d.queued} 封等待投递</span></div></section><div class="overview-heading"><div><span class="section-overline">OVERVIEW</span><h2>邮局概览</h2></div><span>所有邮箱的当前统计</span></div>` +
    `<div class="stats-grid">${stat("邮箱用户", d.users, "已创建的邮箱账号", "users", true)}${stat("接收邮件", d.received, "当前收件箱中的邮件", "inbox")}${stat("发送邮件", d.sent, `${d.queued} 封等待外部投递`, "send")}${stat("接入域名", d.domains, "你的专属邮件地址", "globe")}</div><div class="overview-grid"><section class="card"><div class="card-header"><div><h2>邮件活动</h2><div class="card-title-note">近 7 天 · 当前保存的收发邮件</div></div><div class="chart-legend"><span><i class="legend-square"></i>接收</span><span><i class="legend-square pale"></i>发送</span></div></div><div class="chart-area"><div class="chart-labels"><span>${max}</span><span>${Math.ceil(max / 2)}</span><span>0</span></div><div class="chart">${days.map((x) => `<div class="chart-day" title="${x.label} 接收 ${x.received || 0} / 发送 ${x.sent || 0}"><div class="bar" style="height:${((x.received || 0) / max) * 100}%"></div><div class="bar pale" style="height:${((x.sent || 0) / max) * 100}%"></div><span class="day-label">${x.label}</span></div>`).join("")}</div></div></section><section class="card"><div class="card-header"><div><h2>快捷入口</h2><div class="card-title-note">日常管理，轻松抵达</div></div>${icon("forward")}</div><div class="quick-grid">${quick.map(([r, i, t, sub]) => `<a href="#${r}" class="quick-link"><span class="quick-icon">${icon(i)}</span><div><strong>${t}</strong><small>${sub}</small></div></a>`).join("")}</div></section></div><div class="overview-bottom"><section class="card"><div class="card-header"><h2>最近动态</h2><a href="#system" class="muted" style="font-size:11px;text-decoration:none">查看全部 →</a></div><div class="activity-list">${
      d.recent
        .slice(0, 5)
        .map(
          (x) =>
            `<div class="activity-row"><span class="activity-icon">${icon(x.action.startsWith("mail") ? "send" : "check")}</span><div>${esc(actionNames[x.action] || x.action)}<small>${esc(x.actor)}</small></div><time>${date(x.created_at)}</time></div>`,
        )
        .join("") || empty("还没有管理动态")
    }</div></section><section class="card"><div class="card-header"><h2>服务概况</h2><span class="pill"><i class="dot"></i>运行中</span></div><div class="system-list">${[
      ["服务主机", `<strong class="mono">${esc(s.hostname)}</strong>`],
      ["已用邮件空间", bytes(d.storageBytes)],
      [
        "外部投递",
        `<span class="pill ${s.outboundMode === "local" ? "gray" : ""}">${deliveryLabel(s)}</span>`,
      ],
      [
        "失败投递",
        `<span class="pill ${d.failed ? "red" : ""}">${d.failed} 封</span>`,
      ],
      [
        "传输加密 TLS",
        `<span class="pill ${s.tls ? "" : "orange"}">${s.tls ? "已启用" : "待配置"}</span>`,
      ],
    ]
      .map(
        ([l, v]) =>
          `<div class="system-row"><span>${l}</span><span>${v}</span></div>`,
      )
      .join("")}</div></section></div>`
  );
}
const adminMailbox = () =>
  isAdmin() && ["inbox", "sent", "trash", "codes"].includes(state.route);
const search = (placeholder = "搜索主题、发件人或正文") =>
  `<form class="search" data-form="search">${icon("search")}<input name="q" aria-label="搜索" placeholder="${placeholder}" value="${esc(state.q)}"></form>`;
const emailFilter = () =>
  `<form class="search" data-form="filter-email">${icon("search")}<input type="email" name="email" value="${esc(state.email)}" placeholder="按完整邮箱地址筛选" aria-label="按邮箱筛选"></form>`;
async function mailbox(folder) {
  const all = adminMailbox();
  const d = await api(
    `${all ? "/admin" : ""}/messages?${new URLSearchParams({ folder, page: state.page, q: state.q, ...(state.email ? { email: state.email } : {}), ...(state.unread ? { unread: "1" } : {}) })}`,
  );
  const names = {
    inbox: ["INBOX", "收件箱", "所有来信，都在这里相遇。"],
    sent: ["SENT MAIL", "发件箱", "查看已发送的邮件与投递状态。"],
    drafts: ["DRAFTS", "草稿箱", "没写完的话，留待下次继续。"],
    trash: ["TRASH", "垃圾箱", "移入此处的邮件可恢复，也可永久删除。"],
    starred: ["STARRED", "星标邮件", "把重要的消息留在手边。"],
    archive: ["ARCHIVE", "归档邮件", "妥善收好每一次连接。"],
    spam: ["SPAM", "垃圾邮件", "移到这里的邮件不出现在收件箱。"],
  };
  return (
    title(...names[folder], btn("写邮件", "new-mail", "edit")) +
    (all
      ? note(
          "管理员视图：查看所有邮箱的" +
            (folder === "inbox" ? "收件" : "发件") +
            "。普通账号只能访问自己的邮件。",
        )
      : "") +
    `<section class="card"><div class="toolbar"><div class="tabs"><button class="tab ${state.unread ? "" : "selected"}" data-action="unread" data-value="0">全部邮件</button><button class="tab ${state.unread ? "selected" : ""}" data-action="unread" data-value="1">未读邮件</button></div>${search()}${all ? emailFilter() : ""}${ib("refresh", "refresh", "刷新邮件")}</div>${d.items.length ? d.items.map((m) => `<article class="mail-row ${m.is_read ? "" : "unread"}" data-action="open-mail" data-id="${m.id}" role="button" tabindex="0" aria-label="打开邮件：${esc(m.subject || "无主题")}"><button class="icon-btn ${m.starred ? "active" : ""}" data-action="star" data-id="${m.id}" data-value="${m.starred ? "0" : "1"}" aria-label="星标邮件">${icon("star")}</button><span class="mail-avatar">${esc((m.from_name || m.from_email || "?").slice(0, 1).toUpperCase())}</span><div class="mail-info"><div class="mail-line"><span class="mail-name">${esc(["sent", "drafts"].includes(folder) ? m.to.map((t) => t.address || t).join(", ") || "未填写收件人" : m.from_name || m.from_email)}</span><time class="mail-time">${date(m.created_at)}</time></div><div class="mail-subject">${esc(m.subject || "（无主题）")}</div><div class="mail-snippet">${esc(m.snippet || "没有正文内容")}</div>${all || folder === "sent" || m.attachment_count ? `<div class="mail-extra">${all ? `<span class="pill gray">${esc(m.mailbox)}</span>` : ""}${folder === "sent" ? badge(m.delivery_status) : ""}${m.attachment_count ? `<span class="muted" style="font-size:10px">${icon("attach")} ${m.attachment_count}</span>` : ""}</div>` : ""}</div></article>`).join("") : empty("这里还没有邮件", state.q ? "换一个关键词试试" : "发送第一封邮件，或等待新的来信。")}<div class="table-foot"><span>共 ${d.total} 封 · 第 ${d.page} / ${Math.max(1, Math.ceil(d.total / d.limit))} 页</span><div class="row-actions"><button class="icon-btn" data-action="page" data-page="${d.page - 1}" ${d.page <= 1 ? "disabled" : ""} aria-label="上一页">${icon("back")}</button><button class="icon-btn" data-action="page" data-page="${d.page + 1}" ${d.page * d.limit >= d.total ? "disabled" : ""} aria-label="下一页">${icon("forward")}</button></div></div></section>`
  );
}
async function openMail(id, remoteBase) {
  const base = remoteBase || (adminMailbox() ? "/admin/manage" : "");
  const m = await api(`${base}/messages/${id}`);
  if (m.folder === "drafts") {
    const a = await api(`/drafts/${id}/attachments`);
    state.files = a.items;
    state.draft = {
      id: m.id,
      to: m.to.map((a) => a.address).join(", "),
      cc: m.cc.map((a) => a.address).join(", "),
      bcc: m.bcc.map((a) => a.address).join(", "),
      subject: m.subject,
      text: m.body_text,
      html: m.body_html,
    };
    go("compose");
    return;
  }
  state.message = { ...m, base };
  const managed = base === "/admin/manage";
  const allowed = (capability, operation) =>
    managed
      ? MailWorkspace.can(capability, m.domain_id, operation)
      : MailWorkspace.canPersonal(capability);
  const messageActions =
    (allowed("mail.send", "create")
      ? btn("回复", "reply", "reply", "secondary small") +
        btn("转发", "forward-mail", "forward", "secondary small")
      : "") +
    (m.folder === "trash" && allowed("mail.update", "update")
      ? btn("恢复", "restore-mail", "archive", "secondary small")
      : "") +
    (allowed("mail.delete", "delete") &&
    (m.folder === "trash" || allowed("mail.delete", "update"))
      ? btn(
          m.folder === "trash" ? "永久删除" : "移入垃圾箱",
          m.folder === "trash" ? "delete-mail" : "trash-mail",
          "trash",
          "danger small",
        )
      : "") +
    (m.folder === "inbox" && allowed("mail.update", "update")
      ? btn("归档", "archive-mail", "archive", "secondary small")
      : "");
  $("#content").innerHTML =
    title(
      "MESSAGE",
      "邮件详情",
      "",
      btn("返回列表", "refresh", "back", "secondary"),
    ) +
    `<section class="card"><div class="toolbar"><div class="row-actions">${messageActions}</div><a class="btn secondary small" href="/api${apiPath(`${base}/messages/${m.id}/raw`)}">${icon("download")}原始邮件</a></div><div class="message-head"><h2>${esc(m.subject || "（无主题）")}</h2><div class="flex"><span class="mail-avatar">${esc((m.from_name || m.from_email || "?").slice(0, 1).toUpperCase())}</span><div class="message-meta"><strong>${esc(m.from_name || m.from_email)}</strong> &lt;${esc(m.from_email)}&gt;<br>收件人：${esc(m.to.map((x) => x.address || x).join(", "))}${m.cc.length ? `<br>抄送：${esc(m.cc.map((x) => x.address || x).join(", "))}` : ""}${m.bcc?.length ? `<br>密送：${esc(m.bcc.map((x) => x.address || x).join(", "))}` : ""}<br>${date(m.created_at)} · ${bytes(m.size)} ${badge(m.delivery_status)}</div></div></div><div class="message-body ${m.body_html ? "" : "plain"}">${m.body_html || esc(m.body_text) || '<span class="muted">没有正文</span>'}</div>${m.attachments.length ? `<div class="attachments">${m.attachments.map((a) => `<a class="attachment" href="/api${apiPath(`${base}/attachments/${a.id}`)}?filename=${encodeURIComponent(a.filename)}">${icon("attach")}<span>${esc(a.filename)}<small>${bytes(a.size)}</small></span>${icon("download")}</a>`).join("")}</div>` : ""}</section>` +
    foot();
  refreshMailbox();
  MailWorkspace.decorateMessage(m);
}
const chips = () =>
  state.files
    .map(
      (a, i) =>
        `<span class="file-chip">${icon("attach")}${esc(a.filename)}<button type="button" data-action="remove-file" data-index="${i}" aria-label="移除附件">×</button></span>`,
    )
    .join("");
function compose() {
  const d = state.draft || {};
  return (
    title("COMPOSE", "写一封邮件", "从这里，开始一次新的连接。") +
    `<form class="card compose-form" data-form="compose"><div class="compose-field"><label>发件人</label><input value="${esc(state.user.name)} &lt;${esc(state.user.email)}&gt;" readonly aria-label="发件人"></div>${[
      ["to", "收件人", "多个地址用逗号分隔"],
      ["cc", "抄送", "可选"],
      ["bcc", "密送", "仅发件人可见"],
      ["subject", "主题", "给这封邮件写一个主题"],
    ]
      .map(
        ([k, l, p]) =>
          `<div class="compose-field"><label for="compose-${k}">${l}</label><input id="compose-${k}" name="${k}" value="${esc(d[k] || "")}" placeholder="${p}" ${k === "subject" ? 'maxlength="500"' : ""}></div>`,
      )
      .join(
        "",
      )}<div class="compose-editor"><textarea name="text" aria-label="邮件正文" placeholder="你好，\n\n在这里写下你想说的话…">${esc(d.text || "")}</textarea></div><div class="file-list" id="file-list">${chips()}</div><div class="compose-footer"><div class="row-actions"><button type="submit" class="btn">${icon("send")}发送邮件</button><button type="button" class="btn secondary" data-action="save-draft">${icon("draft")}保存草稿</button><button type="button" class="icon-btn" data-action="attach" title="添加附件" aria-label="添加附件">${icon("attach")}</button><input type="file" id="file-input" class="sr-only" multiple></div><span class="hint">${d.id ? "已保存的草稿" : "纯文本编辑 · 支持附件"}</span></div></form>`
  );
}
const pages = {
  async users() {
    const { items } = await api("/admin/users");
    state.users = items;
    const rows = items.filter((u) =>
      `${u.email} ${u.name}`.toLowerCase().includes(state.q.toLowerCase()),
    );
    return (
      title(
        "PEOPLE",
        "用户列表",
        "为每一个人，安放一个专属的邮箱。",
        btn("添加用户", "add-user"),
      ) +
      `<section class="card"><div class="toolbar"><span class="muted" style="font-size:12px">${items.length} 个邮箱账号</span>${search("搜索邮箱地址或姓名")}</div>${table(
        ["邮箱用户", "角色", "邮箱空间", "状态", "创建时间", "操作"],
        rows.map(
          (u) =>
            `<tr><td><div class="flex"><span class="avatar">${esc(u.name.slice(0, 1).toUpperCase())}</span><div>${esc(u.name)}<div class="subline mono">${esc(u.display_email || u.email)}</div></div></div></td><td><span class="pill ${u.role === "admin" ? "" : "gray"}">${u.role === "admin" ? "管理员" : "普通用户"}</span></td><td class="mono">${bytes(u.used_bytes)} / ${bytes(u.quota_bytes)}</td><td><span class="pill ${u.active ? "" : "gray"}"><i class="dot"></i>${u.active ? "正常" : "已停用"}</span></td><td class="muted">${date(u.created_at)}</td><td><div class="row-actions"><button class="btn secondary small" data-action="edit-user" data-id="${u.id}">编辑</button>${ib("key", "reset-user", "重置密码", `data-email="${esc(u.email)}"`)}</div></td></tr>`,
        ),
      )}<div class="table-foot">${rows.length} 个匹配账号 <a href="#batch-register">批量注册 →</a></div></section>`
    );
  },
  async domains() {
    const { items } = await api("/admin/domains");
    return (
      title(
        "DOMAINS",
        "域名列表",
        "让邮件拥有你的名字。",
        btn("添加域名", "add-domain"),
      ) +
      note(
        '添加域名后，点击「DNS 配置」复制记录并检测。公网收发需要部署服务器、开放 25 端口并配置证书与反向解析。<a href="/getting-started.html">查看完整使用步骤 →</a>',
      ) +
      `<section class="card">${table(
        ["邮箱域名", "邮箱账号", "状态", "添加时间", "操作"],
        items.map(
          (d) =>
            `<tr><td><div class="flex"><span class="avatar">${icon("globe")}</span><span class="mono">${esc(d.name)}</span></div></td><td>${d.user_count} 个</td><td><span class="pill ${d.enabled ? "" : "gray"}">${d.enabled ? "已启用" : "已停用"}</span></td><td class="muted">${date(d.created_at)}</td><td><div class="row-actions"><button class="btn light small" data-action="dns-guide" data-id="${d.id}">DNS 配置</button><button class="btn secondary small" data-action="toggle-domain" data-id="${d.id}" data-enabled="${d.enabled ? "0" : "1"}">${d.enabled ? "停用" : "启用"}</button>${!d.user_count ? ib("trash", "delete-domain", "删除域名", `data-id="${d.id}"`) : ""}</div></td></tr>`,
        ),
      )}</section>`
    );
  },
  async forwards() {
    const { items } = await api("/admin/forwards");
    return (
      title(
        "FORWARDING",
        "邮件转发",
        "让来信沿着你设定的方向，继续抵达。",
        btn("添加转发", "add-forward"),
      ) +
      note(
        "支持本地与外部转发，可保留原邮箱副本。系统会检查转发循环，外部转发使用当前投递方式。",
      ) +
      `<section class="card">${table(
        ["来源邮箱", "转发目标", "本地副本", "状态", "操作"],
        items.map(
          (f) =>
            `<tr><td class="mono">${esc(f.email)}</td><td class="mono">${esc(f.target)}</td><td>${f.keep_copy ? "保留" : "不保留"}</td><td><span class="pill">生效中</span></td><td>${ib("trash", "delete-forward", "删除规则", `data-id="${f.id}"`)}</td></tr>`,
        ),
      )}</section>`
    );
  },
  async "batch-register"() {
    return PostOfficeTools.renderBatch();
  },
  async "batch-password"() {
    return (
      title("PASSWORDS", "批量改密", "统一更新账号密码，保持访问安全。") +
      note(
        "改密会立即撤销所选账号的全部网页登录会话。留空新密码时，为每个账号生成独立随机密码。",
      ) +
      `<div class="split-grid"><section class="card"><div class="card-header"><h2>选择邮箱并设置密码</h2></div><div class="card-body"><form data-form="batch-password"><div class="field"><label>邮箱账号</label><textarea name="emails" rows="7" required placeholder="alice@example.com\nbob@example.com"></textarea><p class="hint">每行一个完整邮箱地址，最多 100 个。</p></div>${field("password", "新密码（可选）", "password", "留空自动生成独立随机密码", "", true)}<button class="btn" type="submit">${icon("key")}更新所选密码</button></form></div></section><section class="card"><div class="card-header"><h2>更新结果</h2></div><div class="card-body" id="batch-result">${empty("等待更新", "密码仅在本次结果中显示。", "key")}</div></section></div>`
    );
  },
  async "bulk-send"() {
    return (
      title("BROADCAST", "批量群发", "把同一份消息，分别送到每个人手中。") +
      note(
        "每人收到单独一封邮件，互相看不到其他地址。最多 100 个收件人，外部投递状态可在发件箱查看。",
      ) +
      `<div class="split-grid"><section class="card"><div class="card-header"><h2>群发内容</h2></div><div class="card-body"><form data-form="bulk-send"><div class="field"><label>发件账号</label><input value="${esc(state.user.email)}" disabled></div><div class="field"><label>收件人列表</label><textarea name="recipients" rows="4" required placeholder="alice@example.com\nbob@example.com"></textarea></div>${field("subject", "邮件主题", "text", "例如：本周工作安排")}<div class="field"><label>邮件正文</label><textarea name="text" rows="8" required placeholder="写下要发送给大家的内容…"></textarea></div><button class="btn" type="submit">${icon("bulk")}开始群发</button></form></div></section><section class="card"><div class="card-header"><h2>群发结果</h2></div><div class="card-body" id="batch-result">${empty("等待发送", "发送后逐一显示接收结果。", "send")}</div></section></div>`
    );
  },
  async codes() {
    return PostOfficeTools.renderCodes();
  },
  async api() {
    const [keys, hooks] = await Promise.all([
      api("/admin/api-keys"),
      api("/admin/webhooks"),
    ]);
    const sample = [
      "POST /api/v1/send",
      "Authorization: Bearer YOUR_API_KEY",
      "Content-Type: application/json",
      "",
      "{",
      `  "from": "${state.user.email}",`,
      '  "to": ["user@example.com"],',
      '  "subject": "你好，青邮",',
      '  "text": "这是一封来自 API 的邮件。"',
      "}",
    ].join("\n");
    return (
      title(
        "INTEGRATIONS",
        "邮件推送API",
        "把你的邮局，连接到更多应用与工作流。",
      ) +
      `<section class="card"><div class="card-header"><div><h2>API 密钥</h2><div class="card-title-note">按权限访问全局邮件数据，请仅授予可信应用</div></div>${btn("创建密钥", "add-api-key", "plus", "secondary small")}</div>${table(
        ["名称", "密钥前缀", "权限", "最近使用", "操作"],
        keys.items.map(
          (k) =>
            `<tr><td>${esc(k.name)}</td><td class="mono">${esc(k.prefix)}…</td><td>${k.scopes.map((s) => `<span class="pill gray">${esc(s)}</span>`).join(" ")}</td><td class="muted">${k.last_used_at ? date(k.last_used_at) : "尚未使用"}</td><td>${ib("trash", "delete-api-key", "撤销密钥", `data-id="${k.id}"`)}</td></tr>`,
        ),
      )}</section><div class="split-grid gap-top"><section class="card"><div class="card-header"><div><h2>来信 Webhook</h2><div class="card-title-note">新邮件到达时，推送至你的 HTTPS 接口</div></div>${btn("添加推送", "add-webhook", "plus", "secondary small")}</div>${table(
        ["推送名称 / 地址", "操作"],
        hooks.items.map(
          (h) =>
            `<tr><td>${esc(h.name)}<div class="subline mono">${esc(h.url.slice(0, 70))}</div></td><td>${ib("trash", "delete-webhook", "删除推送", `data-id="${h.id}"`)}</td></tr>`,
        ),
      )}</section><section class="card"><div class="card-header"><h2>调用示例</h2><span class="pill gray">Bearer Token</span></div><div class="card-body"><pre class="api-code">${esc(sample)}</pre><p class="hint">GET /api/v1/messages?email=user@example.com<br>GET /api/v1/codes?email=user@example.com<br>推送签名：HMAC-SHA256(secret, timestamp + "." + 原始请求体)。<br>完整字段、权限和签名验证示例参见 README。</p></div></section></div><section class="card gap-top"><div class="card-header"><h2>最近推送任务</h2></div>${table(
        ["推送", "状态", "尝试次数", "最近错误", "操作"],
        hooks.jobs.map(
          (j) =>
            `<tr><td>${esc(j.name)}</td><td>${badge(j.state)}</td><td>${j.attempts}</td><td class="muted" title="${esc(j.last_error)}">${esc(j.last_error.slice(0, 70) || "—")}</td><td>${j.state === "failed" ? `<button class="btn secondary small" data-action="retry-webhook" data-id="${j.id}">重试</button>` : "—"}</td></tr>`,
        ),
      )}</section>`
    );
  },
  async system() {
    const s = await api("/admin/system");
    return (
      title(
        "SYSTEM",
        "运行状态",
        "查看运行配置、投递队列与管理记录。",
        btn("刷新状态", "refresh", "refresh", "secondary"),
      ) +
      note(
        "网络、TLS 和投递方式从服务器配置读取，修改后重启生效。外部投递失败会显示原因并通知发件邮箱。",
      ) +
      `<section class="card"><div class="card-header"><h2>运行信息</h2><span class="pill"><i class="dot"></i>运行 ${Math.floor(s.uptime / 3600)} 小时 ${Math.floor(s.uptime / 60) % 60} 分钟</span></div><div class="card-body details-grid">${[
        ["邮件主机", s.hostname],
        ["访问地址", s.publicUrl],
        ["运行环境", `Node.js ${s.node}`],
        ["SMTP / Submission", `${s.smtpPort} / ${s.submissionPort}`],
        [
          "IMAP / POP3 / SMTP（SSL/TLS）",
          [s.imapsPort, s.pop3sPort, s.smtpsPort]
            .map((p) => p || "关闭")
            .join(" / "),
        ],
        ["传输加密", s.tls ? "STARTTLS 已启用" : "未配置 TLS（开发模式）"],
        ["外部投递", deliveryLabel(s)],
        ...(s.outboundMode === "relay" ? [["中继主机", s.relayHost]] : []),
        ["单封邮件限制", `${s.maxMessageMB} MB（含 MIME 编码）`],
        ["默认邮箱配额", `${s.defaultQuotaMB} MB`],
        [
          "DKIM 签名",
          s.dkim
            ? s.dkimBackend === "rspamd"
              ? "Rspamd"
              : "Node.js"
            : "未配置",
        ],
        ["应用版本", s.version],
      ]
        .map(
          ([l, v]) =>
            `<div class="detail-box"><div class="muted">${l}</div><strong>${esc(v)}</strong></div>`,
        )
        .join(
          "",
        )}</div></section><section class="card gap-top"><div class="card-header"><h2>外部投递队列</h2><span class="pill gray">最近 100 项</span></div>${table(
        ["发件人 / 收件人", "状态", "尝试", "最近错误", "操作"],
        s.queue.map(
          (j) =>
            `<tr><td class="mono">${esc(j.sender)}<div class="subline">→ ${esc(j.recipient)}</div></td><td>${badge(j.state)}</td><td>${j.attempts} / 5</td><td class="muted" title="${esc(j.last_error)}">${esc(j.last_error.slice(0, 70) || "—")}</td><td>${j.state === "failed" ? `<button class="btn secondary small" data-action="retry-job" data-id="${j.id}">重试</button>` : "—"}</td></tr>`,
        ),
      )}</section><section class="card gap-top"><div class="card-header"><h2>管理操作日志</h2><span class="pill gray">最近 50 项</span></div>${table(
        ["时间", "操作账号", "操作", "详情"],
        s.audit.map(
          (a) =>
            `<tr><td class="muted">${date(a.created_at)}</td><td class="mono">${esc(a.actor)}</td><td>${esc(actionNames[a.action] || a.action)}</td><td class="mono muted">${esc(a.detail)}</td></tr>`,
        ),
      )}</section>`
    );
  },
};
async function showDns(id, input = {}) {
  const plan = await api(
    `/admin/domains/${id}/dns?${new URLSearchParams(input)}`,
  );
  state.dns = { id, plan };
  modal(
    `DNS 配置 · ${plan.domain}`,
    `<p class="hint">在 DNSPod / 阿里云 / Cloudflare 等域名解析控制台填写。此页面只生成指引，不会修改你的 DNS 或服务器配置。</p><div class="form-grid gap-top">${field("hostname", "邮件服务器主机名", "text", "mail.your-domain.com", plan.hostname)}${field("ip", "Linux 服务器公网 IP", "text", "例如：你的服务器公网 IPv4", plan.ip, true)}</div>${plan.warnings.length ? note(plan.warnings.map(esc).join("<br>")) : ""}<div class="dns-table">${table(
      ["类型", "主机记录 / 完整名称", "记录值", "优先级", "操作"],
      plan.records.map(
        (r, i) =>
          `<tr><td><span class="pill gray">${esc(r.type)}</span></td><td class="mono">${esc(r.host)}<div class="subline">${esc(r.name)}</div></td><td><div class="mono dns-value">${r.value ? esc(r.value) : '<span class="muted">待配置</span>'}</div><div class="subline">${esc(r.purpose)}</div>${r.pending ? `<p class="hint">${esc(r.pending)}</p>` : ""}</td><td>${r.priority || "—"}</td><td>${r.value ? ib("copy", "copy-dns", "复制记录值", `data-index="${i}"`) : "—"}</td></tr>`,
      ),
    )}</div><div class="row-actions gap-top">${btn("检测 DNS 解析", "check-dns", "refresh", "secondary")}${btn("下载配置指引", "download-dns", "download", "secondary")}</div><div id="dns-result" class="gap-top"></div><h3 class="gap-top">按顺序完成</h3><ol class="guide-steps">${plan.instructions.map((x) => `<li>${esc(x)}</li>`).join("")}</ol><p class="hint">服务器 .env 至少对应以下值，修改后需要重启：</p><pre class="api-code">${esc(plan.env)}</pre>`,
    async (data) => showDns(id, data),
    "按上方主机与 IP 重新生成",
  );
  $(".modal").classList.add("dns-modal");
}
function field(n, l, t = "text", p = "", v = "", optional = false) {
  return `<div class="field"><label for="field-${n}">${l}</label><input id="field-${n}" type="${t}" name="${n}" placeholder="${esc(p)}" value="${esc(v)}" ${t === "password" ? 'maxlength="256" autocomplete="' + (n === "currentPassword" ? "current-password" : "new-password") + '" ' + (optional ? "" : 'minlength="12"') : ""} ${optional ? "" : "required"}></div>`;
}
function modal(t, body, submit, label = "保存") {
  $("#modal-root").innerHTML =
    `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(t)}"><header class="modal-header"><h2>${esc(t)}</h2>${ib("close", "close-modal", "关闭")}</header><div class="modal-body"><form id="modal-form">${body}${submit ? `<div class="modal-foot"><button type="button" class="btn secondary" data-action="close-modal">取消</button><button type="submit" class="btn">${label}</button></div>` : ""}</form></div></section></div>`;
  const f = $("#modal-form");
  if (submit)
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = $("button[type=submit]", f);
      if (b.disabled) return;
      b.disabled = true;
      try {
        await submit(Object.fromEntries(new FormData(f)), f);
      } catch (error) {
        formError(f, error);
      } finally {
        b.disabled = false;
      }
    });
  setTimeout(
    () => $("input,textarea,select,button", $("#modal-root"))?.focus(),
    0,
  );
}
function closeModal() {
  $("#modal-root").innerHTML = "";
}
function confirmAction(t, d, fn) {
  modal(
    t,
    `<p class="muted" style="line-height:1.9">${esc(d)}</p>`,
    async () => {
      await fn();
      closeModal();
    },
    "确认",
  );
}
function credentials(items, target) {
  state.results = items.filter((item) => item.password && !item.error);
  target.innerHTML = `<span class="pill"><i class="dot"></i>成功处理 ${state.results.length} / ${items.length} 个账号</span><p class="hint">密码仅显示本次，请及时下载保存。</p><div class="secret-box"><pre>${items.map((x) => `${esc(x.email)}\n${x.error ? "失败：" + esc(x.error) : esc(x.password)}`).join("\n\n")}</pre></div><div class="form-actions">${btn("下载成功账号密码", "download-results", "download", "secondary")}</div>`;
}
function download(n, c) {
  const a = document.createElement("a"),
    url = URL.createObjectURL(new Blob([c], { type: "text/plain" }));
  a.href = url;
  a.download = n;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copy(v) {
  try {
    await navigator.clipboard.writeText(v);
    toast("已复制");
  } catch {
    modal(
      "复制内容",
      `<textarea readonly aria-label="待复制内容">${esc(v)}</textarea><p class="hint">请手动选中并复制。</p>`,
    );
  }
}
const actions = {
  "dns-guide": (e) => showDns(e.dataset.id),
  "copy-dns": (e) =>
    copy(state.dns.plan.records[Number(e.dataset.index)].value),
  async "check-dns"() {
    const { id, plan } = state.dns;
    $("#dns-result").innerHTML = '<span class="spinner"></span>正在查询 DNS…';
    try {
      const result = await api(`/admin/domains/${id}/dns/check`, {
        method: "POST",
        body: { hostname: plan.hostname, ip: plan.ip },
      });
      if (!$("#dns-result")) return;
      const labels = {
        passed: "已解析",
        missing: "未查到",
        mismatch: "不匹配",
        review: "待核对",
        error: "查询失败",
      };
      $("#dns-result").innerHTML =
        table(
          ["项目", "检测状态", "本次建议值", "当前解析结果"],
          result.items.map(
            (r) =>
              `<tr><td>${esc(r.type)}<div class="mono dns-value">${esc(r.name)}</div></td><td><span class="pill ${r.status === "passed" ? "" : ["missing", "review"].includes(r.status) ? "orange" : "red"}">${labels[r.status]}</span></td><td class="mono dns-value">${esc(r.value || "未指定")}</td><td><div class="mono dns-value">${esc(r.found.map((v) => (typeof v === "object" ? `${v.priority} ${v.exchange}` : v)).join("\n") || "—")}</div><p class="hint">${esc(r.detail)}</p></td></tr>`,
          ),
        ) +
        `<p class="hint">${esc(result.note)}<br>检测时间：${date(result.checkedAt)}</p>`;
    } catch (error) {
      if ($("#dns-result")) $("#dns-result").textContent = error.message;
    }
  },
  "download-dns": () => {
    const p = state.dns.plan;
    download(
      `${p.domain}-dns.txt`,
      [
        `邮箱域名：${p.domain}`,
        `邮件主机：${p.hostname}`,
        `服务器IP：${p.ip || "待填写"}`,
        "",
        ...p.records.map(
          (r) =>
            `${r.type}\t${r.host}\t${r.value || "[待配置]"}${r.priority ? `\t优先级 ${r.priority}` : ""}\n${r.pending || r.purpose}`,
        ),
        "",
        ...p.instructions.map((s, i) => `${i + 1}. ${s}`),
        "",
        p.env,
        "",
        ...p.warnings,
      ].join("\r\n"),
    );
  },
  refresh: () => render(),
  menu: () => {
    const opened = $(".layout").classList.toggle("menu-open");
    $(".mobile-menu").setAttribute("aria-expanded", String(opened));
  },
  "close-modal": closeModal,
  "new-mail": () => {
    state.draft = null;
    state.files = [];
    go("compose");
  },
  async logout() {
    await api("/auth/logout", { method: "POST" });
    state.user = null;
    state.draft = null;
    state.files = [];
    state.results = null;
    state.csrf = "";
    closeModal();
    authView(false);
  },
  account: () =>
    modal(
      "账号设置",
      `<p class="muted mono">${esc(state.user.email)}</p>${state.user.email.includes("@") ? '<p><button type="button" class="btn secondary" data-action="external-settings">第三方客户端设置</button></p>' : ""}${field("currentPassword", "当前密码", "password")}${field("password", "新密码", "password", "至少 12 个字符")}`,
      async (d) => {
        await api("/auth/password", { method: "POST", body: d });
        closeModal();
        toast("密码已更新，其他会话已撤销");
      },
    ),
  async "external-settings"() {
    const settings = await api("/auth/mail-client");
    const lines = [
      ...(settings.plaintext
        ? [
            [
              "IMAP 收件",
              settings.plaintext.imapPort,
              "无（明文）",
              settings.plaintext.hostname,
            ],
            [
              "SMTP 发件",
              settings.plaintext.smtpPort,
              "无（明文）",
              settings.plaintext.hostname,
            ],
          ]
        : []),
      ["IMAP 收件", settings.imapsPort, "SSL/TLS"],
      ["POP3 收件", settings.pop3sPort, "SSL/TLS"],
      ["SMTP 发件", settings.smtpsPort, "SSL/TLS"],
      ["SMTP 发件", settings.submissionPort, "STARTTLS"],
    ]
      .filter((row) => row[1])
      .map(
        ([protocol, port, encryption, hostname = settings.hostname]) =>
          `${protocol}  ${hostname}  ${port}  ${encryption}`,
      );
    const connectionText = [
      ...lines,
      "邮箱账号  " + settings.username,
      "邮箱密码  使用此邮箱的登录密码",
    ].join("\n");
    modal(
      "第三方客户端设置",
      lines.length
        ? `<p>收件选 IMAP 可同步文件夹和标星，选 POP3 可下载收件箱。发件时开启 SMTP 身份验证。</p><pre class="api-code" id="external-mail-settings">${esc(connectionText)}</pre><button type="button" class="btn secondary" data-action="copy-external-settings">${icon("copy")}复制连接参数</button>`
        : "<p>此服务器尚未启用加密邮件端口，请联系管理员配置 TLS 证书及端口。</p>",
    );
  },
  "copy-external-settings": () =>
    copy($("#external-mail-settings").textContent),
  page: (e) => {
    state.page = Number(e.dataset.page);
    render();
  },
  unread: (e) => {
    state.unread = e.dataset.value === "1";
    state.page = 1;
    render();
  },
  "open-mail": (e) => openMail(e.dataset.id),
  async star(e) {
    await api(`${adminMailbox() ? "/admin" : ""}/messages/${e.dataset.id}`, {
      method: "PATCH",
      body: { starred: e.dataset.value === "1" },
    });
    render();
  },
  "copy-code": (e) => copy(state.codes[Number(e.dataset.index)].code),
  attach: () => $("#file-input").click(),
  "remove-file": (e) => {
    state.files.splice(Number(e.dataset.index), 1);
    $("#file-list").innerHTML = chips();
  },
  async "save-draft"() {
    const data = Object.fromEntries(new FormData($("[data-form=compose]")));
    const r = await api("/drafts", {
      method: "POST",
      body: { ...data, id: state.draft?.id, attachments: state.files },
    });
    state.draft = { ...data, id: r.id };
    toast("草稿已保存");
    refreshMailbox();
  },
  reply: () => {
    const m = state.message;
    state.files = [];
    state.draft = {
      to: m.from_email,
      subject: /^Re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      text: `\n\n—— ${date(m.created_at)}，${m.from_email} 写道：\n${m.body_text
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}`,
    };
    go("compose");
  },
  "forward-mail": () => {
    const m = state.message;
    state.files = [];
    state.draft = {
      subject: `Fwd: ${m.subject}`,
      text: `\n\n—— 转发邮件 ——\n发件人：${m.from_email}\n时间：${date(m.created_at)}\n主题：${m.subject}\n\n${m.body_text}`,
    };
    go("compose");
    toast("已引用正文；附件可下载后重新添加");
  },
  async "trash-mail"() {
    const m = state.message;
    await api(`${m.base}/messages/${m.id}`, {
      method: "PATCH",
      body: { folder: "trash" },
    });
    toast("已移入垃圾箱");
    render();
  },
  async "archive-mail"() {
    const m = state.message;
    await api(`${m.base}/messages/${m.id}`, {
      method: "PATCH",
      body: { folder: "archive" },
    });
    toast("邮件已归档");
    render();
  },
  async "restore-mail"() {
    await api(`${state.message.base}/messages/${state.message.id}/restore`, {
      method: "POST",
    });
    toast("邮件已恢复");
    render();
  },
  "delete-mail": () =>
    confirmAction("永久删除邮件", "此操作会永久删除邮件与附件。", async () => {
      const m = state.message;
      await api(`${m.base}/messages/${m.id}`, { method: "DELETE" });
      toast("邮件已永久删除");
      render();
    }),
  "add-domain": () =>
    modal(
      "添加邮箱域名",
      field("name", "邮箱域名", "text", "example.com"),
      async (d) => {
        const created = await api("/admin/domains", {
          method: "POST",
          body: d,
        });
        closeModal();
        toast("域名与独立 DKIM 密钥已创建，请复制 DNS 记录");
        render();
        await showDns(created.id);
      },
    ),
  "toggle-domain": (e) =>
    confirmAction(
      e.dataset.enabled === "1" ? "启用域名" : "停用域名",
      "停用后，该域名下所有邮箱将无法登录与收发邮件。",
      async () => {
        await api(`/admin/domains/${e.dataset.id}`, {
          method: "PATCH",
          body: { enabled: e.dataset.enabled === "1" },
        });
        render();
      },
    ),
  "delete-domain": (e) =>
    confirmAction("删除域名", "仅允许删除没有邮箱账号的域名。", async () => {
      await api(`/admin/domains/${e.dataset.id}`, { method: "DELETE" });
      render();
    }),
  async "add-user"() {
    const { items } = await api("/admin/domains");
    modal(
      "添加邮箱用户",
      `<div class="field"><label>邮箱域名</label><select name="domain">${items
        .filter((d) => d.enabled)
        .map((d) => `<option>${esc(d.name)}</option>`)
        .join(
          "",
        )}</select></div>${field("local", "邮箱用户名", "text", "alice")}${field("name", "显示名称", "text", "小青")}${field("password", "登录密码（留空自动生成）", "password", "至少 12 个字符", "", true)}`,
      async (d, f) => {
        if (d.password && d.password.length < 12)
          throw new Error("密码至少 12 个字符");
        const r = await api("/admin/users", { method: "POST", body: d });
        credentials([r], f);
        toast("邮箱已创建");
      },
    );
  },
  "edit-user": (e) => {
    const u = state.users.find((u) => u.id === Number(e.dataset.id));
    modal(
      "编辑邮箱账号",
      `<p class="muted mono">${esc(u.email)}</p>${field("name", "显示名称", "text", "", u.name)}${field("quotaMB", "邮箱配额（MB）", "number", "", u.quota_bytes / 1024 ** 2)}<label class="check-label"><input type="checkbox" name="active" ${u.active ? "checked" : ""}>允许登录与收发邮件</label>`,
      async (d) => {
        await api(`/admin/users/${u.id}`, {
          method: "PATCH",
          body: {
            name: d.name,
            quotaMB: Number(d.quotaMB),
            active: d.active === "on",
          },
        });
        closeModal();
        toast("用户已更新");
        render();
      },
    );
  },
  "reset-user": (e) =>
    modal(
      "重置账号密码",
      `<p class="muted mono">${esc(e.dataset.email)}</p>${field("password", "新密码（留空自动生成）", "password", "至少 12 个字符", "", true)}`,
      async (d, f) => {
        const r = await api("/admin/users/passwords", {
          method: "POST",
          body: { emails: [e.dataset.email], password: d.password },
        });
        credentials(r.items, f);
      },
    ),
  "add-forward": () =>
    modal(
      "添加邮件转发",
      field("email", "来源邮箱", "email", "alice@example.com") +
        field("target", "转发至", "email", "bob@example.com") +
        '<label class="check-label"><input type="checkbox" name="keepCopy" checked>在来源邮箱保留副本</label>',
      async (d) => {
        await api("/admin/forwards", {
          method: "POST",
          body: { ...d, keepCopy: d.keepCopy === "on" },
        });
        closeModal();
        toast("转发规则已添加");
        render();
      },
    ),
  "delete-forward": (e) =>
    confirmAction(
      "删除转发规则",
      "删除后，新邮件将不再转发至此目标。",
      async () => {
        await api(`/admin/forwards/${e.dataset.id}`, { method: "DELETE" });
        render();
      },
    ),
  "download-results": () =>
    download(
      "mailbox-credentials.txt",
      state.results.map((x) => `${x.email}\t${x.password}`).join("\r\n"),
    ),
  "add-api-key": () =>
    modal(
      "创建 API 密钥",
      field("name", "密钥名称", "text", "例如：业务系统") +
        '<p class="hint">密钥可以在选定权限内访问全局邮箱数据。</p><label class="check-label"><input type="checkbox" name="send" checked>mail:send · 以本地账号发送邮件</label><label class="check-label"><input type="checkbox" name="read">mail:read · 查询邮件列表</label><label class="check-label"><input type="checkbox" name="codes">codes:read · 读取验证码</label>',
      async (d, f) => {
        const scopes = [];
        if (d.send) scopes.push("mail:send");
        if (d.read) scopes.push("mail:read");
        if (d.codes) scopes.push("codes:read");
        const r = await api("/admin/api-keys", {
          method: "POST",
          body: { name: d.name, scopes },
        });
        f.innerHTML = `<span class="pill">密钥已创建</span><p class="hint">密钥仅显示一次，请妥善保管。</p><div class="secret-box"><pre>${esc(r.token)}</pre></div><button type="button" class="btn secondary gap-top" data-action="copy-secret" data-value="${esc(r.token)}">复制密钥</button>`;
      },
    ),
  "copy-secret": (e) => copy(e.dataset.value),
  "delete-api-key": (e) =>
    confirmAction(
      "撤销 API 密钥",
      "撤销后，使用此密钥的应用将立即失去访问权限。",
      async () => {
        await api(`/admin/api-keys/${e.dataset.id}`, { method: "DELETE" });
        render();
      },
    ),
  "add-webhook": () =>
    modal(
      "添加邮件推送",
      field("name", "推送名称", "text", "例如：业务收信通知") +
        field("url", "接收 URL", "url", "https://your-app.com/mail-webhook") +
        '<p class="hint">所有本地新来信都会推送。默认仅允许公共 HTTPS 地址。</p>',
      async (d, f) => {
        const r = await api("/admin/webhooks", { method: "POST", body: d });
        f.innerHTML = `<span class="pill">推送已创建</span><p class="hint">此签名密钥仅显示一次，请保存并在接收端校验。</p><div class="secret-box"><pre>${esc(r.secret)}</pre></div><button type="button" class="btn secondary gap-top" data-action="copy-secret" data-value="${esc(r.secret)}">复制签名密钥</button>`;
      },
    ),
  "delete-webhook": (e) =>
    confirmAction(
      "删除邮件推送",
      "此推送及其待处理任务会一起删除。",
      async () => {
        await api(`/admin/webhooks/${e.dataset.id}`, { method: "DELETE" });
        render();
      },
    ),
  async "retry-webhook"(e) {
    await api(`/admin/webhooks/jobs/${e.dataset.id}/retry`, { method: "POST" });
    toast("已重新加入推送队列");
    render();
  },
  async "retry-job"(e) {
    await api(`/admin/queue/${e.dataset.id}/retry`, { method: "POST" });
    toast("已重新加入发送队列");
    render();
  },
};
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  e.preventDefault();
  if (el.disabled) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  const b = el.tagName === "BUTTON" ? el : null;
  if (b) b.disabled = true;
  try {
    await fn(el);
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (b) b.disabled = false;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
  if (e.key === "Enter" && e.target.matches("[role=button][data-action]")) {
    e.preventDefault();
    e.target.click();
  }
  if (e.key === "Tab" && $("#modal-form")) {
    const list = $$(
      "button,input,select,textarea,a[href]",
      $("#modal-root"),
    ).filter((x) => !x.disabled);
    const first = list[0],
      last = list.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.id !== "file-input") return;
  try {
    for (const file of e.target.files) {
      if (state.files.length >= 20) throw new Error("每封邮件最多 20 个附件");
      if (file.size > 20 * 1024 ** 2) throw new Error("单个附件不能超过 20 MB");
      const content = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result.split(",")[1]);
        r.onerror = () => reject(new Error("读取附件失败"));
        r.readAsDataURL(file);
      });
      state.files.push({ filename: file.name, content });
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    if ($("#file-list")) $("#file-list").innerHTML = chips();
    e.target.value = "";
  }
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  const b = $("button[type=submit]", f);
  if (b?.disabled) return;
  if (b) b.disabled = true;
  try {
    const t = f.dataset.form;
    if (t === "login" || t === "setup") {
      const r = await api(
        t === "setup"
          ? "/setup"
          : mailboxClient
            ? "/auth/webmail/login"
            : "/auth/login",
        {
          method: "POST",
          body: d,
        },
      );
      state.user = r.user;
      state.license = r.license;
      if (!mailboxClient && r.user.role !== "admin") {
        location.assign("/webmail/#inbox");
        return;
      }
      await MailWorkspace.loadPreferences();
      shell();
      go(
        t === "setup" && r.user.management_only
          ? "domains"
          : MailWorkspace.defaultRoute(),
      );
      if (t === "setup" && r.domainId) await showDns(r.domainId);
    } else if (t === "search") {
      state.q = d.q;
      state.page = 1;
      render();
    } else if (t === "filter-email") {
      state.email = d.email;
      state.page = 1;
      render();
    } else if (t === "compose") {
      await api("/send", {
        method: "POST",
        body: { ...d, attachments: state.files, draftId: state.draft?.id },
      });
      state.draft = null;
      state.files = [];
      toast("邮件已接收，本地立即投递；外部邮件进入队列");
      go("sent");
    } else if (t === "batch-register") {
      const entries = d.entries
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [local, password, name] = l
            .split(/[,，\t]/)
            .map((s) => s.trim());
          return { local, password, name };
        });
      const r = await api("/admin/users/batch", {
        method: "POST",
        body: { domain: d.domain, entries },
      });
      credentials(r.items, $("#batch-result"));
      toast(`已创建 ${r.items.length} 个账号`);
    } else if (t === "batch-password") {
      const r = await api("/admin/users/passwords", {
        method: "POST",
        body: d,
      });
      credentials(r.items, $("#batch-result"));
      toast("密码已更新");
    } else if (t === "bulk-send") {
      const r = await api("/admin/bulk-send", { method: "POST", body: d });
      const n = r.items.filter((x) => x.ok).length;
      $("#batch-result").innerHTML =
        `<span class="pill">接收 ${n} / ${r.items.length} 封</span><div class="result-list">${r.items.map((x) => `<div class="result-row"><span class="mono">${esc(x.email)}</span><span>${x.ok ? "已接收" : esc(x.error)}</span></div>`).join("")}</div><p class="hint">外部实际投递状态请到发件箱查看。</p>`;
      toast(`群发完成，系统接收 ${n} 封`);
    }
  } catch (error) {
    formError(f, error);
  } finally {
    if (b) b.disabled = false;
  }
});
window.addEventListener("hashchange", render);
async function init() {
  try {
    await MailWorkspace.loadPublic();
    if (!mailboxClient && (await MailWorkspace.publicRoute())) return;
    if (!mailboxClient && (await PostOfficeTools.publicRoute())) return;
    const s = await api("/setup/status");
    if (s.needsSetup) {
      if (mailboxClient) {
        authView(false);
        formError(
          $(".auth-form"),
          new Error("邮局尚未初始化，请联系管理员先完成设置。"),
        );
        $('.auth-form button[type="submit"]').disabled = true;
        return;
      }
      authView(true);
      return;
    }
    try {
      const me = await api("/auth/me");
      if (mailboxClient && me.user.management_only) {
        state.user = null;
        authView(false);
        formError(
          $(".auth-form"),
          new Error("当前是独立管理账号，请使用邮箱地址登录客户端。"),
        );
        return;
      }
      if (!mailboxClient && me.user.role !== "admin") {
        location.replace("/webmail/" + (location.hash || "#inbox"));
        return;
      }
      state.user = me.user;
      state.license = me.license;
      await MailWorkspace.loadPreferences();
      shell();
      render();
    } catch (error) {
      if (state.user && error.code === "LICENSE_REQUIRED") {
        shell();
        go(MailWorkspace.defaultRoute());
      } else authView(false);
    }
  } catch (e) {
    $("#app").innerHTML = empty("无法连接邮局服务", e.message, "server");
  }
}
PostOfficeTools.configure({
  api: async (path, options) => {
    if (path === "/admin/domains") {
      if (state.route === "batch-register" && !MailWorkspace.remote())
        return api("/admin/manage/domain-options?purpose=create");
      return MailWorkspace.resource("domains");
    }
    if (path === "/admin/users") return MailWorkspace.resource("accounts");
    if (path === "/admin/users/batch")
      return api(
        MailWorkspace.remote()
          ? `/admin/connections/${MailWorkspace.connectionId}/accounts/batch`
          : "/admin/manage/accounts/batch",
        options,
      );
    return api(path, options);
  },
  esc,
  icon,
  toast,
  render,
  copy,
  download,
  confirmAction,
});
pages.codes = PostOfficeTools.renderCodes;
pages["batch-register"] = PostOfficeTools.renderBatch;
MailWorkspace.configure({
  mailboxClient,
  clientWorkspace,
  go,
  api,
  esc,
  icon,
  toast,
  render,
  copy,
  download,
  confirmAction,
  modal,
  closeModal,
  state,
  openMail,
  credentials,
  shell,
});
Object.assign(pages, MailWorkspace.pages);
init();
