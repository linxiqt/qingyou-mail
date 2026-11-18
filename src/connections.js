import http from "node:http";
import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import {
  AppError,
  textValue,
  idValue,
  emailAddress,
  domainName,
  recipients,
  passwordValid,
  token,
} from "./security.js";
import { webhookTarget } from "./webhooks.js";
import { generateAccounts } from "./account-generator.js";
import {
  getSetting,
  putSetting,
  integer,
  bool,
  mapConcurrent,
} from "./settings.js";
import { cleanHtml } from "./html.js";

const md5 = (value) => createHash("md5").update(value).digest("hex");
export function scrubRemote(value) {
  if (Array.isArray(value)) return value.map(scrubRemote);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(?:password(?:_encode|_hash)?|private[_-]?key|key_pem|secret|key|api[_-]?key|authorization|.*token)$/i.test(
              key,
            ),
        )
        .map(([key, data]) => [key, scrubRemote(data)]),
    );
  return value;
}
export async function connectionRequest(
  connection,
  path,
  { method = "GET", body, allowPrivate = false, binary = false } = {},
) {
  const base = new URL(connection.url),
    url = new URL(path, base);
  if (url.origin !== base.origin) throw new AppError("远程接口地址无效");
  let destination;
  try {
    destination = await webhookTarget(url.href, allowPrivate);
  } catch (error) {
    throw new AppError(error.message.replaceAll("Webhook", "邮局API"));
  }
  const data =
    body === undefined
      ? null
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const headers = { Accept: "application/json" };
  if (connection.type === "baota")
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  else {
    headers["Content-Type"] = "application/json";
    headers.Authorization = `Bearer ${connection.secret}`;
  }
  if (data !== null) headers["Content-Length"] = Buffer.byteLength(data);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        headers,
        timeout: 15000,
        ...(connection.ca_pem ? { ca: connection.ca_pem } : {}),
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [destination.address])
            : callback(
                null,
                destination.address.address,
                destination.address.family,
              ),
      },
      (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new AppError(`远程邮局返回 HTTP ${response.statusCode}`, 502));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 5 * 1024 * 1024) {
            request.destroy();
            reject(new AppError("远程响应超过5MB，请缩小查询范围", 502));
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new AppError("读取远程响应失败", 502)),
        );
        response.on("end", () => {
          try {
            if (binary) {
              resolve(Buffer.concat(chunks));
              return;
            }
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (
              value?.success === false ||
              value?.status === false ||
              (typeof value?.code === "number" &&
                value.code !== 0 &&
                value.code !== 200)
            )
              throw new AppError(
                "远程邮局拒绝了此操作，请检查接口权限和参数",
                502,
              );
            resolve(value);
          } catch (error) {
            reject(
              error instanceof AppError
                ? error
                : new AppError(
                    "远程邮局未返回有效JSON，请检查API地址和访问权限",
                    502,
                  ),
            );
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) =>
      reject(
        new AppError(
          /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(error.code || "")
            ? "远程证书校验失败，请配置匹配主机名的证书或上传CA证书"
            : "远程邮局连接失败或超时；操作结果请刷新核对",
          502,
        ),
      ),
    );
    request.end(data);
  });
}
export function createConnectionAdapter(connection, config) {
  const raw = (path, method = "GET", body) =>
    connectionRequest(connection, path, {
      method,
      body,
      allowPrivate: config.remoteApiAllowPrivate,
    });
  const bt = async (action, params = {}) => {
    const time = String(Math.floor(Date.now() / 1000)),
      form = new URLSearchParams({
        request_time: time,
        request_token: md5(time + md5(connection.secret)),
        ...Object.fromEntries(
          Object.entries(params).map(([k, v]) => [
            k,
            typeof v === "object" ? JSON.stringify(v) : String(v),
          ]),
        ),
      });
    return raw(
      `plugin?action=a&name=mail_sys&s=${encodeURIComponent(action)}`,
      "POST",
      form.toString(),
    );
  };
  const list = (value) =>
    Array.isArray(value)
      ? value
      : Array.isArray(value?.items)
        ? value.items
        : Array.isArray(value?.data)
          ? value.data
          : Array.isArray(value?.data?.list)
            ? value.data.list
            : Array.isArray(value?.data?.data)
              ? value.data.data
              : [];
  const data = (value) => value?.data ?? value;
  const capabilities =
    connection.type === "billionmail"
      ? ["domains", "accounts", "send", "bulk-send", "templates", "forwards"]
      : [
          "domains",
          "accounts",
          "inbox",
          "sent",
          "send",
          "bulk-send",
          "forwards",
        ];
  async function resource(name, query = {}) {
    if (!capabilities.includes(name))
      throw new AppError("当前邮局接口不提供此项能力", 422);
    const page = integer(query.page, 1, 1, 100000, "页码"),
      limit = integer(query.limit, 30, 1, 100, "每页数量");
    let response;
    if (connection.type === "node") {
      const paths = {
        domains: "domains",
        accounts: "accounts",
        inbox: "messages",
        sent: "messages",
        forwards: "forwards",
      };
      if (name === "templates")
        throw new AppError("远程Node邮局的模板在本地模板页管理", 422);
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (query.domain) params.set("domain", domainName(query.domain));
      if (query.email) params.set("emails", emailAddress(query.email));
      if (query.q) params.set("q", textValue(query.q, 100));
      if (["inbox", "sent"].includes(name)) params.set("folder", name);
      response = await raw(`api/v1/manage/${paths[name]}?${params}`);
    } else if (connection.type === "baota") {
      const actions = {
        domains: "get_domains",
        accounts: "get_mailboxs",
        inbox: "get_mails",
        sent: "get_sent_mails",
        forwards: "get_forward",
      };
      if (name === "templates")
        return { items: [], page, total: 0, capabilities };
      if (["inbox", "sent"].includes(name) && !query.email)
        throw new AppError("请先选择要查看的邮箱");
      response = await bt(actions[name], {
        p: page,
        size: limit,
        ...(query.domain ? { domain: domainName(query.domain) } : {}),
        ...(query.email ? { username: emailAddress(query.email) } : {}),
      });
    } else {
      const paths = {
        domains: "domains/all",
        accounts: "mailbox/all",
        templates: "email_template/list",
        forwards: "mail_forward/list",
      };
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(limit),
      });
      if (query.domain) params.set("domain", domainName(query.domain));
      if (query.q) params.set("keyword", textValue(query.q, 100));
      response = await raw(`api/${paths[name]}?${params}`);
    }
    let items = list(response);
    if (name === "accounts")
      items = items.map((item) => ({
        id: item.id ?? item.username,
        email: item.email || item.username,
        name: item.name || item.full_name || item.username,
        role: item.role || (item.is_admin ? "admin" : "user"),
        active: Number(item.active ?? 1) !== 0,
        quota_bytes: item.quota_bytes ?? item.quota ?? 0,
        used_bytes: item.used_bytes ?? item.used_quota ?? 0,
        domain:
          item.domain || (item.username || item.email || "").split("@")[1],
        created_at:
          item.created_at ||
          (item.create_time
            ? new Date(item.create_time * 1000).toISOString()
            : item.created),
      }));
    if (name === "domains")
      items = items.map((item) => ({
        ...item,
        name: item.name || item.domain,
        enabled: Number(item.enabled ?? item.active ?? 1) !== 0,
      }));
    if (name === "inbox" || name === "sent")
      items = items.map((item) => ({
        ...item,
        body_html: cleanHtml(item.body_html || item.html || ""),
        subject: item.subject || item.title || "",
        from_email: item.from_email || item.from || "",
        created_at: item.created_at || item.date || "",
        mailbox: query.email || item.mailbox,
      }));
    return {
      items: scrubRemote(items),
      page,
      limit,
      total: Number(response?.total ?? response?.data?.total ?? items.length),
      capabilities,
    };
  }
  async function action(operation, input = {}) {
    if (
      connection.type !== "node" &&
      ["send", "bulk-send"].includes(operation) &&
      (input.attachments?.length || input.cc?.length || input.bcc?.length)
    )
      throw new AppError(
        "此远程面板适配器暂不支持附件、抄送或密送，请在原面板发送",
      );
    const email = input.email ? emailAddress(input.email) : undefined,
      domain = input.domain ? domainName(input.domain) : email?.split("@")[1];
    if (operation.startsWith("domain.") && !domain)
      throw new AppError("请填写域名");
    if (operation.startsWith("account.") && !email)
      throw new AppError("请填写邮箱地址");
    const forward = operation.startsWith("forward.");
    const forwardAddress = forward ? emailAddress(input.email) : "";
    const forwardTarget =
      forward && operation !== "forward.delete"
        ? emailAddress(input.target)
        : "";
    const catchall =
      operation === "domain.catchall" && input.enabled !== false
        ? emailAddress(input.target || input.email)
        : "";
    const quota =
      integer(input.quotaMB, 1024, 1, 1048576, "邮箱配额MB") * 1048576;
    if (
      operation === "account.create" ||
      (operation === "account.update" && input.password)
    )
      passwordValid(input.password);
    if (operation === "account.delete" && input.confirm !== true)
      throw new AppError("请确认删除远程邮箱及邮件");
    if (operation === "domain.delete" && input.confirmDomain !== domain)
      throw new AppError("请填写完整域名确认删除");
    if (connection.type === "node") {
      const id = input.id === undefined ? undefined : idValue(input.id);
      const paths = {
        "account.create": ["accounts", "POST", { ...input, email }],
        "account.update": [`accounts/${id}`, "PATCH", input],
        "account.delete": [
          "accounts/delete",
          "POST",
          { ids: [id], confirm: true },
        ],
        "domain.create": ["domains", "POST", { name: domain }],
        "domain.update": [
          `domains/${id}`,
          "PATCH",
          { enabled: bool(input.enabled, true) },
        ],
        "domain.delete": [
          `domains/${id}`,
          "DELETE",
          { cascade: true, confirmDomain: domain },
        ],
        "domain.catchall": [
          `domains/${id}/catchall`,
          "PUT",
          { email: input.target, enabled: input.enabled },
        ],
        "forward.create": ["forwards", "POST", input],
        "forward.update": [`forwards/${id}`, "PATCH", input],
        "forward.delete": ["forwards/delete", "POST", { ids: [id] }],
        send: ["send", "POST", input],
        "bulk-send": ["bulk-send", "POST", input],
      };
      const request = paths[operation];
      if (!request) throw new AppError("不支持此远程操作");
      return raw("api/v1/manage/" + request[0], request[1], request[2]);
    }
    if (connection.type === "baota") {
      const requests = {
        "account.create": [
          "add_mailbox",
          {
            username: email,
            password: input.password,
            full_name: textValue(input.name || email?.split("@")[0] || ""),
            quota: `${quota / 1048576} MB`,
            is_admin: 0,
          },
        ],
        "account.update": [
          "update_mailbox",
          {
            username: email,
            ...(input.password ? { password: input.password } : {}),
            ...(input.name ? { full_name: textValue(input.name) } : {}),
            quota: `${quota / 1048576} MB`,
            active: Number(bool(input.active, true)),
            is_admin: 0,
          },
        ],
        "account.delete": ["delete_mailbox", { username: email }],
        "domain.create": [
          "add_domain",
          {
            domain,
            hostname: input.hostname || `mail.${domain}`,
            mailbox_quota: quota,
            quota: quota * 100,
          },
        ],
        "domain.update": [
          "update_domain",
          { domain, active: Number(bool(input.enabled, true)) },
        ],
        "domain.delete": ["delete_domain", { domain }],
        "domain.catchall": ["set_catchall", { domain, email: catchall }],
        "forward.create": [
          "add_forward",
          {
            address: forwardAddress,
            goto: forwardTarget,
            active: Number(bool(input.enabled, true)),
          },
        ],
        "forward.update": [
          "edit_forward",
          {
            address: forwardAddress,
            goto: forwardTarget,
            active: Number(bool(input.enabled, true)),
          },
        ],
        "forward.delete": ["delete_forward", { address: forwardAddress }],
      };
      if (operation === "send" || operation === "bulk-send") {
        const to = recipients(input.recipients || input.to, true),
          from = emailAddress(input.from),
          subject = textValue(input.subject, 500),
          content = input.html
            ? cleanHtml(input.html)
            : String(input.text || "");
        if (Buffer.byteLength(content) > config.maxMessageBytes)
          throw new AppError("邮件正文过大");
        const results = [];
        for (const recipient of to) {
          const response = await bt("send_mail", {
            mail_from: from,
            mail_to: recipient,
            subject,
            content,
            subtype: input.html ? "html" : "text",
            ...(input.senderPassword ? { password: input.senderPassword } : {}),
          });
          results.push({
            email: recipient,
            ok: true,
            response: scrubRemote(response),
          });
        }
        return { items: results };
      }
      const request = requests[operation];
      if (!request) throw new AppError("不支持此远程操作");
      return bt(request[0], request[1]);
    }
    const baseAccount = {
      domain,
      local_part: email?.split("@")[0],
      full_name: textValue(input.name || email?.split("@")[0] || ""),
      active: Number(bool(input.active, true)),
      isAdmin: 0,
      quota,
      quota_active: 1,
      ...(input.password ? { password: input.password } : {}),
    };
    if (operation === "account.update" && !input.password)
      throw new AppError("当前BillionMail更新接口要求同时提供邮箱密码");
    const requests = {
      "account.create": ["mailbox/create", baseAccount],
      "account.update": ["mailbox/update", baseAccount],
      "account.delete": ["mailbox/delete", { emails: [email] }],
      "domain.create": [
        "domains/create",
        {
          domain,
          hostname: input.hostname || `mail.${domain}`,
          mailboxes: 100,
          mailboxQuota: quota,
          quota: quota * 100,
          rateLimit: 12,
        },
      ],
      "domain.update": [
        "domains/update",
        {
          domain,
          active: Number(bool(input.enabled, true)),
          mailboxes: 100,
          mailboxQuota: quota,
          quota: quota * 100,
          rateLimit: 12,
        },
      ],
      "domain.delete": ["domains/delete", { domain }],
      "forward.create": [
        "mail_forward/add",
        {
          address: forwardAddress,
          goto: forwardTarget,
          domain,
          active: Number(bool(input.enabled, true)),
        },
      ],
      "forward.update": [
        "mail_forward/edit",
        {
          address: forwardAddress,
          goto: forwardTarget,
          active: Number(bool(input.enabled, true)),
        },
      ],
      "forward.delete": ["mail_forward/delete", { address: forwardAddress }],
      "template.create": [
        "email_template/create",
        {
          temp_name: textValue(input.name || "青邮模板"),
          add_type: 0,
          html_content: cleanHtml(input.html || input.text || ""),
        },
      ],
    };
    if (operation === "send" || operation === "bulk-send") {
      const to = recipients(input.recipients || input.to, true),
        from = emailAddress(input.from),
        subject = textValue(input.subject, 500),
        name = `postoffice-${Date.now()}-${token(6)}`;
      const html = cleanHtml(
        input.html ||
          `<p>${String(input.text || "")
            .replace(
              /[&<>]/g,
              (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
            )
            .replace(/\n/g, "<br>")}</p>`,
      );
      if (Buffer.byteLength(html) > config.maxMessageBytes)
        throw new AppError("邮件正文过大");
      const template = input.templateId
        ? idValue(input.templateId)
        : Number(
            data(
              await raw("api/email_template/create", "POST", {
                temp_name: name,
                add_type: 0,
                html_content: html,
              }),
            )?.id,
          );
      if (!template) throw new AppError("远程邮局未返回模板ID", 502);
      const created = await raw("api/contact/group/create", "POST", {
        name,
        description: "青邮投递任务",
        create_type: 1,
        double_optin: 0,
      });
      let group = Number(data(created)?.id || data(created)?.group_id);
      if (!group) {
        const groups = list(
          await raw(
            `api/contact/group/list?page=1&page_size=100&keyword=${encodeURIComponent(name)}`,
          ),
        );
        group = Number(groups.find((g) => g.name === name)?.id);
      }
      if (!group) throw new AppError("远程邮局未返回联系人分组ID", 502);
      await raw("api/contact/group/import", "POST", {
        group_ids: [group],
        contacts: to.join("\n"),
        import_type: 2,
        default_active: 1,
        status: 1,
        overwrite: 0,
      });
      const task = await raw("api/batch_mail/task/create", "POST", {
        addresser: from,
        subject,
        template_id: template,
        group_id: group,
        is_record: 1,
        unsubscribe: 1,
        threads: 4,
        track_open: 0,
        track_click: 0,
        start_time: Math.floor(Date.now() / 1000),
        warmup: 0,
        remark: name,
      });
      return {
        accepted: true,
        taskId: data(task)?.id,
        recipients: to.length,
        templateId: template,
        groupId: group,
      };
    }
    const request = requests[operation];
    if (!request) throw new AppError("当前远程邮局不支持此操作", 422);
    return raw("api/" + request[0], "POST", request[1]);
  }
  return { resource, action, capabilities };
}
export function mountConnectionRoutes(adminRouter, store, config) {
  const { db, audit } = store;
  // Keep saved credentials/configuration for a later release, but do not allow
  // direct URLs or stale client selections to invoke remote operations.
  adminRouter.use("/connections", (_req, _res, next) =>
    next(new AppError("多邮局管理暂时停用，已有连接配置保留", 403)),
  );
  const metadata = (row) =>
    row && {
      id: row.id,
      name: row.name,
      type: row.type,
      url: row.url,
      enabled: row.enabled,
      hasSecret: Boolean(row.secret),
      ca_pem: row.ca_pem,
      last_status: row.last_status,
      last_checked_at: row.last_checked_at,
      created_at: row.created_at,
    };
  function connection(req) {
    const row = db
      .prepare("SELECT * FROM mail_connections WHERE id=? AND enabled=1")
      .get(idValue(req.params.id));
    if (!row) throw new AppError("邮局连接不存在或已停用", 404);
    return row;
  }
  function nodeConnection(req) {
    const row = connection(req);
    if (row.type !== "node")
      throw new AppError(
        "此操作仅支持青邮 Node.js 远程邮局，请在原面板操作",
        422,
      );
    return row;
  }
  const nodePath = (req, suffix = "") =>
    `api/v1/manage/messages/${idValue(req.params.messageId)}${suffix}`;
  adminRouter.get("/connections/:id/messages/:messageId", async (req, res) => {
    const row = nodeConnection(req),
      message = await connectionRequest(row, nodePath(req), {
        allowPrivate: config.remoteApiAllowPrivate,
      });
    res.json({
      ...scrubRemote(message),
      body_html: cleanHtml(message.body_html || ""),
    });
  });
  adminRouter.patch("/connections/:id/messages/:messageId", async (req, res) =>
    res.json(
      await connectionRequest(nodeConnection(req), nodePath(req), {
        method: "PATCH",
        body: req.body,
        allowPrivate: config.remoteApiAllowPrivate,
      }),
    ),
  );
  adminRouter.post(
    "/connections/:id/messages/:messageId/restore",
    async (req, res) =>
      res.json(
        await connectionRequest(
          nodeConnection(req),
          nodePath(req, "/restore"),
          {
            method: "POST",
            body: {},
            allowPrivate: config.remoteApiAllowPrivate,
          },
        ),
      ),
  );
  adminRouter.delete("/connections/:id/messages/:messageId", async (req, res) =>
    res.json(
      await connectionRequest(nodeConnection(req), nodePath(req), {
        method: "DELETE",
        body: {},
        allowPrivate: config.remoteApiAllowPrivate,
      }),
    ),
  );
  adminRouter.get(
    "/connections/:id/messages/:messageId/raw",
    async (req, res) =>
      res
        .attachment(`message-${idValue(req.params.messageId)}.eml`)
        .type("message/rfc822")
        .send(
          await connectionRequest(nodeConnection(req), nodePath(req, "/raw"), {
            binary: true,
            allowPrivate: config.remoteApiAllowPrivate,
          }),
        ),
  );
  adminRouter.get(
    "/connections/:id/attachments/:attachmentId",
    async (req, res) =>
      res
        .attachment(
          textValue(
            String(
              req.query.filename ||
                `attachment-${idValue(req.params.attachmentId)}`,
            ),
            200,
          ),
        )
        .type("application/octet-stream")
        .send(
          await connectionRequest(
            nodeConnection(req),
            `api/v1/manage/attachments/${idValue(req.params.attachmentId)}`,
            { binary: true, allowPrivate: config.remoteApiAllowPrivate },
          ),
        ),
  );
  adminRouter.get("/connections", (req, res) =>
    res.json({
      items: db
        .prepare("SELECT * FROM mail_connections ORDER BY id")
        .all()
        .map(metadata),
      currentId: getSetting(db, `connection:${req.user.id}`, { id: 0 }).id,
    }),
  );
  async function save(req, res) {
    const old = req.params.id
      ? db
          .prepare("SELECT * FROM mail_connections WHERE id=?")
          .get(idValue(req.params.id))
      : null;
    if (req.params.id && !old) throw new AppError("连接不存在", 404);
    if (
      !old &&
      db.prepare("SELECT count(*) n FROM mail_connections").get().n >= 50
    )
      throw new AppError("最多添加50个远程邮局");
    const input = req.body,
      type = input.type ?? old?.type ?? "node",
      name = textValue(input.name ?? old?.name ?? "", 80),
      secret = textValue(input.secret || old?.secret || "", 2048);
    if (
      !["node", "baota", "billionmail"].includes(type) ||
      !name ||
      secret.length < 8
    )
      throw new AppError("请填写名称、连接类型和有效API密钥");
    let target;
    try {
      target = await webhookTarget(
        input.url || old?.url,
        config.remoteApiAllowPrivate,
      );
    } catch (error) {
      throw new AppError(error.message.replaceAll("Webhook", "邮局API"));
    }
    const url = target.url;
    if (url.search) throw new AppError("邮局地址不要包含查询参数");
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    const ca = String(input.ca_pem ?? old?.ca_pem ?? "");
    if (ca.length > 16000) throw new AppError("CA证书过长");
    if (ca)
      try {
        new X509Certificate(ca);
      } catch {
        throw new AppError("CA证书格式无效，请提供PEM公钥证书");
      }
    const enabled = bool(input.enabled, Boolean(old?.enabled ?? true));
    let id = old?.id;
    if (old)
      db.prepare(
        "UPDATE mail_connections SET name=?,type=?,url=?,secret=?,ca_pem=?,enabled=?,last_status='' WHERE id=?",
      ).run(name, type, url.href, secret, ca, Number(enabled), id);
    else
      id = Number(
        db
          .prepare(
            "INSERT INTO mail_connections(name,type,url,secret,ca_pem,enabled) VALUES(?,?,?,?,?,?)",
          )
          .run(name, type, url.href, secret, ca, Number(enabled))
          .lastInsertRowid,
      );
    audit(req.user.email, old ? "connection.update" : "connection.create", {
      id,
      type,
    });
    res.status(old ? 200 : 201).json({ id });
  }
  adminRouter.post("/connections", save);
  adminRouter.patch("/connections/:id", save);
  adminRouter.delete("/connections/:id", (req, res) => {
    db.prepare("DELETE FROM mail_connections WHERE id=?").run(
      idValue(req.params.id),
    );
    audit(req.user.email, "connection.delete", { id: req.params.id });
    res.json({ ok: true });
  });
  adminRouter.post("/connections/current", (req, res) => {
    const id = integer(req.body.id, 0, 0, Number.MAX_SAFE_INTEGER, "邮局编号");
    if (
      id &&
      !db
        .prepare("SELECT id FROM mail_connections WHERE id=? AND enabled=1")
        .get(id)
    )
      throw new AppError("该邮局不可用");
    putSetting(db, `connection:${req.user.id}`, { id });
    res.json({ id });
  });
  adminRouter.post("/connections/:id/test", async (req, res) => {
    const row = connection(req);
    try {
      const data = await createConnectionAdapter(row, config).resource(
        "domains",
      );
      db.prepare(
        "UPDATE mail_connections SET last_status='ok',last_checked_at=? WHERE id=?",
      ).run(new Date().toISOString(), row.id);
      res.json({
        ok: true,
        domains: data.items.length,
        capabilities: data.capabilities,
      });
    } catch (error) {
      db.prepare(
        "UPDATE mail_connections SET last_status='error',last_checked_at=? WHERE id=?",
      ).run(new Date().toISOString(), row.id);
      throw error;
    }
  });
  adminRouter.get("/connections/:id/data/:resource", async (req, res) =>
    res.json(
      await createConnectionAdapter(connection(req), config).resource(
        req.params.resource,
        req.query,
      ),
    ),
  );
  adminRouter.post("/connections/:id/action", async (req, res) => {
    const row = connection(req),
      operation = textValue(req.body.operation, 60);
    const result = await createConnectionAdapter(row, config).action(
      operation,
      req.body.input || {},
    );
    audit(req.user.email, "connection.action", { id: row.id, operation });
    res.json(scrubRemote(result));
  });
  adminRouter.post("/connections/:id/accounts/batch", async (req, res) => {
    const row = connection(req),
      adapter = createConnectionAdapter(row, config),
      existing = await adapter.resource("accounts", {
        domain: req.body.domain,
      });
    const used = new Set(existing.items.map((u) => u.email?.toLowerCase()));
    const entries =
      req.body.entries ||
      generateAccounts(req.body, (email) => used.has(email));
    if (!Array.isArray(entries) || !entries.length || entries.length > 100)
      throw new AppError("一次创建1–100个邮箱");
    const prepared = entries.map((entry) => {
      const email = emailAddress(
        entry.email || `${entry.local}@${req.body.domain}`,
      );
      passwordValid(entry.password);
      return { ...entry, email };
    });
    const concurrency = getSetting(db, "platform", {
      batchConcurrency: 4,
    }).batchConcurrency;
    const items = await mapConcurrent(prepared, concurrency, async (entry) => {
      try {
        await adapter.action("account.create", entry);
        return { email: entry.email, password: entry.password, ok: true };
      } catch (error) {
        return { email: entry.email, ok: false, error: error.message };
      }
    });
    audit(req.user.email, "connection.batch_create", {
      id: row.id,
      count: entries.length,
    });
    res.json({ items });
  });
}
