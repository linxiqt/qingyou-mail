export const folders = [
  ["inbox", "收件箱", "inbox"],
  ["unread", "未读邮件", "mail"],
  ["starred", "已标星", "star"],
  ["sent", "已发送", "send"],
  ["drafts", "草稿箱", "edit"],
  ["archive", "归档", "archive"],
  ["trash", "已删除", "trash"],
  ["spam", "垃圾邮件", "shield"],
];
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const recipientsText = (value) =>
  (Array.isArray(value) ? value : [])
    .map((x) => (typeof x === "string" ? x : x.address || ""))
    .filter(Boolean)
    .join(", ");
export const parseRecipients = (value) =>
  String(value || "")
    .split(/[,;\n，；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
export const isAdmin = (account) =>
  account?.portal === "admin" && account?.user?.role === "admin";
export function can(account, capability) {
  if (!account) return false;
  if (!account.user?.client_manager) return true;
  return (account.user.capabilities || []).includes(capability);
}
export function listPath(folder, page = 1, query = "") {
  const params = new URLSearchParams({
    folder: folder === "unread" ? "inbox" : folder,
    page: String(page),
    limit: "30",
  });
  if (folder === "unread") params.set("unread", "1");
  if (query.trim()) params.set("q", query.trim());
  return "/messages?" + params;
}
export function bytes(value) {
  const n = Number(value) || 0;
  return n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;
}
export function date(value, full = false) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat(
    "zh-CN",
    full
      ? { dateStyle: "medium", timeStyle: "short" }
      : {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        },
  ).format(d);
}
export function createRequestGate() {
  let epoch = 0;
  return {
    invalidate() {
      epoch++;
    },
    ticket() {
      const current = ++epoch;
      return () => current === epoch;
    },
  };
}
export function aiText(message) {
  return `主题：${message.subject || "无主题"}\n发件人：${message.from_email || ""}\n\n${message.body_text || ""}`;
}
