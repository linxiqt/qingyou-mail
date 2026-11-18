// The v1 Bearer contract, checked against src/api.js and src/management.js.
// Generate standalone documents; no running server or credentials are required.
import { mkdir, writeFile } from "node:fs/promises";

const out = new URL("../docs/api/", import.meta.url);
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (description, extra = {}) => ({
  type: "string",
  ...(description ? { description } : {}),
  ...extra,
});
const int = (description, extra = {}) => ({
  type: "integer",
  ...(description ? { description } : {}),
  ...extra,
});
const bool = (description) => ({
  type: "boolean",
  ...(description ? { description } : {}),
});
const obj = (properties, required = [], extra = {}) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  ...extra,
});
const arr = (items, extra = {}) => ({ type: "array", items, ...extra });
const input = (properties, required = [], extra = {}) =>
  obj(properties, required, { additionalProperties: false, ...extra });
const id = int("服务器返回的记录 ID；不得猜测。", { minimum: 1 });
const email = str("完整邮箱地址。", {
  format: "email",
  example: "alice@example.com",
});
const addresses = {
  oneOf: [
    arr(email, { maxItems: 100 }),
    str("逗号、分号或空白分隔的邮箱地址。"),
  ],
};
const ids = arr(id, { minItems: 1, maxItems: 100 });
const folders = ["inbox", "sent", "drafts", "archive", "spam", "trash"];
const flag = int("数据库布尔值：0 否，1 是。", { enum: [0, 1] });
const date = str("服务器 ISO 8601 时间字符串。");
const mailboxLimit = int(
  "邮箱账号数量上限；null 不限，0 禁止新增；所有已存在邮箱均占名额。",
  { minimum: 0, maximum: 1000000, nullable: true },
);
const mailProps = {
  from: email,
  to: addresses,
  cc: addresses,
  bcc: addresses,
  subject: str("主题，不含换行。", { maxLength: 500, default: "" }),
  text: str("纯文本正文。"),
  html: str("可选 HTML 正文，服务端会清洗。"),
  attachments: arr(ref("SendAttachment"), { maxItems: 20 }),
  draftId: {
    ...id,
    description: "可选：发送成功时删除同一发件邮箱下的此草稿。不是幂等键。",
  },
};
const accountProps = {
  email,
  password: str(
    "12–256 字符；省略时服务端生成。响应包含初始密码，请单独交付用户。",
    { minLength: 12, maxLength: 256 },
  ),
  name: str("显示名称，默认邮箱前缀。", { maxLength: 200 }),
  note: str("备注。", { maxLength: 500 }),
  quotaMB: int("邮箱空间 MB，默认取服务器配置。", {
    minimum: 1,
    maximum: 1048576,
  }),
};
const summaryProps = {
  id,
  owner_id: id,
  mailbox: email,
  folder: str("", { enum: folders }),
  from_email: email,
  from_name: str(),
  subject: str(),
  snippet: str("摘要，不是完整正文。"),
  to: arr(ref("MailAddress")),
  cc: arr(ref("MailAddress")),
  to_json: str("历史兼容字段，优先使用已解码的 to。"),
  cc_json: str("历史兼容字段，优先使用 cc。"),
  size: int("MIME 字节数。", { minimum: 0 }),
  is_read: flag,
  starred: flag,
  delivery_status: str(
    "received / draft / queued / delivered / partial / failed；delivered 不保证进入外部收件箱。",
  ),
  created_at: date,
  attachment_count: int("", { minimum: 0 }),
};
const schemas = {
  Error: obj(
    {
      error: str("错误说明。"),
      code: str("可选机器码，例如 LICENSE_REQUIRED、DOMAIN_MAILBOX_LIMIT。"),
    },
    ["error"],
  ),
  Ok: obj(
    { ok: bool(), count: int("部分批量操作返回的数量。", { minimum: 0 }) },
    ["ok"],
  ),
  MailAddress: obj({ address: email, name: str() }, ["address", "name"]),
  SendAttachment: input(
    {
      filename: str("", { maxLength: 200 }),
      content: str("标准 Base64；不要带 data: 前缀，也不要传路径或 URL。", {
        format: "byte",
      }),
    },
    ["filename", "content"],
  ),
  SendMail: input(mailProps, [], {
    description:
      "to/cc/bcc 至少一处非空，总计最多 100 个地址；from 必须是启用的本地邮箱，建议显式填写。",
  }),
  SentMail: obj(
    {
      id: {
        ...id,
        description: "已保存的发件箱邮件 ID，不是入站收件副本 ID。",
      },
    },
    ["id"],
  ),
  MessageSummary: obj(summaryProps, [
    "id",
    "owner_id",
    "mailbox",
    "folder",
    "subject",
    "snippet",
    "to",
    "cc",
    "is_read",
    "starred",
    "delivery_status",
    "created_at",
    "attachment_count",
  ]),
  MessagePage: obj(
    {
      items: arr(ref("MessageSummary")),
      total: int("", { minimum: 0 }),
      page: int("", { minimum: 1 }),
      limit: int("", { minimum: 1, maximum: 100 }),
    },
    ["items", "total", "page", "limit"],
  ),
  MessageDetail: obj(
    {
      ...Object.fromEntries(
        Object.entries(summaryProps).filter(
          ([k]) => !["mailbox", "attachment_count"].includes(k),
        ),
      ),
      body_text: str(),
      body_html: str(),
      bcc: arr(ref("MailAddress")),
      bcc_json: str(),
      message_id: str("RFC Message-ID；与数据库 id 不同。", { nullable: true }),
      previous_folder: str("", { nullable: true }),
      trashed_at: { ...date, nullable: true },
      attachments: arr(ref("Attachment")),
      domain_id: id,
      owner_role: str(),
      owner_client_manager: flag,
    },
    [
      "id",
      "folder",
      "subject",
      "body_text",
      "body_html",
      "to",
      "cc",
      "bcc",
      "attachments",
      "is_read",
    ],
  ),
  Attachment: obj(
    { id, filename: str(), content_type: str(), size: int("", { minimum: 0 }) },
    ["id", "filename", "content_type", "size"],
  ),
  PatchMessage: input(
    {
      read: bool(),
      starred: bool(),
      folder: str("", { enum: ["inbox", "archive", "spam", "trash"] }),
    },
    [],
    { minProperties: 1 },
  ),
  BatchMessages: input(
    {
      ids,
      action: str("", {
        enum: ["trash", "archive", "read", "unread", "restore"],
      }),
    },
    ["ids", "action"],
  ),
  CodeResults: obj(
    {
      items: arr(
        obj(
          {
            id,
            mailbox: email,
            from_email: email,
            subject: str(),
            created_at: date,
            code: str(),
            rule_id: id,
            rule_name: str(),
          },
          ["id", "mailbox", "from_email", "subject", "created_at", "code"],
        ),
      ),
      settings: obj({}, [], { additionalProperties: true }),
      receivedCount: int("", { minimum: 0 }),
      matchedCount: int("", { minimum: 0 }),
    },
    ["items", "settings", "receivedCount", "matchedCount"],
  ),
  Account: obj(
    {
      id,
      domain_id: id,
      email,
      display_email: str(),
      name: str(),
      role: str(),
      admin_scope: str(),
      client_manager: flag,
      avatar: str(),
      note: str(),
      active: flag,
      quota_bytes: int(),
      used_bytes: int(),
      created_at: date,
      domain: str(),
    },
    ["id", "email", "domain", "active", "quota_bytes", "used_bytes"],
  ),
  AccountPage: obj(
    {
      items: arr(ref("Account")),
      total: int(),
      page: int(),
      limit: int("不传 page/limit 时兼容旧客户端返回最多 5000 条。"),
    },
    ["items", "total", "page", "limit"],
  ),
  CreateAccount: input(accountProps, ["email"]),
  AccountCredentials: obj(
    {
      items: arr(
        obj(
          {
            email,
            password: str(
              "初始/新密码。应脱离模型上下文单独交付，不记入日志。",
            ),
          },
          ["email", "password"],
        ),
      ),
    },
    ["items"],
  ),
  BatchAccounts: {
    oneOf: [
      input(
        { entries: arr(ref("CreateAccount"), { minItems: 1, maxItems: 100 }) },
        ["entries"],
      ),
      input(
        {
          domain: str("已启用域名。"),
          count: int("", { minimum: 1, maximum: 100, default: 50 }),
          randomUsername: { ...bool(), default: true },
          usernameLength: int("", { minimum: 4, maximum: 32, default: 8 }),
          usernameNumbers: { ...bool(), default: true },
          usernameUppercase: { ...bool(), default: false },
          prefix: str("非随机用户名的前缀。", {
            default: "user",
            maxLength: 32,
          }),
          startNumber: int("", { minimum: 0, maximum: 999999999, default: 1 }),
          randomPassword: { ...bool(), default: true },
          passwordLength: int("", { minimum: 12, maximum: 64, default: 12 }),
          passwordUppercase: { ...bool(), default: true },
          passwordNumbers: { ...bool(), default: true },
          passwordSymbols: { ...bool(), default: true },
          password: str("randomPassword=false 时必填。", {
            minLength: 12,
            maxLength: 256,
          }),
        },
        ["domain"],
      ),
    ],
  },
  PatchAccount: input({
    name: accountProps.name,
    note: accountProps.note,
    quotaMB: accountProps.quotaMB,
    active: bool(),
    password: accountProps.password,
  }),
  DeleteAccounts: input({ ids, confirm: { type: "boolean", enum: [true] } }, [
    "ids",
    "confirm",
  ]),
  ResetPasswords: input(
    {
      emails: addresses,
      password: accountProps.password,
      length: int("省略 password 时生成的随机密码长度。", {
        minimum: 12,
        maximum: 64,
        default: 16,
      }),
    },
    ["emails"],
  ),
  Domain: obj(
    {
      id,
      name: str(),
      enabled: flag,
      mailbox_limit: mailboxLimit,
      mailbox_count: int(),
      user_count: int(),
      mailbox_remaining: int("", { nullable: true }),
      catchall_enabled: { ...flag, enum: [0, 1, null], nullable: true },
      catchall_email: { ...email, nullable: true },
      catchall_target: { ...email, nullable: true },
      catchall_forward_enabled: { ...flag, enum: [0, 1, null], nullable: true },
      created_at: date,
    },
    [
      "id",
      "name",
      "enabled",
      "mailbox_limit",
      "mailbox_count",
      "mailbox_remaining",
    ],
  ),
  DomainList: obj({ items: arr(ref("Domain")) }, ["items"]),
  CreateDomain: input(
    {
      name: str("邮箱域名，如 example.com，不是 mail.example.com 主机名。"),
      mailboxLimit,
    },
    ["name"],
  ),
  CreatedDomain: obj({ id, name: str() }, ["id", "name"]),
  PatchDomain: input({ enabled: bool(), mailboxLimit }),
  DeleteDomain: input({
    cascade: bool("域名下有邮箱时必须为 true。"),
    confirmDomain: str("域名下有邮箱时必须与完整域名精确一致。"),
  }),
  Catchall: input({
    enabled: { ...bool(), default: true },
    email: {
      ...email,
      description: "启用时必填；必须是同域下启用的永久邮箱。",
    },
  }),
  DnsOptions: input({
    hostname: str("可选预览邮件主机名，不修改服务器配置。"),
    ip: str("可选公网 IP，不修改服务器配置。"),
  }),
  DnsRecord: obj(
    {
      key: str(),
      type: str(),
      name: str(),
      host: str("DNS 控制台主机记录，例如 @ 或 default._domainkey。"),
      value: str("", { nullable: true }),
      purpose: str(),
      priority: int(),
      pending: str(),
    },
    ["key", "type", "name", "host", "value", "purpose"],
  ),
  DnsPlan: obj(
    {
      domain: str(),
      hostname: str(),
      ip: str(),
      ipSource: str(),
      records: arr(ref("DnsRecord")),
      warnings: arr(str()),
      relayConfigured: bool(),
      outboundMode: str(),
      tlsConfigured: bool(),
      env: str(),
      instructions: arr(str()),
    },
    ["domain", "hostname", "records", "warnings"],
  ),
  DnsCheck: obj(
    {
      checkedAt: date,
      note: str(),
      items: arr({
        allOf: [
          ref("DnsRecord"),
          obj(
            {
              status: str("", {
                enum: ["passed", "missing", "mismatch", "review", "error"],
              }),
              found: arr({}),
              detail: str(),
            },
            ["status", "found", "detail"],
          ),
        ],
      }),
    },
    ["checkedAt", "items", "note"],
  ),
  ForwardId: {
    oneOf: [
      id,
      str("Catch-all ID，例如 catchall:12。", {
        pattern: "^catchall:[1-9][0-9]*$",
      }),
    ],
  },
  Forward: obj(
    {
      id: ref("ForwardId"),
      domain_id: id,
      user_id: id,
      email: str("普通来源邮箱或 *@example.com。"),
      target: email,
      enabled: flag,
      keep_copy: flag,
      kind: str("Catch-all 时为 catchall；普通规则可能没有此字段。"),
      created_at: date,
    },
    ["id", "email", "target", "enabled", "keep_copy"],
  ),
  ForwardList: obj({ items: arr(ref("Forward")) }, ["items"]),
  CreateForward: input(
    {
      email: str("已存在的来源邮箱；或使用 *@example.com 创建 Catch-all。"),
      target: email,
      enabled: { ...bool(), default: true },
      keepCopy: {
        ...bool("普通规则是否保留副本；Catch-all 固定不保留副本。"),
        default: true,
      },
    },
    ["email", "target"],
  ),
  PatchForward: input({
    email: str("不能改变规则类型。"),
    target: email,
    enabled: bool(),
    keepCopy: bool("仅普通转发支持。"),
  }),
  BatchForwards: input(
    { emails: addresses, target: email, enabled: bool(), keepCopy: bool() },
    ["emails", "target"],
  ),
  DeleteForwards: input(
    { ids: arr(ref("ForwardId"), { minItems: 1, maxItems: 100 }) },
    ["ids"],
  ),
  BulkSend: input(
    {
      ...Object.fromEntries(
        Object.entries(mailProps).filter(
          ([k]) => !["to", "cc", "bcc", "draftId"].includes(k),
        ),
      ),
      recipients: addresses,
      randomSender: {
        ...bool("随机选择已启用的普通本地邮箱；默认 false。"),
        default: false,
      },
    },
    ["recipients"],
  ),
  BulkSendResults: obj(
    {
      items: arr(
        obj({ email, from: email, ok: bool(), id, error: str() }, [
          "email",
          "from",
          "ok",
        ]),
      ),
    },
    ["items"],
  ),
};
const query = (name, schema, description) => ({
  name,
  in: "query",
  required: false,
  schema,
  ...(description ? { description } : {}),
});
const pathId = { name: "id", in: "path", required: true, schema: id };
const paging = [
  query("page", int("", { minimum: 1, maximum: 100000, default: 1 })),
  query("limit", int("", { minimum: 1, maximum: 100, default: 30 })),
];
const mailQuery = [
  query("folder", str("", { enum: folders, default: "inbox" })),
  ...paging,
  query(
    "q",
    str("", { maxLength: 100 }),
    "搜索主题、发件地址、正文；不是发件人精确匹配。",
  ),
  query("unread", str("", { enum: ["1"] }), "1 表示只看未读；省略表示全部。"),
];
const paths = {};
function operation(
  route,
  method,
  operationId,
  summary,
  {
    scope = "management",
    description = "",
    body,
    params = [],
    response = "Ok",
    status = 200,
    type = "application/json",
    effect = method !== "get",
    example,
    tag = "管理",
  } = {},
) {
  const op = {
    operationId,
    summary,
    tags: [tag],
    description: `需要 ${scope} 权限。${description}`,
    "x-required-scope": scope,
    "x-requires-confirmation": effect,
    ...(params.length ? { parameters: params } : {}),
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref(body),
                ...(example ? { example } : {}),
              },
            },
          },
        }
      : {}),
    responses: {
      [status]: {
        description:
          status === 201
            ? "创建/接收成功；发信成功仅表示已保存并接受投递。"
            : "成功。",
        content: {
          [type]: {
            schema:
              type === "application/json"
                ? ref(response)
                : { type: "string", format: "binary" },
          },
        },
      },
      default: {
        description:
          "400 参数；401 密钥失效；402 授权；403 scope/IP/功能开关；404 不存在；409 冲突/配额；413 过大；422 验证码规则错误；429 频率/日额度；5xx 服务/代理错误。反向代理错误可能不是 JSON。",
        content: { "application/json": { schema: ref("Error") } },
      },
    },
  };
  (paths[route] ??= {})[method] = op;
}
operation("/api/v1/send", "post", "sendMail", "发送一封邮件", {
  scope: "mail:send",
  tag: "邮件",
  body: "SendMail",
  response: "SentMail",
  status: 201,
  description:
    "受 defaultSender、allowedSenders、allowedRecipientDomains、dailyLimit、ipAllowlist 限制。独立 admin 账号没有邮箱时须提供 from 或默认发件邮箱。无幂等键，不自动重试。",
  example: {
    from: "alice@example.com",
    to: ["bob@example.com"],
    subject: "会议确认",
    text: "请确认明天下午三点的会议。",
  },
});
operation("/api/v1/messages", "get", "listMail", "搜索邮件摘要与投递状态", {
  scope: "mail:read",
  tag: "邮件",
  params: [
    query("email", email, "邮箱精确过滤；不填可读取所有邮箱，不是权限边界。"),
    ...mailQuery.map((p) =>
      p.name === "folder"
        ? { ...p, schema: { ...p.schema, enum: [...folders, "starred"] } }
        : p,
    ),
  ],
  response: "MessagePage",
  description:
    "不返回正文；starred 排除 trash/spam；按 created_at DESC,id DESC 排序。GET 不标记已读。",
});
operation("/api/v1/codes", "get", "listCodes", "查询最近邮件验证码", {
  scope: "codes:read",
  tag: "邮件",
  params: [query("email", email)],
  response: "CodeResults",
  description:
    "不是完整收件箱。按后台提取规则、时间窗和结果数设置，扫描最近最多 300 封符合条件的收件。无 page/limit 参数；普通来信未匹配验证码时不返回。",
});
const manage = "/api/v1/manage";
operation(
  manage + "/messages",
  "get",
  "listManagedMail",
  "跨邮箱搜索邮件摘要",
  {
    tag: "邮件管理",
    params: [
      query("emails", str("一个或多个邮箱，逗号分隔；不是 email。")),
      ...mailQuery,
    ],
    response: "MessagePage",
    description:
      "folder 不支持 starred；用 emails 筛选多个邮箱。省略 emails 查询全局。",
  },
);
operation(
  manage + "/messages/{id}",
  "get",
  "getMail",
  "读取邮件正文及附件元数据",
  {
    tag: "邮件管理",
    params: [pathId],
    response: "MessageDetail",
    description:
      "id 从邮件列表取得。不会自动标记已读；返回 body_text/body_html、to/cc/bcc、附件 ID，不包含 raw 或附件 Base64。",
  },
);
operation(
  manage + "/messages/{id}",
  "patch",
  "updateMail",
  "标记已读、星标或移动邮件",
  {
    tag: "邮件管理",
    params: [pathId],
    body: "PatchMessage",
    example: { read: true },
    description:
      "至少传一个字段；folder=trash 为移入垃圾箱。不要将用户未要求阅读的邮件自动标为已读。",
  },
);
operation(
  manage + "/messages/{id}",
  "delete",
  "deleteMailPermanently",
  "永久删除垃圾箱中的邮件",
  {
    tag: "邮件管理",
    params: [pathId],
    description: "须先移动到 trash；队列正在投递时返回 409。不可恢复。",
  },
);
operation(
  manage + "/messages/{id}/restore",
  "post",
  "restoreMail",
  "恢复垃圾箱邮件",
  {
    tag: "邮件管理",
    params: [pathId],
    description:
      "恢复 previous_folder，缺失时恢复 inbox；非 trash 返回 400。不需要请求体。",
  },
);
operation(
  manage + "/messages/{id}/raw",
  "get",
  "downloadMail",
  "下载原始 EML",
  {
    tag: "邮件管理",
    params: [pathId],
    type: "message/rfc822",
    description: "响应为二进制 EML，文件名在 Content-Disposition；不是 JSON。",
  },
);
operation(
  manage + "/attachments/{id}",
  "get",
  "downloadAttachment",
  "下载附件",
  {
    tag: "邮件管理",
    params: [pathId],
    type: "application/octet-stream",
    description:
      "使用 getMail 返回的 attachments[].id，不能用邮件 ID。文件名在 Content-Disposition。",
  },
);
operation(
  manage + "/messages/batch",
  "post",
  "batchUpdateMail",
  "批量标记、归档、删除到垃圾箱或恢复",
  {
    tag: "邮件管理",
    body: "BatchMessages",
    description:
      "最多 100 个 ID，事务提交。trash/archive 跳过 drafts 和已在 trash 的邮件；restore 跳过非 trash。count 是去重 ID 数，不等于实际改变数。",
  },
);
operation(
  manage + "/accounts",
  "get",
  "listAccounts",
  "查询邮箱账号和空间使用情况",
  {
    tag: "邮箱账号",
    params: [
      ...paging,
      query("domain", str("邮箱域名。")),
      query("q", str("", { maxLength: 100 })),
    ],
    response: "AccountPage",
    description: "请显式传 page/limit。排除临时邮箱；不返回密码哈希。",
  },
);
operation(
  manage + "/accounts",
  "post",
  "createAccount",
  "在已存在域名下创建邮箱",
  {
    tag: "邮箱账号",
    body: "CreateAccount",
    response: "AccountCredentials",
    status: 201,
    description:
      "域名须启用且有剩余名额。返回 items[{email,password}]，没有 id；随后查询账号列表获得 ID。",
    example: {
      email: "assistant@example.com",
      name: "工作助手",
      quotaMB: 1024,
    },
  },
);
operation(
  manage + "/accounts/batch",
  "post",
  "createAccounts",
  "批量创建或生成邮箱",
  {
    tag: "邮箱账号",
    body: "BatchAccounts",
    response: "AccountCredentials",
    status: 201,
    description:
      "entries 显式账号，或 domain+随机生成参数二选一。1–100 个，全部通过才写入。生成模式使用服务器默认邮箱空间。",
  },
);
operation(
  manage + "/accounts/{id}",
  "patch",
  "updateAccount",
  "修改邮箱名称、备注、空间、状态或密码",
  {
    tag: "邮箱账号",
    params: [pathId],
    body: "PatchAccount",
    description:
      "修改密码或停用会撤销该账号会话；不能在这里修改邮箱地址或授予管理员权限。",
  },
);
operation(
  manage + "/accounts/delete",
  "post",
  "deleteAccounts",
  "删除账号及其邮件",
  {
    tag: "邮箱账号",
    body: "DeleteAccounts",
    description:
      "须 confirm=true，不能删除当前密钥所属账号；正在投递时返回 409。不可恢复，整批事务。",
  },
);
operation(
  manage + "/accounts/passwords",
  "post",
  "resetPasswords",
  "重置指定邮箱密码",
  {
    tag: "邮箱账号",
    body: "ResetPasswords",
    response: "AccountCredentials",
    description:
      "最多 100 个邮箱，撤销各邮箱会话；不能修改当前密钥所属账号。不传 password 时生成随机密码。",
  },
);
operation(
  manage + "/domains",
  "get",
  "listDomains",
  "查询域名、邮箱数量和 Catch-all",
  {
    tag: "域名",
    response: "DomainList",
    description:
      "mailbox_limit=null 表示不限；mailbox_remaining 为剩余名额。无分页。",
  },
);
operation(
  manage + "/domains",
  "post",
  "createDomain",
  "添加邮箱域名并生成 DKIM",
  {
    tag: "域名",
    body: "CreateDomain",
    response: "CreatedDomain",
    status: 201,
    description:
      "使用已配置的 DKIM 后端生成密钥；不自动向 DNS 服务商写记录。首个邮件域名可能补全邮件主机设置。",
  },
);
operation(
  manage + "/domains/{id}",
  "patch",
  "updateDomain",
  "修改域名启停和邮箱数量限制",
  {
    tag: "域名",
    params: [pathId],
    body: "PatchDomain",
    description:
      "mailboxLimit 不能小于已使用名额；不能停用包含全局管理员邮箱的域名。",
  },
);
operation(
  manage + "/domains/{id}",
  "delete",
  "deleteDomain",
  "删除域名及可选级联删除其邮箱",
  {
    tag: "域名",
    params: [pathId],
    body: "DeleteDomain",
    description:
      "有邮箱时须 cascade=true 且 confirmDomain=完整域名；空域名传 {}。不能删除包含全局管理员邮箱的域名。",
  },
);
operation(
  manage + "/domains/{id}/dns",
  "get",
  "getDomainDns",
  "取得 A/MX/SPF/DKIM/DMARC 解析指引",
  {
    tag: "域名",
    params: [pathId, query("hostname", str()), query("ip", str())],
    response: "DnsPlan",
    description:
      "仅生成/预览指引，不修改 DNS，不轮换 DKIM。复制 records[].host/type/value，MX 另读 priority。",
  },
);
operation(
  manage + "/domains/{id}/dns/check",
  "post",
  "checkDomainDns",
  "查询 DNS 记录是否生效",
  {
    tag: "域名",
    params: [pathId],
    body: "DnsOptions",
    response: "DnsCheck",
    effect: false,
    description:
      "传 {} 使用当前配置。HTTP 200 只代表查询完成；逐项看 status。passed 不代表邮件端口、投递或外部收件箱验收成功。",
  },
);
operation(
  manage + "/domains/{id}/catchall",
  "put",
  "setDomainCatchall",
  "将未知收件地址收进本域指定邮箱",
  {
    tag: "域名",
    params: [pathId],
    body: "Catchall",
    description:
      "启用时 email 必填，且会删除此域名的 Catch-all 转发规则；enabled=false 关闭本域收集。与 *@domain 外部转发为互斥方案。",
  },
);
operation(
  manage + "/forwards",
  "get",
  "listForwards",
  "查询普通和 Catch-all 转发",
  {
    tag: "转发",
    response: "ForwardList",
    description:
      "ID 可为整数或 catchall:域名ID；无分页。普通规则可能不返回 kind。",
  },
);
operation(
  manage + "/forwards",
  "post",
  "createForward",
  "创建邮箱转发或 Catch-all 转发",
  {
    tag: "转发",
    body: "CreateForward",
    status: 201,
    description:
      "Catch-all 匹配不存在的本地地址，已存在邮箱保持自己的路由；启用后替换本域收集规则。不允许转发循环。返回 ok，随后列表查询 ID。",
  },
);
operation(
  manage + "/forwards/batch",
  "post",
  "createForwards",
  "为多个已存在邮箱创建同一目标转发",
  {
    tag: "转发",
    body: "BatchForwards",
    status: 201,
    description: "最多 100 个来源邮箱，全部通过才提交；不用于通配 Catch-all。",
  },
);
operation(manage + "/forwards/{id}", "patch", "updateForward", "修改转发规则", {
  tag: "转发",
  params: [
    {
      ...pathId,
      schema: { oneOf: [id, str("", { pattern: "^catchall:[1-9][0-9]*$" })] },
    },
  ],
  body: "PatchForward",
  description:
    "普通/Catch-all 类型不可互换。Catch-all ID 用列表返回的 catchall:N。",
});
operation(
  manage + "/forwards/delete",
  "post",
  "deleteForwards",
  "删除指定转发规则",
  {
    tag: "转发",
    body: "DeleteForwards",
    description: "最多 100 个 ID，支持普通数字 ID 和 catchall:N；不删除邮箱。",
  },
);
operation(manage + "/send", "post", "sendManagedMail", "通过全局管理权限发信", {
  tag: "管理发信",
  body: "SendMail",
  response: "SentMail",
  status: 201,
  description:
    "此接口不使用 mail:send 密钥的发件人、收件域、每日额度策略；只适合全局可信管理。一般 AI 发信请用 sendMail。仍检查 IP、账号有效性、频率、空间和授权。",
});
operation(
  manage + "/bulk-send",
  "post",
  "sendBulkMail",
  "逐收件人发送独立邮件",
  {
    tag: "管理发信",
    body: "BulkSend",
    response: "BulkSendResults",
    description:
      "最多 100 个收件人，非原子提交；HTTP 200 中各 items[].ok 可能不同，不要重发已成功项。管理发信不使用 mail:send 的每日额度等策略。",
  },
);

const spec = {
  openapi: "3.0.3",
  info: {
    title: "青邮：供外部 AI 调用的服务端 API",
    version: "1.3.0",
    description:
      "适配青邮 v1.3.0 现有服务端。AI 通过 HTTPS + Bearer Key 调用，不需要桌面客户端运行。由全局管理员创建密钥；mail:read/codes:read 是全局读取，management 是全局管理。查询过滤不是权限隔离。所有路径/返回值按现有实现描述；文档不授予任何额外权限。没有 MCP / OAuth 服务，也不支持 Idempotency-Key。",
  },
  servers: [
    {
      url: "https://mail.example.com:8443",
      description:
        "导入后替换成自己的服务器 HTTPS 地址，保留实际端口，不加 /api。",
    },
  ],
  security: [{ bearerAuth: [] }],
  tags: ["邮件", "邮件管理", "邮箱账号", "域名", "转发", "管理发信"].map(
    (name) => ({ name }),
  ),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "po_...",
        description:
          "青邮后台「邮件推送 API」创建的 API Key，不是 AI 服务商密钥，不是管理员密码。各 operation 的 x-required-scope 表示应用权限，并非 OAuth scope。",
      },
    },
    schemas,
  },
};
const mailOps = new Set([
  "sendMail",
  "listMail",
  "listCodes",
  "getMail",
  "updateMail",
  "restoreMail",
  "deleteMailPermanently",
  "batchUpdateMail",
]);
const mailSpec = structuredClone(spec);
mailSpec.info.title = "青邮：AI 邮件工具（8 个操作）";
mailSpec.info.description +=
  " 此精简定义省略账号/域名操作，但不会缩小实际 API Key 的权限。";
mailSpec.paths = Object.fromEntries(
  Object.entries(mailSpec.paths)
    .map(([route, methods]) => [
      route,
      Object.fromEntries(
        Object.entries(methods).filter(([, op]) => mailOps.has(op.operationId)),
      ),
    ])
    .filter(([, methods]) => Object.keys(methods).length),
);
// Keep each import small and self-contained: remove schemas unreachable from its paths.
function prune(document) {
  const needed = new Set();
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref?.startsWith("#/components/schemas/")) {
      const name = value.$ref.split("/").at(-1);
      if (!needed.has(name)) {
        needed.add(name);
        walk(document.components.schemas[name]);
      }
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(document.paths);
  document.components.schemas = Object.fromEntries(
    Object.entries(document.components.schemas).filter(([key]) =>
      needed.has(key),
    ),
  );
  return document;
}
await mkdir(out, { recursive: true });
for (const [filename, document] of [
  ["openapi.json", spec],
  ["openapi-mail.json", mailSpec],
]) {
  await writeFile(
    new URL(filename, out),
    JSON.stringify(prune(document), null, 2) + "\n",
  );
  console.log(
    `${filename}: ${Object.values(document.paths).reduce((n, methods) => n + Object.keys(methods).length, 0)} operations`,
  );
}
