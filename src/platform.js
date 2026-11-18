import { AppError, textValue, token } from "./security.js";
import {
  getSetting,
  putSetting,
  integer,
  bool,
  domainList,
} from "./settings.js";
import { isGlobalAdmin } from "./access.js";
import { backup } from "node:sqlite";
import { mkdir, stat, chmod, readdir } from "node:fs/promises";
import path from "node:path";

export const featureCatalog = [
  ["overview", "总览", "chart", true],
  ["compose", "发邮件", "edit"],
  ["inbox", "收件箱", "inbox"],
  ["sent", "发件箱", "send"],
  ["forwards", "邮件转发", "forward"],
  ["users", "用户列表", "users", true],
  ["batch-register", "批量注册", "batch"],
  ["bulk-send", "批量群发", "bulk"],
  ["batch-password", "批量改密", "key"],
  ["domains", "域名列表", "globe", true],
  ["codes", "接码", "code"],
  ["temp-mail", "临时邮箱页面", "mail"],
  ["templates", "邮件模板", "draft"],
  ["api", "邮件推送API", "api"],
  ["connections", "多邮局管理", "server"],
  ["managers", "权限管理", "shield"],
  ["system", "系统设置", "settings", true],
  ["platform", "平台设置", "settings", true],
  ["features", "功能管理", "settings", true],
  ["about", "程序信息", "info"],
].map(([id, name, icon, core = false], order) => ({
  id,
  name,
  icon,
  core,
  order,
  enabled: id !== "connections",
  show: id !== "connections",
  ...(id === "connections" ? { paused: true } : {}),
}));
const defaults = {
  name: "青邮",
  logoUrl: "",
  copyright: "",
  icpText: "",
  icpUrl: "https://beian.miit.gov.cn/",
  backgroundType: "color",
  backgroundColor: "#f4f6fb",
  backgroundImage: "",
  backgroundOpacity: 90,
  theme: "auto",
  layout: "vertical",
  announcement: "",
  retentionEnabled: false,
  retentionDays: 90,
  purgeTrashDays: 0,
  retentionDomains: [],
  cacheEnabled: false,
  cacheSeconds: 15,
  batchConcurrency: 4,
};
const imageUrl = (value) => {
  if (!value) return "";
  if (/^\/api\/branding-assets\/[A-Za-z0-9_-]{24}$/.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("图片地址无效");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new AppError("图片地址需为HTTPS地址或已上传图片");
  return url.href;
};
function publicSettings(settings) {
  return Object.fromEntries(
    [
      "name",
      "logoUrl",
      "copyright",
      "icpText",
      "icpUrl",
      "backgroundType",
      "backgroundColor",
      "backgroundImage",
      "backgroundOpacity",
      "theme",
      "layout",
      "announcement",
    ].map((key) => [key, settings[key]]),
  );
}
export function createResponseCache(store) {
  const cache = new Map();
  return {
    clear() {
      const count = cache.size;
      cache.clear();
      return count;
    },
    size: () => cache.size,
    wrap(req, res) {
      if (req._cacheWrapped) return;
      req._cacheWrapped = true;
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        res.once("finish", () => {
          if (res.statusCode < 400) cache.clear();
        });
        return;
      }
      const settings = getSetting(store.db, "platform", defaults);
      if (
        !settings.cacheEnabled ||
        req.query.refresh === "1" ||
        !/^\/api\/admin\/(?:manage\/accounts|manage\/domains|overview)(?:\?|$)/.test(
          req.originalUrl,
        )
      )
        return;
      const key = `${req.user.id}:${req.originalUrl}`,
        found = cache.get(key);
      if (found && found.expires > Date.now()) {
        res.setHeader("X-PostOffice-Cache", "hit");
        res.json(structuredClone(found.body));
        return true;
      }
      const original = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode < 300) {
          if (cache.size >= 1000) cache.clear();
          cache.set(key, {
            body: structuredClone(body),
            expires: Date.now() + settings.cacheSeconds * 1000,
          });
          res.setHeader("X-PostOffice-Cache", "miss");
        }
        return original(body);
      };
    },
  };
}
export function featureGate(db, req) {
  const path = req.path.toLowerCase().replace(/\/+$/, "");
  if (/^\/admin\/connections(?:\/|$)/.test(path))
    throw new AppError("多邮局管理暂时停用，已有连接配置保留", 403);
  const mappings = [
    [/^\/(?:temp\/|admin\/temp-mail)/, "temp-mail"],
    [
      /^\/(?:code-links|code-admin|admin\/code-|admin\/codes|v1\/codes)/,
      "codes",
    ],
    [/^\/templates/, "templates"],
    [/^\/admin\/connections/, "connections"],
    [/^\/admin\/managers/, "managers"],
    [/^\/admin\/(?:manage\/)?bulk-send/, "bulk-send"],
    [/^\/admin\/(?:users\/batch|manage\/accounts\/batch)/, "batch-register"],
    [
      /^\/admin\/(?:users\/passwords|manage\/accounts\/passwords)/,
      "batch-password",
    ],
    [/^\/admin\/(?:manage\/)?forwards/, "forwards"],
    [/^\/(?:v1\/send|send_mail|admin\/api-keys)/, "api"],
    [/^\/(?:send$|drafts|admin\/manage\/send)/, "compose"],
  ];
  const id = mappings.find(([pattern]) => pattern.test(path))?.[1];
  if (
    id &&
    getSetting(db, "features", { items: [] }).items.some(
      (f) => f.id === id && f.enabled === false,
    )
  )
    throw new AppError("此功能已由管理员停用", 403);
}
export function mountPlatformRoutes(
  router,
  adminRouter,
  store,
  config,
  auth,
  cache,
) {
  const { db, transaction, audit } = store,
    settings = () => getSetting(db, "platform", defaults);
  const backupDir = path.join(config.dataDir, "admin-backups");
  let backupRunning = false,
    lastBackup = 0;
  const backupName = (name) =>
    /^postoffice-\d{13}-[A-Za-z0-9_-]{8}\.sqlite$/.test(name);
  adminRouter.post("/platform/backup", async (req, res) => {
    if (backupRunning || Date.now() - lastBackup < 300000)
      throw new AppError("备份间隔至少5分钟，请稍后再试", 429);
    backupRunning = true;
    try {
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      const files = (await readdir(backupDir)).filter(backupName);
      if (files.length >= 20)
        throw new AppError("已保留20份手动备份，请在服务器归档旧文件后再创建");
      const name = `postoffice-${Date.now()}-${token(6)}.sqlite`,
        file = path.join(backupDir, name);
      await backup(db, file);
      await chmod(file, 0o600);
      lastBackup = Date.now();
      audit(req.user.email, "backup.create", { name });
      res.status(201).json({
        name,
        size: (await stat(file)).size,
        url: `/api/admin/platform/backups/${name}`,
      });
    } finally {
      backupRunning = false;
    }
  });
  adminRouter.get("/platform/backups", async (_req, res) => {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const names = (await readdir(backupDir))
      .filter(backupName)
      .sort()
      .reverse();
    res.json({
      items: await Promise.all(
        names.map(async (name) => ({
          name,
          size: (await stat(path.join(backupDir, name))).size,
          url: `/api/admin/platform/backups/${name}`,
        })),
      ),
    });
  });
  adminRouter.get("/platform/backups/:name", async (req, res) => {
    if (!backupName(req.params.name)) throw new AppError("备份名称无效", 404);
    const file = path.join(backupDir, req.params.name);
    try {
      await stat(file);
    } catch {
      throw new AppError("备份不存在", 404);
    }
    audit(req.user.email, "backup.download", { name: req.params.name });
    res
      .attachment(req.params.name)
      .type("application/octet-stream")
      .sendFile(file);
  });
  const features = () => {
    const stored = getSetting(db, "features", { items: [] }).items;
    return featureCatalog
      .map((defaultValue) => {
        const merged = {
          ...defaultValue,
          ...stored.find((item) => item.id === defaultValue.id),
        };
        if (defaultValue.paused)
          Object.assign(merged, { enabled: false, show: false, paused: true });
        if (defaultValue.core)
          Object.assign(merged, { enabled: true, show: true, core: true });
        return merged;
      })
      .sort((a, b) => a.order - b.order);
  };
  router.get("/platform", (_req, res) => res.json(publicSettings(settings())));
  router.get("/preferences", auth, (req, res) =>
    res.json({ platform: publicSettings(settings()), features: features() }),
  );
  adminRouter.get("/platform", (_req, res) =>
    res.json({ ...settings(), cacheEntries: cache.size() }),
  );
  adminRouter.put("/platform", (req, res) => {
    const old = settings(),
      i = req.body,
      value = {
        name: textValue(i.name ?? old.name, 40),
        logoUrl: imageUrl(i.logoUrl ?? old.logoUrl),
        copyright: textValue(i.copyright ?? old.copyright, 200),
        icpText: textValue(i.icpText ?? old.icpText, 100),
        icpUrl: String(i.icpUrl ?? old.icpUrl),
        backgroundType: i.backgroundType ?? old.backgroundType,
        backgroundColor: i.backgroundColor ?? old.backgroundColor,
        backgroundImage: imageUrl(i.backgroundImage ?? old.backgroundImage),
        backgroundOpacity: integer(
          i.backgroundOpacity,
          old.backgroundOpacity,
          10,
          100,
          "背景不透明度",
        ),
        theme: i.theme ?? old.theme,
        layout: i.layout ?? old.layout,
        announcement: String(i.announcement ?? old.announcement),
        retentionEnabled: bool(i.retentionEnabled, old.retentionEnabled),
        retentionDays: integer(
          i.retentionDays,
          old.retentionDays,
          1,
          3650,
          "邮件保留天数",
        ),
        purgeTrashDays: integer(
          i.purgeTrashDays,
          old.purgeTrashDays,
          0,
          3650,
          "垃圾箱永久清理天数",
        ),
        retentionDomains: domainList(i.retentionDomains, old.retentionDomains),
        cacheEnabled: bool(i.cacheEnabled, old.cacheEnabled),
        cacheSeconds: integer(
          i.cacheSeconds,
          old.cacheSeconds,
          0,
          300,
          "缓存秒数",
        ),
        batchConcurrency: integer(
          i.batchConcurrency,
          old.batchConcurrency,
          1,
          8,
          "批量操作并发数",
        ),
      };
    if (
      !value.name ||
      !/^#[0-9a-f]{6}$/i.test(value.backgroundColor) ||
      !["color", "image"].includes(value.backgroundType) ||
      !["auto", "light", "dark"].includes(value.theme) ||
      !["vertical", "horizontal"].includes(value.layout) ||
      value.announcement.length > 10000
    )
      throw new AppError("平台设置格式无效");
    let icp;
    try {
      icp = new URL(value.icpUrl);
    } catch {
      throw new AppError("备案链接无效");
    }
    if (icp.protocol !== "https:" || icp.username || icp.password)
      throw new AppError("备案链接需为HTTPS");
    value.icpUrl = icp.href;
    if (
      value.retentionDomains.some(
        (name) => !db.prepare("SELECT id FROM domains WHERE name=?").get(name),
      )
    )
      throw new AppError("清理范围中的域名不存在");
    if (
      ((value.retentionEnabled && !old.retentionEnabled) ||
        (value.purgeTrashDays > 0 &&
          value.purgeTrashDays !== old.purgeTrashDays)) &&
      i.confirmRetention !== true
    )
      throw new AppError("请确认邮件自动清理设置及影响范围");
    transaction(() => {
      putSetting(db, "platform", value);
      audit(req.user.email, "platform.update", {
        retentionEnabled: value.retentionEnabled,
        purgeTrashDays: value.purgeTrashDays,
      });
    });
    cache.clear();
    res.json(value);
  });
  adminRouter.post("/platform/assets", (req, res) => {
    const raw = req.body.content;
    if (
      typeof raw !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) ||
      raw.length > 7 * 1024 * 1024
    )
      throw new AppError("图片编码无效或超过5MB");
    const content = Buffer.from(raw, "base64");
    let mime;
    if (
      content
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = "image/png";
    else if (content[0] === 255 && content[1] === 216 && content[2] === 255)
      mime = "image/jpeg";
    else if (/^GIF8[79]a$/.test(content.subarray(0, 6).toString()))
      mime = "image/gif";
    else if (
      content.subarray(0, 4).toString() === "RIFF" &&
      content.subarray(8, 12).toString() === "WEBP"
    )
      mime = "image/webp";
    if (!mime || content.length > 5 * 1024 * 1024)
      throw new AppError("仅支持5MB以内的PNG/JPEG/WebP/GIF图片");
    if (
      db
        .prepare(
          "SELECT coalesce(sum(length(content)),0) n FROM branding_assets",
        )
        .get().n +
        content.length >
      50 * 1024 * 1024
    )
      throw new AppError("品牌图片总容量已达50MB，请先移除未使用图片");
    const id = token(18);
    db.prepare(
      "INSERT INTO branding_assets(id,mime,content) VALUES(?,?,?)",
    ).run(id, mime, content);
    res.status(201).json({ url: `/api/branding-assets/${id}` });
  });
  adminRouter.get("/platform/assets", (_req, res) =>
    res.json({
      items: db
        .prepare(
          "SELECT id,mime,length(content) AS size,created_at FROM branding_assets ORDER BY created_at DESC",
        )
        .all()
        .map((row) => ({ ...row, url: `/api/branding-assets/${row.id}` })),
    }),
  );
  adminRouter.delete("/platform/assets/:id", (req, res) => {
    const value = settings(),
      url = `/api/branding-assets/${req.params.id}`;
    if ([value.logoUrl, value.backgroundImage].includes(url))
      throw new AppError("请先更换正在使用的图片");
    db.prepare("DELETE FROM branding_assets WHERE id=?").run(
      String(req.params.id),
    );
    res.json({ ok: true });
  });
  router.get("/branding-assets/:id", (req, res) => {
    const row =
      /^[A-Za-z0-9_-]{24}$/.test(req.params.id) &&
      db
        .prepare("SELECT mime,content FROM branding_assets WHERE id=?")
        .get(req.params.id);
    if (!row) throw new AppError("图片不存在", 404);
    res.type(row.mime).send(Buffer.from(row.content));
  });
  adminRouter.get("/features", (_req, res) => res.json({ items: features() }));
  adminRouter.put("/features", (req, res) => {
    if (
      !Array.isArray(req.body.items) ||
      req.body.items.length !== featureCatalog.length
    )
      throw new AppError("请提交完整功能列表");
    const seen = new Set(),
      items = req.body.items.map((item, order) => {
        const def = featureCatalog.find((f) => f.id === item.id);
        if (!def || seen.has(item.id))
          throw new AppError("功能列表有重复或无效项目");
        seen.add(item.id);
        if (def.paused)
          return { id: item.id, enabled: false, show: false, order };
        const enabled = bool(item.enabled, true),
          show = bool(item.show, true);
        if (def.core && (!enabled || !show))
          throw new AppError("核心管理入口不能关闭或隐藏");
        return { id: item.id, enabled, show, order };
      });
    putSetting(db, "features", { items });
    audit(req.user.email, "features.update");
    res.json({ items: features() });
  });
  adminRouter.post("/platform/cache/clear", (req, res) => {
    const count = cache.clear();
    audit(req.user.email, "cache.clear", { count });
    res.json({ ok: true, count });
  });
  function selection(input = {}) {
    const mode = input.mode || "trash";
    if (!["trash", "purge"].includes(mode)) throw new AppError("清理方式无效");
    const days = integer(
        input.days,
        settings().retentionDays,
        0,
        3650,
        "保留天数",
      ),
      domains = domainList(input.domains, settings().retentionDomains);
    let where =
        "m.folder<>'drafts' AND NOT EXISTS(SELECT 1 FROM delivery_jobs j WHERE j.message_id=m.id AND j.state IN ('queued','sending'))",
      args = [];
    where +=
      mode === "trash" ? " AND m.folder<>'trash'" : " AND m.folder='trash'";
    if (days > 0) {
      where += " AND m.created_at<?";
      args.push(new Date(Date.now() - days * 86400000).toISOString());
    }
    if (domains.length) {
      where += ` AND d.name IN(${domains.map(() => "?").join(",")})`;
      args.push(...domains);
    }
    const rows = db
      .prepare(
        `SELECT m.id,m.size FROM messages m JOIN users u ON u.id=m.owner_id JOIN domains d ON d.id=u.domain_id WHERE ${where} ORDER BY m.id LIMIT 5000`,
      )
      .all(...args);
    return { mode, days, domains, rows };
  }
  adminRouter.post("/platform/cleanup/preview", (req, res) => {
    const plan = selection(req.body),
      secret = token(24);
    db.prepare("DELETE FROM cleanup_plans WHERE expires_at<?").run(Date.now());
    db.prepare(
      "INSERT INTO cleanup_plans(token,actor_id,message_ids,mode,expires_at) VALUES(?,?,?,?,?)",
    ).run(
      secret,
      req.user.id,
      JSON.stringify(plan.rows.map((row) => row.id)),
      plan.mode,
      Date.now() + 300000,
    );
    res.json({
      token: secret,
      mode: plan.mode,
      count: plan.rows.length,
      bytes: plan.rows.reduce((n, r) => n + r.size, 0),
      expiresIn: 300,
    });
  });
  adminRouter.post("/platform/cleanup/execute", (req, res) => {
    const plan = db
      .prepare(
        "SELECT * FROM cleanup_plans WHERE token=? AND actor_id=? AND expires_at>?",
      )
      .get(String(req.body.token || ""), req.user.id, Date.now());
    if (!plan) throw new AppError("清理预览已失效，请重新预览", 409);
    if (
      req.body.confirmText !==
      (plan.mode === "purge" ? "永久删除" : "移入垃圾箱")
    )
      throw new AppError("确认文字不匹配");
    const ids = JSON.parse(plan.message_ids);
    transaction(() => {
      for (const id of ids) {
        if (
          db
            .prepare(
              "SELECT id FROM delivery_jobs WHERE message_id=? AND state IN ('queued','sending')",
            )
            .get(id)
        )
          throw new AppError("部分邮件正在投递，请重新预览", 409);
        if (plan.mode === "purge") {
          db.prepare(
            "DELETE FROM delivery_jobs WHERE message_id=? AND state NOT IN('queued','sending')",
          ).run(id);
          db.prepare("DELETE FROM messages WHERE id=? AND folder='trash'").run(
            id,
          );
        } else
          db.prepare(
            "UPDATE messages SET previous_folder=folder,folder='trash',trashed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND folder NOT IN('trash','drafts')",
          ).run(id);
      }
      db.prepare("DELETE FROM cleanup_plans WHERE token=?").run(plan.token);
      audit(req.user.email, "mail.cleanup", {
        count: ids.length,
        mode: plan.mode,
      });
    });
    res.json({ ok: true, count: ids.length });
  });
  function maintain() {
    const value = settings();
    if (!value.retentionEnabled) return;
    transaction(() => {
      const plan = selection({ mode: "trash", days: value.retentionDays });
      for (const row of plan.rows)
        db.prepare(
          "UPDATE messages SET previous_folder=folder,folder='trash',trashed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        ).run(row.id);
      if (value.purgeTrashDays > 0) {
        const cutoff = new Date(
          Date.now() - value.purgeTrashDays * 86400000,
        ).toISOString();
        let sql =
            "SELECT m.id FROM messages m JOIN users u ON u.id=m.owner_id JOIN domains d ON d.id=u.domain_id WHERE m.folder='trash' AND m.trashed_at<? AND NOT EXISTS(SELECT 1 FROM delivery_jobs j WHERE j.message_id=m.id AND j.state IN('queued','sending'))",
          args = [cutoff];
        if (value.retentionDomains.length) {
          sql += ` AND d.name IN(${value.retentionDomains.map(() => "?").join(",")})`;
          args.push(...value.retentionDomains);
        }
        for (const row of db.prepare(sql + " LIMIT 5000").all(...args)) {
          db.prepare("DELETE FROM delivery_jobs WHERE message_id=?").run(
            row.id,
          );
          db.prepare("DELETE FROM messages WHERE id=?").run(row.id);
        }
      }
      if (plan.rows.length)
        audit("maintenance", "mail.retention", { moved: plan.rows.length });
    });
    cache.clear();
  }
  const timer = setInterval(() => {
    try {
      maintain();
    } catch (error) {
      console.error("Mail retention failed:", error.message);
    }
  }, 3600000);
  timer.unref();
  return () => clearInterval(timer);
}
