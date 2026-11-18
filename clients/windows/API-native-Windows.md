# 青邮 Windows 客户端与 AI API

此程序是远程邮局客户端，不安装 SMTP、数据库或邮件服务。默认服务器 `https://210.16.166.94:24785`，可在登录时修改。所有邮箱、邮件、域名和管理操作使用服务器数据；本机只保存独立登录会话、账号资料、证书信任。

## 安装与构建

下载 `Qingyou-Windows-1.3.1-x64.zip` 并完整解压，运行其中的 `青邮.exe`。这是免安装客户端，不需安装 Node.js；请保留同目录的 DLL、resources 和其他运行文件，不能单独复制 EXE 使用。本次交付为完整 ZIP，未提供单文件 EXE。

首次添加服务器、用户名及密码；`admin` 在服务器确认管理员角色后自动打开后台，其他邮箱进入普通邮件界面。账号菜单支持添加、切换和移除多个账号，最多 20 个，登录状态相互隔离。移除账号会尝试向服务器退出登录并清除本机对应会话，不删除服务器邮箱。

开发构建：在此目录运行 `npm ci`、`npm run runtime`、`npm test`、`npm run build`。`runtime` 下载并校验项目锁定的官方 Electron 运行时，已安装时不会重复下载。本机开发服务的 HTTP 只在非打包版且显式设置 `QINGYOU_DEV_LOCAL=1` 时允许；发行版必须 HTTPS。正式发行未提供 Windows 代码签名证书，构建产物不应被称为已签名安装包。

## 自签名 HTTPS

证书不受信任时，先查看服务器证书 SHA-256 指纹，通过服务器管理员或可信渠道核对后，在客户端确认信任。信任仅对应当前服务器及当前证书；证书变化后连接失败，需重新核对。程序不会全局跳过 TLS 验证。证书查看连接只获取公钥证书，不发送用户名或密码。

## AI 接口文档

侧栏「AI 接口文档」在软件内提供外部 AI 调用邮局的接口说明、参数、示例、权限与返回结构。文档按需加载，直接展示当前账号服务器地址。支持逐项复制和复制整份文档、OpenAPI JSON；密钥始终为占位符。不会自动调用服务器接口或向模型服务发送邮件。

## UI 桥接口

仅客户端自带页面可调用 `window.postoffice`；远程管理后台没有 Node.js 或此桥接口。所有方法返回 Promise；异常表示网络、参数或权限错误，服务器响应通过 `{status,data}` 返回。平台常量 `platform:"windows"`，能力 `capabilities:{apiReference:true,admin:true,attachments:true,certificateTrust:true}`。

| 方法 | 参数 | 返回 |
|---|---|---|
| `copyText(input)` | `{text}`，非空、最多 1000000 字符 | `{copied:true}`；只写剪贴板，不提供读取接口 |
| `listAccounts()` | 无 | `[{id,server,user,portal}]` |
| `login(input)` | `{server,username,password}` | `{id,server,user,portal}` |
| `request(input)` | `{accountId,path,method?,body?}` | `{status,data}` |
| `removeAccount(id)` | 账号 ID | `{ok:true}` |
| `openAdmin(id)` | 管理员账号 ID | `{opened:true}` |
| `download(input)` | `{accountId,path,filename}` | `{saved:true}` 或 `{cancelled:true}` |
| `inspectCertificate(input)` | `{server}` | `{fingerprint,subject,issuer,validFrom,validTo,trusted}` |
| `trustCertificate(input)` | `{server,fingerprint}` | 用户原生确认后 `{ok:true}` |

`request.path` 是入口相对路径，如 `/messages?folder=inbox&page=1&limit=30`、`/messages/123`、`/send`、`/drafts`、`/mailbox`。原生层按账号 portal 添加 `/api/client` 或 `/api`，自动携带该账号独立 Cookie 和 CSRF。禁止完整外部 URL、路径逃逸、初始化和任意登录接口。附件下载只接受 `/attachments/<id>` 或 `/messages/<id>/raw`，由系统保存对话框选择位置。

UI 桥不是开放网络服务：本程序不监听本地 HTTP 端口。第三方服务接入邮局仍使用服务器现有 API Key 管理接口，不应复用桌面登录 Cookie。

参考：[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[Session](https://www.electronjs.org/docs/latest/api/session)、[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。

