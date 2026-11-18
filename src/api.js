import express from "express";
import { messageColumns } from "./message-columns.js";
import rateLimit from "express-rate-limit";
import {
  AppError,
  token,
  digest,
  equal,
  hashPassword,
  verifyPassword,
  passwordValid,
  emailAddress,
  domainName,
  recipients,
  textValue,
  idValue,
  publicUser,
} from "./security.js";
import { folders } from "./mail.js";
import { assertForwardGraph } from "./forwarding.js";
import { createCodeService, mountCodeRoutes } from "./codes.js";
import { generateAccounts } from "./account-generator.js";
import { mapLimit } from "./async-pool.js";
import {
  normalizeMailboxLimit,
  assertMailboxCapacity,
  assertMailboxLimit,
} from "./domain-quota.js";
import { mountTempMailRoutes } from "./temp-mail.js";
import { mountManagementRoutes } from "./management.js";
import {
  isGlobalAdmin,
  isClientManager,
  userPayload,
  requireDomain,
} from "./access.js";
import {
  effectiveCapabilities,
  requireCapability,
} from "./admin-permissions.js";
import { sendPolicy, checkSendPolicy } from "./send-policy.js";
import {
  mountPlatformRoutes,
  createResponseCache,
  featureGate,
} from "./platform.js";
import { ipRules } from "./settings.js";
import { mountConnectionRoutes } from "./connections.js";
import { webhookTarget } from "./webhooks.js";
import { dnsPlan, checkDnsPlan } from "./dns.js";
import { createDnsResolver } from "./dns-resolver.js";
import { generateDomainKey, saveDomainKey } from "./domain-keys.js";
import {
  configureFirstMailDomain,
  mailHostnameConfigured,
  saveMailHostname,
} from "./mail-settings.js";

export function mountApi(app, store, mail, config) {
  const { db, transaction, audit } = store;
  const codeService = createCodeService(store);
  const responseCache = createResponseCache(store);
  const router = express.Router();
  const authLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "登录尝试过多，请 15 分钟后重试" },
  });
  const sendLimit = rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.id),
    message: { error: "发送过于频繁，请稍后重试" },
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 600,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "请求过于频繁" },
    }),
    router,
  );
  router.use((req, _res, next) => {
    req.authPortal = req.path.startsWith("/client/") ? "client" : "admin";
    if (req.authPortal === "client") {
      req.url = req.url.slice("/client".length);
      if (
        /^\/(?:admin|v1|send_mail)(?:\/|$)/i.test(req.path) ||
        /^\/setup\/?$/i.test(req.path)
      )
        throw new AppError("客户端不能访问后台接口", 403);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      req.body ??= {};
      if (typeof req.body !== "object" || Array.isArray(req.body))
        throw new AppError("请求体必须为 JSON 对象");
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== config.publicUrl
    )
      throw new AppError("请求来源无效，请检查 PUBLIC_URL 配置", 403);
    featureGate(db, req);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
      responseCache.wrap(req, _res);
    next();
  });
  const cookieName = (portal) =>
    portal === "client" ? "postoffice_client_session" : "postoffice_session";
  const sessionCookie = (value, portal = "admin") =>
    `${cookieName(portal)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value ? 604800 : 0}${config.secureCookies ? "; Secure" : ""}`;
  function login(res, user, portal = "admin") {
    const secret = token();
    const csrf = token();
    db.prepare(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,portal) VALUES(?,?,?,?,?)",
    ).run(digest(secret), user.id, csrf, Date.now() + 7 * 86400000, portal);
    res.setHeader("Set-Cookie", sessionCookie(secret, portal));
    return {
      user: { ...publicUser(user), ...userPayload(db, user) },
      csrfToken: csrf,
      license: { required: false, valid: true, mode: "none", expiresAt: null },
    };
  }
  function auth(req, _res, next) {
    const raw = req.headers.cookie?.match(
      new RegExp(`(?:^|;\\s*)${cookieName(req.authPortal)}=([^;]+)`),
    )?.[1];
    const session =
      raw &&
      db
        .prepare(
          "SELECT * FROM sessions WHERE token_hash=? AND expires_at>? AND portal=?",
        )
        .get(digest(raw), Date.now(), req.authPortal);
    const user = session && mail.activeUser(session.user_id);
    if (
      !user ||
      (req.authPortal === "admin" && user.role !== "admin") ||
      (req.authPortal === "client" && !user.email.includes("@"))
    )
      throw new AppError("请在当前入口重新登录", 401);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !equal(req.headers["x-csrf-token"], session.csrf_token)
    )
      throw new AppError("安全校验失败，请刷新页面", 403);
    req.user = user;
    req.session = session;
    if (req.authPortal === "client" && isClientManager(user)) {
      const route = req.path.toLowerCase();
      const read = ["GET", "HEAD"].includes(req.method);
      let capability;
      if (/^\/(?:mailbox|messages|attachments)(?:\/|$)/.test(route))
        capability = read
          ? "mail.read"
          : req.method === "DELETE" ||
              req.body?.folder === "trash" ||
              req.body?.action === "trash"
            ? "mail.delete"
            : "mail.update";
      else if (/^\/(?:send|drafts)(?:\/|$)/.test(route))
        capability = "mail.send";
      else if (/^\/templates(?:\/|$)/.test(route))
        capability = "templates.manage";
      if (capability) requireCapability(user, capability);
    }
    next();
  }
  function admin(req, _res, next) {
    if (req.user.role !== "admin") throw new AppError("仅管理员可访问", 403);
    if (
      !isGlobalAdmin(req.user) &&
      !req.originalUrl.split("?")[0].startsWith("/api/admin/manage/")
    )
      throw new AppError("此功能需要全局管理员权限", 403);
    // Scoped authorization happens inside each management handler. Never serve
    // a cached response before those capability and domain checks have run.
    if (isGlobalAdmin(req.user) && responseCache.wrap(req, _res)) return;
    next();
  }
  function scoped(scope) {
    return (req, _res, next) => {
      const raw =
        req.headers.authorization?.match(/^Bearer (po_[A-Za-z0-9_-]+)$/)?.[1] ||
        (req.method === "POST" &&
        /^po_[A-Za-z0-9_-]+$/.test(req.body?.apiKey || "")
          ? req.body.apiKey
          : undefined);
      const key =
        raw &&
        db
          .prepare("SELECT * FROM api_keys WHERE token_hash=?")
          .get(digest(raw));
      const user = key && mail.activeUser(key.user_id);
      if (!user || !isGlobalAdmin(user))
        throw new AppError("API Key 无效", 401);
      if (
        !ipRules(
          sendPolicy(JSON.parse(key.policy_json || "{}")).ipAllowlist,
        ).test(req.ip)
      )
        throw new AppError("当前IP不在API白名单内", 403);
      if (!JSON.parse(key.scopes).includes(scope))
        throw new AppError("API Key 权限不足", 403);
      db.prepare("UPDATE api_keys SET last_used_at=? WHERE id=?").run(
        new Date().toISOString(),
        key.id,
      );
      req.user = user;
      req.apiKey = key;
      next();
    };
  }
  function freshGlobal(req) {
    const actor = mail.activeUser(req.user.id);
    if (!actor || !isGlobalAdmin(actor))
      throw new AppError("管理权限已失效，请重新登录", 403);
    if (
      req.session &&
      !db
        .prepare("SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?")
        .get(req.session.token_hash, Date.now())
    )
      throw new AppError("登录会话已失效，请重新登录", 401);
    if (req.apiKey) {
      const key = db
        .prepare(
          "SELECT scopes,policy_json FROM api_keys WHERE id=? AND user_id=?",
        )
        .get(req.apiKey.id, actor.id);
      if (
        !key ||
        key.scopes !== req.apiKey.scopes ||
        key.policy_json !== req.apiKey.policy_json
      )
        throw new AppError("API Key 已失效或权限已变更", 401);
    }
    req.user = actor;
    return actor;
  }
  function freshPersonal(req, capability) {
    const actor = mail.activeUser(req.user.id);
    if (
      !actor ||
      !db
        .prepare(
          "SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>? AND portal=?",
        )
        .get(req.session.token_hash, Date.now(), req.authPortal)
    )
      throw new AppError("登录会话已失效，请重新登录", 401);
    if (capability && req.authPortal === "client" && isClientManager(actor))
      requireCapability(actor, capability);
    req.user = actor;
    return actor;
  }
  function pagination(req) {
    const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    return {
      page: Math.floor(page),
      limit: Math.floor(limit),
      offset: (Math.floor(page) - 1) * Math.floor(limit),
    };
  }
  const summaryColumns = `m.id,m.owner_id,m.folder,m.from_email,m.from_name,m.to_json,m.cc_json,m.subject,m.snippet,m.size,m.is_read,m.starred,m.delivery_status,m.created_at,u.email AS mailbox,(SELECT count(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count`;
  const decode = (row) =>
    row && {
      ...row,
      to: JSON.parse(row.to_json),
      cc: JSON.parse(row.cc_json),
      ...(row.bcc_json ? { bcc: JSON.parse(row.bcc_json) } : {}),
    };
  function listMessages(req, all = false) {
    const { page, limit, offset } = pagination(req);
    const conditions = [];
    const args = [];
    if (!all) {
      conditions.push("m.owner_id=?");
      args.push(req.user.id);
    }
    if (req.query.email) {
      conditions.push("u.email=?");
      args.push(emailAddress(req.query.email));
    }
    const folder = req.query.folder || "inbox";
    if (folder === "starred")
      conditions.push("m.starred=1 AND m.folder NOT IN ('trash','spam')");
    else {
      if (!folders.includes(folder)) throw new AppError("文件夹无效");
      conditions.push("m.folder=?");
      args.push(folder);
    }
    if (req.query.q) {
      const q = `%${String(req.query.q).slice(0, 100)}%`;
      conditions.push(
        "(m.subject LIKE ? OR m.from_email LIKE ? OR m.body_text LIKE ?)",
      );
      args.push(q, q, q);
    }
    if (req.query.unread === "1") conditions.push("m.is_read=0");
    const where = conditions.join(" AND ");
    const total = db
      .prepare(
        `SELECT count(*) AS total FROM messages m JOIN users u ON u.id=m.owner_id WHERE ${where}`,
      )
      .get(...args).total;
    const items = db
      .prepare(
        `SELECT ${summaryColumns} FROM messages m JOIN users u ON u.id=m.owner_id WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset)
      .map(decode);
    return { items, total, page, limit };
  }
  function ownedMessage(req, id, adminView = false, includeRaw = false) {
    const row = db
      .prepare(
        `SELECT ${includeRaw ? "*" : messageColumns()} FROM messages WHERE id=?`,
      )
      .get(idValue(id));
    if (
      !row ||
      (row.owner_id !== req.user.id &&
        !(adminView && req.user.role === "admin"))
    )
      throw new AppError("邮件不存在", 404);
    return row;
  }
  router.get("/setup/status", (_req, res) =>
    res.json({
      needsSetup: !db.prepare("SELECT id FROM users LIMIT 1").get(),
      requiresToken: false,
    }),
  );
  router.post("/setup", authLimit, async (req, res) => {
    if (db.prepare("SELECT id FROM users LIMIT 1").get())
      throw new AppError("系统已初始化", 409);
    const managementOnly = !req.body.domain && !req.body.email;
    const domain = managementOnly ? "" : domainName(req.body.domain);
    const email = managementOnly
      ? String(req.body.username || "admin")
          .trim()
          .toLowerCase()
      : emailAddress(req.body.email);
    if (managementOnly && !/^[a-z][a-z0-9_-]{2,31}$/.test(email))
      throw new AppError(
        "管理账号需为 3–32 位字母、数字、下划线或短横线，以字母开头",
      );
    if (!managementOnly && !email.endsWith(`@${domain}`))
      throw new AppError("管理员邮箱必须属于初始域名");
    const name = textValue(req.body.name || "管理员");
    const [hash, domainKey] = await Promise.all([
      hashPassword(req.body.password),
      managementOnly ? null : generateDomainKey(config, domain),
    ]);
    const user = transaction(() => {
      if (db.prepare("SELECT id FROM users LIMIT 1").get())
        throw new AppError("系统已初始化", 409);
      // The empty namespace links management logins to the existing user schema.
      // It is never exposed as a mail domain and has no mailbox or DKIM key.
      const domainId = db
        .prepare("INSERT INTO domains(name) VALUES(?)")
        .run(domain).lastInsertRowid;
      if (domainKey) saveDomainKey(db, domainId, domainKey);
      const id = db
        .prepare(
          "INSERT INTO users(domain_id,email,name,password_hash,role,quota_bytes) VALUES(?,?,?,?,'admin',?)",
        )
        .run(
          domainId,
          email,
          name,
          hash,
          config.defaultQuotaBytes,
        ).lastInsertRowid;
      audit(email, "system.setup", { domain });
      return db.prepare("SELECT * FROM users WHERE id=?").get(id);
    });
    if (!managementOnly) configureFirstMailDomain(db, config, domain);
    res.status(201).json({
      ...login(res, user),
      domainId: managementOnly ? null : user.domain_id,
    });
  });
  router.post(
    ["/auth/login", "/auth/webmail/login"],
    authLimit,
    async (req, res) => {
      const user = db.prepare("SELECT * FROM users WHERE email=?").get(
        String(req.body.email || "")
          .trim()
          .toLowerCase(),
      );
      const valid = await verifyPassword(
        req.body.password,
        user?.password_hash,
      );
      const current = user && mail.activeUser(user.id);
      if (!valid || !current || current.password_hash !== user.password_hash)
        throw new AppError("账号或密码错误，或账号已停用", 401);
      const portal =
        req.authPortal === "client" ||
        /^\/auth\/webmail\/login\/?$/i.test(req.path)
          ? "client"
          : "admin";
      if (portal === "client" && !current.email.includes("@"))
        throw new AppError(
          "此入口仅供邮箱账号登录，请使用完整邮箱地址和邮箱密码",
          403,
        );
      if (portal === "admin" && current.role !== "admin")
        throw new AppError("此入口仅供管理员登录，请使用客户端", 403);
      audit(current.email, "auth.login", { portal });
      res.json(login(res, current, portal));
    },
  );
  router.get("/auth/me", auth, (req, res) =>
    res.json({
      user: { ...publicUser(req.user), ...userPayload(db, req.user) },
      csrfToken: req.session.csrf_token,
      license: { required: false, valid: true, mode: "none", expiresAt: null },
    }),
  );
  router.get("/auth/mail-client", auth, (req, res) => {
    if (!req.user.email.includes("@"))
      throw new AppError("请使用完整邮箱地址登录", 403);
    const hostname = mailHostnameConfigured(config)
      ? config.mailHostname
      : new URL(config.publicUrl).hostname;
    res.json({
      hostname,
      username: req.user.display_email || req.user.email,
      ...(req.user.email === config.plaintextMailbox
        ? {
            plaintext: {
              hostname,
              imapPort: config.imapPort,
              smtpPort: config.smtpPort,
            },
          }
        : {}),
      imapsPort: config.imapsPort,
      pop3sPort: config.pop3sPort,
      smtpsPort: config.smtpsPort,
      submissionPort: config.tls.cert ? config.submissionPort : 0,
    });
  });
  router.post("/auth/logout", auth, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
      req.session.token_hash,
    );
    res.setHeader("Set-Cookie", sessionCookie("", req.authPortal));
    res.json({ ok: true });
  });
  router.post("/auth/password", auth, authLimit, async (req, res) => {
    const previousHash = req.user.password_hash;
    if (
      !(await verifyPassword(req.body.currentPassword, req.user.password_hash))
    )
      throw new AppError("当前密码错误", 403);
    const hash = await hashPassword(req.body.password);
    transaction(() => {
      freshPersonal(req);
      if (req.user.password_hash !== previousHash)
        throw new AppError("密码已被修改，请重新登录后操作", 409);
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
        hash,
        req.user.id,
      );
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.id);
      audit(req.user.email, "auth.password");
    });
    res.json(login(res, req.user, req.authPortal));
  });
  router.get("/mailbox", auth, (req, res) => {
    const counts = db
      .prepare(
        "SELECT folder,count(*) AS total,sum(CASE WHEN is_read=0 THEN 1 ELSE 0 END) AS unread FROM messages WHERE owner_id=? GROUP BY folder",
      )
      .all(req.user.id);
    res.json({
      counts,
      usedBytes: mail.usage(req.user.id),
      quotaBytes: req.user.quota_bytes,
      relayConfigured: Boolean(config.relay),
      outboundMode: mail.outboundMode,
    });
  });
  // Guard every admin URL, including message and attachment routes registered below.
  router.use("/admin", auth, admin);
  router.get("/messages", auth, (req, res) => res.json(listMessages(req)));
  const messageRoutes = ["/messages/:id", "/admin/messages/:id"];
  router.get(messageRoutes, auth, (req, res) => {
    const adminView = req.path.startsWith("/admin/");
    if (adminView && req.user.role !== "admin")
      throw new AppError("仅管理员可访问", 403);
    const message = ownedMessage(req, req.params.id, adminView);
    const markRead =
      !isClientManager(req.user) ||
      effectiveCapabilities(req.user).includes("mail.update");
    if (markRead)
      db.prepare("UPDATE messages SET is_read=1 WHERE id=?").run(message.id);
    const { raw, ...safe } = message;
    res.json({
      ...decode(safe),
      is_read: markRead ? 1 : message.is_read,
      attachments: db
        .prepare(
          "SELECT id,filename,content_type,size FROM attachments WHERE message_id=?",
        )
        .all(message.id),
    });
  });
  router.patch(messageRoutes, auth, (req, res) => {
    const message = ownedMessage(
      req,
      req.params.id,
      req.path.startsWith("/admin/"),
    );
    const updates = [];
    const values = [];
    for (const [field, key] of [
      ["is_read", "read"],
      ["starred", "starred"],
    ])
      if (typeof req.body[key] === "boolean") {
        updates.push(`${field}=?`);
        values.push(req.body[key] ? 1 : 0);
      }
    if (req.body.folder) {
      if (
        !folders.includes(req.body.folder) ||
        ["drafts", "sent"].includes(req.body.folder)
      )
        throw new AppError("移动目标无效");
      updates.push("folder=?", "previous_folder=?", "trashed_at=?");
      values.push(
        req.body.folder,
        message.folder,
        req.body.folder === "trash" ? new Date().toISOString() : null,
      );
    }
    if (!updates.length) throw new AppError("没有可更新的字段");
    db.prepare(`UPDATE messages SET ${updates.join(",")} WHERE id=?`).run(
      ...values,
      message.id,
    );
    res.json({ ok: true });
  });
  router.delete(messageRoutes, auth, (req, res) => {
    const message = ownedMessage(
      req,
      req.params.id,
      req.path.startsWith("/admin/"),
    );
    if (message.folder !== "trash" && message.folder !== "drafts")
      throw new AppError("请先把邮件移入垃圾箱");
    db.prepare("DELETE FROM messages WHERE id=?").run(message.id);
    res.json({ ok: true });
  });
  router.post("/messages/:id/restore", auth, (req, res) => {
    const message = ownedMessage(req, req.params.id);
    const target =
      folders.includes(message.previous_folder) &&
      message.previous_folder !== "trash"
        ? message.previous_folder
        : "inbox";
    db.prepare(
      "UPDATE messages SET folder=?,previous_folder=NULL,trashed_at=NULL WHERE id=?",
    ).run(target, message.id);
    res.json({ ok: true });
  });
  router.get(
    ["/attachments/:id", "/admin/attachments/:id"],
    auth,
    (req, res) => {
      const a = db
        .prepare(
          "SELECT a.*,m.owner_id FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=?",
        )
        .get(idValue(req.params.id));
      if (
        !a ||
        (a.owner_id !== req.user.id &&
          !(req.path.startsWith("/admin/") && req.user.role === "admin"))
      )
        throw new AppError("附件不存在", 404);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      );
      res.send(Buffer.from(a.content));
    },
  );
  router.get(
    ["/messages/:id/raw", "/admin/messages/:id/raw"],
    auth,
    (req, res) => {
      const message = ownedMessage(
        req,
        req.params.id,
        req.path.startsWith("/admin/"),
        true,
      );
      res
        .type("message/rfc822")
        .attachment(`message-${message.id}.eml`)
        .send(Buffer.from(message.raw || ""));
    },
  );
  router.post("/send", auth, sendLimit, async (req, res) =>
    res
      .status(201)
      .json(
        await mail.send(req.user, req.body, () =>
          freshPersonal(req, "mail.send"),
        ),
      ),
  );
  router.post("/drafts", auth, async (req, res) =>
    res
      .status(201)
      .json(
        await mail.saveDraft(req.user, req.body, () =>
          freshPersonal(req, "mail.send"),
        ),
      ),
  );
  router.get("/drafts/:id/attachments", auth, (req, res) => {
    const m = ownedMessage(req, req.params.id);
    if (m.folder !== "drafts") throw new AppError("草稿不存在", 404);
    res.json({
      items: db
        .prepare("SELECT filename,content FROM attachments WHERE message_id=?")
        .all(m.id)
        .map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content).toString("base64"),
        })),
    });
  });

  const adminRouter = express.Router();
  router.use("/manage", auth, (req, res, next) => {
    if (req.authPortal !== "client" || !isClientManager(req.user))
      throw new AppError("尚未分配客户端域名管理权限", 403);
    if (
      !/^\/(?:accounts|account-options|domains|domain-options|forwards|messages|attachments|send|bulk-send)(?:[/?]|$)/i.test(
        req.url,
      )
    )
      throw new AppError("客户端管理接口不存在", 404);
    featureGate(db, { path: "/admin/manage" + req.path });
    const original = req.url;
    req.url = "/manage" + req.url;
    adminRouter.handle(req, res, (error) => {
      req.url = original;
      next(error);
    });
  });
  router.use("/admin", auth, admin, adminRouter);
  adminRouter.get("/mail-settings", (_req, res) =>
    res.json({
      hostname: mailHostnameConfigured(config) ? config.mailHostname : "",
      configured: mailHostnameConfigured(config),
    }),
  );
  adminRouter.put("/mail-settings", (req, res) => {
    const result = saveMailHostname(db, config, req.body.hostname);
    audit(req.user.email, "mail.hostname", result);
    res.json(result);
  });
  adminRouter.get("/overview", (_req, res) => {
    const count = (sql) => db.prepare(sql).get().n;
    const days = db
      .prepare(
        "SELECT substr(created_at,1,10) AS day,sum(CASE WHEN folder='inbox' THEN 1 ELSE 0 END) AS received,sum(CASE WHEN folder='sent' THEN 1 ELSE 0 END) AS sent FROM messages WHERE created_at>=strftime('%Y-%m-%dT00:00:00Z','now','-6 days') GROUP BY day ORDER BY day",
      )
      .all();
    res.json({
      users: count("SELECT count(*) n FROM users WHERE instr(email,'@')>0"),
      domains: count("SELECT count(*) n FROM domains WHERE name<>''"),
      received: count("SELECT count(*) n FROM messages WHERE folder='inbox'"),
      sent: count("SELECT count(*) n FROM messages WHERE folder='sent'"),
      queued: count(
        "SELECT count(*) n FROM delivery_jobs WHERE state IN ('queued','sending')",
      ),
      failed: count(
        "SELECT count(*) n FROM delivery_jobs WHERE state='failed'",
      ),
      storageBytes: count("SELECT coalesce(sum(size),0) n FROM messages"),
      days,
      recent: db
        .prepare(
          "SELECT id,actor,action,detail,created_at FROM audit_logs ORDER BY id DESC LIMIT 8",
        )
        .all(),
    });
  });
  adminRouter.get("/messages", (req, res) => res.json(listMessages(req, true)));
  adminRouter.get("/users", (_req, res) =>
    res.json({
      items: db
        .prepare(
          `SELECT u.id,u.email,u.display_email,u.name,u.role,u.active,u.quota_bytes,u.created_at,d.name AS domain,coalesce((SELECT sum(size) FROM messages m WHERE m.owner_id=u.id),0) AS used_bytes FROM users u JOIN domains d ON d.id=u.domain_id WHERE d.name<>'' ORDER BY u.id DESC`,
        )
        .all(),
    }),
  );
  async function prepareUser(entry, fallbackDomain) {
    const email = emailAddress(
      entry.email || `${entry.local}@${fallbackDomain}`,
    );
    const domain = db
      .prepare("SELECT * FROM domains WHERE name=? AND enabled=1")
      .get(email.split("@")[1]);
    if (!domain)
      throw new AppError(`域名不存在或已停用：${email.split("@")[1]}`);
    assertMailboxCapacity(db, domain.id);
    const password = entry.password || token(15);
    const hash = await hashPassword(password);
    return {
      email,
      displayEmail: String(entry.email || email).trim(),
      domainId: domain.id,
      name: textValue(entry.name || email.split("@")[0]),
      password,
      hash,
    };
  }
  adminRouter.post("/users", async (req, res) => {
    const entry = await prepareUser(req.body, req.body.domain);
    transaction(() => {
      freshGlobal(req);
      assertMailboxCapacity(db, entry.domainId);
      db.prepare(
        "INSERT INTO users(domain_id,email,name,password_hash,quota_bytes) VALUES(?,?,?,?,?)",
      ).run(
        entry.domainId,
        entry.email,
        entry.name,
        entry.hash,
        config.defaultQuotaBytes,
      );
      audit(req.user.email, "user.create", { email: entry.email });
    });
    res.status(201).json({ email: entry.email, password: entry.password });
  });
  adminRouter.patch("/users/:id", (req, res) => {
    const user = db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(idValue(req.params.id));
    if (!user) throw new AppError("用户不存在", 404);
    if (user.id === req.user.id && req.body.active === false)
      throw new AppError("不能停用当前管理员账号");
    const active =
      typeof req.body.active === "boolean"
        ? Number(req.body.active)
        : user.active;
    const quota =
      req.body.quotaMB === undefined
        ? user.quota_bytes
        : Number(req.body.quotaMB) * 1024 * 1024;
    if (
      !Number.isSafeInteger(quota) ||
      quota < 1024 * 1024 ||
      quota > 1024 ** 4
    )
      throw new AppError("配额无效");
    transaction(() => {
      db.prepare(
        "UPDATE users SET active=?,quota_bytes=?,name=? WHERE id=?",
      ).run(
        active,
        quota,
        req.body.name === undefined ? user.name : textValue(req.body.name),
        user.id,
      );
      if (!active)
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      audit(req.user.email, "user.update", { id: user.id, active, quota });
    });
    res.json({ ok: true });
  });
  adminRouter.post("/users/batch", async (req, res) => {
    const inputEntries =
      req.body.entries === undefined
        ? generateAccounts(req.body, (email) =>
            Boolean(
              db.prepare("SELECT id FROM users WHERE email=?").get(email),
            ),
          )
        : req.body.entries;
    if (
      !Array.isArray(inputEntries) ||
      inputEntries.length < 1 ||
      inputEntries.length > 100
    )
      throw new AppError("一次可注册 1–100 个账号");
    const entries = await mapLimit(inputEntries, 4, (e) =>
      prepareUser(e, req.body.domain),
    );
    if (new Set(entries.map((e) => e.email)).size !== entries.length)
      throw new AppError("存在重复邮箱");
    transaction(() => {
      const counts = new Map();
      freshGlobal(req);
      for (const entry of entries)
        counts.set(entry.domainId, (counts.get(entry.domainId) || 0) + 1);
      for (const [id, count] of counts) assertMailboxCapacity(db, id, count);
      for (const e of entries)
        db.prepare(
          "INSERT INTO users(domain_id,email,display_email,name,password_hash,quota_bytes) VALUES(?,?,?,?,?,?)",
        ).run(
          e.domainId,
          e.email,
          e.displayEmail,
          e.name,
          e.hash,
          config.defaultQuotaBytes,
        );
      audit(req.user.email, "user.batch_create", { count: entries.length });
    });
    res.status(201).json({
      items: entries.map((e) => ({
        email: e.displayEmail,
        password: e.password,
      })),
    });
  });
  adminRouter.post("/users/passwords", async (req, res) => {
    const emails = recipients(req.body.emails, true);
    if (req.body.password) passwordValid(req.body.password);
    const entries = await mapLimit(emails, 4, async (email) => {
      const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
      if (!user) throw new AppError(`邮箱不存在：${email}`);
      const password = req.body.password || token(15);
      return { user, password, hash: await hashPassword(password) };
    });
    transaction(() => {
      freshGlobal(req);
      for (const e of entries) {
        db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
          e.hash,
          e.user.id,
        );
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(e.user.id);
      }
      audit(req.user.email, "user.batch_password", { count: entries.length });
    });
    const own = entries.find((e) => e.user.id === req.user.id);
    res.json({
      items: entries.map((e) => ({
        email: e.user.email,
        password: e.password,
      })),
      ...(own ? login(res, req.user) : {}),
    });
  });
  adminRouter.post("/bulk-send", sendLimit, async (req, res) => {
    const emails = recipients(req.body.recipients, true);
    const results = [];
    // Each recipient gets an individual message and cannot see the other addresses.
    for (const email of emails) {
      try {
        const result = await mail.send(
          freshGlobal(req),
          {
            ...req.body,
            to: [email],
            cc: [],
            bcc: [],
          },
          () => freshGlobal(req),
        );
        results.push({ email, id: result.id, ok: true });
      } catch (error) {
        results.push({ email, ok: false, error: error.message });
      }
    }
    audit(req.user.email, "mail.bulk_send", {
      count: emails.length,
      succeeded: results.filter((r) => r.ok).length,
    });
    res.json({ items: results });
  });
  adminRouter.get("/domains", (_req, res) =>
    res.json({
      items: db
        .prepare(
          "SELECT d.*,(SELECT count(*) FROM users u WHERE u.domain_id=d.id) AS user_count FROM domains d WHERE d.name<>'' ORDER BY id DESC",
        )
        .all()
        .map((row) => ({
          ...row,
          mailbox_count: row.user_count,
          mailbox_remaining:
            row.mailbox_limit === null
              ? null
              : Math.max(0, row.mailbox_limit - row.user_count),
        })),
    }),
  );
  adminRouter.post("/domains", async (req, res) => {
    const name = domainName(req.body.name);
    const limit = normalizeMailboxLimit(req.body.mailboxLimit);
    const key = await generateDomainKey(config, name);
    const id = transaction(() => {
      freshGlobal(req);
      const id = Number(
        db
          .prepare("INSERT INTO domains(name,mailbox_limit) VALUES(?,?)")
          .run(name, limit).lastInsertRowid,
      );
      saveDomainKey(db, id, key);
      audit(req.user.email, "domain.create", { name, mailboxLimit: limit });
      return id;
    });
    configureFirstMailDomain(db, config, name);
    res.status(201).json({ ok: true, id, name });
  });
  function domainPlan(req, input) {
    const domain = db
      .prepare("SELECT name FROM domains WHERE id=? AND name<>''")
      .get(idValue(req.params.id));
    if (!domain) throw new AppError("域名不存在", 404);
    const key = db
      .prepare("SELECT selector,private_key FROM domain_keys WHERE domain_id=?")
      .get(idValue(req.params.id));
    return dnsPlan(
      domain.name,
      config,
      input,
      key
        ? {
            domainName: domain.name,
            keySelector: key.selector,
            privateKey: key.private_key,
          }
        : null,
    );
  }
  adminRouter.get("/domains/:id/dns", (req, res) =>
    res.json(domainPlan(req, req.query)),
  );
  const dnsLimit = rateLimit({
    windowMs: 60000,
    limit: 10,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "DNS 检测过于频繁，请稍后重试" },
  });
  adminRouter.post("/domains/:id/dns/check", dnsLimit, async (req, res) =>
    res.json(
      await checkDnsPlan(domainPlan(req, req.body), createDnsResolver(config)),
    ),
  );
  adminRouter.patch("/domains/:id", (req, res) => {
    const id = idValue(req.params.id);
    const row = db
      .prepare("SELECT * FROM domains WHERE id=? AND name<>''")
      .get(id);
    if (!row) throw new AppError("域名不存在", 404);
    if (req.body.enabled !== undefined && typeof req.body.enabled !== "boolean")
      throw new AppError("状态无效");
    const enabled = req.body.enabled ?? Boolean(row.enabled);
    if (
      !enabled &&
      (id === req.user.domain_id ||
        db
          .prepare(
            "SELECT id FROM users WHERE domain_id=? AND role='admin' AND admin_scope='global' LIMIT 1",
          )
          .get(id))
    )
      throw new AppError("不能停用包含全局管理员的域名");
    const limit = normalizeMailboxLimit(
      req.body.mailboxLimit,
      row.mailbox_limit,
    );
    transaction(() => {
      assertMailboxLimit(db, id, limit);
      db.prepare("UPDATE domains SET enabled=?,mailbox_limit=? WHERE id=?").run(
        Number(enabled),
        limit,
        id,
      );
      if (!enabled)
        db.prepare(
          "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE domain_id=?)",
        ).run(id);
      audit(req.user.email, "domain.update", {
        id,
        enabled,
        mailboxLimit: limit,
      });
    });
    res.json({ ok: true });
  });
  adminRouter.delete("/domains/:id", (req, res) => {
    const id = idValue(req.params.id);
    if (db.prepare("SELECT id FROM users WHERE domain_id=? LIMIT 1").get(id))
      throw new AppError("域名下仍有邮箱，不能删除");
    db.prepare("DELETE FROM domains WHERE id=?").run(id);
    audit(req.user.email, "domain.delete", { id });
    res.json({ ok: true });
  });
  adminRouter.get("/forwards", (_req, res) =>
    res.json({
      items: db
        .prepare(
          "SELECT f.*,u.email FROM forwards f JOIN users u ON u.id=f.user_id ORDER BY id DESC",
        )
        .all(),
    }),
  );
  adminRouter.post("/forwards", (req, res) => {
    const email = emailAddress(req.body.email);
    const user = mail.localUser(email);
    if (!user) throw new AppError("来源邮箱不存在或已停用");
    const target = emailAddress(req.body.target);
    if (target === email) throw new AppError("不能转发给自己");
    if (!mail.acceptsRecipient(target) && mail.isLocalDomain(target))
      throw new AppError("目标本地邮箱不存在或已停用");
    if (!mail.isLocalDomain(target) && mail.outboundMode === "local")
      throw new AppError("外部转发需要先启用外部投递");
    transaction(() => {
      db.prepare(
        "INSERT INTO forwards(user_id,target,keep_copy) VALUES(?,?,?)",
      ).run(user.id, target, req.body.keepCopy === false ? 0 : 1);
      assertForwardGraph(db);
      audit(req.user.email, "forward.create", { email, target });
    });
    res.status(201).json({ ok: true });
  });
  adminRouter.delete("/forwards/:id", (req, res) => {
    db.prepare("DELETE FROM forwards WHERE id=?").run(idValue(req.params.id));
    audit(req.user.email, "forward.delete", { id: req.params.id });
    res.json({ ok: true });
  });
  mountCodeRoutes(router, adminRouter, store, codeService);
  mountManagementRoutes(
    router,
    adminRouter,
    store,
    mail,
    config,
    auth,
  );
  const closeTempMail = mountTempMailRoutes(router, adminRouter, store, config);
  const closePlatform = mountPlatformRoutes(
    router,
    adminRouter,
    store,
    config,
    auth,
    responseCache,
  );
  mountConnectionRoutes(adminRouter, store, config);
  adminRouter.get("/codes", async (req, res) =>
    res.json(await codeService.list(req.query.email)),
  );
  adminRouter.get("/api-keys", (_req, res) =>
    res.json({
      items: db
        .prepare(
          "SELECT id,name,prefix,scopes,policy_json,created_at,last_used_at FROM api_keys ORDER BY id DESC",
        )
        .all()
        .map(({ policy_json, ...k }) => ({
          ...k,
          scopes: JSON.parse(k.scopes),
          policy: JSON.parse(policy_json),
        })),
    }),
  );
  adminRouter.post("/api-keys", (req, res) => {
    const name = textValue(req.body.name);
    if (!name) throw new AppError("请输入密钥名称");
    const scopes = req.body.scopes;
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some(
        (s) =>
          !["mail:send", "mail:read", "codes:read", "management"].includes(s),
      )
    )
      throw new AppError("API 权限范围无效");
    const secret = `po_${token()}`;
    const policy = sendPolicy(req.body.policy);
    const id = db
      .prepare(
        "INSERT INTO api_keys(user_id,name,prefix,token_hash,scopes,policy_json) VALUES(?,?,?,?,?,?)",
      )
      .run(
        req.user.id,
        name,
        secret.slice(0, 10),
        digest(secret),
        JSON.stringify(scopes),
        JSON.stringify(policy),
      ).lastInsertRowid;
    audit(req.user.email, "api_key.create", { name, scopes });
    res.status(201).json({ id: Number(id), token: secret });
  });
  adminRouter.patch("/api-keys/:id", (req, res) => {
    const id = idValue(req.params.id),
      old = db.prepare("SELECT * FROM api_keys WHERE id=?").get(id);
    if (!old) throw new AppError("API密钥不存在", 404);
    const policy = sendPolicy(req.body.policy, JSON.parse(old.policy_json));
    db.prepare("UPDATE api_keys SET policy_json=?,name=? WHERE id=?").run(
      JSON.stringify(policy),
      textValue(req.body.name ?? old.name),
      id,
    );
    audit(req.user.email, "api_key.update", { id });
    res.json({ ok: true, policy });
  });
  adminRouter.delete("/api-keys/:id", (req, res) => {
    db.prepare("DELETE FROM api_keys WHERE id=?").run(idValue(req.params.id));
    audit(req.user.email, "api_key.revoke", { id: req.params.id });
    res.json({ ok: true });
  });
  adminRouter.get("/webhooks", (_req, res) =>
    res.json({
      items: db
        .prepare(
          "SELECT id,name,url,enabled,created_at FROM webhooks ORDER BY id DESC",
        )
        .all(),
      jobs: db
        .prepare(
          "SELECT j.id,j.webhook_id,w.name,j.state,j.attempts,j.last_error,j.created_at FROM webhook_jobs j JOIN webhooks w ON w.id=j.webhook_id ORDER BY j.id DESC LIMIT 20",
        )
        .all(),
    }),
  );
  adminRouter.post("/webhooks", async (req, res) => {
    const name = textValue(req.body.name);
    await webhookTarget(req.body.url, config.webhookAllowPrivate);
    const secret = token();
    const id = db
      .prepare("INSERT INTO webhooks(name,url,secret) VALUES(?,?,?)")
      .run(name, req.body.url, secret).lastInsertRowid;
    audit(req.user.email, "webhook.create", { name });
    res.status(201).json({ id: Number(id), secret });
  });
  adminRouter.delete("/webhooks/:id", (req, res) => {
    db.prepare("DELETE FROM webhooks WHERE id=?").run(idValue(req.params.id));
    audit(req.user.email, "webhook.delete", { id: req.params.id });
    res.json({ ok: true });
  });
  adminRouter.post("/webhooks/jobs/:id/retry", (req, res) => {
    const id = idValue(req.params.id);
    if (
      !db
        .prepare(
          "UPDATE webhook_jobs SET state='queued',attempts=0,next_attempt=0 WHERE id=? AND state='failed'",
        )
        .run(id).changes
    )
      throw new AppError("只能重试失败任务");
    audit(req.user.email, "webhook.retry", { id });
    void mail.work();
    res.json({ ok: true });
  });
  adminRouter.get("/system", (_req, res) =>
    res.json({
      version: "1.4.0",
      node: process.version,
      uptime: Math.floor(process.uptime()),
      hostname: config.mailHostname,
      smtpPort: config.smtpPort,
      submissionPort: config.submissionPort,
      imapsPort: config.imapsPort,
      pop3sPort: config.pop3sPort,
      smtpsPort: config.smtpsPort,
      tls: Boolean(config.tls.cert),
      relayConfigured: Boolean(config.relay),
      relayHost: config.relay?.host || "",
      outboundMode: mail.outboundMode,
      directRequireTls: Boolean(config.directRequireTls),
      dkimBackend: config.dkimBackend || "node",
      dkim: Boolean(
        config.dkim ||
        db.prepare("SELECT domain_id FROM domain_keys LIMIT 1").get(),
      ),
      maxMessageMB: config.maxMessageBytes / 1024 ** 2,
      defaultQuotaMB: config.defaultQuotaBytes / 1024 ** 2,
      publicUrl: config.publicUrl,
      queue: db
        .prepare(
          "SELECT id,message_id,sender,recipient,state,attempts,last_error,created_at,delivered_at FROM delivery_jobs ORDER BY id DESC LIMIT 100",
        )
        .all(),
      audit: db
        .prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50")
        .all(),
    }),
  );
  adminRouter.post("/queue/:id/retry", (req, res) => {
    const id = idValue(req.params.id);
    const job = db
      .prepare("SELECT * FROM delivery_jobs WHERE id=? AND state='failed'")
      .get(id);
    if (!job) throw new AppError("只能重试失败任务");
    transaction(() => {
      db.prepare(
        "UPDATE delivery_jobs SET state='queued',attempts=0,next_attempt=0 WHERE id=?",
      ).run(id);
      if (job.message_id)
        db.prepare(
          "UPDATE messages SET delivery_status='queued' WHERE id=?",
        ).run(job.message_id);
      audit(req.user.email, "queue.retry", { id });
    });
    void mail.work();
    res.json({ ok: true });
  });
  async function apiSend(req, res) {
    const input = { ...req.body };
    if (input.content !== undefined) {
      if (input.subtype === "text") input.text = String(input.content);
      else input.html = String(input.content);
    }
    const reservation = checkSendPolicy(
      store,
      req.apiKey,
      req.ip,
      input,
      req.user.email,
    );
    try {
      const sender = mail.localUser(reservation.from);
      if (!sender || sender.is_temporary)
        throw new AppError("发件账号不存在或已停用");
      res
        .status(201)
        .json(await mail.send(sender, input, () => freshGlobal(req)));
    } catch (error) {
      reservation.refund();
      throw error;
    }
  }
  router.post("/v1/send", scoped("mail:send"), sendLimit, apiSend);
  router.post("/send_mail", scoped("mail:send"), sendLimit, apiSend);
  router.get("/v1/messages", scoped("mail:read"), (req, res) =>
    res.json(listMessages(req, true)),
  );
  router.get("/v1/codes", scoped("codes:read"), async (req, res) =>
    res.json(await codeService.list(req.query.email)),
  );
  router.use("/v1/manage", scoped("management"), (req, res, next) => {
    if (
      !/^\/(?:accounts|domains|forwards|messages|attachments|send|bulk-send)(?:[/?]|$)/.test(
        req.url,
      )
    )
      throw new AppError("管理API接口不存在", 404);
    featureGate(db, { path: "/admin/manage" + req.path });
    const original = req.url;
    req.url = "/manage" + req.url;
    adminRouter.handle(req, res, (error) => {
      req.url = original;
      next(error);
    });
  });
  router.use((_req, _res) => {
    throw new AppError("接口不存在", 404);
  });
  return {
    close() {
      closeTempMail();
      closePlatform();
    },
  };
}
