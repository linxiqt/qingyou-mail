import { folders, esc, can, bytes } from "./model.js";
import { connected, licensed } from "./server-access.js";

// Android uses the same authenticated server data and actions as the desktop.
// These helpers only render the phone's navigation and overview.
export function mailboxCount(mailbox, folder) {
  if (!Array.isArray(mailbox?.counts)) return "—";
  const row = mailbox.counts.find(
    (item) => item.folder === (folder === "unread" ? "inbox" : folder),
  );
  return Number(row?.[folder === "unread" ? "unread" : "total"]) || 0;
}

export function avatarTone(value) {
  return ["blue", "sage", "peach", "lilac"][
    Array.from(String(value || "")).reduce(
      (sum, char) => sum + char.codePointAt(0),
      0,
    ) % 4
  ];
}

export function androidNavigation(state, { icon }) {
  return `<nav class="phone-nav light-surface" data-scrub-nav aria-label="主导航">
    <button data-action="mobile-home" ${state.view === "home" ? 'aria-current="page"' : ""} ${connected(state.account) ? "" : "disabled"}>${icon("mail")}<span>邮箱</span></button>
    <button data-action="mobile-inbox" ${state.view === "mail" ? 'aria-current="page"' : ""} ${connected(state.account) ? "" : "disabled"}>${icon("inbox")}<span>收件箱</span></button>
    <button data-action="compose" ${state.view === "compose" ? 'aria-current="page"' : ""} ${can(state.account, "mail.send") && licensed(state.account) ? "" : "disabled"}>${icon("edit")}<span>写邮件</span></button>
    <button data-action="accounts" ${state.view === "accounts" ? 'aria-current="page"' : ""}>${icon("users")}<span>账号</span></button>
  </nav>`;
}

export function androidOverview(state, helpers) {
  const { icon, ib, label, initials } = helpers;
  const a = state.account;
  const shortcuts = [
    ["inbox", "收件箱", "inbox", "blue"],
    ["unread", "未读邮件", "mail", "white"],
    ["drafts", "草稿箱", "edit", "peach"],
    ["sent", "已发送", "send", "lilac"],
  ];
  return `<main class="shell phone-shell phone-home" data-view="home">
    <section class="phone-overview" aria-label="邮箱总览">
      <header class="phone-home-heading"><div><span class="phone-brand">青邮</span><h1>邮箱</h1></div><div class="row">
        ${ib("mobile-search", "搜索邮件", "search")}
        <button class="phone-avatar" data-action="accounts" aria-label="切换账号：${esc(label(a))}"><span class="avatar">${esc(initials(a.user?.name || label(a)))}</span></button>
      </div></header>
      <div class="mailbox-tiles" aria-label="当前账号邮件统计">${shortcuts.map(([id, title, symbol, tone]) => `<button class="mailbox-tile tile-${tone}" data-action="folder" data-folder="${id}"><span class="tile-icon">${icon(symbol)}</span><span class="tile-name">${title}</span><strong data-mailbox-count="${id}">${mailboxCount(state.mailbox, id)}</strong>${icon("chevron")}</button>`).join("")}</div>
      <div id="home-error" role="alert"></div>
      <div class="phone-section-title"><button data-action="accounts" class="phone-account-label"><span>${esc(a.user?.name || "当前邮箱")}</span><small>${esc(label(a))}</small></button>${ib("accounts", "管理邮箱账号", "down")}</div>
      <nav class="phone-folder-group" aria-label="邮件文件夹">${[
        "inbox",
        "sent",
        "drafts",
        "spam",
        "trash",
      ]
        .map((id) => {
          const [, title, symbol] = folders.find((f) => f[0] === id);
          return `<button data-action="folder" data-folder="${id}">${icon(symbol)}<span>${title}</span><span class="folder-total" data-mailbox-count="${id}">${mailboxCount(state.mailbox, id)}</span>${icon("chevron")}</button>`;
        })
        .join("")}</nav>
      <div class="phone-section-title"><h2>快捷访问</h2><span class="phone-quiet">你的邮箱，随时掌握</span></div>
      <div class="phone-shortcuts"><button data-action="folder" data-folder="starred">${icon("star")}已标星</button><button data-action="folder" data-folder="archive">${icon("archive")}归档</button><button data-action="api-docs">${icon("reference")}AI 接口</button></div>
      <footer class="phone-sync"><span id="home-sync" role="status"></span>${ib("refresh", "同步邮箱", "refresh")}</footer>
      <p id="home-storage" class="phone-storage"></p>
    </section>${androidNavigation(state, helpers)}
  </main>`;
}

export function updateAndroidOverview(state) {
  const home = document.querySelector(".phone-overview");
  if (!home) return;
  home.querySelectorAll("[data-mailbox-count]").forEach((el) => {
    el.textContent = mailboxCount(state.mailbox, el.dataset.mailboxCount);
  });
  home
    .querySelector(".mailbox-tiles")
    .setAttribute("aria-busy", String(state.loading));
  home.querySelector("#home-error").innerHTML = state.error
    ? `<div class="error">${esc(state.error)} <button data-action="${state.account?.authExpired ? "reauth" : "refresh"}">${state.account?.authExpired ? "重新登录" : "重试"}</button></div>`
    : "";
  home.querySelector("#home-sync").textContent = state.loading
    ? "正在同步邮箱…"
    : state.error
      ? "同步未完成，上次数据已保留"
      : state.synced
        ? `已同步 · ${state.synced.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
        : "尚未同步";
  home.querySelector("#home-storage").textContent = state.mailbox?.quotaBytes
    ? `已用 ${bytes(state.mailbox.usedBytes)} / ${bytes(state.mailbox.quotaBytes)}`
    : "";
}

export function androidInbox(state, helpers) {
  const { icon, ib, label, initials } = helpers;
  const title =
    folders.find((folder) => folder[0] === state.folder)?.[1] || "邮箱";
  return `<main class="shell phone-shell phone-mail${state.message ? " reading" : ""}" data-view="mail">
    <section class="list-pane">
      <header class="list-header">
        <div class="phone-list-top"><button class="phone-back-pill" data-action="mobile-home">${icon("back")}邮箱</button><button class="phone-account-mini" data-action="accounts" aria-label="切换账号：${esc(label(state.account))}"><span class="avatar">${esc(initials(state.account.user?.name || label(state.account)))}</span><span>${esc(label(state.account))}</span>${icon("down")}</button></div>
        <div class="search-box">${icon("search")}<input id="search" type="search" aria-label="搜索邮件" placeholder="搜索邮件" maxlength="100" value="${esc(state.query)}"></div>
        <div class="list-title"><div><h1>${title}</h1><small id="message-total">正在同步…</small></div>${ib("refresh", "刷新邮件", "refresh")}</div>
        ${
          ["inbox", "unread", "starred"].includes(state.folder)
            ? `<nav class="phone-filters" aria-label="筛选邮件">${[
                ["inbox", "全部邮件", "inbox"],
                ["unread", "未读", "mail"],
                ["starred", "已标星", "star"],
              ]
                .map(
                  ([id, text, symbol]) =>
                    `<button data-action="folder" data-folder="${id}" aria-pressed="${state.folder === id}">${icon(symbol)}${text}</button>`,
                )
                .join("")}</nav>`
            : ""
        }
      </header>
      <div id="list-error" role="alert"></div>
      <div class="message-list" id="message-list" aria-label="邮件列表"></div>
      <footer class="pager"><span id="sync-note" class="sync-note" role="status"></span><div class="row">${ib("previous", "上一页", "back")}<span id="page-number"></span>${ib("next", "下一页", "chevron")}</div></footer>
    </section>
    <section class="reader" id="reader" aria-label="阅读邮件"></section>
    ${androidNavigation(state, helpers)}
  </main>`;
}

export function androidAccounts(state, helpers, content) {
  return `<main class="shell phone-shell phone-accounts" data-view="accounts"><section class="account-page-scroll" aria-label="账号管理">${content}</section>${androidNavigation(state, helpers)}</main>`;
}

export function androidCompose(state, helpers, title, form) {
  return `<main class="shell phone-shell phone-write" data-view="compose"><section class="compose-page" aria-label="${esc(title)}"><header class="compose-page-heading"><div><span class="phone-brand">青邮</span><h1>${esc(title)}</h1></div>${helpers.ib("compose-exit", "返回上一页", "close")}</header>${form}</section>${androidNavigation(state, helpers)}</main>`;
}
