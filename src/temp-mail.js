import rateLimit from "express-rate-limit";
import {
  AppError,
  token,
  digest,
  equal,
  hashPassword,
  verifyPassword,
  textValue,
  idValue,
} from "./security.js";
import { randomString } from "./account-generator.js";
import { assertMailboxCapacity } from "./domain-quota.js";
import {
  getSetting,
  putSetting,
  integer,
  bool,
  domainList,
} from "./settings.js";

const defaults = {
  enabled: false,
  lifetimeMinutes: 60,
  dailyIpLimit: 5,
  prefix: "temp",
  suffixLength: 8,
  mailSaveDays: 7,
  domains: [],
  backgroundColor: "#edf3ff",
};
const safeColor = (value) => /^#[0-9a-f]{6}$/i.test(value);
export function createTempMailService(store, config) {
  const { db, transaction } = store;
  const settings = () => getSetting(db, "temp_mail", defaults);
  const available = () =>
    db
      .prepare(
        "SELECT name FROM domains WHERE enabled=1 AND name<>'' ORDER BY name",
      )
      .all()
      .map((d) => d.name);
  function domains(input, fallback) {
    const result = domainList(input, fallback);
    const live = available();
    if (result.some((d) => !live.includes(d)))
      throw new AppError("请选择已启用的邮箱域名");
    return result;
  }
  function pageInput(input, old = {}) {
    const options = settings(),
      name = textValue(input.name ?? old.name ?? "", 80);
    if (!name) throw new AppError("请填写页面名称");
    const prefix = textValue(input.prefix ?? old.prefix ?? options.prefix, 24);
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(prefix))
      throw new AppError("前缀需为1–24位小写字母、数字、_或-，以字母开头");
    const selected = domains(input.domains, old.domains || options.domains);
    if (!selected.length) throw new AppError("请至少选择一个域名");
    if (selected.some((d) => !options.domains.includes(d)))
      throw new AppError("页面域名需位于临时邮箱可用域名范围内");
    return {
      name,
      prefix,
      domains: selected,
      enabled: bool(input.enabled, Boolean(old.enabled ?? true)),
      suffixLength: integer(
        input.suffixLength,
        old.suffixLength ?? options.suffixLength,
        6,
        24,
        "随机后缀长度",
      ),
      lifetimeMinutes: integer(
        input.lifetimeMinutes,
        old.lifetimeMinutes ?? options.lifetimeMinutes,
        5,
        10080,
        "邮箱存活分钟数",
      ),
      dailyIpLimit: integer(
        input.dailyIpLimit,
        old.dailyIpLimit ?? options.dailyIpLimit,
        1,
        1000,
        "单IP每日创建额度",
      ),
    };
  }
  const decode = (row) =>
    row && {
      ...row,
      domains: JSON.parse(row.domains_json),
      suffixLength: row.suffix_length,
      lifetimeMinutes: row.lifetime_minutes,
      dailyIpLimit: row.daily_ip_limit,
      requirePassword: Boolean(row.password_hash),
    };
  function load(rawToken, publicAccess = false) {
    const page = decode(
      db
        .prepare("SELECT * FROM temp_pages WHERE token=?")
        .get(String(rawToken || "")),
    );
    if (!page || (publicAccess && (!page.enabled || !settings().enabled)))
      throw new AppError("临时邮箱页面不存在或已停用", 404);
    return page;
  }
  function publicPage(page) {
    const global = settings(),
      live = available();
    return {
      name: page.name,
      token: page.token,
      domains: page.domains.filter(
        (d) => global.domains.includes(d) && live.includes(d),
      ),
      requirePassword: page.requirePassword,
      lifetimeMinutes: page.lifetimeMinutes,
      dailyIpLimit: page.dailyIpLimit,
      backgroundColor: global.backgroundColor,
    };
  }
  function session(req, res, page, create = false) {
    const cookieName = `temp_page_${page.id}`;
    const raw = req.headers.cookie?.match(
      new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`),
    )?.[1];
    const found =
      raw &&
      db
        .prepare(
          "SELECT * FROM temp_sessions WHERE token_hash=? AND page_id=? AND revision=? AND expires_at>?",
        )
        .get(digest(raw), page.id, page.revision, Date.now());
    if (found) return found;
    if (!create) throw new AppError("请先验证页面访问权限", 401);
    const secret = token(),
      hashed = digest(secret),
      expires = Date.now() + 86400000;
    db.prepare(
      "INSERT INTO temp_sessions(token_hash,page_id,revision,expires_at) VALUES(?,?,?,?)",
    ).run(hashed, page.id, page.revision, expires);
    res.append(
      "Set-Cookie",
      `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/api/temp/${page.token}; Max-Age=86400${config.secureCookies ? "; Secure" : ""}`,
    );
    return {
      token_hash: hashed,
      page_id: page.id,
      revision: page.revision,
      expires_at: expires,
    };
  }
  function mailbox(req, res, page) {
    const access = session(req, res, page),
      id = idValue(req.params.mailboxId);
    const box = db
      .prepare(
        "SELECT b.*,u.email FROM temp_mailboxes b JOIN temp_session_mailboxes g ON g.user_id=b.user_id JOIN users u ON u.id=b.user_id JOIN domains d ON d.id=u.domain_id WHERE b.id=? AND b.page_id=? AND g.session_hash=? AND b.expires_at>? AND u.active=1 AND d.enabled=1",
      )
      .get(id, page.id, access.token_hash, Date.now());
    if (!box || !publicPage(page).domains.includes(box.email.split("@")[1]))
      throw new AppError("临时邮箱不存在、未授权或已到期", 404);
    return box;
  }
  function sweep() {
    const now = Date.now();
    transaction(() => {
      db.prepare(
        "UPDATE users SET active=0 WHERE is_temporary=1 AND temporary_expires_at<=?",
      ).run(now);
      db.prepare("DELETE FROM temp_sessions WHERE expires_at<=?").run(now);
      const retention = settings().mailSaveDays;
      if (retention > 0) {
        const cutoff = now - retention * 86400000;
        db.prepare(
          "DELETE FROM users WHERE is_temporary=1 AND temporary_expires_at<? AND NOT EXISTS(SELECT 1 FROM delivery_jobs WHERE owner_id=users.id) AND NOT EXISTS(SELECT 1 FROM forwards WHERE user_id=users.id) AND NOT EXISTS(SELECT 1 FROM api_keys WHERE user_id=users.id)",
        ).run(cutoff);
      }
      db.prepare(
        "DELETE FROM temp_creation_counts WHERE day<date('now','-32 days')",
      ).run();
    });
  }
  return {
    settings,
    available,
    domains,
    pageInput,
    decode,
    load,
    publicPage,
    session,
    mailbox,
    sweep,
  };
}

export function mountTempMailRoutes(router, adminRouter, store, config) {
  const service = createTempMailService(store, config),
    { db, transaction, audit } = store;
  adminRouter.get("/temp-mail/settings", (_req, res) =>
    res.json({ ...service.settings(), availableDomains: service.available() }),
  );
  adminRouter.put("/temp-mail/settings", (req, res) => {
    const old = service.settings(),
      i = req.body;
    const prefix = textValue(i.prefix ?? old.prefix, 24);
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(prefix))
      throw new AppError("邮箱前缀无效");
    const value = {
      enabled: bool(i.enabled, old.enabled),
      domains: service.domains(i.domains, old.domains),
      prefix,
      lifetimeMinutes: integer(
        i.lifetimeMinutes,
        old.lifetimeMinutes,
        5,
        10080,
        "存活分钟数",
      ),
      dailyIpLimit: integer(
        i.dailyIpLimit,
        old.dailyIpLimit,
        1,
        1000,
        "单IP每日额度",
      ),
      suffixLength: integer(
        i.suffixLength,
        old.suffixLength,
        6,
        24,
        "随机长度",
      ),
      mailSaveDays: integer(
        i.mailSaveDays,
        old.mailSaveDays,
        0,
        365,
        "过期临时邮箱数据保留天数",
      ),
      backgroundColor: i.backgroundColor ?? old.backgroundColor,
    };
    if (!safeColor(value.backgroundColor))
      throw new AppError("背景颜色需为六位十六进制颜色");
    if (value.enabled && !value.domains.length)
      throw new AppError("启用前请至少选择一个域名");
    transaction(() => {
      putSetting(db, "temp_mail", value);
      audit(req.user.email, "temp.settings");
    });
    res.json(value);
  });
  adminRouter.get("/temp-mail/pages", (_req, res) =>
    res.json({
      items: db
        .prepare("SELECT * FROM temp_pages ORDER BY id DESC")
        .all()
        .map((row) => {
          const { password_hash, ...page } = service.decode(row);
          return page;
        }),
    }),
  );
  adminRouter.get("/temp-mail/stats", (_req, res) =>
    res.json({
      pages: db.prepare("SELECT count(*) n FROM temp_pages").get().n,
      enabledPages: db
        .prepare("SELECT count(*) n FROM temp_pages WHERE enabled=1")
        .get().n,
      activeMailboxes: db
        .prepare(
          "SELECT count(*) n FROM temp_mailboxes b JOIN users u ON u.id=b.user_id WHERE b.expires_at>? AND u.active=1",
        )
        .get(Date.now()).n,
      todayCreated: db
        .prepare(
          "SELECT coalesce(sum(count),0) n FROM temp_creation_counts WHERE day=date('now')",
        )
        .get().n,
    }),
  );
  async function savePage(req, res) {
    const old = req.params.token ? service.load(req.params.token) : null;
    if (!old && db.prepare("SELECT count(*) n FROM temp_pages").get().n >= 100)
      throw new AppError("最多创建100个临时邮箱页面");
    const value = service.pageInput(req.body, old || {});
    const requires = bool(
      req.body.requirePassword,
      old?.requirePassword || false,
    );
    let password = old?.password_hash || "";
    if (requires && req.body.password)
      password = await hashPassword(req.body.password);
    if (requires && !password) throw new AppError("请设置至少12位访问密码");
    if (!requires) password = "";
    const pageToken = old?.token || token(18);
    transaction(() => {
      if (old)
        db.prepare(
          "UPDATE temp_pages SET name=?,enabled=?,domains_json=?,prefix=?,suffix_length=?,lifetime_minutes=?,daily_ip_limit=?,password_hash=?,revision=revision+1 WHERE id=?",
        ).run(
          value.name,
          Number(value.enabled),
          JSON.stringify(value.domains),
          value.prefix,
          value.suffixLength,
          value.lifetimeMinutes,
          value.dailyIpLimit,
          password,
          old.id,
        );
      else
        db.prepare(
          "INSERT INTO temp_pages(token,name,enabled,domains_json,prefix,suffix_length,lifetime_minutes,daily_ip_limit,password_hash,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          pageToken,
          value.name,
          Number(value.enabled),
          JSON.stringify(value.domains),
          value.prefix,
          value.suffixLength,
          value.lifetimeMinutes,
          value.dailyIpLimit,
          password,
          req.user.id,
        );
      audit(req.user.email, old ? "temp.page.update" : "temp.page.create", {
        token: pageToken,
      });
    });
    res.status(old ? 200 : 201).json({ token: pageToken });
  }
  adminRouter.post("/temp-mail/pages", savePage);
  adminRouter.patch("/temp-mail/pages/:token", savePage);
  adminRouter.delete("/temp-mail/pages/:token", (req, res) => {
    const page = service.load(req.params.token);
    transaction(() => {
      db.prepare(
        "UPDATE users SET active=0,temporary_expires_at=? WHERE id IN(SELECT user_id FROM temp_mailboxes WHERE page_id=?)",
      ).run(Date.now(), page.id);
      db.prepare("DELETE FROM temp_pages WHERE id=?").run(page.id);
      audit(req.user.email, "temp.page.delete", { id: page.id });
    });
    res.json({ ok: true });
  });
  const limit = rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "临时邮箱请求过于频繁，请稍后再试" },
  });
  router.use("/temp/:pageToken", limit, (_req, res, next) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  router.get("/temp/:pageToken", (req, res) =>
    res.json(service.publicPage(service.load(req.params.pageToken, true))),
  );
  router.post("/temp/:pageToken/verify", async (req, res) => {
    const page = service.load(req.params.pageToken, true);
    if (
      page.requirePassword &&
      !(await verifyPassword(req.body.password, page.password_hash))
    )
      throw new AppError("访问密码错误", 401);
    service.session(req, res, page, true);
    res.json({ ok: true });
  });
  router.get("/temp/:pageToken/mailboxes", (req, res) => {
    const page = service.load(req.params.pageToken, true),
      grant = service.session(req, res, page);
    const items = db
      .prepare(
        "SELECT b.id,u.email,b.expires_at,b.created_at FROM temp_mailboxes b JOIN temp_session_mailboxes g ON g.user_id=b.user_id JOIN users u ON u.id=b.user_id WHERE b.page_id=? AND g.session_hash=? AND b.expires_at>? AND u.active=1 ORDER BY b.id DESC",
      )
      .all(page.id, grant.token_hash, Date.now())
      .filter((b) =>
        service.publicPage(page).domains.includes(b.email.split("@")[1]),
      );
    res.json({ items });
  });
  router.post("/temp/:pageToken/mailboxes", async (req, res) => {
    const page = service.load(req.params.pageToken, true),
      publicPage = service.publicPage(page);
    const grant = service.session(req, res, page, !page.requirePassword);
    const domain = String(req.body.domain || publicPage.domains[0] || "");
    if (!publicPage.domains.includes(domain))
      throw new AppError("该域名不在页面可用范围内", 403);
    const domainRow = db
      .prepare("SELECT id FROM domains WHERE name=? AND enabled=1")
      .get(domain);
    if (!domainRow) throw new AppError("域名不存在或已停用", 409);
    assertMailboxCapacity(db, domainRow.id);
    const hash = await hashPassword(token(32)),
      ip = digest(String(req.ip)),
      day = new Date().toISOString().slice(0, 10),
      expires = Date.now() + page.lifetimeMinutes * 60000;
    let email;
    for (let attempt = 0; attempt < 100; attempt++) {
      email = `${page.prefix}-${randomString(page.suffixLength, ["abcdefghijklmnopqrstuvwxyz", "0123456789"])}@${domain}`;
      if (!db.prepare("SELECT id FROM users WHERE email=?").get(email)) break;
      if (attempt === 99)
        throw new AppError("暂时无法分配邮箱，请稍后再试", 503);
    }
    const id = transaction(() => {
      const current = service.load(page.token, true);
      assertMailboxCapacity(db, domainRow.id);
      if (
        current.revision !== page.revision ||
        !service.publicPage(current).domains.includes(domain)
      )
        throw new AppError("页面规则已更新，请刷新重试", 409);
      const used =
        db
          .prepare(
            "SELECT count FROM temp_creation_counts WHERE page_id=? AND ip_hash=? AND day=?",
          )
          .get(page.id, ip, day)?.count || 0;
      if (used >= page.dailyIpLimit)
        throw new AppError("当前IP今日创建额度已用完", 429);
      if (
        db.prepare("SELECT count(*) n FROM users WHERE is_temporary=1").get()
          .n >= 10000
      )
        throw new AppError("临时邮箱容量已满，请稍后再试", 503);
      const user = Number(
        db
          .prepare(
            "INSERT INTO users(domain_id,email,name,password_hash,quota_bytes,is_temporary,temporary_expires_at) VALUES(?,?,?,?,?,1,?)",
          )
          .run(
            domainRow.id,
            email,
            email.split("@")[0],
            hash,
            Math.min(config.defaultQuotaBytes, 25 * 1024 * 1024),
            expires,
          ).lastInsertRowid,
      );
      const id = Number(
        db
          .prepare(
            "INSERT INTO temp_mailboxes(page_id,user_id,expires_at,ip_hash) VALUES(?,?,?,?)",
          )
          .run(page.id, user, expires, ip).lastInsertRowid,
      );
      db.prepare(
        "INSERT INTO temp_session_mailboxes(session_hash,user_id) VALUES(?,?)",
      ).run(grant.token_hash, user);
      db.prepare(
        "INSERT INTO temp_creation_counts(page_id,ip_hash,day,count) VALUES(?,?,?,1) ON CONFLICT(page_id,ip_hash,day) DO UPDATE SET count=count+1",
      ).run(page.id, ip, day);
      return id;
    });
    res.status(201).json({ id, email, expires_at: expires });
  });
  router.get("/temp/:pageToken/mailboxes/:mailboxId/messages", (req, res) => {
    const page = service.load(req.params.pageToken, true),
      box = service.mailbox(req, res, page);
    res.json({
      items: db
        .prepare(
          "SELECT id,from_email,from_name,subject,snippet,size,created_at FROM messages WHERE owner_id=? AND folder='inbox' ORDER BY id DESC LIMIT 100",
        )
        .all(box.user_id),
      expires_at: box.expires_at,
    });
  });
  function message(req, res) {
    const page = service.load(req.params.pageToken, true),
      box = service.mailbox(req, res, page);
    const row = db
      .prepare(
        "SELECT * FROM messages WHERE id=? AND owner_id=? AND folder='inbox'",
      )
      .get(idValue(req.params.messageId), box.user_id);
    if (!row) throw new AppError("邮件不存在", 404);
    return row;
  }
  router.get(
    "/temp/:pageToken/mailboxes/:mailboxId/messages/:messageId",
    (req, res) => {
      const { raw, bcc_json, owner_id, ...item } = message(req, res);
      res.json({
        ...item,
        attachments: db
          .prepare(
            "SELECT id,filename,content_type,size FROM attachments WHERE message_id=?",
          )
          .all(item.id),
      });
    },
  );
  router.get(
    "/temp/:pageToken/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId",
    (req, res) => {
      const item = message(req, res),
        attachment = db
          .prepare("SELECT * FROM attachments WHERE id=? AND message_id=?")
          .get(idValue(req.params.attachmentId), item.id);
      if (!attachment) throw new AppError("附件不存在", 404);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      );
      res
        .type("application/octet-stream")
        .send(Buffer.from(attachment.content));
    },
  );
  router.delete("/temp/:pageToken/mailboxes/:mailboxId", (req, res) => {
    const page = service.load(req.params.pageToken, true),
      box = service.mailbox(req, res, page);
    transaction(() => {
      db.prepare(
        "UPDATE users SET active=0,temporary_expires_at=? WHERE id=? AND is_temporary=1",
      ).run(Date.now(), box.user_id);
      db.prepare("UPDATE temp_mailboxes SET expires_at=? WHERE id=?").run(
        Date.now(),
        box.id,
      );
    });
    res.json({ ok: true });
  });
  service.sweep();
  const timer = setInterval(() => {
    try {
      service.sweep();
    } catch (error) {
      console.error("Temporary mailbox maintenance failed:", error.message);
    }
  }, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
