# 青邮客户端 API

**外部 AI 调用邮局**（查信、读正文、发信、管理邮箱/域名）请使用 [AI 调用服务端 API 文档](../docs/api/README.md)、[完整 OpenAPI](../docs/api/openapi.json) 或 [邮件工具精简 OpenAPI](../docs/api/openapi-mail.json)。这些接口直接连接邮局服务器，不要求桌面客户端运行。软件内的「AI 接口文档」支持直接阅读和复制；下文保留客户端登录协议的开发说明。

本客户端连接已部署的青邮服务器，不启动 SMTP 或本地邮局。账号、邮件、草稿、转发、域名和权限均以服务器为准。接口兼容服务器 v1.2.1 及以上；v1.3.0 增加加载优化，不改变认证协议。

## 地址与认证

服务器地址示例：`https://mail.example.com:8443`，不要在配置地址中加 `/api`。公网只使用 HTTPS。自签名证书须核对服务器证书 SHA-256 指纹后单独信任，不全局关闭 TLS 验证。

普通账号：`POST /api/client/auth/login`，管理员：`POST /api/auth/login`。

```json
{ "email": "alice@example.com", "password": "用户输入的密码" }
```

成功为 200，返回 `{ "user": { "id": 12, "email": "alice@example.com", "role": "user", "client_manager": false }, "csrfToken": "...", "license": { "required": false, "valid": true, "mode": "none", "expiresAt": null } }`，同时设置 HttpOnly 会话 Cookie。客户端 Cookie 为 `postoffice_client_session`，管理员为 `postoffice_session`。会话最长 7 天；每个账号必须使用独立 Cookie 容器。只根据服务端已认证的 `user.role` 判断管理员身份，输入名称 `admin` 本身不授予权限。

后续请求发送所属账号 Cookie；POST/PATCH/PUT/DELETE 还需 `X-CSRF-Token`。JSON 请求设 `Content-Type: application/json`。原生网络层不需要浏览器跨域权限；不要把 Cookie/CSRF/AI 密钥写入网页 localStorage。密码只用于登录，不保存在客户端。密码、权限或账号状态改变可使会话立即失效；收到 401 后提示重新登录。

若发送 Origin，必须与服务器配置的 PUBLIC_URL 完全一致。客户端不应重试可能已被服务器执行的写操作。邮件发送返回 201 只表示已接受/排队，不等于对方收到。

## 普通邮箱 HTTP 接口

下表路径统一加 `/api/client`。

| 方法   | 路径                       | 输入/用途                                                 |
| ------ | -------------------------- | --------------------------------------------------------- |
| GET    | `/auth/me`                 | 当前身份、最新权限、CSRF                                  |
| POST   | `/auth/logout`             | `{}`，撤销当前会话                                        |
| GET    | `/mailbox`                 | 文件夹 total/unread、usedBytes、quotaBytes                |
| GET    | `/messages`                | `folder=inbox&page=1&limit=30&q=关键词&unread=1`          |
| GET    | `/messages/{id}`           | 正文及附件元数据；有修改权限时标为已读                    |
| PATCH  | `/messages/{id}`           | `{"read":true,"starred":false}` 或 `{"folder":"archive"}` |
| POST   | `/messages/{id}/restore`   | `{}`，恢复垃圾箱邮件                                      |
| DELETE | `/messages/{id}`           | 仅垃圾箱或草稿可永久删除，客户端需明确确认                |
| GET    | `/messages/{id}/raw`       | 下载 EML 二进制，不是 JSON                                |
| GET    | `/attachments/{id}`        | 下载附件二进制，文件名来自 Content-Disposition            |
| POST   | `/send`                    | 发送邮件，见下方示例                                      |
| POST   | `/drafts`                  | 草稿，字段同发送；`id` 表示替换已有草稿                   |
| GET    | `/drafts/{id}/attachments` | 草稿附件 Base64，用于编辑已有草稿                         |

folder 支持 inbox、sent、drafts、archive、spam、trash 和 starred（虚拟收藏列表）。分页上限 100；列表只返回摘要，不返回 MIME 和附件内容。响应为 `{items:[], total:120, page:1, limit:30}`。

```json
{
  "to": ["bob@example.net"],
  "cc": [],
  "bcc": [],
  "subject": "项目进度",
  "text": "你好，附件是本次说明。",
  "attachments": [{ "filename": "说明.txt", "content": "SGVsbG8=" }]
}
```

正文可另提供 `html`；服务器负责清洗。附件 `content` 为不含 data: 前缀的 Base64。最多 20 个附件，单封总大小以服务器配置为准（默认 MIME 编码后 20MB）。从草稿发送时用 `draftId`，服务端在成功提交时删除对应草稿。

## 管理接口与权限

Windows 管理员窗口加载该服务器的现有后台，沿用管理员专属会话；远程页面不具有本机 AI/文件系统桥接权限。后台普通管理路径为 `/api/admin/...`。普通账号即使知道 URL 也不能访问后台。

客户端域名用户可访问 `/api/client/manage/...` 的已授权操作。授权是功能能力与域名 read/create/update/delete 的交集；邮箱地址属于某域名，不代表自动拥有该域管理权。具体接口请参阅项目 README 的管理 API 和后台“权限管理”。

| 方法 | 管理路径（管理员前缀 `/api/admin`） | 用途                                                                          |
| ---- | ----------------------------------- | ----------------------------------------------------------------------------- |
| GET  | `/manage/accounts?page=1&limit=30`  | 邮箱账号分页                                                                  |
| POST | `/manage/accounts`                  | `email,password,name,quotaMB` 创建邮箱                                        |
| GET  | `/manage/domains`                   | 已授权域名、容量、Catch-all 状态                                              |
| GET  | `/manage/forwards`                  | 普通及 Catch-all 转发                                                         |
| POST | `/manage/forwards`                  | `email:"*@example.com",target:"sink@example.net",enabled:true,keepCopy:false` |
| GET  | `/system`                           | 运行状态，仅后台全局管理员                                                    |
| GET  | `/managers`                         | 管理员/域名用户授权，仅全局管理员                                             |

多邮局管理继续暂停，`/api/admin/connections/...` 返回 403。

## 外部应用 API Key

在后台“邮件推送 API”创建密钥，使用 `Authorization: Bearer <API_KEY>`。它与客户端 Cookie 会话不同，不可混用。

- `POST /api/v1/send`：`mail:send` scope，收件人/正文结构同上。
- `GET /api/v1/messages`：`mail:read` scope。
- `GET /api/v1/codes`：`codes:read` scope。
- `/api/v1/manage/...`：`management` scope，仍受服务端策略校验。

密钥策略可以限制允许的发件人、收件域、IP 和每日额度。普通桌面/手机客户端不需要管理 API Key。

## 软件内的 API 文档

客户端 v1.3.1 将「AI 设置」替换为「AI 接口文档」，按需载入本地接口定义并使用当前服务器地址。复制由 Windows 隔离 IPC 或 Android 原生剪贴板完成，失败时提供全选文本。它不存储 API Key，不代替服务端鉴权，也不会执行被复制的请求。
