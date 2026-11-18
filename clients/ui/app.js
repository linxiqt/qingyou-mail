import {
  folders,
  esc,
  recipientsText,
  parseRecipients,
  isAdmin,
  can,
  listPath,
  bytes,
  date,
  createRequestGate,
} from "./model.js";
import {
  androidOverview,
  androidInbox,
  androidAccounts,
  androidCompose,
  updateAndroidOverview,
  avatarTone,
} from "./android-ui.js";
import { installNavigation } from "./navigation.js";
import {
  connected,
  licensed,
  normalizeLicense,
  canRecoverLicense,
  accessMessage,
} from "./server-access.js";

const bridge = window.postoffice;
const caps = bridge?.capabilities || {};
const isAndroid = bridge?.platform === "android";
document.body.classList.toggle("android", isAndroid);
const app = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const navigation = installNavigation();
const scrollPositions = new Map();
const accessChecks = new WeakMap();
const state = {
  accounts: [],
  account: null,
  folder: "inbox",
  page: 1,
  query: "",
  items: [],
  total: 0,
  mailbox: null,
  message: null,
  loading: false,
  error: "",
  synced: null,
  html: false,
  view: isAndroid ? "home" : "mail",
  apiReturnView: isAndroid ? "home" : "mail",
  accountReturnView: isAndroid ? "home" : "mail",
  composeReturnView: isAndroid ? "home" : "mail",
  drawer: false,
};
const listGate = createRequestGate(),
  detailGate = createRequestGate(),
  actionGate = createRequestGate(),
  accountGate = createRequestGate();
let searchTimer,
  toastTimer,
  composer = null,
  dialogCleanup = null;
let navigationEpoch = 0;
const paths = {
  reference: "M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6",
  mail: "M3 5h18v14H3z M3 6l9 7 9-7",
  inbox: "M4 4h16l2 13h-6l-2 3h-4l-2-3H2z",
  send: "M22 2L9 15 M22 2l-6 20-7-7-7-7z",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z",
  edit: "m16 3 5 5-12 12H4v-5z M14 5l5 5",
  archive: "M3 4h18v5H3z M5 9v11h14V9 M9 13h6",
  trash: "M3 6h18 M5 6l1 15h12l1-15 M9 6V3h6v3 M10 10v7 M14 10v7",
  shield: "M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z M12 8v5 M12 17h.01",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  back: "m14 5-7 7 7 7",
  plus: "M12 5v14 M5 12h14",
  close: "m6 6 12 12 M18 6 6 18",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  refresh: "M20 7a9 9 0 1 0 1 8 M20 2v5h-5",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3l-1 3-3 1-2 4 2 3 1 4 4 1 3 2 4-2 1-4 3-3-2-4-3-1-1-3z",
  users:
    "M16 21v-3a5 5 0 0 0-10 0v3 M11 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M18 4a4 4 0 0 1 0 8 M19 15c2 1 3 3 3 6",
  attach: "m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9",
  reply: "m9 4-7 7 7 7v-5c6 0 9 3 12 7 0-10-6-13-12-13z",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
  check: "m5 12 4 4L19 6",
  lock: "M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4",
  external: "M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.mail}"/></svg>`;
const ib = (action, label, name, extra = "") =>
  `<button class="icon-button" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra.replace('class="mobile-only"', "data-mobile")}>${icon(name)}</button>`;
const label = (a) =>
  a?.user?.email || a?.user?.username || a?.user?.name || "邮箱账号";
const initials = (value) =>
  String(value || "邮")
    .slice(0, 2)
    .toUpperCase();
const current = (id) => state.account?.id === id;
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 4000);
}
async function request(path, options = {}, account = state.account) {
  if (!account) throw new Error("请先登录邮箱");
  const result = await bridge.request({
    accountId: account.id,
    path,
    method: options.method || "GET",
    body: options.body,
  });
  if (result.status === 401) {
    account.authExpired = true;
    account.connection = "expired";
    account.connectionError = "登录已过期，请重新登录此账号。";
  }
  if (result.status === 402 && result.data?.code === "LICENSE_REQUIRED") {
    account.license = {
      required: true,
      valid: false,
      expiresAt: null,
      mode: "blocked",
      reason: result.data.error || "服务端授权已失效",
    };
    if (current(account.id)) updateAccessUI();
  }
  if (result.status < 200 || result.status >= 300) {
    const error = new Error(
      result.status === 401
        ? "登录已过期，请重新登录此账号。"
        : result.data?.error ||
            result.data?.message ||
            `请求未完成（${result.status}）`,
    );
    error.status = result.status;
    throw error;
  }
  return result.data;
}
async function checkServer(account = state.account, { paint = true } = {}) {
  if (!account) return false;
  if (accessChecks.has(account)) return accessChecks.get(account);
  const pending = (async () => {
    try {
      const result = await request("/auth/me", {}, account);
      if (!result.user || typeof result.user.role !== "string")
        throw new Error("服务端未返回有效登录身份。");
      account.user = result.user;
      account.authExpired = false;
      account.connection = "connected";
      account.connectionError = "";
      account.license = normalizeLicense(result.license);
      account.accessCheckedAt = Date.now();
      return true;
    } catch (error) {
      account.connection = error.status === 401 ? "expired" : "error";
      account.connectionError = error.message;
      account.license = null;
      return false;
    } finally {
      accessChecks.delete(account);
      if (paint && current(account.id)) {
        if (
          !composer &&
          !dialog.open &&
          !navigation.isInteracting() &&
          (!connected(account) ||
            document.querySelector(".server-connect-page"))
        )
          renderShell();
        else updateAccessUI();
      }
    }
  })();
  accessChecks.set(account, pending);
  return pending;
}
async function requireServerLicense(account = state.account) {
  await checkServer(account);
  if (!current(account?.id)) return false;
  if (!licensed(account)) {
    toast(accessMessage(account));
    return false;
  }
  return true;
}
function accessBanner() {
  const a = state.account;
  if (!a || licensed(a)) return "";
  return `<div class="server-access-notice" role="status"><strong>${connected(a) ? "发件与管理暂不可用" : "服务端连接不可用"}</strong><p>${esc(accessMessage(a))}</p><div class="row"><button class="button secondary" data-action="recheck-server">重新检查</button>${canRecoverLicense(a) ? '<button class="button primary" data-action="recover-license">恢复服务端授权</button>' : ""}</div><small>${connected(a) ? "可以继续接收和阅读邮件。" : "连接恢复后继续使用。"}</small></div>`;
}
function updateAccessUI() {
  const a = state.account;
  if (!a) return;
  const allowed = licensed(a);
  const metadata = app.querySelector(".account-profile dl");
  if (metadata && !metadata.querySelector("[data-license-label]"))
    metadata.insertAdjacentHTML(
      "beforeend",
      "<div><dt>服务端授权</dt><dd data-license-label></dd></div>",
    );
  document
    .querySelectorAll(
      '[data-action="compose"],[data-action="reply"],[data-action="forward"],[data-action="edit-draft"]',
    )
    .forEach((b) => (b.disabled = !allowed || !can(a, "mail.send")));
  document
    .querySelectorAll('[data-action="admin"]')
    .forEach((b) => (b.disabled = !allowed));
  document
    .querySelectorAll('[data-action="api-docs"]')
    .forEach((b) => (b.disabled = !connected(a)));
  document
    .querySelectorAll("[data-license-label]")
    .forEach(
      (el) =>
        (el.textContent = allowed
          ? a.license.required === false ? "无需激活" : a.license.mode === "offline"
            ? "离线授权有效"
            : "授权有效"
          : "未授权"),
    );
  const target = app.querySelector(
    ".account-page-scroll,.phone-overview,.phone-inbox-header,.list-header,.admin-intro,.compose-page",
  );
  if (target && !target.querySelector("[data-server-access-banner]")) {
    const host = document.createElement("div");
    host.dataset.serverAccessBanner = "";
    const heading = target.querySelector(
      ".account-page-heading,.phone-home-heading,.compose-page-heading",
    );
    if (heading) heading.after(host);
    else target.prepend(host);
  }
  document.querySelectorAll("[data-server-access-banner]").forEach((el) => {
    el.innerHTML = accessBanner();
  });
  const form = document.querySelector("#compose-form");
  if (form && composer) {
    if (!form.querySelector("[data-server-access-banner]") && !composer.page) {
      const host = document.createElement("div");
      host.dataset.serverAccessBanner = "";
      host.innerHTML = accessBanner();
      form.prepend(host);
    }
    form.querySelectorAll("input,textarea,button").forEach((el) => {
      if (!el.closest("[data-server-access-banner]"))
        el.disabled = composer.busy || !allowed;
    });
    const sender = form.querySelector("input:not([name])");
    if (sender) sender.disabled = true;
  }
}
function renderConnection() {
  const a = state.account,
    waiting = a.connection === "checking";
  app.innerHTML = `<main class="server-connect-page" data-view="connection"><section class="server-connect-card"><div class="brand">${icon("mail")}青邮</div><h1>${waiting ? "正在连接你的邮局" : "请连接服务端"}</h1><p>${esc(label(a))}</p><small>${esc(new URL(a.server).host)}</small><p role="status">${waiting ? "正在验证登录与服务端授权…" : esc(accessMessage(a))}</p><div class="row">${waiting ? "" : `<button class="button primary" data-action="${a.authExpired ? "reauth" : "recheck-server"}">${a.authExpired ? "重新登录" : "重新连接"}</button>`}<button class="button secondary" data-action="accounts">账号与连接</button></div></section></main>`;
}
async function syncServer({ mail = true } = {}) {
  const a = state.account;
  if (!a) return;
  const ok = await checkServer(a);
  if (
    ok &&
    current(a.id) &&
    mail &&
    !isAdmin(a) &&
    !composer &&
    !dialog.open &&
    !navigation.isInteracting() &&
    !state.loading
  )
    await loadMail({ quiet: true });
}
function plainBody(message) {
  if (message.body_text?.trim()) return message.body_text;
  if (!message.body_html) return "";
  const parsed = new DOMParser().parseFromString(
    message.body_html,
    "text/html",
  );
  parsed
    .querySelectorAll(
      "script,style,iframe,object,embed,img,link,meta,form,svg,noscript",
    )
    .forEach((el) => el.remove());
  parsed.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
  parsed
    .querySelectorAll("p,div,li,tr,h1,h2,h3,blockquote")
    .forEach((el) => el.append("\n"));
  return (parsed.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}
function discardComposer(force = false) {
  if (composer?.busy && !force) {
    toast("正在提交，请稍候。");
    return false;
  }
  if (
    composer?.dirty &&
    !force &&
    !confirm("还有未保存的草稿。确定放弃这些修改？")
  )
    return false;
  composer = null;
  return true;
}
function closeDialog(force = false) {
  if (composer && !composer.page && !discardComposer(force)) return false;
  dialogCleanup?.();
  dialogCleanup = null;
  dialog.close();
  dialog.innerHTML = "";
  return true;
}
function rememberScroll() {
  const key = `${state.account?.id}:${state.view}:${state.folder}`;
  scrollPositions.set(
    key,
    [
      ...app.querySelectorAll(
        ".phone-overview,#message-list,.account-page-scroll,.message-detail,.api-article",
      ),
    ].map((el) => ({
      selector: el.id ? "#" + el.id : "." + el.classList[0],
      top: el.scrollTop,
    })),
  );
}
function restoreScroll() {
  const key = `${state.account?.id}:${state.view}:${state.folder}`;
  for (const item of scrollPositions.get(key) || []) {
    const node = app.querySelector(item.selector);
    if (node) node.scrollTop = item.top;
  }
}
function leavePage() {
  if (!closeDialog() || (composer?.page && !discardComposer())) return false;
  navigationEpoch++;
  rememberScroll();
  clearTimeout(searchTimer);
  return true;
}
function showDialog(title, html, { wide = false } = {}) {
  if (!closeDialog()) return false;
  dialog.classList.toggle("wide", wide);
  dialog.innerHTML = `<div class="dialog-heading"><h2>${esc(title)}</h2>${ib("close-dialog", "关闭", "close")}</div><div class="dialog-body">${html}</div>`;
  dialog.showModal();
  return true;
}
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});
function renderLogin() {
  app.innerHTML = `<main class="login-page"><section class="login-story"><div class="brand">${icon("mail")}青邮</div><div><h2>每一个账号，<br>都井井有条。</h2><p>连接你的邮局，收发邮件。工作与生活的邮箱，在一个地方轻松切换。</p></div><small>邮件保存在你的服务器 · 支持多个账号</small></section><section class="login-wrap"><div class="login-form"><h1>登录邮箱</h1><p>使用你的邮局地址和邮箱账号。</p>${loginForm()}${!bridge ? '<div class="error">请在青邮 Windows 或 Android 客户端中打开。此页面需要客户端提供安全连接。</div>' : ""}</div></section></main>`;
}
function loginForm() {
  return `<form id="login-form"><label class="field"><span>服务器地址</span><input name="server" type="url" autocomplete="url" value="https://210.16.166.94:24785" required placeholder="https://mail.example.com"></label><label class="field"><span>${caps.admin ? "邮箱 / 管理员账号" : "邮箱账号"}</span><input name="username" autocomplete="username" required placeholder="you@example.com"></label><label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required></label><div class="form-error error" role="alert"></div><button class="button primary" type="submit" ${!bridge ? "disabled" : ""}>登录</button>${caps.certificateTrust ? '<button type="button" class="button secondary certificate-button" data-action="certificate">查看服务器证书</button>' : ""}<small class="login-note">${caps.admin ? "管理员身份验证通过后，会自动打开管理后台。" : "账号密码由你的邮局管理员提供。"}</small></form>`; // taste-skill-ignore: login placeholders are instructional examples, not fixture accounts.
}
function sidebar() {
  const a = state.account,
    admin = isAdmin(a);
  const used = state.mailbox?.usedBytes || 0,
    quota = state.mailbox?.quotaBytes || 0;
  return `<button class="drawer-scrim" data-action="drawer-close" aria-label="关闭导航"></button><aside class="sidebar"><div class="row spread"><div class="brand">${icon("mail")}青邮</div>${ib("drawer-close", "关闭导航", "close", 'class="mobile-only"')}</div><button class="account-switch" data-action="accounts"><span class="avatar">${esc(initials(label(a)))}</span><span class="identity"><strong>${esc(a.user?.name || label(a))}</strong><small>${esc(label(a))}</small></span>${icon("down")}</button>${
    !admin
      ? `<button class="button primary" data-action="compose" ${!can(a, "mail.send") ? "disabled" : ""}>${icon("edit")}写邮件</button><nav class="folder-nav" aria-label="邮件文件夹">${folders
          .map(([id, title, symbol]) => {
            const c = state.mailbox?.counts?.find(
              (x) => x.folder === (id === "unread" ? "inbox" : id),
            );
            const n =
              id === "unread"
                ? c?.unread
                : id === "inbox"
                  ? c?.unread
                  : c?.total;
            return `<button data-action="folder" data-folder="${id}" class="${state.view === "mail" && state.folder === id ? "active" : ""}" ${state.view === "mail" && state.folder === id ? 'aria-current="page"' : ""}>${icon(symbol)}${title}${n ? `<span class="count">${n}</span>` : ""}</button>`;
          })
          .join("")}</nav>`
      : `<nav class="folder-nav"><button class="${state.view === "mail" ? "active" : ""}" data-action="admin">${icon("shield")}管理后台</button></nav>`
  }<div class="sidebar-footer">${!admin && quota ? `<div class="storage"><div class="row spread"><span>邮箱空间</span><span>${bytes(used)} / ${bytes(quota)}</span></div><progress value="${used}" max="${quota}" aria-label="邮箱空间"></progress></div>` : ""}<button class="button${state.view === "api" ? " active" : ""}" data-action="api-docs" ${state.view === "api" ? 'aria-current="page"' : ""}>${icon("reference")}AI 接口文档</button><button class="button${state.view === "accounts" ? " active" : ""}" data-action="accounts" ${state.view === "accounts" ? 'aria-current="page"' : ""}>${icon("users")}账号管理<span class="count">${state.accounts.length}</span></button><small class="server-note" title="${esc(a.server)}">${icon("lock")}${esc(new URL(a.server).host)}</small></div></aside>`;
}
function renderShell() {
  if (!state.account) return renderLogin();
  if (!connected(state.account) && state.view !== "accounts" && !composer)
    return renderConnection();
  if (state.view === "api") return renderApiDocs();
  if (state.view === "compose" && composer?.page) return updateAccessUI();
  if (state.view === "accounts") {
    const content = accountsContent();
    app.innerHTML = isAndroid
      ? androidAccounts(state, { icon, ib, label, initials }, content)
      : `<main class="shell accounts-shell" data-view="accounts">${sidebar()}<section class="account-page-scroll" aria-label="账号管理">${content}</section></main>`;
    restoreScroll();
    updateAccessUI();
    return;
  }
  if (isAndroid && !isAdmin(state.account)) {
    const helpers = { icon, ib, label, initials };
    app.innerHTML =
      state.view === "home"
        ? androidOverview(state, helpers)
        : androidInbox(state, helpers);
    renderList();
    renderReader();
    restoreScroll();
    updateAccessUI();
    return;
  }
  const admin = isAdmin(state.account);
  app.innerHTML = `<main class="shell${state.drawer ? " drawer-open" : ""}${state.message ? " reading" : ""}">${sidebar()}${admin ? `<section class="admin-pane"><div class="row">${ib("drawer", "打开导航", "menu", 'class="mobile-only"')}<span class="muted">管理员工作区</span></div><div class="admin-intro"><h1>你好，${esc(state.account.user?.name || "管理员")}</h1><p>此账号拥有管理后台权限。域名、邮箱、转发与权限管理在独立的后台窗口中操作。</p>${state.account.authExpired ? '<button class="button primary" data-action="reauth">重新登录管理员</button>' : `<button class="button primary" data-action="admin">${icon("external")}打开管理后台</button>`}</div></section>` : `<section class="list-pane"><header class="list-header"><div class="list-title"><div class="row">${ib("drawer", "打开账号与文件夹", "menu", 'class="mobile-only"')}<div><h1>${folders.find((f) => f[0] === state.folder)?.[1] || "邮箱"}</h1><small id="message-total">${state.loading ? "正在同步…" : `${state.total} 封邮件`}</small></div></div>${ib("refresh", "刷新邮件", "refresh")}</div><div class="search-box">${icon("search")}<input id="search" type="search" aria-label="搜索邮件" placeholder="搜索发件人、主题、正文" maxlength="100" value="${esc(state.query)}"></div></header><div id="list-error"></div><div class="message-list" id="message-list" aria-label="邮件列表"></div><footer class="pager"><span id="sync-note" class="sync-note"></span><div class="row">${ib("previous", "上一页", "back")}<span id="page-number"></span>${ib("next", "下一页", "chevron")}</div></footer><button class="mobile-compose primary" data-action="compose" aria-label="写邮件">${icon("edit")}</button></section><section class="reader" id="reader" aria-label="阅读邮件"></section>`}</main>`;
  if (!admin) {
    renderList();
    renderReader();
  }
  restoreScroll();
  updateAccessUI();
}
function renderList() {
  if (isAndroid) updateAndroidOverview(state);
  const el = document.querySelector("#message-list");
  if (!el) return;
  el.setAttribute("aria-busy", String(state.loading));
  const readerId = state.message?.id;
  el.innerHTML =
    state.loading && !state.items.length
      ? Array.from(
          { length: 7 },
          () =>
            '<div class="skeleton" aria-hidden="true"><span></span><span></span><span></span></div>',
        ).join("")
      : state.items.length
        ? state.items
            .map(
              (m) =>
                `<button class="mail-row${m.id === readerId ? " selected" : ""}${!m.is_read ? " unread" : ""}" data-action="open" data-id="${esc(m.id)}" ${m.id === readerId ? 'aria-current="true"' : ""}><span class="avatar">${esc(initials(m.from_name || m.from_email))}</span><span class="mail-copy"><span class="mail-first"><strong>${esc(m.folder === "sent" ? recipientsText(m.to) : m.from_name || m.from_email)}</strong><time datetime="${esc(m.created_at)}">${esc(date(m.created_at))}</time></span><span class="mail-subject">${esc(m.subject || "（无主题）")}</span><span class="mail-snippet">${esc(m.snippet || "无正文预览")}</span>${m.starred || m.attachment_count || m.delivery_status === "failed" ? `<span class="mail-meta">${m.starred ? `${icon("star")}已标星` : ""}${m.attachment_count ? `${icon("attach")}${m.attachment_count} 个附件` : ""}${m.delivery_status === "failed" ? "发送失败" : ""}</span>` : ""}</span></button>`,
            )
            .join("")
        : `<div class="empty">${icon("inbox")}<h2>${state.query ? "没有找到邮件" : "这里还没有邮件"}</h2><p>${state.query ? "换一个关键词试试。" : "收到的邮件会同步到这里。"}</p></div>`;
  document.querySelector("#message-total").textContent = state.loading
    ? "正在同步…"
    : `${state.total} 封邮件`;
  document.querySelector("#list-error").innerHTML = state.error
    ? `<div class="error list-error" role="alert">${esc(state.error)} <button data-action="${state.account?.authExpired ? "reauth" : "refresh"}">${state.account?.authExpired ? "重新登录" : "重试"}</button></div>`
    : "";
  document.querySelector("#page-number").textContent =
    `${state.page} / ${Math.max(1, Math.ceil(state.total / 30))}`;
  document.querySelector('[data-action="previous"]').disabled =
    state.page <= 1 || state.loading;
  document.querySelector('[data-action="next"]').disabled =
    state.page * 30 >= state.total || state.loading;
  document.querySelector("#sync-note").textContent = state.loading
    ? "同步中"
    : state.synced
      ? `同步于 ${state.synced.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "尚未同步";
  if (isAndroid) {
    el.querySelectorAll(".mail-row").forEach((row, index) => {
      const message = state.items[index];
      row
        .querySelector(".avatar")
        .classList.add(
          "tone-" + avatarTone(message.from_name || message.from_email),
        );
      if (!message.is_read)
        row.setAttribute(
          "aria-label",
          `未读，${message.from_name || message.from_email}，${message.subject || "无主题"}`,
        );
    });
  }
}
function renderReader() {
  const el = document.querySelector("#reader");
  if (!el) return;
  queueMicrotask(updateAccessUI);
  const m = state.message;
  document.querySelector(".shell")?.classList.toggle("reading", Boolean(m));
  syncReaderAccessibility();
  if (!m) {
    el.innerHTML = `<div class="empty reader-empty">${icon("mail")}<h2>选择一封邮件</h2><p>阅读、回复，或开始一封新邮件。</p><button class="button secondary" data-action="compose">${icon("edit")}写邮件</button></div>`;
    return;
  }
  if (m.loading) {
    el.innerHTML = `<header class="reader-toolbar">${ib("back", "返回邮件列表", "back")}<span>正在加载邮件…</span></header><div class="message-detail"><div class="skeleton"><span></span><span></span><span></span></div></div>`;
    return;
  }
  if (m.error) {
    el.innerHTML = `<header class="reader-toolbar">${ib("back", "返回邮件列表", "back")}</header><div class="message-detail"><div class="error">${esc(m.error)}</div><button class="button secondary" data-action="${state.account?.authExpired ? "reauth" : "open"}" data-id="${esc(m.id)}">${state.account?.authExpired ? "重新登录" : "重新加载"}</button></div>`;
    return;
  }
  el.innerHTML = `<header class="reader-toolbar"><div class="reader-actions">${ib("back", "返回邮件列表", "back", 'class="mobile-only"')}${ib("reply", "回复", "reply", !can(state.account, "mail.send") ? "disabled" : "")}${ib("star", m.starred ? "取消标星" : "标星", "star", `aria-pressed="${Boolean(m.starred)}"`)}${m.folder === "trash" ? ib("restore", "恢复邮件", "refresh") : ib("archive", "归档", "archive")}${ib("delete", m.folder === "trash" || m.folder === "drafts" ? "永久删除" : "移入已删除", "trash")}${ib("unread", "标为未读", "mail")}</div><span class="muted">${esc(date(m.created_at))}</span></header><article class="message-detail"><small>${esc(date(m.created_at, true))}</small><h2>${esc(m.subject || "（无主题）")}</h2><div class="sender"><span class="avatar">${esc(initials(m.from_name || m.from_email))}</span><div class="sender-meta"><strong>${esc(m.from_name || m.from_email)}</strong><small>${esc(m.from_email)}</small><small>收件人：${esc(recipientsText(m.to))}${m.cc?.length ? ` · 抄送：${esc(recipientsText(m.cc))}` : ""}</small></div></div>${m.body_html && bridge.platform !== "android" ? `<button class="button secondary" data-action="html">${state.html ? "显示纯文本" : "查看邮件排版"}</button>` : ""}${state.html ? '<iframe class="message-html" sandbox="" title="邮件正文（外部资源已关闭）" referrerpolicy="no-referrer"></iframe>' : `<div class="message-body">${esc(plainBody(m) || "此邮件没有可显示的正文。")}</div>`}${m.attachments?.length ? `<div class="attachments">${m.attachments.map((a) => `<button class="attachment" data-action="download" data-id="${esc(a.id)}" ${!caps.attachments ? "disabled" : ""}>${icon("attach")}<span>${esc(a.filename)}<small>${bytes(a.size)}</small></span>${icon("download")}</button>`).join("")}</div>` : ""}<div class="reply-actions">${m.folder === "drafts" ? `<button class="button primary" data-action="edit-draft">${icon("edit")}继续编辑</button>` : `<button class="button secondary" data-action="reply">${icon("reply")}回复</button><button class="button secondary" data-action="forward">${icon("send")}转发</button>`}</div></article>`;
  if (state.html) {
    el.querySelector("iframe").srcdoc =
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font:15px/1.7 system-ui,sans-serif;overflow-wrap:anywhere;padding:16px;color:#172238}img{max-width:100%}a{pointer-events:none}</style></head><body>${m.body_html}</body></html>`;
  }
}
function syncReaderAccessibility() {
  if (!isAndroid) return;
  const covered =
    Boolean(state.message) && !matchMedia("(min-width:1050px)").matches;
  document
    .querySelectorAll(".phone-mail .list-pane,.phone-mail .phone-nav")
    .forEach((node) => {
      node.inert = covered;
    });
}
window.addEventListener("resize", syncReaderAccessibility);
async function loadMail({ quiet = false } = {}) {
  const a = state.account;
  if (!connected(a) || isAdmin(a)) return;
  const valid = listGate.ticket();
  state.loading = true;
  state.error = "";
  if (!quiet) renderList();
  try {
    const [messages, mailbox] = await Promise.all([
      request(listPath(state.folder, state.page, state.query), {}, a),
      request("/mailbox", {}, a),
    ]);
    if (!valid() || !current(a.id)) return;
    state.items = messages.items || [];
    state.total = messages.total || 0;
    state.mailbox = mailbox;
    state.synced = new Date();
    document
      .querySelector(".sidebar")
      ?.replaceWith(
        document
          .createRange()
          .createContextualFragment(sidebar())
          .querySelector(".sidebar"),
      );
  } catch (error) {
    if (valid() && current(a.id)) state.error = error.message;
  } finally {
    if (valid() && current(a.id)) {
      state.loading = false;
      renderList();
      updateAccessUI();
    }
  }
}
async function selectAccount(id, { openAdmin = false } = {}) {
  if (!leavePage()) return;
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return;
  const valid = accountGate.ticket();
  listGate.invalidate();
  detailGate.invalidate();
  actionGate.invalidate();
  clearTimeout(searchTimer);
  scrollPositions.clear();
  account.connection = "checking";
  account.connectionError = "";
  account.license = null;
  Object.assign(state, {
    account,
    folder: "inbox",
    page: 1,
    query: "",
    items: [],
    total: 0,
    mailbox: null,
    message: null,
    error: "",
    loading: false,
    synced: null,
    view: isAndroid ? "home" : "mail",
    apiReturnView: isAndroid ? "home" : "mail",
    accountReturnView: isAndroid ? "home" : "mail",
    composeReturnView: isAndroid ? "home" : "mail",
    html: false,
    drawer: false,
  });
  renderShell();
  const available = await checkServer(account, { paint: false });
  if (!valid() || !current(account.id)) return;
  renderShell();
  if (!available) return;
  if (isAdmin(account)) {
    if (openAdmin && licensed(account)) await bridge.openAdmin(account.id);
    return;
  }
  await loadMail();
}
async function openMessage(id) {
  actionGate.invalidate();
  const a = state.account,
    valid = detailGate.ticket();
  state.message = { id, loading: true };
  state.html = false;
  renderReader();
  renderList();
  try {
    const message = await request("/messages/" + encodeURIComponent(id), {}, a);
    if (!valid() || !current(a.id)) return;
    state.message = message;
    const row = state.items.find((x) => String(x.id) === String(id));
    if (row) row.is_read = message.is_read;
    renderReader();
    renderList();
  } catch (error) {
    if (valid() && current(a.id)) {
      state.message = { id, error: error.message };
      renderReader();
    }
  }
}
function accountsContent() {
  const a = state.account;
  return `<header class="account-page-heading"><div><span class="phone-brand">青邮</span><h1>账号</h1><p>工作与生活，各有一个邮箱。</p></div>${ib("accounts-exit", "返回上一页", "back")}</header>
    <div class="account-columns"><section class="account-profile" aria-label="当前账号"><span class="avatar">${esc(initials(a.user?.name || label(a)))}</span><span class="account-current-label">当前使用</span><h2>${esc(a.user?.name || "我的邮箱")}</h2><p>${esc(label(a))}</p><dl><div><dt>服务器</dt><dd>${esc(new URL(a.server).host)}</dd></div><div><dt>身份</dt><dd>${isAdmin(a) ? "管理员" : "邮箱用户"}</dd></div><div><dt>登录状态</dt><dd>${a.authExpired ? "需要重新登录" : "已登录"}</dd></div></dl>${a.authExpired ? '<button class="button primary" data-action="reauth">重新登录</button>' : ""}<button class="account-api-link" data-action="api-docs">${icon("reference")}AI 接口文档${icon("chevron")}</button></section>
    <section class="saved-accounts" aria-label="已添加的账号"><div class="account-section-heading"><h2>我的邮箱 <span>${state.accounts.length}</span></h2><button class="button secondary" data-action="add-account">${icon("plus")}添加</button></div><p class="muted">独立登录，一键切换。</p><div class="account-list">${state.accounts.map((account) => `<div class="account-card ${current(account.id) ? "current" : ""}"><button data-action="switch" data-id="${esc(account.id)}" ${current(account.id) ? 'aria-current="true"' : ""}><span class="avatar tone-${avatarTone(label(account))}">${esc(initials(account.user?.name || label(account)))}</span><span><strong>${esc(label(account))}</strong><small>${esc(new URL(account.server).host)}</small><span class="account-badge">${current(account.id) ? "当前账号" : isAdmin(account) ? "管理员" : "切换到此邮箱"}</span></span></button>${ib("remove-account", "退出账号 " + label(account), "close", `data-id="${esc(account.id)}"`)}</div>`).join("")}</div><p class="account-privacy">${icon("lock")}邮件保存在服务器，退出账号不会删除邮件。</p></section></div>`;
}
function openAccountsPage() {
  if (state.view === "accounts") return;
  const previous =
    state.view === "compose" ? state.composeReturnView : state.view;
  if (!leavePage()) return;
  // A discarded composer has no page to return to. Preserve the account page's
  // original origin when returning from a composer opened inside accounts.
  if (previous !== "accounts") state.accountReturnView = previous;
  state.view = "accounts";
  state.drawer = false;
  renderShell();
}
function exitAccounts() {
  if (!leavePage()) return;
  state.view = state.accountReturnView;
  renderShell();
}
async function login(form) {
  const button = form.querySelector("[type=submit]"),
    error = form.querySelector(".form-error"),
    data = new FormData(form);
  button.disabled = true;
  error.textContent = "";
  try {
    const account = await bridge.login({
      server: String(data.get("server")).trim(),
      username: String(data.get("username")).trim(),
      password: String(data.get("password")),
    });
    form.elements.password.value = "";
    state.accounts = await bridge.listAccounts();
    closeDialog(true);
    await selectAccount(account.id, { openAdmin: true });
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}
async function certificate() {
  const form = document.querySelector("#login-form"),
    server = form?.elements.server.value;
  if (!server) return;
  const button = form.querySelector(".certificate-button");
  button.disabled = true;
  try {
    const cert = await bridge.inspectCertificate({ server });
    // Keep the login form (including entered server) behind the native confirmation.
    const description = `服务器：${server}\n主题：${cert.subject}\n签发者：${cert.issuer}\n有效期：${cert.validFrom} — ${cert.validTo}\n\nSHA-256 指纹：\n${cert.fingerprint}\n\n${cert.trusted ? "证书已受信任。" : "请通过服务器管理渠道核对指纹。仅当完全一致时继续信任此证书。"}`;
    if (cert.trusted) {
      alert(description);
      return;
    }
    if (confirm(description + "\n\n指纹已核对一致，继续？")) {
      await bridge.trustCertificate({ server, fingerprint: cert.fingerprint });
      toast("已保存此服务器的证书指纹，可以登录。");
    }
  } catch (error) {
    form.querySelector(".form-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
async function changeMessage(action) {
  const a = state.account,
    m = state.message;
  if (!m || m.loading || m.error) return;
  if (!can(a, action === "delete" ? "mail.delete" : "mail.update"))
    return toast("此账号没有执行此操作的权限");
  const id = m.id,
    valid = actionGate.ticket();
  try {
    if (action === "delete") {
      const permanent = ["trash", "drafts"].includes(m.folder);
      if (permanent && !confirm("永久删除这封邮件及其附件？此操作无法撤销。"))
        return;
      await request(
        "/messages/" + id,
        {
          method: permanent ? "DELETE" : "PATCH",
          body: permanent ? undefined : { folder: "trash" },
        },
        a,
      );
    } else if (action === "restore")
      await request("/messages/" + id + "/restore", { method: "POST" }, a);
    else
      await request(
        "/messages/" + id,
        {
          method: "PATCH",
          body:
            action === "star"
              ? { starred: !m.starred }
              : action === "unread"
                ? { read: false }
                : { folder: "archive" },
        },
        a,
      );
    if (!valid() || !current(a.id)) return;
    if (action === "star") {
      m.starred = !m.starred;
      renderReader();
    } else {
      detailGate.invalidate();
      state.message = null;
      renderReader();
    }
    await loadMail({ quiet: true });
  } catch (error) {
    if (current(a.id)) toast(error.message);
  }
}
async function compose(mode = "new", aiDraft = "") {
  const originEpoch = navigationEpoch;
  if (isAndroid && state.view === "compose" && composer) return;
  const a = state.account,
    m = state.message;
  if (!can(a, "mail.send")) return toast("此账号没有发件权限");
  if (!(await requireServerLicense(a))) return;
  if (originEpoch !== navigationEpoch) return;
  let files = [];
  if (mode === "draft" && m) {
    try {
      files =
        (await request("/drafts/" + m.id + "/attachments", {}, a)).items || [];
      if (!current(a.id)) return;
    } catch (error) {
      return toast("草稿附件读取失败：" + error.message);
    }
  }
  const reply = mode === "reply",
    forward = mode === "forward",
    draft = mode === "draft";
  const to = reply ? m?.from_email || "" : draft ? recipientsText(m?.to) : "";
  const subject = draft
    ? m?.subject || ""
    : reply
      ? /^(re|回复):/i.test(m?.subject)
        ? m.subject
        : "Re: " + (m?.subject || "")
      : forward
        ? "Fwd: " + (m?.subject || "")
        : "";
  const quoted =
    (reply || forward) && m
      ? `\n\n—— ${date(m.created_at, true)}，${m.from_email} ——\n${plainBody(m)}`
      : "";
  const text = draft ? plainBody(m) : aiDraft ? aiDraft + quoted : quoted;
  if (
    !showComposer(
      draft ? "编辑草稿" : reply ? "回复邮件" : forward ? "转发邮件" : "写邮件",
      `<form id="compose-form">${forward && m?.attachments?.length ? '<p class="muted">本次转发包含邮件正文；需要转发的附件请保存后重新添加。</p>' : ""}<label class="field"><span>发件人</span><input value="${esc(label(a))}" disabled></label><label class="field"><span>收件人</span><input name="to" value="${esc(to)}" placeholder="多个地址以逗号分隔" autocomplete="off"></label><div class="composer-grid"><label class="field"><span>抄送</span><input name="cc" value="${esc(draft ? recipientsText(m?.cc) : "")}" autocomplete="off"></label><label class="field"><span>密送</span><input name="bcc" value="${esc(draft ? recipientsText(m?.bcc) : "")}" autocomplete="off"></label></div><label class="field"><span>主题</span><input name="subject" value="${esc(subject)}" maxlength="998"></label><label class="field"><span>正文</span><textarea class="compose-text" name="text" placeholder="写点什么…">${esc(text)}</textarea></label><label class="field"><span>添加附件</span><input type="file" id="attachments-input" multiple><small>最多 20 个附件，总大小不超过 14 MB。</small></label><div class="file-list" id="file-list"></div><div class="form-error error" role="alert"></div><div class="form-actions"><span class="muted" id="draft-status"></span><button type="button" class="button secondary" data-action="save-draft">保存草稿</button><button type="submit" class="button primary">${icon("send")}发送邮件</button></div></form>`,
      { wide: true },
    )
  )
    return;
  composer = {
    account: a,
    id: draft ? m.id : null,
    files,
    dirty: false,
    busy: false,
    page: isAndroid,
  };
  renderFiles();
  updateAccessUI();
  document
    .querySelector('#compose-form [name="to"]')
    ?.focus({ preventScroll: true });
}
function showComposer(title, form) {
  if (!isAndroid) return showDialog(title, form, { wide: true });
  if (!leavePage()) return false;
  state.composeReturnView = state.view;
  state.view = "compose";
  app.innerHTML = androidCompose(state, { icon, ib }, title, form);
  return true;
}
function exitCompose(force = false) {
  if (!discardComposer(force)) return false;
  state.view = state.composeReturnView;
  renderShell();
  return true;
}
function renderFiles() {
  const el = document.querySelector("#file-list");
  if (el && composer)
    el.innerHTML = composer.files
      .map(
        (f, i) =>
          `<div class="file-row"><span>${icon("attach")}${esc(f.filename)} <small>${bytes(Math.floor((f.content.length * 3) / 4))}</small></span>${ib("remove-file", "移除附件", "close", `data-index="${i}"`)}</div>`,
      )
      .join("");
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取附件"));
    reader.onload = () =>
      resolve({
        filename: file.name,
        content: String(reader.result).split(",")[1],
      });
    reader.readAsDataURL(file);
  });
}
async function addFiles(input) {
  const draft = composer;
  if (!draft) return;
  const files = Array.from(input.files || []);
  input.value = "";
  if (draft.files.length + files.length > 20)
    return toast("最多添加 20 个附件");
  const size =
    draft.files.reduce(
      (n, f) => n + Math.floor((f.content.length * 3) / 4),
      0,
    ) + files.reduce((n, f) => n + f.size, 0);
  if (size > 14 * 1024 ** 2) return toast("附件总大小不能超过 14 MB");
  input.disabled = true;
  try {
    const added = await Promise.all(files.map(readFile));
    if (composer !== draft) return;
    draft.files.push(...added);
    draft.dirty = true;
    renderFiles();
  } catch (error) {
    toast(error.message);
  } finally {
    input.disabled = false;
  }
}
async function submitCompose(send) {
  const draft = composer,
    form = document.querySelector("#compose-form");
  if (!draft || draft.busy) return;
  const data = new FormData(form),
    payload = {
      to: parseRecipients(data.get("to")),
      cc: parseRecipients(data.get("cc")),
      bcc: parseRecipients(data.get("bcc")),
      subject: String(data.get("subject")),
      text: String(data.get("text")),
      attachments: draft.files,
    };
  if (send && !payload.to.length) {
    form.querySelector(".form-error").textContent = "请填写至少一个收件人";
    return;
  }
  draft.busy = true;
  form
    .querySelectorAll("button,input,textarea")
    .forEach((el) => (el.disabled = true));
  form.querySelector(".form-error").textContent = "";
  try {
    if (!(await requireServerLicense(draft.account))) {
      if (composer === draft)
        form.querySelector(".form-error").textContent = accessMessage(
          draft.account,
        );
      return;
    }
    const result = await request(
      send ? "/send" : "/drafts",
      {
        method: "POST",
        body: {
          ...payload,
          ...(draft.id
            ? send
              ? { draftId: draft.id }
              : { id: draft.id }
            : {}),
        },
      },
      draft.account,
    );
    if (composer !== draft) return;
    draft.dirty = false;
    if (send) {
      if (draft.page) exitCompose(true);
      else closeDialog(true);
      toast("邮件已提交发送");
      if (current(draft.account.id)) await loadMail({ quiet: true });
    } else {
      draft.id = result.id;
      form.querySelector("#draft-status").textContent = "草稿已保存到服务器";
      toast("草稿已保存");
    }
  } catch (error) {
    if (composer === draft)
      form.querySelector(".form-error").textContent = error.message;
  } finally {
    draft.busy = false;
    if (composer === draft)
      form
        .querySelectorAll("button,input,textarea")
        .forEach((el) => (el.disabled = false));
    const sender = form.querySelector("input:not([name])");
    if (sender) sender.disabled = true;
    updateAccessUI();
  }
}
async function renderApiDocs() {
  const accountId = state.account.id;
  const server = state.account.server;
  app.innerHTML = `<main class="shell api-shell">${isAndroid ? "" : sidebar()}<section class="api-pane"><div class="api-topbar">${isAndroid ? "" : ib("drawer", "打开导航", "menu", 'class="mobile-only"')}<button class="button" data-action="api-exit">${icon("back")}返回${isAdmin(state.account) ? "工作区" : "邮箱"}</button></div><div id="api-reference"><p class="muted">正在打开接口文档…</p></div></section></main>`;
  const host = document.querySelector("#api-reference");
  try {
    const { mountApiReference } = await import("./api-reference.js");
    if (!host.isConnected || state.view !== "api" || !current(accountId))
      return;
    mountApiReference(host, {
      server,
      copyText: async (text) => {
        if (bridge.copyText) {
          const result = await bridge.copyText({ text });
          if (!result?.copied) throw Error("复制失败");
        } else if (navigator.clipboard?.writeText)
          await navigator.clipboard.writeText(text);
        else throw Error("当前环境不支持自动复制");
      },
    });
  } catch {
    if (host.isConnected)
      host.innerHTML =
        '<p role="alert">接口文档加载失败，请重试。</p><button class="button secondary" data-action="api-docs">重新加载</button>';
  }
}
async function download(id) {
  const attachment = state.message?.attachments?.find(
    (a) => String(a.id) === String(id),
  );
  if (!attachment) return;
  try {
    const result = await bridge.download({
      accountId: state.account.id,
      path: "/attachments/" + encodeURIComponent(id),
      filename: attachment.filename,
    });
    if (result.saved) toast("附件已保存");
  } catch (error) {
    toast(error.message);
  }
}
function setDrawer(open) {
  state.drawer = open;
  document.querySelector(".shell")?.classList.toggle("drawer-open", open);
  if (!matchMedia("(max-width:800px)").matches) return;
  document
    .querySelectorAll(".list-pane,.reader,.admin-pane,.api-pane")
    .forEach((el) => (el.inert = open));
  if (open)
    document.querySelector('.sidebar [data-action="drawer-close"]')?.focus();
  else document.querySelector('[data-action="drawer"]')?.focus();
}

function mobileHome() {
  if (!leavePage()) return;
  clearTimeout(searchTimer);
  detailGate.invalidate();
  actionGate.invalidate();
  state.message = null;
  state.view = "home";
  renderShell();
}
function visitFolder(folder) {
  if (!folders.some(([id]) => id === folder)) return;
  if (!leavePage()) return;
  clearTimeout(searchTimer);
  state.view = "mail";
  state.folder = folder;
  state.page = 1;
  state.query = "";
  state.items = [];
  state.message = null;
  state.drawer = false;
  state.loading = true;
  detailGate.invalidate();
  actionGate.invalidate();
  renderShell();
  return loadMail();
}
function backToList() {
  detailGate.invalidate();
  actionGate.invalidate();
  const id = state.message?.id;
  state.message = null;
  renderReader();
  renderList();
  // Keep the list's scroll offset and return keyboard/screen-reader focus.
  const row = [...document.querySelectorAll(".mail-row")].find(
    (el) => el.dataset.id === String(id),
  );
  row?.focus({ preventScroll: true });
}
if (isAndroid) {
  // The native Android Back action must pop UI state before leaving the app.
  window.__postofficeBack = () => {
    if (dialog.open) {
      closeDialog();
      return true;
    }
    if (state.view === "api") {
      state.view = state.apiReturnView;
      renderShell();
      return true;
    }
    if (state.view === "compose") {
      exitCompose();
      return true;
    }
    if (state.view === "accounts") {
      exitAccounts();
      return true;
    }
    if (state.message) {
      backToList();
      return true;
    }
    if (state.account && state.view === "mail") {
      mobileHome();
      return true;
    }
    return false;
  };
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  try {
    if (action === "mobile-home") return mobileHome();
    if (action === "mobile-inbox" || action === "mobile-search") {
      if (
        action === "mobile-inbox" &&
        state.folder === "inbox" &&
        state.mailbox
      ) {
        if (!leavePage()) return;
        state.view = "mail";
        state.message = null;
        renderShell();
        return;
      }
      const loading = visitFolder("inbox");
      if (action === "mobile-search")
        document.querySelector("#search")?.focus();
      return loading;
    }
    if (action === "close-dialog") return closeDialog();
    if (action === "recheck-server") {
      target.disabled = true;
      try {
        await syncServer();
      } finally {
        if (target.isConnected) target.disabled = false;
      }
      return;
    }
    if (action === "recover-license") {
      const a = state.account;
      await checkServer(a);
      if (!current(a.id) || !canRecoverLicense(a))
        return toast("仅已连接的全局管理员可恢复服务端授权。");
      if (!bridge.openLicense)
        return toast("请更新 Windows 客户端后打开授权恢复页。");
      return bridge.openLicense(a.id);
    }
    if (action === "accounts") return openAccountsPage();
    if (action === "accounts-exit") return exitAccounts();
    if (action === "compose-exit") return exitCompose();
    if (action === "add-account") return showDialog("添加账号", loginForm());
    if (action === "reauth") {
      if (showDialog("重新登录", loginForm())) {
        const form = dialog.querySelector("#login-form");
        form.elements.server.value = state.account.server;
        form.elements.username.value = label(state.account);
        form.elements.password.focus();
      }
      return;
    }
    if (action === "certificate") return certificate();
    if (action === "switch")
      return await selectAccount(target.dataset.id, { openAdmin: true });
    if (action === "remove-account") {
      const a = state.accounts.find((x) => x.id === target.dataset.id);
      if (!a || !confirm(`退出 ${label(a)}？邮件仍保存在服务器。`)) return;
      await bridge.removeAccount(a.id);
      state.accounts = await bridge.listAccounts();
      if (current(a.id)) {
        closeDialog(true);
        state.account = null;
        listGate.invalidate();
        detailGate.invalidate();
        actionGate.invalidate();
        if (state.accounts.length) await selectAccount(state.accounts[0].id);
        else renderLogin();
      } else renderShell();
      return;
    }
    if (action === "api-docs") {
      if (!leavePage()) return;
      if (state.view !== "api") state.apiReturnView = state.view;
      state.view = "api";
      state.drawer = false;
      return renderShell();
    }
    if (action === "api-exit") {
      state.view = state.apiReturnView;
      return renderShell();
    }
    if (action === "admin") {
      if (state.account.authExpired) return toast("登录已过期，请先重新登录");
      if (!(await requireServerLicense())) return;
      return await bridge.openAdmin(state.account.id);
    }
    if (action === "drawer" || action === "drawer-close") {
      setDrawer(action === "drawer");
      return;
    }
    if (action === "folder") {
      return visitFolder(target.dataset.folder);
    }
    if (action === "refresh") return syncServer();
    if (action === "previous" || action === "next") {
      state.page += action === "next" ? 1 : -1;
      state.items = [];
      return loadMail();
    }
    if (action === "open") return openMessage(target.dataset.id);
    if (action === "back") {
      return backToList();
    }
    if (action === "html") {
      state.html = !state.html;
      renderReader();
      return;
    }
    if (["star", "archive", "delete", "restore", "unread"].includes(action))
      return changeMessage(action);
    if (action === "compose") return compose();
    if (action === "reply" || action === "forward") return compose(action);
    if (action === "edit-draft") return compose("draft");
    if (action === "remove-file") {
      if (composer) {
        composer.files.splice(Number(target.dataset.index), 1);
        composer.dirty = true;
        renderFiles();
      }
      return;
    }
    if (action === "save-draft") return submitCompose(false);
    if (action === "download") return download(target.dataset.id);
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "login-form") return login(event.target);
  if (event.target.id === "compose-form") return submitCompose(true);
});
document.addEventListener("input", (event) => {
  if (event.target.id === "search") {
    clearTimeout(searchTimer);
    listGate.invalidate();
    state.query = event.target.value;
    searchTimer = setTimeout(() => {
      state.page = 1;
      state.items = [];
      loadMail();
    }, 280);
  }
  if (event.target.closest("#compose-form") && composer) composer.dirty = true;
});
document.addEventListener("change", (event) => {
  if (event.target.id === "attachments-input") addFiles(event.target);
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("#search")?.focus();
  }
  if (event.key === "Escape" && !dialog.open) {
    if (isAndroid) window.__postofficeBack();
    else setDrawer(false);
  }
  if (
    event.key === "Tab" &&
    state.drawer &&
    !dialog.open &&
    matchMedia("(max-width:800px)").matches
  ) {
    const nodes = [
        ...document.querySelectorAll(".sidebar button:not(:disabled)"),
      ].filter((el) => el.getClientRects().length),
      first = nodes[0],
      last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
document.addEventListener("visibilitychange", () => {
  if (
    !document.hidden &&
    !state.loading &&
    !navigation.isInteracting() &&
    state.account &&
    Date.now() - (state.account.accessCheckedAt || 0) > 5000
  )
    void syncServer();
});
window.addEventListener("online", () => {
  if (state.account) void syncServer();
});
window.addEventListener("beforeunload", (event) => {
  if (composer?.dirty || composer?.busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});
setInterval(() => {
  if (
    !document.hidden &&
    !state.loading &&
    !navigation.isInteracting() &&
    state.account
  )
    void syncServer();
}, 60000);
async function boot() {
  if (!bridge) return renderLogin();
  try {
    state.accounts = await bridge.listAccounts();
    if (state.accounts.length) await selectAccount(state.accounts[0].id);
    else renderLogin();
  } catch (error) {
    renderLogin();
    toast(error.message);
  }
}
boot();
