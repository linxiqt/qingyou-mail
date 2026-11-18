import { messageColumns } from "./message-columns.js";
import {
  AppError,
  emailAddress,
  domainName,
  textValue,
  idValue,
  recipients,
  hashPassword,
  token,
  publicUser,
} from "./security.js";
import { generateAccounts, randomString } from "./account-generator.js";
import {
  isGlobalAdmin,
  requireGlobal,
  requireDomain,
  scopeSql,
  userPayload,
  canManageDomains,
  isClientManager,
} from "./access.js";
import { generateDomainKey, saveDomainKey } from "./domain-keys.js";
import { configureFirstMailDomain } from "./mail-settings.js";
import { dnsPlan, checkDnsPlan } from "./dns.js";
import { createDnsResolver } from "./dns-resolver.js";
import { integer, bool } from "./settings.js";
import { cleanHtml } from "./html.js";
import { randomInt } from "node:crypto";
import rateLimit from "express-rate-limit";
import {
  capabilityCatalog,
  rolePresets,
  requireCapability,
  managerCapabilities,
  clientCapabilityIds,
} from "./admin-permissions.js";
import {
  assertMailboxCapacity,
  normalizeMailboxLimit,
  assertMailboxLimit,
} from "./domain-quota.js";
import { mapLimit } from "./async-pool.js";
import { assertForwardGraph as forwardGraph } from "./forwarding.js";

function bodyText(value, max = 1000000) {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw new AppError("正文格式无效或过长");
  return value;
}
export function deleteAccount(store, user, actor) {
  const { db } = store;
  if (user.id === actor.id) throw new AppError("不能删除当前登录账号");
  if (canManageDomains(user)) requireGlobal(actor);
  if (
    db
      .prepare(
        "SELECT id FROM delivery_jobs WHERE owner_id=? AND state='sending' LIMIT 1",
      )
      .get(user.id)
  )
    throw new AppError("该邮箱正在投递邮件，请稍后再删除", 409);
  db.prepare("DELETE FROM delivery_jobs WHERE owner_id=?").run(user.id);
  db.prepare("DELETE FROM forwards WHERE user_id=?").run(user.id);
  db.prepare("DELETE FROM api_keys WHERE user_id=?").run(user.id);
  db.prepare("UPDATE temp_pages SET created_by=? WHERE created_by=?").run(
    actor.id,
    user.id,
  );
  db.prepare("DELETE FROM users WHERE id=?").run(user.id);
}
export function mountManagementRoutes(
  router,
  adminRouter,
  store,
  mail,
  config,
  auth,
  license,
) {
  const { db, transaction, audit } = store;
  // Check again after awaits: a manager may have been disabled or revoked while
  // password hashing or message construction was in progress.
  function freshActor(req, capability) {
    const actor = mail.activeUser(req.user.id);
    if (!actor || !canManageDomains(actor))
      throw new AppError("管理权限已失效，请重新登录", 403);
    if (
      req.session &&
      !db
        .prepare("SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?")
        .get(req.session.token_hash, Date.now())
    )
      throw new AppError("登录会话已失效，请重新登录", 401);
    if (req.apiKey) {
      const current = db
        .prepare("SELECT * FROM api_keys WHERE id=? AND user_id=?")
        .get(req.apiKey.id, actor.id);
      if (
        !current ||
        current.scopes !== req.apiKey.scopes ||
        current.policy_json !== req.apiKey.policy_json ||
        !JSON.parse(current.scopes).includes("management")
      )
        throw new AppError("API Key 权限已变化，请重试", 401);
    }
    req.user = actor;
    if (capability) requireCapability(actor, capability);
    return actor;
  }
  const optionPurpose = {
    send: ["mail.send", "create"],
    read: ["mail.read", "read"],
    forward: ["forwards.write", "read"],
    "forward-catchall": ["forwards.write", "create"],
    "forward-catchall-update": ["forwards.write", "update"],
    password: ["accounts.password", "update"],
    create: ["accounts.create", "create"],
    accounts: ["accounts.read", "read"],
    catchall: ["domains.update", "update"],
  };
  adminRouter.use("/manage", (req, _res, next) => {
    const route = req.path.toLowerCase().replace(/\/+$/, ""),
      read = ["GET", "HEAD"].includes(req.method);
    let capability;
    if (["/account-options", "/domain-options"].includes(route)) {
      const purpose = optionPurpose[req.query.purpose];
      if (!purpose) throw new AppError("请选择有效的用途");
      capability = purpose[0];
    } else if (route.startsWith("/accounts")) {
      capability = read
        ? "accounts.read"
        : route === "/accounts/passwords"
          ? "accounts.password"
          : route === "/accounts/delete"
            ? "accounts.delete"
            : req.method === "PATCH"
              ? "accounts.update"
              : "accounts.create";
      if (req.body?.password && req.method === "PATCH")
        requireCapability(req.user, "accounts.password");
    } else if (route.startsWith("/domains")) {
      capability =
        read || /\/dns(?:\/check)?$/.test(route)
          ? "domains.read"
          : req.method === "DELETE"
            ? "domains.delete"
            : "domains.update";
    } else if (
      route.startsWith("/messages") ||
      route.startsWith("/attachments")
    ) {
      capability = read
        ? "mail.read"
        : req.method === "DELETE" ||
            req.body?.folder === "trash" ||
            req.body?.action === "trash"
          ? "mail.delete"
          : "mail.update";
    } else if (route.startsWith("/forwards"))
      capability = read ? "forwards.read" : "forwards.write";
    else if (["/send", "/bulk-send"].includes(route)) capability = "mail.send";
    if (!capability) throw new AppError("不支持的管理操作", 404);
    requireCapability(req.user, capability);
    next();
  });
  adminRouter.get("/permission-catalog", (req, res) => {
    requireGlobal(req.user);
    res.json({
      capabilities: capabilityCatalog,
      clientCapabilities: clientCapabilityIds,
      presets: rolePresets,
    });
  });
  adminRouter.get("/manage/domain-options", (req, res) => {
    const scope = scopeSql(
      db,
      req.user,
      "d.id",
      optionPurpose[req.query.purpose][1],
    );
    res.json({
      items: db
        .prepare(
          `SELECT d.*,(SELECT count(*) FROM users u WHERE u.domain_id=d.id) AS mailbox_count FROM domains d WHERE ${scope.sql} AND d.name<>''${req.query.purpose === "forward-catchall-update" ? "" : " AND d.enabled=1"} ORDER BY d.name LIMIT 1000`,
        )
        .all(...scope.args)
        .map((d) => ({
          ...d,
          mailbox_remaining:
            d.mailbox_limit === null
              ? null
              : Math.max(0, d.mailbox_limit - d.mailbox_count),
        })),
    });
  });
  adminRouter.get("/manage/account-options", (req, res) => {
    const scope = scopeSql(
      db,
      req.user,
      "u.domain_id",
      optionPurpose[req.query.purpose][1],
    );
    const page = integer(req.query.page, 1, 1, 100000, "页码"),
      limit = integer(req.query.limit, 100, 1, 200, "每页数量");
    const q = `%${String(req.query.q || "").slice(0, 100)}%`,
      where = `${scope.sql} AND d.name<>'' AND d.enabled=1 AND u.active=1 AND u.is_temporary=0 AND (u.email LIKE ? OR u.name LIKE ?)${isGlobalAdmin(req.user) ? "" : " AND ((u.role='user' AND u.client_manager=0) OR u.id=?)"}${req.query.domain ? " AND d.name=?" : ""}`;
    const args = [
      ...scope.args,
      q,
      q,
      ...(isGlobalAdmin(req.user) ? [] : [req.user.id]),
      ...(req.query.domain ? [domainName(req.query.domain)] : []),
    ];
    const total = db
      .prepare(
        `SELECT count(*) n FROM users u JOIN domains d ON d.id=u.domain_id WHERE ${where}`,
      )
      .get(...args).n;
    const items = db
      .prepare(
        `SELECT u.id,u.email,u.display_email,u.name,u.domain_id,u.active,d.name AS domain FROM users u JOIN domains d ON d.id=u.domain_id WHERE ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, (page - 1) * limit);
    res.json({ items, total, page, limit });
  });
  function managedUser(req, operation = "read") {
    const user = db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(idValue(req.params.id));
    if (!user || !user.email.includes("@"))
      throw new AppError("邮箱账号不存在", 404);
    requireDomain(db, req.user, user.domain_id, operation);
    if (canManageDomains(user) && !isGlobalAdmin(req.user))
      throw new AppError("只能由全局管理员管理具有管理权限的账号", 403);
    return user;
  }
  function domain(req, operation = "read") {
    const row = db
      .prepare("SELECT * FROM domains WHERE id=? AND name<>''")
      .get(idValue(req.params.id));
    if (!row) throw new AppError("域名不存在", 404);
    requireDomain(db, req.user, row.id, operation);
    return row;
  }
  adminRouter.get("/manage/accounts", (req, res) => {
    const scope = scopeSql(db, req.user, "u.domain_id"),
      q = `%${String(req.query.q || "").slice(0, 100)}%`;
    const extra =
      (req.query.domain ? " AND d.name=?" : "") +
      (isGlobalAdmin(req.user)
        ? ""
        : " AND ((u.role='user' AND u.client_manager=0) OR u.id=?)");
    const args = [
      ...scope.args,
      q,
      q,
      ...(req.query.domain ? [domainName(req.query.domain)] : []),
      ...(isGlobalAdmin(req.user) ? [] : [req.user.id]),
    ];
    const paginated =
      req.query.page !== undefined || req.query.limit !== undefined;
    const page = integer(req.query.page, 1, 1, 100000, "页码"),
      limit = paginated
        ? integer(req.query.limit, 30, 1, 100, "每页数量")
        : 5000;
    const where = `${scope.sql} AND d.name<>'' AND u.is_temporary=0 AND (u.email LIKE ? OR u.name LIKE ?)${extra}`;
    const total = db
      .prepare(
        `SELECT count(*) n FROM users u JOIN domains d ON d.id=u.domain_id WHERE ${where}`,
      )
      .get(...args).n;
    res.json({
      items: db
        .prepare(
          `SELECT page.*,coalesce((SELECT sum(size) FROM messages m WHERE m.owner_id=page.id),0) AS used_bytes FROM (SELECT u.id,u.domain_id,u.email,u.display_email,u.name,u.role,u.admin_scope,u.client_manager,u.avatar,u.note,u.active,u.quota_bytes,u.created_at,d.name AS domain FROM users u JOIN domains d ON d.id=u.domain_id WHERE ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?) page`,
        )
        .all(...args, limit, (page - 1) * limit),
      total,
      page,
      limit,
    });
  });
  async function createUsers(req, res, batch = false) {
    const input = batch
      ? req.body.entries ||
        generateAccounts(req.body, (email) =>
          Boolean(db.prepare("SELECT id FROM users WHERE email=?").get(email)),
        )
      : [req.body];
    if (
      !Array.isArray(input) ||
      input.length < 1 ||
      input.length > 100 ||
      input.some(
        (item) => !item || typeof item !== "object" || Array.isArray(item),
      )
    )
      throw new AppError("一次创建1–100个账号");
    const capacityCounts = new Map();
    for (const item of input) {
      const address = emailAddress(
        item.email || `${item.local}@${req.body.domain}`,
      );
      const domain = db
        .prepare("SELECT id FROM domains WHERE name=? AND enabled=1")
        .get(address.split("@")[1]);
      if (!domain) throw new AppError("域名不存在或已停用");
      requireDomain(db, req.user, domain.id, "create");
      capacityCounts.set(domain.id, (capacityCounts.get(domain.id) || 0) + 1);
    }
    for (const [id, count] of capacityCounts)
      assertMailboxCapacity(db, id, count);
    const entries = await mapLimit(input, 4, async (item) => {
      const email = emailAddress(
          item.email || `${item.local}@${req.body.domain}`,
        ),
        domain = db
          .prepare("SELECT id FROM domains WHERE name=? AND enabled=1")
          .get(email.split("@")[1]);
      if (!domain) throw new AppError("域名不存在或已停用");
      requireDomain(db, req.user, domain.id, "create");
      if (db.prepare("SELECT id FROM users WHERE email=?").get(email))
        throw new AppError(`邮箱已存在：${email}`, 409);
      const password = item.password || token(18),
        hash = await hashPassword(password);
      return {
        email,
        display: String(item.email || email).trim(),
        domainId: domain.id,
        name: textValue(item.name || email.split("@")[0]),
        note: textValue(item.note || "", 500),
        quota:
          integer(
            item.quotaMB,
            config.defaultQuotaBytes / 1048576,
            1,
            1048576,
            "配额MB",
          ) * 1048576,
        password,
        hash,
      };
    });
    if (new Set(entries.map((e) => e.email)).size !== entries.length)
      throw new AppError("邮箱地址重复");
    transaction(() => {
      freshActor(req, "accounts.create");
      for (const [id, count] of capacityCounts) {
        requireDomain(db, req.user, id, "create");
        if (
          !db.prepare("SELECT id FROM domains WHERE id=? AND enabled=1").get(id)
        )
          throw new AppError("域名已停用", 409);
        assertMailboxCapacity(db, id, count);
      }
      for (const e of entries)
        db.prepare(
          "INSERT INTO users(domain_id,email,display_email,name,password_hash,quota_bytes,note) VALUES(?,?,?,?,?,?,?)",
        ).run(e.domainId, e.email, e.display, e.name, e.hash, e.quota, e.note);
      audit(req.user.email, batch ? "user.batch_create" : "user.create", {
        count: entries.length,
      });
    });
    res.status(201).json({
      items: entries.map((e) => ({ email: e.display, password: e.password })),
    });
  }
  adminRouter.post("/manage/accounts", (req, res) => createUsers(req, res));
  adminRouter.post("/manage/accounts/batch", (req, res) =>
    createUsers(req, res, true),
  );
  adminRouter.patch("/manage/accounts/:id", async (req, res) => {
    const user = managedUser(req, "update");
    const active = bool(req.body.active, Boolean(user.active));
    if (user.id === req.user.id && !active)
      throw new AppError("不能停用当前账号");
    const name = textValue(req.body.name ?? user.name),
      note = textValue(req.body.note ?? user.note, 500);
    const quota =
      req.body.quotaMB === undefined
        ? user.quota_bytes
        : integer(req.body.quotaMB, 1024, 1, 1048576, "配额MB") * 1048576;
    const password = req.body.password
      ? await hashPassword(req.body.password)
      : null;
    transaction(() => {
      freshActor(req, "accounts.update");
      managedUser(req, "update");
      if (password) requireCapability(req.user, "accounts.password");
      db.prepare(
        "UPDATE users SET name=?,note=?,active=?,quota_bytes=?,password_hash=coalesce(?,password_hash) WHERE id=?",
      ).run(name, note, Number(active), quota, password, user.id);
      if (password || !active)
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      audit(req.user.email, "user.update", { id: user.id, active });
    });
    res.json({ ok: true });
  });
  adminRouter.post("/manage/accounts/delete", (req, res) => {
    requireCapability(req.user, "accounts.delete");
    if (req.body.confirm !== true)
      throw new AppError("请明确确认删除所选账号及邮件");
    if (
      !Array.isArray(req.body.ids) ||
      !req.body.ids.length ||
      req.body.ids.length > 100
    )
      throw new AppError("请选择1–100个账号");
    const ids = [...new Set(req.body.ids.map(idValue))];
    transaction(() => {
      for (const id of ids) {
        const user = managedUser({ ...req, params: { id } }, "delete");
        deleteAccount(store, user, req.user);
      }
      audit(req.user.email, "user.batch_delete", { ids });
    });
    res.json({ ok: true, count: ids.length });
  });
  adminRouter.post("/manage/accounts/passwords", async (req, res) => {
    const emails = recipients(req.body.emails, true);
    const entries = await mapLimit(emails, 4, async (email) => {
      const user = db
        .prepare("SELECT * FROM users WHERE email=? AND is_temporary=0")
        .get(email);
      if (!user) throw new AppError(`邮箱不存在：${email}`);
      requireDomain(db, req.user, user.domain_id, "update");
      if (canManageDomains(user)) requireGlobal(req.user);
      if (user.id === req.user.id)
        throw new AppError("当前登录账号请通过账号设置修改密码");
      const password =
        req.body.password ||
        randomString(integer(req.body.length, 16, 12, 64, "随机密码长度"), [
          "abcdefghijklmnopqrstuvwxyz",
          "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
          "0123456789",
          "!@#$%&*+-_=",
        ]);
      return { user, password, hash: await hashPassword(password) };
    });
    transaction(() => {
      freshActor(req, "accounts.password");
      for (const e of entries) {
        const current = managedUser(
          { ...req, params: { id: e.user.id } },
          "update",
        );
        if (current.id === req.user.id)
          throw new AppError("当前账号请通过账号设置改密");
        db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
          e.hash,
          e.user.id,
        );
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(e.user.id);
      }
      audit(req.user.email, "user.batch_password", { count: entries.length });
    });
    res.json({
      items: entries.map((e) => ({
        email: e.user.email,
        password: e.password,
      })),
    });
  });
  adminRouter.get("/manage/domains", (req, res) => {
    const scope = scopeSql(db, req.user, "d.id");
    res.json({
      items: db
        .prepare(
          `SELECT d.*,(SELECT count(*) FROM users u WHERE u.domain_id=d.id AND u.is_temporary=0) AS user_count,(SELECT count(*) FROM users u WHERE u.domain_id=d.id) AS mailbox_count,c.enabled AS catchall_enabled,u.email AS catchall_email,f.target AS catchall_target,f.enabled AS catchall_forward_enabled FROM domains d LEFT JOIN domain_catchalls c ON c.domain_id=d.id LEFT JOIN users u ON u.id=c.user_id LEFT JOIN catchall_forwards f ON f.domain_id=d.id WHERE ${scope.sql} AND d.name<>'' ORDER BY d.id DESC`,
        )
        .all(...scope.args)
        .map((row) => ({
          ...row,
          mailbox_remaining:
            row.mailbox_limit === null
              ? null
              : Math.max(0, row.mailbox_limit - row.mailbox_count),
        })),
    });
  });
  adminRouter.post("/manage/domains", async (req, res) => {
    requireGlobal(req.user);
    const mailboxLimit = normalizeMailboxLimit(req.body.mailboxLimit);
    const name = domainName(req.body.name),
      key = await generateDomainKey(config, name);
    const id = transaction(() => {
      freshActor(req);
      requireGlobal(req.user);
      const id = Number(
        db
          .prepare("INSERT INTO domains(name,mailbox_limit) VALUES(?,?)")
          .run(name, mailboxLimit).lastInsertRowid,
      );
      saveDomainKey(db, id, key);
      audit(req.user.email, "domain.create", { name, mailboxLimit });
      return id;
    });
    configureFirstMailDomain(db, config, name);
    res.status(201).json({ id, name });
  });
  adminRouter.patch("/manage/domains/:id", (req, res) => {
    const row = domain(req, "update"),
      enabled = bool(req.body.enabled, Boolean(row.enabled));
    if (req.body.mailboxLimit !== undefined) requireGlobal(req.user);
    const mailboxLimit = normalizeMailboxLimit(
      req.body.mailboxLimit,
      row.mailbox_limit,
    );
    assertMailboxLimit(db, row.id, mailboxLimit);
    if (
      !enabled &&
      (row.id === req.user.domain_id ||
        db
          .prepare(
            "SELECT id FROM users WHERE domain_id=? AND role='admin' AND admin_scope='global' LIMIT 1",
          )
          .get(row.id))
    )
      throw new AppError("不能停用包含全局管理员的域名");
    transaction(() => {
      db.prepare("UPDATE domains SET enabled=?,mailbox_limit=? WHERE id=?").run(
        Number(enabled),
        mailboxLimit,
        row.id,
      );
      if (!enabled)
        db.prepare(
          "DELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE domain_id=?)",
        ).run(row.id);
      audit(req.user.email, "domain.update", {
        id: row.id,
        enabled,
        mailboxLimit,
      });
    });
    res.json({ ok: true });
  });
  function plan(req) {
    const row = domain(req),
      key = db
        .prepare("SELECT * FROM domain_keys WHERE domain_id=?")
        .get(row.id);
    return dnsPlan(
      row.name,
      config,
      req.method === "GET" ? req.query : req.body,
      key
        ? {
            domainName: row.name,
            keySelector: key.selector,
            privateKey: key.private_key,
          }
        : null,
    );
  }
  adminRouter.get("/manage/domains/:id/dns", (req, res) => res.json(plan(req)));
  adminRouter.post("/manage/domains/:id/dns/check", async (req, res) =>
    res.json(await checkDnsPlan(plan(req), createDnsResolver(config))),
  );
  adminRouter.put("/manage/domains/:id/catchall", (req, res) => {
    const row = domain(req, "update");
    const enabled = bool(req.body.enabled, true);
    transaction(() => {
      if (!enabled)
        db.prepare("DELETE FROM domain_catchalls WHERE domain_id=?").run(
          row.id,
        );
      else {
        const user = mail.localUser(emailAddress(req.body.email));
        if (!user || user.domain_id !== row.id || user.is_temporary)
          throw new AppError("捕获目标需为该域名下已启用的永久邮箱");
        if (canManageDomains(user) && user.id !== req.user.id)
          requireGlobal(req.user);
        db.prepare("DELETE FROM catchall_forwards WHERE domain_id=?").run(
          row.id,
        );
        db.prepare(
          "INSERT INTO domain_catchalls(domain_id,user_id) VALUES(?,?) ON CONFLICT(domain_id) DO UPDATE SET user_id=excluded.user_id,enabled=1",
        ).run(row.id, user.id);
        forwardGraph(db);
      }
      audit(req.user.email, "domain.catchall", { id: row.id, enabled });
    });
    res.json({ ok: true });
  });
  adminRouter.delete("/manage/domains/:id", (req, res) => {
    const row = domain(req, "delete");
    if (
      row.id === req.user.domain_id ||
      db
        .prepare(
          "SELECT id FROM users WHERE domain_id=? AND role='admin' AND admin_scope='global' LIMIT 1",
        )
        .get(row.id)
    )
      throw new AppError("不能删除包含全局管理员的域名");
    const users = db
      .prepare("SELECT * FROM users WHERE domain_id=?")
      .all(row.id);
    if (users.length) requireCapability(req.user, "accounts.delete");
    if (
      users.length &&
      !(req.body.cascade === true && req.body.confirmDomain === row.name)
    )
      throw new AppError("请确认级联删除并输入完整域名");
    transaction(() => {
      for (const user of users) deleteAccount(store, user, req.user);
      db.prepare("DELETE FROM domains WHERE id=?").run(row.id);
      audit(req.user.email, "domain.delete", {
        name: row.name,
        mailboxes: users.length,
      });
    });
    res.json({ ok: true });
  });
  adminRouter.get("/manage/forwards", (req, res) => {
    const scope = scopeSql(db, req.user, "u.domain_id");
    const catchallScope = scopeSql(db, req.user, "f.domain_id");
    res.json({
      items: [
        ...db
          .prepare(
            `SELECT f.*,u.email,u.domain_id FROM forwards f JOIN users u ON u.id=f.user_id WHERE ${scope.sql}${isGlobalAdmin(req.user) ? "" : " AND ((u.role='user' AND u.client_manager=0) OR u.id=?)"} ORDER BY f.id DESC`,
          )
          .all(
            ...scope.args,
            ...(isGlobalAdmin(req.user) ? [] : [req.user.id]),
          ),
        ...db
          .prepare(
            `SELECT f.domain_id,'catchall:'||f.domain_id AS id,'*@'||d.name AS email,f.target,f.enabled,0 AS keep_copy,'catchall' AS kind FROM catchall_forwards f JOIN domains d ON d.id=f.domain_id WHERE ${catchallScope.sql} ORDER BY d.name`,
          )
          .all(...catchallScope.args),
      ],
    });
  });
  function catchallId(value) {
    return typeof value === "string" && value.startsWith("catchall:")
      ? idValue(value.slice(9))
      : null;
  }
  function saveCatchallForward(req, old) {
    const source = String(req.body.email || old?.email || "");
    if (!source.startsWith("*@"))
      throw new AppError("Catch-all 来源需使用 *@域名");
    const name = domainName(source.slice(2));
    const enabled = bool(req.body.enabled, Boolean(old?.enabled ?? true));
    const domain = db
      .prepare("SELECT * FROM domains WHERE name=? AND name<>''")
      .get(name);
    if (!domain || (enabled && !domain.enabled))
      throw new AppError("来源域名不存在或已停用");
    requireDomain(db, req.user, domain.id, old ? "update" : "create");
    if (old) requireDomain(db, req.user, old.domain_id, "update");
    const target = emailAddress(req.body.target || old?.target);
    if (
      db
        .prepare("SELECT 1 FROM catchall_forwards WHERE domain_id=?")
        .get(domain.id) &&
      old?.domain_id !== domain.id
    )
      throw new AppError("该域名已有 Catch-all 转发规则，请编辑现有规则", 409);
    if (enabled && mail.isLocalDomain(target) && !mail.acceptsRecipient(target))
      throw new AppError("目标本地邮箱不存在或已停用");
    if (enabled && !mail.isLocalDomain(target) && mail.outboundMode === "local")
      throw new AppError("外部投递尚未启用");
    if (
      enabled &&
      db
        .prepare("SELECT 1 FROM domain_catchalls WHERE domain_id=?")
        .get(domain.id)
    )
      requireDomain(db, req.user, domain.id, "update");
    if (old)
      db.prepare("DELETE FROM catchall_forwards WHERE domain_id=?").run(
        old.domain_id,
      );
    db.prepare(
      "INSERT INTO catchall_forwards(domain_id,target,enabled,created_by) VALUES(?,?,?,?)",
    ).run(domain.id, target, Number(enabled), req.user.id);
    if (enabled)
      db.prepare("DELETE FROM domain_catchalls WHERE domain_id=?").run(
        domain.id,
      );
  }
  function saveForward(req, old) {
    const wildcard = String(req.body.email || old?.email || "").startsWith(
      "*@",
    );
    if (old && wildcard !== (old.kind === "catchall"))
      throw new AppError("不能修改规则类型，请删除后重新创建");
    if (wildcard) return saveCatchallForward(req, old);
    const email = emailAddress(req.body.email || old?.email),
      user = mail.localUser(email),
      target = emailAddress(req.body.target || old?.target);
    if (!user || user.is_temporary)
      throw new AppError("来源需为已启用的永久邮箱");
    if (canManageDomains(user) && user.id !== req.user.id)
      requireGlobal(req.user);
    if (canManageDomains(old) && old.user_id !== req.user.id)
      requireGlobal(req.user);
    requireDomain(db, req.user, user.domain_id, old ? "update" : "create");
    if (old) requireDomain(db, req.user, old.domain_id, "update");
    const enabled = bool(req.body.enabled, Boolean(old?.enabled ?? true)),
      keep = bool(req.body.keepCopy, Boolean(old?.keep_copy ?? true));
    if (email === target) throw new AppError("不能转发给自己");
    if (mail.isLocalDomain(target) && !mail.acceptsRecipient(target))
      throw new AppError("目标本地邮箱不存在或已停用");
    if (!mail.isLocalDomain(target) && mail.outboundMode === "local")
      throw new AppError("外部投递尚未启用");
    if (old)
      db.prepare(
        "UPDATE forwards SET user_id=?,target=?,keep_copy=?,enabled=? WHERE id=?",
      ).run(user.id, target, Number(keep), Number(enabled), old.id);
    else
      db.prepare(
        "INSERT INTO forwards(user_id,target,keep_copy,enabled) VALUES(?,?,?,?)",
      ).run(user.id, target, Number(keep), Number(enabled));
  }
  adminRouter.post("/manage/forwards", (req, res) => {
    transaction(() => {
      saveForward(req);
      forwardGraph(db);
      audit(req.user.email, "forward.create");
    });
    res.status(201).json({ ok: true });
  });
  adminRouter.post("/manage/forwards/batch", (req, res) => {
    const emails = recipients(req.body.emails, true);
    transaction(() => {
      for (const email of emails)
        saveForward({ ...req, body: { ...req.body, email } });
      forwardGraph(db);
      audit(req.user.email, "forward.batch_create", { count: emails.length });
    });
    res.status(201).json({ ok: true, count: emails.length });
  });
  adminRouter.patch("/manage/forwards/:id", (req, res) => {
    const domainId = catchallId(req.params.id);
    const old = domainId
      ? db
          .prepare(
            "SELECT f.*, 'catchall' AS kind,'*@'||d.name AS email FROM catchall_forwards f JOIN domains d ON d.id=f.domain_id WHERE f.domain_id=?",
          )
          .get(domainId)
      : db
          .prepare(
            "SELECT f.*,u.email,u.domain_id,u.role,u.client_manager FROM forwards f JOIN users u ON u.id=f.user_id WHERE f.id=?",
          )
          .get(idValue(req.params.id));
    if (!old) throw new AppError("转发规则不存在", 404);
    transaction(() => {
      saveForward(req, old);
      forwardGraph(db);
      audit(req.user.email, "forward.update", { id: req.params.id });
    });
    res.json({ ok: true });
  });
  adminRouter.post("/manage/forwards/delete", (req, res) => {
    if (
      !Array.isArray(req.body.ids) ||
      !req.body.ids.length ||
      req.body.ids.length > 100
    )
      throw new AppError("请选择1–100条规则");
    transaction(() => {
      for (const raw of new Set(req.body.ids)) {
        const domainId = catchallId(raw);
        if (domainId) {
          requireDomain(db, req.user, domainId, "delete");
          if (
            !db
              .prepare("DELETE FROM catchall_forwards WHERE domain_id=?")
              .run(domainId).changes
          )
            throw new AppError("规则不存在", 404);
          continue;
        }
        const id = idValue(raw),
          rule = db
            .prepare(
              "SELECT u.domain_id,u.role,u.client_manager,u.id AS user_id FROM forwards f JOIN users u ON u.id=f.user_id WHERE f.id=?",
            )
            .get(id);
        if (!rule) throw new AppError("规则不存在", 404);
        if (canManageDomains(rule) && rule.user_id !== req.user.id)
          requireGlobal(req.user);
        requireDomain(db, req.user, rule.domain_id, "delete");
        db.prepare("DELETE FROM forwards WHERE id=?").run(id);
      }
      audit(req.user.email, "forward.batch_delete", {
        count: req.body.ids.length,
      });
    });
    res.json({ ok: true });
  });
  adminRouter.get("/managers", (req, res) => {
    requireGlobal(req.user);
    res.json({
      items: db
        .prepare(
          "SELECT * FROM users WHERE (role='admin' OR client_manager=1) AND is_temporary=0 ORDER BY id",
        )
        .all()
        .map((user) => ({ ...publicUser(user), ...userPayload(db, user) })),
    });
  });
  async function saveManager(req, res) {
    requireGlobal(req.user);
    const old = req.params.id
      ? db
          .prepare("SELECT * FROM users WHERE id=? AND is_temporary=0")
          .get(idValue(req.params.id))
      : null;
    if (req.params.id && !old) throw new AppError("管理员账号不存在", 404);
    const scope =
      req.body.scope ??
      (old
        ? isClientManager(old)
          ? "client"
          : old.role === "admin"
            ? old.admin_scope
            : "user"
        : "client");
    if (!["global", "scoped", "client", "user"].includes(scope))
      throw new AppError("账号权限类型无效");
    if (old && !old.email.includes("@") && scope !== "global")
      throw new AppError("独立管理账号需保留全局管理员权限");
    if (
      old?.id === req.user.id &&
      (scope !== "global" || req.body.active === false)
    )
      throw new AppError("不能降低当前全局管理员权限或停用自身");
    if (old?.id === req.user.id && req.body.password)
      throw new AppError("当前登录账号请通过账号设置修改密码");
    const permissionInput = { ...req.body };
    if (
      scope === "client" &&
      !isClientManager(old) &&
      permissionInput.rolePreset === undefined &&
      permissionInput.capabilities === undefined
    )
      permissionInput.rolePreset = "client_manager";
    const permissionConfig = managerCapabilities(permissionInput, old);
    if (
      scope === "client" &&
      permissionConfig.capabilities.some(
        (id) => !clientCapabilityIds.includes(id),
      )
    )
      throw new AppError("客户端用户不能修改或删除域名及系统配置");
    const storedGrants = (id) =>
      db
        .prepare(
          "SELECT * FROM domain_permissions WHERE user_id=? ORDER BY domain_id",
        )
        .all(id);
    const previousGrants = old ? storedGrants(old.id) : [];
    const permissions = req.body.permissions ?? previousGrants;
    if (!Array.isArray(permissions) || permissions.length > 100)
      throw new AppError("域名权限配置无效");
    const grants = permissions.map((p) => {
      if (!p || typeof p !== "object" || Array.isArray(p))
        throw new AppError("域名权限配置无效");
      const domain_id = idValue(p.domain_id);
      if (
        !db
          .prepare("SELECT id FROM domains WHERE id=? AND name<>''")
          .get(domain_id)
      )
        throw new AppError("权限中的域名不存在");
      return {
        domain_id,
        ...Object.fromEntries(
          ["read", "create", "update", "delete"].map((key) => [
            `can_${key}`,
            Number(
              bool(
                p[`can_${key}`] === 0
                  ? false
                  : p[`can_${key}`] === 1
                    ? true
                    : p[`can_${key}`],
                false,
              ),
            ),
          ]),
        ),
      };
    });
    if (new Set(grants.map((g) => g.domain_id)).size !== grants.length)
      throw new AppError("域名权限重复");
    const email = old?.email || emailAddress(req.body.email),
      domain = db
        .prepare("SELECT id FROM domains WHERE name=? AND enabled=1")
        .get(email.includes("@") ? email.split("@")[1] : "");
    if (!domain) throw new AppError("管理员邮箱的域名不存在或已停用");
    if (!old) assertMailboxCapacity(db, domain.id);
    const name = textValue(req.body.name ?? old?.name ?? email.split("@")[0]),
      note = textValue(req.body.note ?? old?.note ?? "", 500),
      active = bool(req.body.active, Boolean(old?.active ?? true));
    const hash = req.body.password
      ? await hashPassword(req.body.password)
      : old?.password_hash;
    if (!hash) throw new AppError("请设置管理员密码");
    const id = transaction(() => {
      freshActor(req);
      requireGlobal(req.user);
      const current =
        old && db.prepare("SELECT * FROM users WHERE id=?").get(old.id);
      if (
        old &&
        (!current ||
          JSON.stringify(current) !== JSON.stringify(old) ||
          JSON.stringify(storedGrants(old.id)) !==
            JSON.stringify(previousGrants))
      )
        throw new AppError("该账号已被其他操作修改，请刷新后重试", 409);
      if (
        current?.role === "admin" &&
        current.admin_scope !== "scoped" &&
        (scope !== "global" || !active) &&
        db
          .prepare(
            "SELECT count(*) n FROM users u JOIN domains d ON d.id=u.domain_id WHERE u.role='admin' AND u.admin_scope<>'scoped' AND u.active=1 AND d.enabled=1 AND u.id<>?",
          )
          .get(current.id).n === 0
      )
        throw new AppError("必须保留至少一个可用的全局管理员", 409);
      if (!old) assertMailboxCapacity(db, domain.id);
      if (
        !db
          .prepare("SELECT id FROM domains WHERE id=? AND enabled=1")
          .get(domain.id)
      )
        throw new AppError("管理员域名已停用", 409);
      let id = old?.id;
      if (old)
        db.prepare(
          "UPDATE users SET name=?,note=?,active=?,password_hash=?,role=?,admin_scope=? WHERE id=?",
        ).run(
          name,
          note,
          Number(active),
          hash,
          ["user", "client"].includes(scope) ? "user" : "admin",
          scope === "client" ? "scoped" : scope === "user" ? "global" : scope,
          id,
        );
      else
        id = Number(
          db
            .prepare(
              "INSERT INTO users(domain_id,email,name,note,active,password_hash,role,admin_scope,quota_bytes) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .run(
              domain.id,
              email,
              name,
              note,
              Number(active),
              hash,
              ["user", "client"].includes(scope) ? "user" : "admin",
              scope === "client"
                ? "scoped"
                : scope === "user"
                  ? "global"
                  : scope,
              config.defaultQuotaBytes,
            ).lastInsertRowid,
        );
      db.prepare(
        "UPDATE users SET admin_role=?,admin_capabilities=?,client_manager=? WHERE id=?",
      ).run(
        permissionConfig.preset,
        ["scoped", "client"].includes(scope)
          ? JSON.stringify(permissionConfig.capabilities)
          : null,
        Number(scope === "client"),
        id,
      );
      db.prepare("DELETE FROM domain_permissions WHERE user_id=?").run(id);
      if (["scoped", "client"].includes(scope))
        for (const g of grants)
          db.prepare(
            "INSERT INTO domain_permissions(user_id,domain_id,can_read,can_create,can_update,can_delete) VALUES(?,?,?,?,?,?)",
          ).run(
            id,
            g.domain_id,
            g.can_read,
            g.can_create,
            g.can_update,
            g.can_delete,
          );
      if (id !== req.user.id)
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      audit(req.user.email, "manager.update", {
        id,
        scope,
        permissions: grants,
        rolePreset: permissionConfig.preset,
        capabilities: permissionConfig.capabilities,
      });
      return id;
    });
    res.status(old ? 200 : 201).json({ id });
  }
  adminRouter.post("/managers", saveManager);
  adminRouter.patch("/managers/:id", saveManager);
  const columns =
    "m.id,m.owner_id,m.folder,m.from_email,m.from_name,m.to_json,m.cc_json,m.subject,m.snippet,m.size,m.is_read,m.starred,m.delivery_status,m.created_at,u.email AS mailbox,(SELECT count(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count";
  adminRouter.get("/manage/messages", (req, res) => {
    const scope = scopeSql(db, req.user, "u.domain_id"),
      folder = req.query.folder || "inbox";
    if (
      !["inbox", "sent", "trash", "drafts", "archive", "spam"].includes(folder)
    )
      throw new AppError("文件夹无效");
    let where = `${scope.sql} AND m.folder=?${isGlobalAdmin(req.user) ? "" : " AND ((u.role='user' AND u.client_manager=0) OR u.id=?)"}`,
      args = [
        ...scope.args,
        folder,
        ...(isGlobalAdmin(req.user) ? [] : [req.user.id]),
      ];
    if (req.query.emails) {
      const emails = recipients(req.query.emails, true);
      where += ` AND u.email IN(${emails.map(() => "?").join(",")})`;
      args.push(...emails);
    }
    if (req.query.q) {
      where +=
        " AND (m.subject LIKE ? OR m.from_email LIKE ? OR m.body_text LIKE ?)";
      const q = `%${String(req.query.q).slice(0, 100)}%`;
      args.push(q, q, q);
    }
    if (req.query.unread === "1") where += " AND m.is_read=0";
    const page = integer(req.query.page, 1, 1, 100000, "页码"),
      limit = integer(req.query.limit, 30, 1, 100, "每页数量");
    const total = db
      .prepare(
        `SELECT count(*) n FROM messages m JOIN users u ON u.id=m.owner_id WHERE ${where}`,
      )
      .get(...args).n;
    const items = db
      .prepare(
        `SELECT ${columns} FROM messages m JOIN users u ON u.id=m.owner_id WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, (page - 1) * limit)
      .map((m) => ({
        ...m,
        to: JSON.parse(m.to_json),
        cc: JSON.parse(m.cc_json),
      }));
    res.json({ items, total, page, limit });
  });
  function managedMessage(req, includeRaw = false) {
    const message = db
      .prepare(
        `SELECT ${includeRaw ? "m.*" : messageColumns("m.")},u.domain_id,u.role AS owner_role,u.client_manager AS owner_client_manager FROM messages m JOIN users u ON u.id=m.owner_id WHERE m.id=?`,
      )
      .get(idValue(req.params.id));
    if (!message) throw new AppError("邮件不存在", 404);
    if (
      (message.owner_role === "admin" || message.owner_client_manager === 1) &&
      message.owner_id !== req.user.id
    )
      requireGlobal(req.user);
    requireDomain(db, req.user, message.domain_id, "read");
    return message;
  }
  adminRouter.get("/manage/messages/:id", (req, res) => {
    const { raw, ...message } = managedMessage(req);
    res.json({
      ...message,
      to: JSON.parse(message.to_json),
      cc: JSON.parse(message.cc_json),
      bcc: JSON.parse(message.bcc_json),
      attachments: db
        .prepare(
          "SELECT id,filename,content_type,size FROM attachments WHERE message_id=?",
        )
        .all(message.id),
    });
  });
  adminRouter.patch("/manage/messages/:id", (req, res) => {
    const message = managedMessage(req);
    requireDomain(db, req.user, message.domain_id, "update");
    if (req.body.folder === "trash")
      requireDomain(db, req.user, message.domain_id, "delete");
    const updates = [],
      args = [];
    for (const [key, field] of [
      ["read", "is_read"],
      ["starred", "starred"],
    ])
      if (typeof req.body[key] === "boolean") {
        updates.push(`${field}=?`);
        args.push(Number(req.body[key]));
      }
    if (req.body.folder) {
      if (!["inbox", "archive", "spam", "trash"].includes(req.body.folder))
        throw new AppError("文件夹无效");
      updates.push("folder=?", "previous_folder=?", "trashed_at=?");
      args.push(
        req.body.folder,
        message.folder,
        req.body.folder === "trash" ? new Date().toISOString() : null,
      );
    }
    if (!updates.length) throw new AppError("没有可更新的字段");
    db.prepare(`UPDATE messages SET ${updates.join(",")} WHERE id=?`).run(
      ...args,
      message.id,
    );
    res.json({ ok: true });
  });
  adminRouter.post("/manage/messages/:id/restore", (req, res) => {
    const message = managedMessage(req);
    requireDomain(db, req.user, message.domain_id, "update");
    if (message.folder !== "trash") throw new AppError("邮件不在垃圾箱");
    db.prepare(
      "UPDATE messages SET folder=?,previous_folder=NULL,trashed_at=NULL WHERE id=?",
    ).run(message.previous_folder || "inbox", message.id);
    res.json({ ok: true });
  });
  adminRouter.delete("/manage/messages/:id", (req, res) => {
    const message = managedMessage(req);
    requireDomain(db, req.user, message.domain_id, "delete");
    if (message.folder !== "trash") throw new AppError("请先将邮件移入垃圾箱");
    if (
      db
        .prepare(
          "SELECT id FROM delivery_jobs WHERE message_id=? AND state IN('queued','sending')",
        )
        .get(message.id)
    )
      throw new AppError("该邮件正在投递，请稍后处理", 409);
    transaction(() => {
      db.prepare("DELETE FROM delivery_jobs WHERE message_id=?").run(
        message.id,
      );
      db.prepare("DELETE FROM messages WHERE id=?").run(message.id);
      audit(req.user.email, "mail.delete", { id: message.id });
    });
    res.json({ ok: true });
  });
  adminRouter.get("/manage/messages/:id/raw", (req, res) => {
    const message = managedMessage(req, true);
    res
      .attachment(`message-${message.id}.eml`)
      .type("message/rfc822")
      .send(Buffer.from(message.raw || ""));
  });
  adminRouter.get("/manage/attachments/:id", (req, res) => {
    const row = db
      .prepare(
        "SELECT a.*,u.domain_id,u.role AS owner_role,u.client_manager AS owner_client_manager,u.id AS owner_id FROM attachments a JOIN messages m ON m.id=a.message_id JOIN users u ON u.id=m.owner_id WHERE a.id=?",
      )
      .get(idValue(req.params.id));
    if (!row) throw new AppError("附件不存在", 404);
    if (
      (row.owner_role === "admin" || row.owner_client_manager === 1) &&
      row.owner_id !== req.user.id
    )
      requireGlobal(req.user);
    requireDomain(db, req.user, row.domain_id, "read");
    res
      .attachment(row.filename)
      .type("application/octet-stream")
      .send(Buffer.from(row.content));
  });
  function sender(req, email) {
    freshActor(req, "mail.send");
    const user = mail.localUser(emailAddress(email || req.user.email));
    if (!user || user.is_temporary)
      throw new AppError("发件邮箱不存在或已停用");
    requireDomain(db, req.user, user.domain_id, "create");
    if (canManageDomains(user) && user.id !== req.user.id)
      requireGlobal(req.user);
    return user;
  }
  const sendLimit = rateLimit({
    windowMs: 60000,
    limit: 30,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "发信过于频繁，请稍后再试" },
  });
  adminRouter.post("/manage/send", sendLimit, async (req, res) =>
    res
      .status(201)
      .json(
        await mail.send(sender(req, req.body.from), req.body, () =>
          sender(req, req.body.from),
        ),
      ),
  );
  adminRouter.post("/manage/bulk-send", sendLimit, async (req, res) => {
    const emails = recipients(req.body.recipients, true),
      results = [];
    const random = bool(req.body.randomSender, false);
    const pool = random
      ? db
          .prepare(
            "SELECT * FROM users WHERE active=1 AND is_temporary=0 AND role='user'",
          )
          .all()
          .filter((u) => {
            try {
              sender(req, u.email);
              return true;
            } catch {
              return false;
            }
          })
      : [sender(req, req.body.from)];
    if (!pool.length) throw new AppError("没有可用的发件邮箱");
    for (const email of emails) {
      const user = pool[random ? randomInt(pool.length) : 0];
      try {
        const message = await mail.send(
          user,
          {
            ...req.body,
            to: [email],
            cc: [],
            bcc: [],
          },
          () => sender(req, user.email),
        );
        results.push({ email, from: user.email, id: message.id, ok: true });
      } catch (error) {
        results.push({
          email,
          from: user.email,
          ok: false,
          error: error.message,
        });
      }
    }
    audit(req.user.email, "mail.bulk_send", {
      count: emails.length,
      succeeded: results.filter((r) => r.ok).length,
    });
    res.json({ items: results });
  });
  router.use("/templates", auth, (req, _res, next) => {
    if (canManageDomains(req.user))
      requireCapability(req.user, "templates.manage");
    next();
  });
  router.get("/templates", (req, res) =>
    res.json({
      items: db
        .prepare(
          "SELECT * FROM mail_templates WHERE owner_id=? ORDER BY updated_at DESC,id DESC",
        )
        .all(req.user.id),
    }),
  );
  router.post("/templates", (req, res) => {
    const name = textValue(req.body.name, 100),
      subject = textValue(req.body.subject || "", 500),
      text = bodyText(req.body.text || ""),
      html = cleanHtml(bodyText(req.body.html || ""));
    if (!name) throw new AppError("请填写模板名称");
    if (
      db
        .prepare("SELECT count(*) n FROM mail_templates WHERE owner_id=?")
        .get(req.user.id).n >= 100
    )
      throw new AppError("每个账号最多100个模板");
    const id = Number(
      db
        .prepare(
          "INSERT INTO mail_templates(owner_id,name,subject,body_text,body_html) VALUES(?,?,?,?,?)",
        )
        .run(req.user.id, name, subject, text, html).lastInsertRowid,
    );
    res.status(201).json({ id });
  });
  router.patch("/templates/:id", (req, res) => {
    const id = idValue(req.params.id),
      old = db
        .prepare("SELECT * FROM mail_templates WHERE id=? AND owner_id=?")
        .get(id, req.user.id);
    if (!old) throw new AppError("模板不存在", 404);
    const name = textValue(req.body.name ?? old.name, 100),
      subject = textValue(req.body.subject ?? old.subject, 500),
      text = bodyText(req.body.text ?? old.body_text),
      html = cleanHtml(bodyText(req.body.html ?? old.body_html));
    if (!name) throw new AppError("模板名称不能为空");
    db.prepare(
      "UPDATE mail_templates SET name=?,subject=?,body_text=?,body_html=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).run(name, subject, text, html, id);
    res.json({ ok: true });
  });
  router.delete("/templates/:id", (req, res) => {
    if (
      !db
        .prepare("DELETE FROM mail_templates WHERE id=? AND owner_id=?")
        .run(idValue(req.params.id), req.user.id).changes
    )
      throw new AppError("模板不存在", 404);
    res.json({ ok: true });
  });
  const batchMessages = (req, res) => {
    if (
      !Array.isArray(req.body.ids) ||
      !req.body.ids.length ||
      req.body.ids.length > 100
    )
      throw new AppError("请选择1–100封邮件");
    const action = req.body.action;
    if (!["trash", "archive", "read", "unread", "restore"].includes(action))
      throw new AppError("批量操作无效");
    transaction(() => {
      for (const raw of new Set(req.body.ids)) {
        const id = idValue(raw),
          row = db
            .prepare(
              "SELECT m.*,u.domain_id,u.role AS owner_role,u.client_manager AS owner_client_manager FROM messages m JOIN users u ON u.id=m.owner_id WHERE m.id=?",
            )
            .get(id);
        if (!row) throw new AppError("邮件不存在", 404);
        if (row.owner_id !== req.user.id || req.managedMailBatch) {
          license?.assertAllowed();
          freshActor(req, action === "trash" ? "mail.delete" : "mail.update");
          if (
            row.owner_id !== req.user.id &&
            (row.owner_role === "admin" || row.owner_client_manager === 1)
          )
            requireGlobal(req.user);
          requireDomain(db, req.user, row.domain_id, "update");
          if (action === "trash")
            requireDomain(db, req.user, row.domain_id, "delete");
        }
        if (["read", "unread"].includes(action))
          db.prepare("UPDATE messages SET is_read=? WHERE id=?").run(
            Number(action === "read"),
            id,
          );
        else if (action === "restore") {
          if (row.folder === "trash")
            db.prepare(
              "UPDATE messages SET folder=?,previous_folder=NULL,trashed_at=NULL WHERE id=?",
            ).run(row.previous_folder || "inbox", id);
        } else if (row.folder !== "drafts" && row.folder !== "trash")
          db.prepare(
            "UPDATE messages SET previous_folder=folder,folder=?,trashed_at=? WHERE id=?",
          ).run(
            action === "trash" ? "trash" : "archive",
            action === "trash" ? new Date().toISOString() : null,
            id,
          );
      }
    });
    res.json({ ok: true, count: new Set(req.body.ids).size });
  };
  router.post("/messages/batch", auth, batchMessages);
  adminRouter.post("/manage/messages/batch", (req, res) => {
    req.managedMailBatch = true;
    return batchMessages(req, res);
  });
}
