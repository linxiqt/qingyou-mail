// Isolated test bridge. This file is never copied into native client packages.
const makeAccount = (id, email, portal = "client") => ({
  id,
  server:
    id === "personal"
      ? "https://second.example.test:8443"
      : "https://mail.example.test",
  portal,
  user: {
    email,
    name: email.startsWith("work") ? "工作邮箱" : "个人邮箱",
    role: portal === "admin" ? "admin" : "user",
    ...(portal === "admin" ? { admin_scope: "global" } : {}),
  },
});
const accounts = [
  makeAccount("work", "work@example.test"),
  makeAccount("personal", "hello@example.test"),
  makeAccount("admin", "admin", "admin"),
];
const mails = [
  {
    id: "m1",
    from_name: "林琪",
    from_email: "linqi@example.test",
    subject: "产品评审 · 周四下午见",
    snippet:
      "更新后的方案和议程已整理好，我们在周四下午两点一起确认最后的细节。",
    body_text:
      "你好，\n\n更新后的方案和议程已整理好。我们在周四下午两点一起确认最后的细节。\n\n本次重点：\n1. 首页的结构与交互\n2. 移动端适配\n3. 下周的交付安排\n\n有其他议题可以直接回复这封邮件。\n\n林琪",
    is_read: 0,
    starred: 1,
    attachment_count: 1,
    attachments: [{ id: "f1", filename: "评审议程.pdf", size: 24650 }],
    created_at: "2026-11-02T09:41:00+08:00",
  },
  {
    id: "m2",
    from_name: "设计团队",
    from_email: "design@example.test",
    subject: "新版组件说明已更新",
    snippet: "按钮、表单和消息状态的规范已整理完成，请查收。",
    body_text: "组件说明已更新。",
    is_read: 0,
    created_at: "2026-11-02T08:35:00+08:00",
  },
  {
    id: "m3",
    from_name: "周晓",
    from_email: "zhou@example.test",
    subject: "Re: 关于下周的安排",
    snippet: "收到，我会在周三之前把资料准备好。",
    body_text: "收到，我会在周三之前把资料准备好。",
    is_read: 1,
    created_at: "2026-11-01T17:24:00+08:00",
  },
  {
    id: "m4",
    from_name: "青邮通知",
    from_email: "notice@example.test",
    subject: "你的邮箱已准备就绪",
    snippet: "欢迎使用青邮。现在可以在手机和电脑上收发邮件了。",
    body_text: "",
    body_html:
      "<p>纯 HTML 邮件也能阅读</p><script>window.BAD=1</script><p>第二段正文</p>",
    is_read: 1,
    created_at: "2026-10-31T10:00:00+08:00",
  },
].map((m) => ({
  ...m,
  to: [{ address: "work@example.test" }],
  cc: [],
  folder: "inbox",
}));
const copy = (x) => JSON.parse(JSON.stringify(x));
window.__fixture = { requests: [], sent: [], ai: [], opens: [], downloads: [] };
const mobile = new URL(location.href).searchParams.has("android");
window.postoffice = {
  platform: mobile ? "android" : "windows",
  capabilities: {
    ai: !mobile,
    admin: !mobile,
    attachments: true,
    certificateTrust: true,
  },
  async copyText({ text }) {
    if (window.__fixture.copyFails) throw Error("Clipboard unavailable");
    (window.__fixture.copies ||= []).push(text);
    return { copied: true };
  },
  async listAccounts() {
    return copy(
      mobile ? accounts.filter((a) => a.portal === "client") : accounts,
    );
  },
  async login({ username }) {
    const a = makeAccount("new", username);
    accounts.push(a);
    return copy(a);
  },
  async removeAccount(id) {
    accounts.splice(
      accounts.findIndex((a) => a.id === id),
      1,
    );
  },
  async openAdmin(id) {
    window.__fixture.opens.push(id);
  },
  async openLicense(id) {
    (window.__fixture.recoveries ||= []).push(id);
  },
  async request({ accountId, path, method = "GET", body }) {
    window.__fixture.requests.push({ accountId, path, method, body });
    if (window.__fixture.expired)
      return { status: 401, data: { error: "expired" } };
    const url = new URL(path, "https://mail.example.test");
    if (url.searchParams.get("q") === "slow")
      await new Promise((r) => setTimeout(r, 350));
    else await new Promise((r) => setTimeout(r, 30));
    if (path === "/auth/me")
      if (window.__fixture.disconnected) throw new Error("无法连接服务器");
    if (path === "/auth/me" && window.__fixture.accessDelay)
      await new Promise((r) => setTimeout(r, window.__fixture.accessDelay));
    if (path === "/auth/me")
      return {
        status: 200,
        data: {
          user: copy(accounts.find((a) => a.id === accountId).user),
          csrfToken: "fixture-csrf",
          license: copy(
            window.__fixture.licenses?.[accountId] ?? {
              required: true,
              valid: true,
              mode: "online",
              expiresAt: null,
            },
          ),
        },
      };
    if (
      window.__fixture.failMail &&
      (path === "/mailbox" || path.startsWith("/messages?"))
    )
      return { status: 503, data: { error: "暂时无法连接邮箱，请重试" } };
    if (path === "/mailbox")
      return {
        status: 200,
        data: {
          counts: [
            {
              folder: "inbox",
              total: accountId === "personal" ? 1 : 4,
              unread: accountId === "personal" ? 1 : 2,
            },
            { folder: "sent", total: 8 },
            { folder: "drafts", total: 1 },
          ],
          usedBytes: 3456789,
          quotaBytes: 1073741824,
        },
      };
    if (path.startsWith("/messages?")) {
      let items =
        accountId === "personal"
          ? [{ ...mails[0], id: "personal-mail", subject: "个人邮箱专属邮件" }]
          : mails;
      if (url.searchParams.get("unread") === "1")
        items = items.filter((m) => !m.is_read);
      if (url.searchParams.get("folder") === "starred")
        items = items.filter((m) => m.starred);
      if (url.searchParams.get("q") && url.searchParams.get("q") !== "slow")
        items = items.filter((m) =>
          (m.subject + m.from_name + m.body_text).includes(
            url.searchParams.get("q"),
          ),
        );
      if (window.__fixture.empty) items = [];
      return {
        status: 200,
        data: {
          items: copy(items),
          total: items.length,
          page: 1,
          limit: 30,
        },
      };
    }
    if (path.startsWith("/messages/") && method === "GET")
      return {
        status: 200,
        data: copy(
          mails.find((m) => m.id === path.split("/")[2]) || {
            ...mails[0],
            id: "personal-mail",
            subject: "个人邮箱专属邮件",
          },
        ),
      };
    if (path.startsWith("/drafts/") && path.endsWith("/attachments"))
      return { status: 200, data: { items: [] } };
    if (path === "/drafts") {
      window.__fixture.sent.push({ draft: true, body });
      return { status: 201, data: { id: "saved-draft" } };
    }
    if (path === "/send") {
      window.__fixture.sent.push({ draft: false, body });
      return { status: 201, data: { id: "sent" } };
    }
    return { status: 200, data: { ok: true } };
  },
  async getAIConfig() {
    return {
      baseUrl: "https://ai.example.test/v1",
      model: "test-model",
      hasApiKey: true,
    };
  },
  async setAIConfig() {
    return { hasApiKey: true };
  },
  async runAI(input) {
    window.__fixture.ai.push(input);
    return {
      text: "本周四下午两点进行产品评审，讨论首页、移动适配和交付安排。",
    };
  },
  async download(input) {
    window.__fixture.downloads.push(input);
    return { saved: true };
  },
  async inspectCertificate() {
    return { fingerprint: "00:11:22", trusted: true };
  },
  async trustCertificate() {
    return { ok: true };
  },
};
