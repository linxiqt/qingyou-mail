import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { randomUUID } from "node:crypto";
import { popOctets } from "./pop-octets.js";
import {
  AppError,
  emailAddress,
  recipients,
  textValue,
  idValue,
} from "./security.js";
import { postWebhook } from "./webhooks.js";
import { createOutbound } from "./outbound.js";
import { signWithRspamd } from "./rspamd.js";
import { cleanHtml } from "./html.js";
import { isClientManager } from "./access.js";
import { requireCapability } from "./admin-permissions.js";

export const folders = ["inbox", "sent", "drafts", "trash", "archive", "spam"];
export function extractCode(text) {
  return (
    String(text).match(
      /(?:验证码|校验码|动态码|verification\s*code|security\s*code|one.time\s*(?:password|code)|\bOTP\b|\bcode\b)[^\d\n]{0,30}(\d{4,8})(?!\d)/i,
    )?.[1] ||
    String(text).match(/(?<!\d)\d{6}(?!\d)/)?.[0] ||
    null
  );
}
export function createMailService(store, config, license) {
  const { db, transaction } = store;
  const outbound = createOutbound(config, config.outboundDependencies);
  function signingKey(sender) {
    const domain = sender.split("@")[1];
    if (config.dkimBackend !== "rspamd" && config.dkim?.domainName === domain)
      return config.dkim;
    const key = db
      .prepare(
        "SELECT k.* FROM domain_keys k JOIN domains d ON d.id=k.domain_id WHERE d.name=?",
      )
      .get(domain || "");
    return key
      ? {
          domainName: domain,
          keySelector: key.selector,
          privateKey: key.private_key,
        }
      : undefined;
  }
  let stopped = false;
  let working = false;
  let idleResolve;
  const activeUser = (id) =>
    db
      .prepare(
        "SELECT u.* FROM users u JOIN domains d ON d.id=u.domain_id WHERE u.id=? AND u.active=1 AND d.enabled=1 AND (u.is_temporary=0 OR u.temporary_expires_at>?)",
      )
      .get(id, Date.now());
  const localUser = (email) =>
    db
      .prepare(
        "SELECT u.* FROM users u JOIN domains d ON d.id=u.domain_id WHERE u.email=? AND d.name<>'' AND u.active=1 AND d.enabled=1 AND (u.is_temporary=0 OR u.temporary_expires_at>?)",
      )
      .get(email, Date.now());
  const recipientUser = (email) => {
    if (!email.includes("@")) return undefined;
    const exact = db.prepare("SELECT id FROM users WHERE email=?").get(email);
    if (exact) return activeUser(exact.id);
    const catchall = db
      .prepare(
        "SELECT c.user_id FROM domain_catchalls c JOIN domains d ON d.id=c.domain_id WHERE d.name=? AND d.enabled=1 AND c.enabled=1",
      )
      .get(email.split("@")[1]);
    return catchall ? activeUser(catchall.user_id) : undefined;
  };
  const catchallForward = (email) => {
    if (
      !email.includes("@") ||
      db.prepare("SELECT 1 FROM users WHERE email=?").get(email)
    )
      return undefined;
    const rule = db
      .prepare(
        "SELECT f.* FROM catchall_forwards f JOIN domains d ON d.id=f.domain_id WHERE d.name=? AND d.enabled=1 AND f.enabled=1",
      )
      .get(email.split("@")[1]);
    return rule && activeUser(rule.created_by) ? rule : undefined;
  };
  const acceptsRecipient = (email) =>
    Boolean(recipientUser(email) || catchallForward(email));
  const isLocalDomain = (email) =>
    Boolean(
      db
        .prepare("SELECT id FROM domains WHERE name=?")
        .get(email.split("@")[1]),
    );
  const usage = (id) =>
    db
      .prepare(
        "SELECT coalesce(sum(size),0) AS bytes FROM messages WHERE owner_id=?",
      )
      .get(id).bytes;
  function checkQuota(user, bytes) {
    if (usage(user.id) + bytes > user.quota_bytes)
      throw new AppError(`邮箱空间不足：${user.email}`, 422, 452);
  }
  function routes(addresses) {
    const local = new Map();
    const external = new Set();
    const externalOwners = new Map();
    let ownerId;
    function visit(address, path = [], owner) {
      if (path.includes(address) || path.length > 10)
        throw new AppError("邮件转发规则存在循环", 422);
      const catchall = catchallForward(address);
      if (catchall) {
        ownerId ??= catchall.created_by;
        visit(
          catchall.target,
          [...path, address],
          owner || catchall.created_by,
        );
        return;
      }
      const user = recipientUser(address);
      if (!user) {
        if (isLocalDomain(address))
          throw new AppError(`本地邮箱不存在或已停用：${address}`, 422);
        if (outbound.mode === "local")
          throw new AppError(
            "外部投递已关闭，当前只允许向本地邮箱发送",
            422,
            451,
          );
        external.add(address);
        externalOwners.set(address, owner);
        return;
      }
      ownerId ??= user.id;
      const rules = db
        .prepare("SELECT * FROM forwards WHERE user_id=? AND enabled=1")
        .all(user.id);
      if (!rules.length || rules.some((rule) => rule.keep_copy))
        local.set(user.id, user);
      for (const rule of rules)
        visit(rule.target, [...path, address], owner || user.id);
    }
    for (const address of addresses) visit(address);
    if (external.size + local.size > 200) throw new AppError("转发目标过多");
    return {
      local: [...local.values()],
      external: [...external],
      ownerId,
      externalOwners,
    };
  }
  async function parse(raw) {
    const parsed = await simpleParser(raw, {
      maxHtmlLengthToParse: config.maxMessageBytes,
      skipImageLinks: true,
    });
    return {
      from_email: parsed.from?.value[0]?.address || "",
      popOctets: popOctets(raw),
      from_count: parsed.from?.value.length || 0,
      from_name: parsed.from?.value[0]?.name || "",
      to: parsed.to?.value || [],
      cc: parsed.cc?.value || [],
      bcc: [],
      subject: parsed.subject || "",
      body_text: parsed.text || "",
      body_html: sanitizeHtml(parsed.html || "", {
        allowedTags: [
          "p",
          "br",
          "div",
          "span",
          "b",
          "strong",
          "i",
          "em",
          "u",
          "s",
          "blockquote",
          "pre",
          "code",
          "h1",
          "h2",
          "h3",
          "h4",
          "ul",
          "ol",
          "li",
          "hr",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
          "a",
        ],
        allowedAttributes: { a: ["href", "target", "rel"] },
        allowedSchemes: ["https", "http", "mailto"],
        transformTags: {
          a: sanitizeHtml.simpleTransform("a", {
            target: "_blank",
            rel: "noopener noreferrer",
          }),
        },
      }),
      attachments: parsed.attachments || [],
      message_id:
        parsed.messageId || `<${randomUUID()}@${config.mailHostname}>`,
    };
  }
  function insert(user, folder, parsed, raw, status, notifyInbox = true) {
    checkQuota(user, raw.length);
    const result = db
      .prepare(
        `INSERT INTO messages(owner_id,folder,from_email,from_name,to_json,cc_json,bcc_json,subject,body_text,body_html,snippet,raw,size,is_read,delivery_status,message_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        user.id,
        folder,
        parsed.from_email,
        parsed.from_name,
        JSON.stringify(parsed.to),
        JSON.stringify(parsed.cc),
        JSON.stringify(folder === "inbox" ? [] : parsed.bcc || []),
        parsed.subject,
        parsed.body_text,
        parsed.body_html,
        parsed.body_text.replace(/\s+/g, " ").slice(0, 180),
        raw,
        raw.length,
        folder === "inbox" ? 0 : 1,
        status,
        parsed.message_id,
      );
    const id = Number(result.lastInsertRowid);
    db.prepare(
      "UPDATE protocol_messages SET pop_octets=? WHERE message_id=?",
    ).run(parsed.popOctets ?? popOctets(raw), id);
    for (const a of parsed.attachments)
      db.prepare(
        "INSERT INTO attachments(message_id,filename,content_type,size,content) VALUES(?,?,?,?,?)",
      ).run(
        id,
        a.filename || "attachment",
        a.contentType || "application/octet-stream",
        a.content.length,
        a.content,
      );
    if (folder === "inbox" && notifyInbox) {
      const payload = JSON.stringify({
        id: randomUUID(),
        event: "mail.received",
        timestamp: new Date().toISOString(),
        data: {
          id,
          mailbox: user.email,
          from: parsed.from_email,
          to: parsed.to,
          subject: parsed.subject,
          text: parsed.body_text.slice(0, 100000),
          code: extractCode(`${parsed.subject}\n${parsed.body_text}`),
          attachments: parsed.attachments.map((a) => ({
            filename: a.filename,
            size: a.content.length,
          })),
        },
      });
      for (const hook of db
        .prepare("SELECT id FROM webhooks WHERE enabled=1")
        .all())
        db.prepare(
          "INSERT INTO webhook_jobs(webhook_id,payload) VALUES(?,?)",
        ).run(hook.id, payload);
    }
    return id;
  }
  function queue(route, sender, parsed, raw, sentId, ownerId) {
    for (const user of route.local)
      insert(user, "inbox", parsed, raw, "received");
    for (const recipient of route.external)
      db.prepare(
        "INSERT INTO delivery_jobs(message_id,owner_id,sender,recipient,raw) VALUES(?,?,?,?,?)",
      ).run(
        sentId,
        ownerId || route.externalOwners?.get(recipient) || route.ownerId,
        sender,
        recipient,
        raw,
      );
  }
  async function compose(user, input, draft = false) {
    if (!user.email.includes("@"))
      throw new AppError("请先添加邮件域名和邮箱，再选择发件邮箱");
    const to = recipients(input.to);
    const cc = recipients(input.cc);
    const bcc = recipients(input.bcc);
    if (!draft && !to.length && !cc.length && !bcc.length)
      throw new AppError("请填写收件人");
    if (to.length + cc.length + bcc.length > 100)
      throw new AppError("单封邮件最多 100 个收件人");
    const subject = textValue(input.subject ?? "", 500);
    const html = input.html ? cleanHtml(String(input.html)) : "";
    const text = String(
      input.text ||
        (html
          ? sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
          : ""),
    );
    if (
      Buffer.byteLength(text) + Buffer.byteLength(html) >
      config.maxMessageBytes
    )
      throw new AppError("邮件正文过大", 413);
    const attachments = input.attachments || [];
    if (!Array.isArray(attachments) || attachments.length > 20)
      throw new AppError("每封邮件最多 20 个附件");
    let size = Buffer.byteLength(text) + Buffer.byteLength(html);
    const files = attachments.map((a) => {
      if (
        typeof a.content !== "string" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(a.content)
      )
        throw new AppError("附件编码无效");
      const content = Buffer.from(a.content, "base64");
      size += content.length;
      if (size > config.maxMessageBytes)
        throw new AppError("邮件和附件总大小超出限制", 413);
      return {
        filename: textValue(a.filename, 200) || "attachment",
        content,
        contentType: "application/octet-stream",
      };
    });
    const raw = await new MailComposer({
      from: { name: user.name, address: user.email },
      to,
      cc,
      bcc,
      subject,
      text,
      html: html || undefined,
      attachments: files,
      dkim: config.dkimBackend === "rspamd" ? undefined : config.dkim,
      disableFileAccess: true,
      disableUrlAccess: true,
      messageId: `<${randomUUID()}@${config.mailHostname}>`,
      date: new Date(),
    })
      .compile()
      .build();
    if (raw.length > config.maxMessageBytes)
      throw new AppError("MIME 编码后的邮件大小超出限制，请减少附件", 413);
    const parsed = await parse(raw);
    parsed.bcc = bcc.map((address) => ({ address, name: "" }));
    return { raw, parsed, addresses: [...new Set([...to, ...cc, ...bcc])] };
  }
  async function send(user, input, authorize = null) {
    authorize?.();
    license?.assertAllowed();
    if (!activeUser(user.id)) throw new AppError("账号或域名已停用", 403);
    const { raw, parsed, addresses } = await compose(user, input);
    license?.assertAllowed();
    const id = transaction(() => {
      authorize?.();
      user = activeUser(user.id);
      if (!user) throw new AppError("账号或域名已停用", 403);
      const route = routes(addresses);
      if (input.draftId) {
        const deleted = db
          .prepare(
            "DELETE FROM messages WHERE id=? AND owner_id=? AND folder='drafts'",
          )
          .run(idValue(input.draftId), user.id);
        if (!deleted.changes) throw new AppError("草稿不存在", 404);
      }
      const sentId = insert(
        user,
        "sent",
        parsed,
        raw,
        route.external.length ? "queued" : "delivered",
      );
      queue(route, user.email, parsed, raw, sentId, user.id);
      store.audit(user.email, "mail.send", {
        messageId: sentId,
        recipients: addresses.length,
      });
      return sentId;
    });
    void work();
    return { id };
  }
  async function saveDraft(user, input, authorize = null) {
    authorize?.();
    const { raw, parsed } = await compose(user, input, true);
    return transaction(() => {
      authorize?.();
      user = activeUser(user.id);
      if (!user) throw new AppError("账号或域名已停用", 403);
      if (input.id) {
        if (
          !db
            .prepare(
              "DELETE FROM messages WHERE id=? AND owner_id=? AND folder='drafts'",
            )
            .run(idValue(input.id), user.id).changes
        )
          throw new AppError("草稿不存在", 404);
      }
      return { id: insert(user, "drafts", parsed, raw, "draft") };
    });
  }
  async function receive(
    raw,
    envelope,
    authenticatedUser,
    remote = "unknown",
    authorize = null,
  ) {
    if (authenticatedUser) license?.assertAllowed();
    if (raw.length > config.maxMessageBytes)
      throw new AppError("邮件过大", 413, 552);
    // Blind recipients must never leak through a submitted raw message.
    const headerEnd = raw.indexOf("\r\n\r\n");
    const lfHeaderEnd = raw.indexOf("\n\n");
    const boundary = headerEnd >= 0 ? headerEnd : lfHeaderEnd;
    if (boundary < 0) throw new AppError("邮件缺少完整 MIME 头部", 400, 554);
    const header = raw
      .subarray(0, boundary)
      .toString("utf8")
      .replace(/^Bcc:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gim, "");
    if ((header.match(/^Received:/gim) || []).length >= 50)
      throw new AppError("邮件经过的转发节点过多", 422, 554);
    raw = Buffer.concat([Buffer.from(header), raw.subarray(boundary)]);
    const safeRemote = String(remote)
      .replace(/[^a-fA-F0-9:.]/g, "")
      .slice(0, 80);
    raw = Buffer.concat([
      Buffer.from(
        `Received: from [${safeRemote}] by ${config.mailHostname} with ESMTP; ${new Date().toUTCString()}\r\n`,
      ),
      raw,
    ]);
    const parsed = await parse(raw);
    if (authenticatedUser) license?.assertAllowed();
    if (
      authenticatedUser &&
      (parsed.from_count !== 1 ||
        parsed.from_email.toLowerCase() !== authenticatedUser.email)
    )
      throw new AppError("From 必须与登录邮箱一致", 403, 553);
    return transaction(() => {
      const addresses = envelope.to.map(emailAddress);
      if (authenticatedUser) {
        authenticatedUser = authorize
          ? authorize()
          : activeUser(authenticatedUser.id);
        if (!authenticatedUser) throw new AppError("账号已停用", 403);
        if (isClientManager(authenticatedUser))
          requireCapability(authenticatedUser, "mail.send");
      }
      if (!authenticatedUser && addresses.some((a) => !acceptsRecipient(a)))
        throw new AppError("Relay denied", 403);
      const route = routes(addresses);
      const ownerId = authenticatedUser?.id;
      const id = authenticatedUser
        ? insert(
            authenticatedUser,
            "sent",
            parsed,
            raw,
            route.external.length ? "queued" : "delivered",
          )
        : null;
      queue(route, envelope.from, parsed, raw, id, ownerId);
      return { id };
    });
  }
  function updateStatus(messageId) {
    if (!messageId) return;
    const jobs = db
      .prepare("SELECT state FROM delivery_jobs WHERE message_id=?")
      .all(messageId);
    const status = jobs.some((j) => ["queued", "sending"].includes(j.state))
      ? "queued"
      : jobs.every((j) => j.state === "delivered")
        ? "delivered"
        : jobs.some((j) => j.state === "delivered")
          ? "partial"
          : "failed";
    db.prepare("UPDATE messages SET delivery_status=? WHERE id=?").run(
      status,
      messageId,
    );
  }
  async function failureNotice(job, reason) {
    // Notify only a local submitter. Never bounce to an unverified Internet sender.
    if (!job.message_id) return;
    const user = activeUser(job.owner_id);
    if (!user) return;
    const original = db
      .prepare("SELECT subject FROM messages WHERE id=? AND owner_id=?")
      .get(job.message_id, user.id);
    if (!original) return;
    const raw = await new MailComposer({
      from: {
        name: "邮局投递通知",
        address: `mailer-daemon@${config.mailHostname}`,
      },
      to: user.email,
      subject: `邮件投递失败：${original.subject || "（无主题）"}`,
      text: `邮件未能投递。\n\n收件人：${job.recipient}\n原邮件主题：${original.subject}\n原因：${String(reason).slice(0, 1000)}\n\n你可以在发件箱查看状态，管理员可在邮局管理中重试。`,
      headers: {
        "Auto-Submitted": "auto-generated",
        "X-Auto-Response-Suppress": "All",
      },
      messageId: `<${randomUUID()}@${config.mailHostname}>`,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
      .compile()
      .build();
    const parsed = await parse(raw);
    transaction(() => insert(user, "inbox", parsed, raw, "received"));
  }
  async function work() {
    if (working || stopped || license?.status().valid === false) return;
    working = true;
    try {
      db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
      for (let i = 0; i < 20 && !stopped; i++) {
        if (license?.status().valid === false) break;
        const job = db
          .prepare(
            "SELECT * FROM delivery_jobs WHERE state='queued' AND next_attempt<=? ORDER BY id LIMIT 1",
          )
          .get(Date.now());
        if (!job) break;
        db.prepare(
          "UPDATE delivery_jobs SET state='sending',attempts=attempts+1 WHERE id=?",
        ).run(job.id);
        try {
          if (!activeUser(job.owner_id))
            throw new AppError("所属邮箱或域名已停用", 403);
          const key = signingKey(job.sender);
          let raw = Buffer.from(job.raw);
          if (config.dkimBackend === "rspamd" && key)
            raw = await signWithRspamd(config, {
              raw,
              sender: job.sender,
              recipient: job.recipient,
              domain: key.domainName,
              selector: key.keySelector,
            });
          if (
            config.dkimBackend === "rspamd" &&
            !key &&
            isLocalDomain(job.sender)
          )
            throw Object.assign(
              new Error("发件域名缺少 Rspamd DKIM 密钥，稍后重试"),
              { responseCode: 451 },
            );
          if (license?.status().valid === false) {
            db.prepare(
              "UPDATE delivery_jobs SET state='queued',attempts=? WHERE id=?",
            ).run(job.attempts, job.id);
            break;
          }
          await outbound.sendMail({
            envelope: { from: job.sender, to: [job.recipient] },
            raw,
            dkim: config.dkimBackend === "rspamd" ? undefined : key,
            disableFileAccess: true,
            disableUrlAccess: true,
          });
          db.prepare(
            "UPDATE delivery_jobs SET state='delivered',last_error='',delivered_at=? WHERE id=?",
          ).run(new Date().toISOString(), job.id);
        } catch (error) {
          if (license?.status().valid === false) {
            db.prepare(
              "UPDATE delivery_jobs SET state='queued',attempts=? WHERE id=?",
            ).run(job.attempts, job.id);
            break;
          }
          const failed =
            job.attempts + 1 >= (config.deliveryMaxAttempts || 48) ||
            Date.now() - Date.parse(job.created_at) >=
              (config.deliveryMaxAgeMs || 5 * 86400000) ||
            error.responseCode >= 500 ||
            error.status === 403;
          db.prepare(
            "UPDATE delivery_jobs SET state=?,last_error=?,next_attempt=? WHERE id=?",
          ).run(
            failed ? "failed" : "queued",
            String(error.message).slice(0, 1000),
            Date.now() +
              Math.min(4 * 3600000, 60000 * 2 ** Math.min(job.attempts, 8)),
            job.id,
          );
          if (failed) {
            try {
              await failureNotice(job, error.message);
            } catch (noticeError) {
              console.error("投递失败通知未入库", job.id, noticeError.message);
            }
          }
        }
        updateStatus(job.message_id);
      }
      for (let i = 0; i < 20 && !stopped; i++) {
        if (license?.status().valid === false) break;
        const job = db
          .prepare(
            "SELECT j.*,w.url,w.secret FROM webhook_jobs j JOIN webhooks w ON w.id=j.webhook_id WHERE j.state='queued' AND j.next_attempt<=? AND w.enabled=1 ORDER BY j.id LIMIT 1",
          )
          .get(Date.now());
        if (!job) break;
        db.prepare(
          "UPDATE webhook_jobs SET state='sending',attempts=attempts+1 WHERE id=?",
        ).run(job.id);
        try {
          await postWebhook(job, job.payload, config.webhookAllowPrivate);
          db.prepare(
            "UPDATE webhook_jobs SET state='delivered',last_error='' WHERE id=?",
          ).run(job.id);
        } catch (error) {
          db.prepare(
            "UPDATE webhook_jobs SET state=?,last_error=?,next_attempt=? WHERE id=?",
          ).run(
            job.attempts + 1 >= 5 ? "failed" : "queued",
            String(error.message).slice(0, 1000),
            Date.now() + 60000 * 2 ** job.attempts,
            job.id,
          );
        }
      }
    } finally {
      working = false;
      idleResolve?.();
    }
  }
  const timer = setInterval(() => void work(), 10000);
  timer.unref();
  return {
    send,
    receive,
    saveDraft,
    compose,
    parse,
    insert,
    localUser,
    recipientUser,
    acceptsRecipient,
    isLocalDomain,
    activeUser,
    usage,
    work,
    assertSendingAllowed: () => license?.assertAllowed(),
    outboundMode: outbound.mode,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (working)
        await new Promise((resolve) => {
          idleResolve = resolve;
        });
      outbound.close();
    },
  };
}
