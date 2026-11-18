import rateLimit from "express-rate-limit";
import { randomString } from "./account-generator.js";
import {
  AppError,
  emailAddress,
  idValue,
  textValue,
  token,
  equal,
} from "./security.js";
import { bool, integer, ipRules, getSetting, putSetting } from "./settings.js";

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function mountCodeLinks(router, adminRouter, store, service) {
  const { db, transaction, audit } = store;
  function bound(linkId, active = false) {
    return db
      .prepare(
        `SELECT u.id,u.email FROM code_link_users b JOIN users u ON u.id=b.user_id JOIN domains d ON d.id=u.domain_id WHERE b.link_id=? ${active ? "AND u.active=1 AND d.enabled=1 AND (u.is_temporary=0 OR u.temporary_expires_at>?)" : ""} ORDER BY u.id`,
      )
      .all(linkId, ...(active ? [Date.now()] : []));
  }
  function emails(input, old) {
    const values =
      input.emails ??
      (input.email
        ? [input.email]
        : old
          ? bound(old.id).map((u) => u.email)
          : []);
    if (!Array.isArray(values) || !values.length || values.length > 100)
      throw new AppError("请选择1–100个邮箱");
    const users = [...new Set(values.map(emailAddress))].map((email) => {
      const user = db
        .prepare(
          "SELECT u.id,u.email FROM users u JOIN domains d ON d.id=u.domain_id WHERE u.email=? AND u.active=1 AND d.enabled=1 AND (u.is_temporary=0 OR u.temporary_expires_at>?)",
        )
        .get(email, Date.now());
      if (!user) throw new AppError(`邮箱不存在或已停用：${email}`);
      return user;
    });
    return users;
  }
  function validate(input, old = null) {
    const settings = service.settings();
    if (!settings.enabled || !settings.allowPublicLinks)
      throw new AppError("请先启用接码及接码链接");
    const users = emails(input, old),
      allowlist = ipRules(input.ipAllowlist ?? old?.ip_allowlist ?? "").text;
    if (input.requireIp === true && !allowlist)
      throw new AppError("启用IP校验时请填写白名单");
    const custom = input.token === "" ? undefined : (input.token ?? old?.token);
    if (
      custom !== undefined &&
      (!/^[A-Za-z0-9]{8}$/.test(custom) || typeof custom !== "string")
    )
      throw new AppError("Token需为8位大小写字母或数字");
    let generated = custom;
    if (!generated)
      do {
        generated = randomString(8, [alphabet]);
      } while (
        db.prepare("SELECT id FROM code_links WHERE token=?").get(generated)
      );
    const duplicate = db
      .prepare("SELECT id FROM code_links WHERE token=?")
      .get(generated);
    if (duplicate && duplicate.id !== old?.id)
      throw new AppError("Token已存在", 409);
    return {
      users,
      token: generated,
      label: textValue(input.label ?? old?.label ?? "", 80),
      enabled: Number(bool(input.enabled, Boolean(old?.enabled ?? true))),
      ipAllowlist: allowlist,
      includeMessage: Number(
        bool(input.includeMessage, Boolean(old?.include_message ?? false)),
      ),
      expires:
        input.hours === undefined && old
          ? old.expires_at
          : Date.now() +
            integer(input.hours, settings.linkHours, 1, 720, "有效期（小时）") *
              3600000,
    };
  }
  function save(value, old) {
    const id =
      old?.id ||
      Number(
        db
          .prepare(
            "INSERT INTO code_links(token,user_id,label,enabled,expires_at,ip_allowlist,include_message) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            value.token,
            value.users[0].id,
            value.label,
            value.enabled,
            value.expires,
            value.ipAllowlist,
            value.includeMessage,
          ).lastInsertRowid,
      );
    if (old) {
      db.prepare(
        "UPDATE code_links SET token=?,user_id=?,label=?,enabled=?,expires_at=?,ip_allowlist=?,include_message=? WHERE id=?",
      ).run(
        value.token,
        value.users[0].id,
        value.label,
        value.enabled,
        value.expires,
        value.ipAllowlist,
        value.includeMessage,
        id,
      );
      db.prepare("DELETE FROM code_link_users WHERE link_id=?").run(id);
    }
    for (const user of value.users)
      db.prepare(
        "INSERT INTO code_link_users(link_id,user_id) VALUES(?,?)",
      ).run(id, user.id);
    return {
      id,
      token: value.token,
      expires_at: value.expires,
      emails: value.users.map((u) => u.email),
    };
  }
  adminRouter.get("/code-links", (req, res) => {
    const query = String(req.query.q || "")
      .toLowerCase()
      .slice(0, 100);
    const items = db
      .prepare("SELECT * FROM code_links ORDER BY id DESC LIMIT 1000")
      .all()
      .map((l) => ({
        ...l,
        emails: bound(l.id).map((u) => u.email),
        email: bound(l.id)[0]?.email || "",
      }))
      .filter((l) =>
        `${l.token} ${l.label} ${l.emails.join(" ")}`
          .toLowerCase()
          .includes(query),
      );
    res.json({
      items,
      total: db.prepare("SELECT count(*) n FROM code_links").get().n,
    });
  });
  adminRouter.post("/code-links", (req, res) => {
    if (db.prepare("SELECT count(*) n FROM code_links").get().n >= 1000)
      throw new AppError("最多保存1000条链接");
    const value = validate(req.body),
      result = transaction(() => {
        const link = save(value);
        audit(req.user.email, "codes.link.create", {
          id: link.id,
          mailboxes: value.users.length,
        });
        return link;
      });
    res.status(201).json(result);
  });
  adminRouter.post("/code-links/batch", (req, res) => {
    const users = emails(req.body);
    if (req.body.token) throw new AppError("一对一批量创建请使用自动token");
    if (
      db.prepare("SELECT count(*) n FROM code_links").get().n + users.length >
      1000
    )
      throw new AppError("链接总数最多1000条");
    const items = transaction(() => {
      const result = users.map((user) =>
        save(validate({ ...req.body, emails: [user.email] })),
      );
      audit(req.user.email, "codes.link.batch_create", {
        count: result.length,
      });
      return result;
    });
    res.status(201).json({ items });
  });
  adminRouter.patch("/code-links/:id", (req, res) => {
    const old = db
      .prepare("SELECT * FROM code_links WHERE id=?")
      .get(idValue(req.params.id));
    if (!old) throw new AppError("链接不存在", 404);
    const value = validate(req.body, old);
    const result = transaction(() => {
      const result = save(value, old);
      audit(req.user.email, "codes.link.update", { id: old.id });
      return result;
    });
    res.json(result);
  });
  adminRouter.delete("/code-links/:id", (req, res) => {
    const id = idValue(req.params.id);
    transaction(() => {
      db.prepare("DELETE FROM code_links WHERE id=?").run(id);
      audit(req.user.email, "codes.link.delete", { id });
    });
    res.json({ ok: true });
  });
  adminRouter.get("/code-links/:id/logs", (req, res) => {
    const id = idValue(req.params.id),
      page = integer(req.query.page, 1, 1, 10000, "页码"),
      limit = integer(req.query.limit, 30, 1, 100, "每页数量");
    if (!db.prepare("SELECT id FROM code_links WHERE id=?").get(id))
      throw new AppError("链接不存在", 404);
    res.json({
      items: db
        .prepare(
          "SELECT id,ip,action,result,reason,created_at FROM code_access_logs WHERE link_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(id, limit, (page - 1) * limit),
      total: db
        .prepare("SELECT count(*) n FROM code_access_logs WHERE link_id=?")
        .get(id).n,
      page,
      limit,
    });
  });
  const adminAccess = () =>
    getSetting(db, "code_admin", { secret: "", public: false });
  adminRouter.get("/code-admin", (_req, res) => res.json(adminAccess()));
  adminRouter.post("/code-admin/refresh", (req, res) => {
    const value = { ...adminAccess(), secret: token(32) };
    transaction(() => {
      putSetting(db, "code_admin", value);
      audit(req.user.email, "codes.admin.rotate");
    });
    res.json(value);
  });
  adminRouter.put("/code-admin", (req, res) => {
    const old = adminAccess(),
      enabled = bool(req.body.public, old.public);
    if (enabled && !old.public && req.body.confirmPublicAccess !== true)
      throw new AppError("请明确确认允许任何访问者查看管理员接码结果");
    const value = { ...old, public: enabled };
    transaction(() => {
      putSetting(db, "code_admin", value);
      audit(req.user.email, "codes.admin.public", { enabled });
    });
    res.json(value);
  });
  const limit = rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "请求过于频繁，请稍后重试" },
  });
  function log(req, link, action, result, reason = "") {
    db.prepare(
      "INSERT INTO code_access_logs(link_id,ip,action,result,reason) VALUES(?,?,?,?,?)",
    ).run(
      link?.id || null,
      String(req.ip).slice(0, 80),
      action,
      result,
      reason,
    );
    db.prepare(
      "DELETE FROM code_access_logs WHERE id NOT IN(SELECT id FROM code_access_logs ORDER BY id DESC LIMIT 5000)",
    ).run();
  }
  function access(req, action = "read") {
    const settings = service.settings(),
      raw = req.body.token;
    const link =
      typeof raw === "string" && /^[A-Za-z0-9]{8}$/.test(raw)
        ? db.prepare("SELECT * FROM code_links WHERE token=?").get(raw)
        : null;
    const deny = (reason) => {
      log(req, link, action, "denied", reason);
      throw new AppError("接码链接无效、无权访问、已停用或已过期", 404);
    };
    if (
      !settings.enabled ||
      !settings.allowPublicLinks ||
      !link ||
      !link.enabled ||
      link.expires_at <= Date.now()
    )
      deny("链接无效或已失效");
    if (!ipRules(link.ip_allowlist).test(req.ip)) deny("IP不在白名单内");
    const users = bound(link.id, true).filter(
      (u) =>
        !settings.domains?.length ||
        settings.domains.includes(u.email.split("@")[1]),
    );
    if (!users.length) deny("没有可用的绑定邮箱");
    return { link, users };
  }
  router.post("/code-links/read", limit, async (req, res) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    const { link, users } = access(req);
    const result = await service.list(
      users.map((u) => u.email),
      100,
      { includeUnmatched: Boolean(link.include_message) },
    );
    log(req, link, req.body.action === "open" ? "open" : "read", "success");
    res.json({
      mailbox: users[0].email,
      mailboxes: users.map((u) => u.email),
      refreshSeconds: service.settings().refreshSeconds,
      includeMessage: Boolean(link.include_message),
      receivedCount: result.receivedCount,
      matchedCount: result.matchedCount,
      items: result.items,
    });
  });
  router.post("/code-links/message", limit, (req, res) => {
    const { link, users } = access(req, "message");
    if (!link.include_message) {
      log(req, link, "message", "denied", "未授予正文访问权限");
      throw new AppError("此链接未开放邮件正文", 403);
    }
    const id = idValue(req.body.id),
      message = db
        .prepare(
          `SELECT m.id,m.subject,m.from_email,m.created_at,m.body_text,m.body_html,u.email AS mailbox FROM messages m JOIN users u ON u.id=m.owner_id WHERE m.id=? AND m.folder='inbox' AND m.owner_id IN(${users.map(() => "?").join(",")})`,
        )
        .get(id, ...users.map((u) => u.id));
    if (!message) throw new AppError("邮件不存在", 404);
    log(req, link, "message", "success");
    res.json(message);
  });
  router.post("/code-admin/read", limit, async (req, res) => {
    const settings = adminAccess();
    if (
      !service.settings().enabled ||
      (!settings.public &&
        (!settings.secret || !equal(req.body.secret, settings.secret)))
    )
      throw new AppError("管理员接码访问凭据无效", 404);
    res.json(await service.list());
  });
}
