import { Worker } from "node:worker_threads";
import { randomInt } from "node:crypto";
import rateLimit from "express-rate-limit";
import { AppError, emailAddress, idValue, textValue } from "./security.js";
import { mountCodeLinks } from "./code-links.js";
import { domainList, bool, integer } from "./settings.js";

const defaults = {
  enabled: true,
  allowPublicLinks: true,
  lookbackHours: 24,
  maxResults: 100,
  refreshSeconds: 10,
  linkHours: 24,
};
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const number = (value, min, max, label) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new AppError(`${label}需为 ${min}–${max}`);
  return n;
};
const boolean = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new AppError("开关设置需为布尔值");
  return value;
};
export function runCodeRules(
  rules,
  messages,
  timeoutMs = 1000,
  detailed = false,
) {
  if (!rules.length || !messages.length)
    return Promise.resolve(messages.map(() => ({ code: null })));
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./code-rules-worker.js", import.meta.url),
      {
        workerData: { rules, messages, detailed },
        resourceLimits: { maxOldGenerationSizeMb: 32 },
      },
    );
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new AppError("验证码规则执行超时，请简化表达式后重试", 422)),
      timeoutMs,
    );
    worker.once("message", (value) => finish(null, value));
    worker.once("error", () =>
      finish(new AppError("验证码规则执行失败，请检查表达式", 422)),
    );
    worker.once("exit", () => {
      if (!done) finish(new AppError("验证码规则执行中断", 422));
    });
  });
}
function ruleInput(input, previous = {}) {
  const value = { ...previous, ...input };
  const name = textValue(value.name, 80);
  const pattern = textValue(value.pattern, 256);
  const flags = value.flags ?? "i";
  if (
    !name ||
    !pattern ||
    typeof flags !== "string" ||
    !/^(?!.*(.).*\1)[gimu]*$/.test(flags)
  )
    throw new AppError("请填写规则名称、表达式及有效标志（g、i、m、u）");
  try {
    new RegExp(pattern, flags);
  } catch {
    throw new AppError("正则表达式格式不正确");
  }
  return {
    name,
    pattern,
    flags,
    sender_filter: textValue(value.sender_filter || "", 200),
    subject_filter: textValue(value.subject_filter || "", 200),
    priority: number(value.priority ?? 10, 1, 10000, "规则顺序"),
    enabled: Number(boolean(input.enabled, Boolean(previous.enabled ?? true))),
    description: textValue(value.description || "", 500),
  };
}
export function createCodeService(store) {
  const { db, transaction } = store;
  transaction(() => {
    if (
      !db
        .prepare("SELECT key FROM app_settings WHERE key='code_rules_seeded'")
        .get()
    ) {
      const insert = db.prepare(
        "INSERT INTO code_rules(name,pattern,flags,priority) VALUES(?,?,'i',?)",
      );
      insert.run(
        "验证码关键词",
        "(?:验证码|校验码|动态码|verification\\s*code|security\\s*code|one.time\\s*(?:password|code)|\\bOTP\\b|\\bcode\\b)[^\\d\\n]{0,30}(\\d{4,8})(?!\\d)",
        10,
      );
      insert.run("六位数字", "(?<!\\d)(\\d{6})(?!\\d)", 20);
      db.prepare(
        "INSERT INTO app_settings(key,value) VALUES('code_rules_seeded','true')",
      ).run();
    }
  });
  const settings = () => ({
    ...defaults,
    ...JSON.parse(
      db.prepare("SELECT value FROM app_settings WHERE key='codes'").get()
        ?.value || "{}",
    ),
  });
  const rules = (enabled = false) =>
    db
      .prepare(
        `SELECT * FROM code_rules ${enabled ? "WHERE enabled=1" : ""} ORDER BY priority,id`,
      )
      .all();
  async function list(email, limit, { includeUnmatched = false } = {}) {
    const config = settings();
    if (!config.enabled)
      return { items: [], settings: config, receivedCount: 0, matchedCount: 0 };
    const args = [
      new Date(
        Date.now() -
          (config.historyDays > 0
            ? config.historyDays * 24
            : config.lookbackHours) *
            3600000,
      ).toISOString(),
    ];
    let where =
      "m.folder='inbox' AND m.created_at>=? AND u.active=1 AND d.enabled=1";
    where += " AND (u.is_temporary=0 OR u.temporary_expires_at>?)";
    args.push(Date.now());
    if (email) {
      const emails = Array.isArray(email) ? email : [email];
      if (!emails.length)
        return {
          items: [],
          settings: config,
          receivedCount: 0,
          matchedCount: 0,
        };
      if (emails.length > 100) throw new AppError("最多选择100个邮箱");
      where += ` AND u.email IN (${emails.map(() => "?").join(",")})`;
      args.push(...emails.map(emailAddress));
    }
    if (config.domains?.length) {
      where += ` AND d.name IN (${config.domains.map(() => "?").join(",")})`;
      args.push(...config.domains);
    }
    let messages = db
      .prepare(
        `SELECT m.id,substr(m.subject,1,500) AS subject,substr(m.body_text,1,20000) AS body_text,substr(m.from_email,1,320) AS from_email,m.created_at,u.email AS mailbox FROM messages m JOIN users u ON u.id=m.owner_id JOIN domains d ON d.id=u.domain_id WHERE ${where} ORDER BY m.id DESC LIMIT 300`,
      )
      .all(...args);
    if (config.showHistory === false) {
      const seen = new Set();
      messages = messages.filter((m) => {
        if (seen.has(m.mailbox)) return false;
        seen.add(m.mailbox);
        return true;
      });
    }
    const matches = await runCodeRules(rules(true), messages);
    const items = messages
      .map(({ body_text, ...message }, index) => ({
        ...message,
        ...matches[index],
      }))
      .filter((message) => includeUnmatched || message.code)
      .slice(0, limit || config.maxResults);
    return {
      items,
      settings: config,
      receivedCount: messages.length,
      matchedCount: matches.filter((match) => match.code).length,
    };
  }
  return { settings, rules, list };
}
export function mountCodeRoutes(router, adminRouter, store, service) {
  const { db, transaction, audit } = store;
  adminRouter.get("/code-settings", (_req, res) =>
    res.json(service.settings()),
  );
  adminRouter.put("/code-settings", (req, res) => {
    const old = service.settings(),
      input = req.body;
    const config = {
      enabled: boolean(input.enabled, old.enabled),
      allowPublicLinks: boolean(input.allowPublicLinks, old.allowPublicLinks),
      lookbackHours: number(
        input.lookbackHours ?? old.lookbackHours,
        1,
        168,
        "邮件范围（小时）",
      ),
      maxResults: number(
        input.maxResults ?? old.maxResults,
        1,
        100,
        "最多结果数",
      ),
      refreshSeconds: number(
        input.refreshSeconds ?? old.refreshSeconds,
        5,
        300,
        "刷新间隔（秒）",
      ),
      linkHours: number(
        input.linkHours ?? old.linkHours,
        1,
        720,
        "默认有效期（小时）",
      ),
      domains: domainList(input.domains, old.domains || []),
      showHistory: bool(input.showHistory, old.showHistory ?? true),
      historyDays: integer(
        input.historyDays,
        old.historyDays ?? 0,
        0,
        3650,
        "历史显示天数",
      ),
    };
    if (
      config.domains.some(
        (name) =>
          !db
            .prepare("SELECT id FROM domains WHERE name=? AND enabled=1")
            .get(name),
      )
    )
      throw new AppError("接码域名不存在或已停用");
    transaction(() => {
      db.prepare(
        "INSERT INTO app_settings(key,value) VALUES('codes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(JSON.stringify(config));
      audit(req.user.email, "codes.settings");
    });
    res.json(config);
  });
  adminRouter.get("/code-rules", (_req, res) =>
    res.json({ items: service.rules() }),
  );
  adminRouter.post("/code-rules", (req, res) => {
    if (db.prepare("SELECT count(*) AS n FROM code_rules").get().n >= 50)
      throw new AppError("最多保存 50 条规则");
    const rule = ruleInput(req.body);
    const id = transaction(() => {
      const id = Number(
        db
          .prepare(
            "INSERT INTO code_rules(name,pattern,flags,sender_filter,subject_filter,priority,enabled,description) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(...Object.values(rule)).lastInsertRowid,
      );
      audit(req.user.email, "codes.rule.create", { id });
      return id;
    });
    res.status(201).json({ id, ...rule });
  });
  adminRouter.patch("/code-rules/:id", (req, res) => {
    const id = idValue(req.params.id),
      old = db.prepare("SELECT * FROM code_rules WHERE id=?").get(id);
    if (!old) throw new AppError("规则不存在", 404);
    const rule = ruleInput(req.body, old);
    transaction(() => {
      db.prepare(
        "UPDATE code_rules SET name=?,pattern=?,flags=?,sender_filter=?,subject_filter=?,priority=?,enabled=?,description=? WHERE id=?",
      ).run(...Object.values(rule), id);
      audit(req.user.email, "codes.rule.update", { id });
    });
    res.json({ id, ...rule });
  });
  adminRouter.delete("/code-rules/:id", (req, res) => {
    const id = idValue(req.params.id);
    transaction(() => {
      db.prepare("DELETE FROM code_rules WHERE id=?").run(id);
      audit(req.user.email, "codes.rule.delete", { id });
    });
    res.json({ ok: true });
  });
  adminRouter.post("/code-rules/test", async (req, res) => {
    if (
      !Array.isArray(req.body.samples) ||
      !req.body.samples.length ||
      req.body.samples.length > 50 ||
      req.body.samples.some(
        (sample) => typeof sample !== "string" || sample.length > 20000,
      )
    )
      throw new AppError("请提供 1–50 条测试文本，每条最多 20000 字符");
    const rules = req.body.rule
      ? [{ id: 0, ...ruleInput(req.body.rule) }]
      : service.rules(true);
    const matches = await runCodeRules(
      rules,
      req.body.samples.map((text) => ({
        body_text: text,
        from_email: textValue(req.body.from_email || "", 320),
        subject: textValue(req.body.subject || "", 500),
      })),
    );
    res.json({
      items: matches.map((match, index) => ({
        input: req.body.samples[index],
        ...match,
      })),
    });
  });
  adminRouter.post("/code-rules/test-all", async (req, res) => {
    const text = req.body.text;
    if (typeof text !== "string" || !text || text.length > 20000)
      throw new AppError("请输入最多20000字符的测试内容");
    const rules = service.rules(),
      result = (
        await runCodeRules(
          rules,
          [
            {
              body_text: text,
              subject: textValue(req.body.subject || "", 500),
              from_email: textValue(req.body.from_email || "", 320),
            },
          ],
          1000,
          true,
        )
      )[0];
    const details = result.results || [];
    res.json({
      ...result,
      stats: {
        totalRules: rules.length,
        enabledRules: rules.filter((r) => r.enabled).length,
        matchedRules: details.filter((r) => r.matched).length,
        extractedRules: details.filter((r) => r.code).length,
      },
    });
  });
  mountCodeLinks(router, adminRouter, store, service);
}
