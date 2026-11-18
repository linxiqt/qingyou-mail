# 青邮 · 自托管多域名邮局

在自己的服务器上为多个域名开设邮箱。管理员在后台分配账号和权限，用户用中文网页邮箱或邮件客户端收发邮件。服务端使用 Node.js 24、Express 和 SQLite，不需要另装数据库。

[功能介绍](#功能介绍)　·　[电脑版功能图鉴](#windows-电脑版功能图鉴)　·　[本地启动](#本地运行)　·　[Docker 部署](#linux-部署docker-compose)　·　[systemd 部署](#linux-部署systemd)　·　[备份与恢复](#备份与恢复)

**使用许可：个人非商业自用免费；企业内部使用和商业运营均须事先取得付费授权。** 即使企业只给员工搭邮箱、不对外收费，也需要授权。修改服务端并向用户提供网络服务的，还须向这些用户免费提供实际运行版本的对应源码；商业授权不免除此义务。青邮是**源码可见软件**，完整条款见 [青邮源码可见软件许可证 1.0](LICENSE)。

## 功能介绍

### Windows 电脑版 · 三栏收件箱

左栏切换账号和文件夹，中栏搜索或选择邮件，右栏直接阅读正文、下载附件和回复。

![Windows 电脑版收件箱：从左到右依次是文件夹、邮件列表和带附件的邮件正文。](public/readme/windows-inbox.png)

### Android 手机版 · 邮箱首页

首页卡片显示收件、未读、草稿和已发送数量；底部导航可直接进入收件箱、写邮件或切换账号。

<img src="public/readme/android-mailbox.png" alt="Android 手机版竖屏截图：邮箱统计卡片、工作邮箱文件夹及底部导航。" width="320">

*两张截图均使用演示账号和示例邮件。*

### 主要功能

| 你想做什么 | 从哪里开始 | 青邮能帮你做什么 |
| :--- | :--- | :--- |
| 为团队开邮箱 | 管理后台 → 域名列表、用户列表 | 添加域名，查看该域名的 DNS 记录，单独或批量创建邮箱；分别限制邮箱数量和单邮箱容量。 |
| 日常收发邮件 | 网页邮箱 `/webmail/` 或邮件客户端 | 用完整邮箱地址登录，收发附件、保存草稿、整理文件夹。也可通过 IMAP 或 POP3 收信、SMTP 发信。 |
| 让同事管理自己的域名 | 管理后台 → 用户列表 → 权限管理 | 指定可管理的域名，再单独授权创建邮箱、重置密码或设置转发。相同邮箱后缀不代表拥有管理权。 |
| 接住寄错地址的邮件 | 管理后台 → 邮件转发 → Catch-all | 把寄给本域未创建地址的信转到指定邮箱；已有邮箱仍按自己的规则收信。 |
| 让业务系统收发邮件 | [API](#api) 与 [Webhook](#webhook) | 用限定权限的 API Key 发信或查询邮件；用带签名的 Webhook 将邮件事件推送到业务系统。 |

### Windows 电脑版功能图鉴

按任务展开，点击截图可查看原图。前 3 组是 Windows 客户端；后 4 组是管理员从客户端打开的服务端后台。图片来自隔离的演示环境，不含生产邮箱；已停用的「多邮局管理」不列为可用功能。

<details>
<summary><strong>读信与整理</strong>（11 张）</summary>

读信时可以在右侧处理邮件，不必离开列表。

| 功能与操作 | 截图（点击放大） |
| :--- | :--- |
| **三栏收件箱**<br>从文件夹到列表，再到正文与附件。 | [![三栏收件箱操作界面](public/readme/windows-inbox.png)](public/readme/windows-inbox.png) |
| **搜索邮件**<br>按发件人、主题或正文筛选。 | [![搜索邮件操作界面](public/readme/desktop/search.jpg)](public/readme/desktop/search.jpg) |
| **未读邮件**<br>只看还没读过的来信。 | [![未读邮件操作界面](public/readme/desktop/unread.jpg)](public/readme/desktop/unread.jpg) |
| **已标星**<br>集中查看需要跟进的邮件。 | [![已标星操作界面](public/readme/desktop/starred.jpg)](public/readme/desktop/starred.jpg) |
| **阅读工具栏**<br>从左到右：回复、切换星标、归档、删除和标记未读。 | [![阅读工具栏操作界面](public/readme/desktop/reader-tools.jpg)](public/readme/desktop/reader-tools.jpg) |
| **查看邮件排版**<br>在纯文本和隔离的 HTML 正文之间切换。 | [![查看邮件排版操作界面](public/readme/desktop/html.jpg)](public/readme/desktop/html.jpg) |
| **保存附件**<br>查看文件名、大小及保存反馈。 | [![保存附件操作界面](public/readme/desktop/attachment.jpg)](public/readme/desktop/attachment.jpg) |
| **已发送**<br>查看已发送邮件及其内容。 | [![已发送操作界面](public/readme/desktop/sent.jpg)](public/readme/desktop/sent.jpg) |
| **归档**<br>查阅从收件箱归档的邮件。 | [![归档操作界面](public/readme/desktop/archive.jpg)](public/readme/desktop/archive.jpg) |
| **已删除**<br>检查删除的邮件，选择恢复或永久删除。 | [![已删除操作界面](public/readme/desktop/trash.jpg)](public/readme/desktop/trash.jpg) |
| **垃圾邮件**<br>检查被归入垃圾邮件文件夹的邮件。 | [![垃圾邮件操作界面](public/readme/desktop/spam.jpg)](public/readme/desktop/spam.jpg) |

</details>

<details>
<summary><strong>写信与草稿</strong>（6 张）</summary>

保存草稿和发送是两个不同的操作。

| 功能与操作 | 截图（点击放大） |
| :--- | :--- |
| **写邮件、添加附件与保存草稿**<br>填写收件人、抄送、密送、主题和正文，检查附件及草稿状态。 | [![写邮件、添加附件与保存草稿操作界面](public/readme/desktop/compose.jpg)](public/readme/desktop/compose.jpg) |
| **发送邮件**<br>查看提交后的发送反馈。 | [![发送邮件操作界面](public/readme/desktop/send.jpg)](public/readme/desktop/send.jpg) |
| **草稿箱**<br>找到尚未发出的邮件。 | [![草稿箱操作界面](public/readme/desktop/drafts.jpg)](public/readme/desktop/drafts.jpg) |
| **继续编辑**<br>打开已有草稿，保留原来的主题和正文。 | [![继续编辑操作界面](public/readme/desktop/edit-draft.jpg)](public/readme/desktop/edit-draft.jpg) |
| **回复**<br>沿用原邮件的联系人和主题。 | [![回复操作界面](public/readme/desktop/reply.jpg)](public/readme/desktop/reply.jpg) |
| **转发**<br>填写新的收件人；需要转发的附件需重新添加。 | [![转发操作界面](public/readme/desktop/forward.jpg)](public/readme/desktop/forward.jpg) |

</details>

<details>
<summary><strong>账号与接口文档</strong>（7 张）</summary>

普通账号进入个人邮箱；管理员账号可以打开服务端后台。

| 功能与操作 | 截图（点击放大） |
| :--- | :--- |
| **账号管理与退出**<br>查看服务器、登录身份和已添加账号；退出不会删除服务器邮件。 | [![账号管理与退出操作界面](public/readme/desktop/accounts.jpg)](public/readme/desktop/accounts.jpg) |
| **添加账号与证书检查入口**<br>输入服务器及用户名，登录前可查看服务器证书。 | [![添加账号与证书检查入口操作界面](public/readme/desktop/login.jpg)](public/readme/desktop/login.jpg) |
| **切换邮箱**<br>切换后，列表显示所选账号自己的邮件。 | [![切换邮箱操作界面](public/readme/desktop/switch.jpg)](public/readme/desktop/switch.jpg) |
| **连接失败与重试**<br>服务器无法访问时，检查连接后重新尝试。 | [![连接失败与重试操作界面](public/readme/desktop/reconnect.jpg)](public/readme/desktop/reconnect.jpg) |
| **AI 接口文档**<br>浏览接口清单，复制服务器地址或 OpenAPI 文档。 | [![AI 接口文档操作界面](public/readme/desktop/desktop-api-overview.png)](public/readme/desktop/desktop-api-overview.png) |
| **接口详情与调用示例**<br>查看请求参数并复制接口示例。 | [![接口详情与调用示例操作界面](public/readme/desktop/desktop-api-endpoint.png)](public/readme/desktop/desktop-api-endpoint.png) |
| **管理员工作区**<br>用管理员身份进入远程管理后台。 | [![管理员工作区操作界面](public/readme/desktop/desktop-admin.png)](public/readme/desktop/desktop-admin.png) |

</details>

<details>
<summary><strong>后台：收发与账号</strong>（15 张）</summary>

以下是 Windows 管理员工作区打开的服务端页面，不是普通邮箱的操作权限。

| 功能与操作 | 截图（点击放大） |
| :--- | :--- |
| **总览**<br>查看邮箱数量、收发统计和服务状态。 | [![总览操作界面](public/readme/desktop/admin-overview.jpg)](public/readme/desktop/admin-overview.jpg) |
| **后台发邮件**<br>使用编辑器写信、存草稿或保存为模板。 | [![后台发邮件操作界面](public/readme/desktop/admin-compose.jpg)](public/readme/desktop/admin-compose.jpg) |
| **后台收件箱**<br>查找、筛选和批量整理有权访问的来信。 | [![后台收件箱操作界面](public/readme/desktop/admin-inbox.jpg)](public/readme/desktop/admin-inbox.jpg) |
| **后台邮件详情**<br>打开列表中的邮件，核对正文与收发信息。 | [![后台邮件详情操作界面](public/readme/desktop/admin-mail-detail.jpg)](public/readme/desktop/admin-mail-detail.jpg) |
| **后台发件箱**<br>检查已发送邮件。 | [![后台发件箱操作界面](public/readme/desktop/admin-sent.jpg)](public/readme/desktop/admin-sent.jpg) |
| **用户列表**<br>筛选账号、查看所属域名、导出列表或进入邮箱管理。 | [![用户列表操作界面](public/readme/desktop/admin-users.jpg)](public/readme/desktop/admin-users.jpg) |
| **新建邮箱**<br>指定地址、显示名称和初始配置。 | [![新建邮箱操作界面](public/readme/desktop/account-create.jpg)](public/readme/desktop/account-create.jpg) |
| **编辑邮箱**<br>调整账号资料和邮箱配额。 | [![编辑邮箱操作界面](public/readme/desktop/account-edit.jpg)](public/readme/desktop/account-edit.jpg) |
| **客户端域名用户授权**<br>按账号限定可操作的功能和域名范围。 | [![客户端域名用户授权操作界面](public/readme/desktop/account-permissions.jpg)](public/readme/desktop/account-permissions.jpg) |
| **权限管理**<br>查看能够进入后台的管理账号。 | [![权限管理操作界面](public/readme/desktop/admin-managers.jpg)](public/readme/desktop/admin-managers.jpg) |
| **添加管理账号**<br>为新管理员选择角色、功能权限及可管理域名。 | [![添加管理账号操作界面](public/readme/desktop/manager-create.jpg)](public/readme/desktop/manager-create.jpg) |
| **批量注册**<br>按规则生成一组邮箱账号。 | [![批量注册操作界面](public/readme/desktop/admin-batch-register.jpg)](public/readme/desktop/admin-batch-register.jpg) |
| **按列表导入**<br>按行录入账号，而不是使用随机生成规则。 | [![按列表导入操作界面](public/readme/desktop/batch-import.jpg)](public/readme/desktop/batch-import.jpg) |
| **批量群发**<br>选择收件人并编写要分别投递的邮件。 | [![批量群发操作界面](public/readme/desktop/admin-bulk-send.jpg)](public/readme/desktop/admin-bulk-send.jpg) |
| **批量改密**<br>先核对目标账号，再统一更新密码。 | [![批量改密操作界面](public/readme/desktop/admin-batch-password.jpg)](public/readme/desktop/admin-batch-password.jpg) |

</details>

<details>
<summary><strong>后台：域名与转发</strong>（9 张）</summary>

邮箱数量上限是域名级限制，与单个邮箱的存储配额不同。

| 功能与操作 | 截图（点击放大） |
| :--- | :--- |
| **域名列表**<br>对照启用状态、邮箱数量与捕获方式。 | [![域名列表操作界面](public/readme/desktop/admin-domains.jpg)](public/readme/desktop/admin-domains.jpg) |
| **添加域名**<br>把新的收发域名加入邮局。 | [![添加域名操作界面](public/readme/desktop/domain-create.jpg)](public/readme/desktop/domain-create.jpg) |
| **DNS 解析指引**<br>查看该演示域名对应的邮件解析记录。 | [![DNS 解析指引操作界面](public/readme/desktop/domain-dns.jpg)](public/readme/desktop/domain-dns.jpg) |
| **域名容量**<br>限制单个域名下可创建的邮箱数量。 | [![域名容量操作界面](public/readme/desktop/domain-limit.jpg)](public/readme/desktop/domain-limit.jpg) |
| **本地捕获邮箱**<br>为未创建的地址选择本域的接收邮箱。 | [![本地捕获邮箱操作界面](public/readme/desktop/domain-catchall.jpg)](public/readme/desktop/domain-catchall.jpg) |
| **邮件转发规则列表**<br>查看和管理已有转发规则。 | [![邮件转发规则列表操作界面](public/readme/desktop/admin-forwards.jpg)](public/readme/desktop/admin-forwards.jpg) |
| **邮箱转发**<br>为已有邮箱设置目标地址与保留副本选项。 | [![邮箱转发操作界面](public/readme/desktop/forward-create.jpg)](public/readme/desktop/forward-create.jpg) |
| **Catch-all 转发**<br>按域名接收未创建地址的邮件并转发。 | [![Catch-all 转发操作界面](public/readme/desktop/forward-catchall.jpg)](public/readme/desktop/forward-catchall.jpg) |
| **批量创建转发**<br>一次配置多个来源邮箱。 | [![批量创建转发操作界面](public/readme/desktop/forward-batch.jpg)](public/readme/desktop/forward-batch.jpg) |

</details>

<details>
<summary><strong>后台：接码、临时邮箱与 API</strong>（12 张）</summary>

接码链接、临时邮箱和 API 密钥是三个独立入口。

| 功能与操作 | 截图（点击放大） |
| :--- | :--- |
| **接码链接管理**<br>查看链接关联的邮箱、有效期及状态。 | [![接码链接管理操作界面](public/readme/desktop/admin-codes.jpg)](public/readme/desktop/admin-codes.jpg) |
| **创建接码链接**<br>限定允许访问的邮箱与内容。 | [![创建接码链接操作界面](public/readme/desktop/code-create.jpg)](public/readme/desktop/code-create.jpg) |
| **接码设置**<br>调整接码的全局选项与默认行为。 | [![接码设置操作界面](public/readme/desktop/codes-settings.jpg)](public/readme/desktop/codes-settings.jpg) |
| **验证码规则**<br>核对匹配顺序、表达式和启用状态。 | [![验证码规则操作界面](public/readme/desktop/codes-rules.jpg)](public/readme/desktop/codes-rules.jpg) |
| **创建验证码规则**<br>设置筛选条件与提取表达式。 | [![创建验证码规则操作界面](public/readme/desktop/rule-create.jpg)](public/readme/desktop/rule-create.jpg) |
| **批量规则测试**<br>先用样本文本验证规则效果。 | [![批量规则测试操作界面](public/readme/desktop/codes-test.jpg)](public/readme/desktop/codes-test.jpg) |
| **临时邮箱页面**<br>管理临时邮箱页面及使用限制。 | [![临时邮箱页面操作界面](public/readme/desktop/admin-temp-mail.jpg)](public/readme/desktop/admin-temp-mail.jpg) |
| **新建临时邮箱页面**<br>配置页面名称、可用域名与有效期等选项。 | [![新建临时邮箱页面操作界面](public/readme/desktop/temp-page-create.jpg)](public/readme/desktop/temp-page-create.jpg) |
| **邮件模板**<br>查看可重复使用的邮件内容。 | [![邮件模板操作界面](public/readme/desktop/admin-templates.jpg)](public/readme/desktop/admin-templates.jpg) |
| **新建模板**<br>编辑模板内容供后续写信使用。 | [![新建模板操作界面](public/readme/desktop/template-create.jpg)](public/readme/desktop/template-create.jpg) |
| **邮件推送 API**<br>查看密钥列表和调用示例。 | [![邮件推送 API操作界面](public/readme/desktop/admin-api.jpg)](public/readme/desktop/admin-api.jpg) |
| **创建密钥与授权策略**<br>选择权限、额度和允许范围；截图未生成密钥。 | [![创建密钥与授权策略操作界面](public/readme/desktop/key-create.jpg)](public/readme/desktop/key-create.jpg) |

</details>

<details>
<summary><strong>后台：运行与维护</strong>（9 张）</summary>

平台设置中的备份、清理和品牌资源各有独立操作界面。

| 功能与操作 | 截图（点击放大） |
| :--- | :--- |
| **运行状态**<br>检查主机、协议端口、TLS 和投递模式。 | [![运行状态操作界面](public/readme/desktop/admin-system.jpg)](public/readme/desktop/admin-system.jpg) |
| **投递队列与操作日志**<br>对照外发任务和后台操作记录。 | [![投递队列与操作日志操作界面](public/readme/desktop/queue-audit.jpg)](public/readme/desktop/queue-audit.jpg) |
| **平台设置**<br>设置系统名称、默认主题和布局。 | [![平台设置操作界面](public/readme/desktop/admin-platform.jpg)](public/readme/desktop/admin-platform.jpg) |
| **品牌图片**<br>管理可用于界面的品牌资源。 | [![品牌图片操作界面](public/readme/desktop/brand-assets.jpg)](public/readme/desktop/brand-assets.jpg) |
| **备份管理**<br>查看在线备份的创建与下载入口。 | [![备份管理操作界面](public/readme/desktop/platform-backups.jpg)](public/readme/desktop/platform-backups.jpg) |
| **邮件保留策略**<br>配置保留期限、清理范围和垃圾箱策略。 | [![邮件保留策略操作界面](public/readme/desktop/retention.jpg)](public/readme/desktop/retention.jpg) |
| **手动清理预览**<br>执行前先检查清理条件及影响范围。 | [![手动清理预览操作界面](public/readme/desktop/cleanup-preview.jpg)](public/readme/desktop/cleanup-preview.jpg) |
| **功能管理**<br>调整功能的启用状态、显示状态与顺序。 | [![功能管理操作界面](public/readme/desktop/admin-features.jpg)](public/readme/desktop/admin-features.jpg) |
| **程序信息**<br>查看程序信息及产品说明。 | [![程序信息操作界面](public/readme/desktop/admin-about.jpg)](public/readme/desktop/admin-about.jpg) |

</details>

### 一封邮件如何送达？

```mermaid
flowchart LR
    A["网页邮箱或客户端"] --> B["青邮服务端"]
    B -->|本地收件人| C["写入收件箱"]
    B -->|外部收件人| D["外发队列"]
    D -->|直投或 SMTP 中继| E["对方邮局"]
```

想先试用，不必先配置公网 DNS：[本地启动](#本地运行) 后创建两个测试邮箱即可互发。准备让外部邮箱也能收到信时，再配置 [域名与外部收发](#域名与外部收发)。

## 本地运行

在项目根目录操作，先用 `node -v` 确认是 **Node.js 24.x**。仅在首次运行时复制配置，不要覆盖已有 `.env`。

Windows（PowerShell）：

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd ci
npm.cmd start
```

Linux：

```bash
npm ci
test -f .env || cp .env.example .env
npm start
```

启动后访问 <http://localhost:3000/healthz> 检查服务；按 `Ctrl+C` 停止，下次在同一目录直接执行 `npm start`（PowerShell 用 `npm.cmd start`）。本机互发测试可在 `.env` 设置 `OUTBOUND_MODE=local`。

打开 <http://localhost:3000>，首次访问直接设置独立管理员账号和密码，无需初始化口令，也无需先填写邮件域名。系统没有默认密码，创建首个管理员后关闭首次设置入口，后续访问使用账号密码登录。

初始化示例：管理账号 `admin`，设置至少 12 位密码。登录后在「域名列表」添加 `example.com`，SMTP 主机名会自动设为 `mail.example.com`，也可在页面修改。后台保存的主机名优先于 `.env`，立即用于新 SMTP 连接及外发 EHLO，并在重启后保留。再添加两个邮箱即可测试网页互发。管理账号不作为收发邮箱。默认直接查询收件域名 MX 并从服务器 25 端口向外投递，也可选 SMTP 中继或仅本地模式。公网实际收发需要 Linux 部署及正确的域名、端口和发件认证配置。

```bash
npm run check
npm test
```

测试用临时数据库和本地 SMTP / Webhook 服务，覆盖权限隔离、附件、密送、草稿、配额事务、转发循环、真实 SMTP 收件、MX 直接投递及故障切换、失败通知、可选中继、API Key、批量操作与会话撤销，不访问真实收件人。

## Linux 部署：Docker Compose

1. 准备已安装 Docker Engine 和 Compose 插件的 Linux 主机；在项目根目录执行 `test -f .env || cp .env.example .env`。
2. 设置实际网页地址 `PUBLIC_URL`（可使用服务器 IP 的 HTTPS 地址）和 `TRUST_PROXY=1`。`MAIL_HOSTNAME` 可留空，登录后在后台设置。若没有反向代理，不要设置信任代理。
3. 将有效证书放入 `certs/fullchain.pem` 和 `certs/privkey.pem`，确保容器内 UID 1000 能读取，勿设为全员可读。
4. 设置 `OUTBOUND_MODE=direct` 并开放出站 25，或选择中继模式。每个域名自动生成 DKIM；将公钥加入 DNS。Compose 强制生产模式，缺少 TLS 或 HTTPS 地址会拒绝启动。
5. 创建备份目录并赋予容器用户权限，启动服务，再部署 Nginx HTTPS 反向代理。

```bash
mkdir -p backups certs
sudo chown 1000:1000 backups
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/healthz
docker compose logs --tail=50 postoffice
```

容器以非 root 用户运行，25/587 映射到容器高位端口。HTTP 3000 只绑定宿主机回环地址，供 `deploy/nginx.conf` 反向代理。用 `docker compose stop` 停止、`docker compose start` 再次启动；修改 `.env` 后使用 `docker compose up -d` 重新创建容器。数据持久化到 `mail-data` 命名卷；不要用 `docker compose down -v` 删除邮件数据。

证书续期后，更新 `certs/` 文件并重启容器加载证书。若启用 DKIM，将私钥额外挂载到容器并配置实际路径。健康检查使用 HTTP `/healthz`。

## Linux 部署：systemd

安装 Node.js 24 后：

```bash
sudo useradd --system --home /opt/postoffice --shell /usr/sbin/nologin postoffice
sudo mkdir -p /opt/postoffice/data /opt/postoffice/backups
# 将项目复制到 /opt/postoffice 后执行：
cd /opt/postoffice
npm ci --omit=dev
test -f .env || cp .env.example .env
# 编辑 .env，填写下述生产配置。
sudo chown -R postoffice:postoffice data backups
sudo chown postoffice:postoffice .env
sudo chmod 600 /opt/postoffice/.env
sudo cp deploy/postoffice.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now postoffice
sudo systemctl status postoffice --no-pager
sudo journalctl -u postoffice -n 30
curl -fsS http://127.0.0.1:3000/healthz
```

日常管理使用 `sudo systemctl start postoffice`、`sudo systemctl stop postoffice` 或 `sudo systemctl restart postoffice`。首次上线时先限制后台访问，完成首个管理员设置后再对公网开放。

生产 `.env` 至少设置：

```dotenv
NODE_ENV=production
PUBLIC_URL=https://mail.example.com
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=1
SMTP_HOST=0.0.0.0
SMTP_PORT=25
SUBMISSION_PORT=587
MAIL_HOSTNAME=mail.example.com
TLS_CERT_PATH=/opt/postoffice/certs/fullchain.pem
TLS_KEY_PATH=/opt/postoffice/certs/privkey.pem
SMTP_ALLOW_INSECURE_AUTH=false
```

证书应复制到服务可读取的目录，私钥权限设为 `640`，所属组为 `postoffice`。示例 systemd 的 `ProtectHome=true` 会阻止读取用户主目录中的文件。确认 `/usr/bin/node` 是 Node.js 24，否则调整 `ExecStart`。

Nginx 使用 `deploy/nginx.conf`，修改域名和证书路径后运行 `sudo nginx -t` 并重载。开放入站 25（SMTP 收信）、587（STARTTLS 认证发信）、465、993、995（如需第三方客户端）、443（网页）以及证书申请需要的 80。直接外发时，服务器供应商也需允许出站 25。

网页入口可以与邮件主机名分别配置，例如 `PUBLIC_URL=https://203.0.113.25:8443`、`MAIL_HOSTNAME=mail.example.com`。网页反向代理需使用匹配该 IP 的证书，SMTP 继续使用匹配邮件主机名的证书。DNS 配置指引会保留已配置的网页地址。

## 域名与外部收发

使用示例域名 `example.com` 与主机 `mail.example.com`：

| 类型 | 名称               | 值                                                                                        |
| ---- | ------------------ | ----------------------------------------------------------------------------------------- |
| A    | mail               | 服务器公网 IPv4                                                                           |
| MX   | @                  | `10 mail.example.com.`                                                                    |
| TXT  | @                  | 直接投递使用服务器 IP 授权，如 `v=spf1 ip4:服务器公网IP ~all`；中继模式采用服务商要求的值 |
| TXT  | default._domainkey | 后台生成的 DKIM 公钥记录；中继若另有要求，按服务商配置                                    |
| TXT  | _dmarc             | 初期可使用 `v=DMARC1; p=none`，验证对齐后再逐步收紧                                       |

仅在 IPv6 可用且开放 25 时添加 AAAA。邮局从公网通过 25 接收本地账号邮件。外部发信默认直接查收件域名 MX，按优先级投递，遇到临时故障尝试备用 MX。没有 MX 时按 SMTP 标准使用域名地址；Null MX 和不存在的域名明确失败。DNS 目标会解析并固定为已校验的公网 IP，禁止连接本地、私网和元数据地址。

```dotenv
OUTBOUND_MODE=direct
MAIL_HOSTNAME=mail.example.com
MAIL_PUBLIC_IP=服务器公网IP
DIRECT_REQUIRE_TLS=false
DELIVERY_MAX_ATTEMPTS=48
DELIVERY_MAX_AGE_HOURS=120
```

在服务器商控制台设置公网 IP 的 PTR 指向邮件主机名，并确保其 A/AAAA 指回同一 IP。发信使用 `MAIL_HOSTNAME` 作为 EHLO。对方支持 STARTTLS 时使用 TLS 1.2 以上并严格校验主机名与证书，TLS 握手失败不会降级重发明文；对方未提供 STARTTLS 时默认允许标准 SMTP 投递。设 `DIRECT_REQUIRE_TLS=true` 可要求所有目标支持 TLS。没有实现 DANE 或 MTA-STS 策略获取。

`OUTBOUND_MODE=auto` 是默认值：配置 `RELAY_HOST` 时采用中继，否则直投。`local` 只允许本地邮箱互发。使用可选中继时：

```dotenv
OUTBOUND_MODE=relay
RELAY_HOST=smtp.your-provider.com
RELAY_PORT=587
RELAY_SECURE=false
RELAY_USER=your-relay-user
RELAY_PASSWORD=your-relay-password
```

`RELAY_SECURE=false` 使用强制 STARTTLS；465 使用 `RELAY_SECURE=true`。每个添加的域名都会自动生成独立 RSA 2048 位 DKIM 密钥，默认选择器为 `default`，外发时按发件域名选择对应私钥签名。已有域名在升级后自动补齐密钥，重启不会重新生成或轮换。私钥不通过 HTTP 返回。

Linux 可选择由 Rspamd 生成密钥并签名。先从 [Rspamd 官方软件源](https://docs.rspamd.com/getting-started/installation/) 安装 `rspamd`，将 `deploy/rspamd/` 中的四个 `.conf` / `.inc` 配置文件复制到 `/etc/rspamd/local.d/`（不包含 systemd 的 `postoffice-rspamd.conf`），并准备密钥目录：

```bash
sudo install -d -o postoffice -g _rspamd -m 2750 /var/lib/postoffice-dkim
sudo install -d /etc/systemd/system/postoffice.service.d
sudo cp deploy/rspamd/postoffice-rspamd.conf /etc/systemd/system/postoffice.service.d/rspamd.conf
sudo rspamadm configtest
sudo systemctl enable --now rspamd
```

在邮局 `.env` 中设置以下参数，并删除旧的 `DKIM_DOMAIN`、`DKIM_SELECTOR`、`DKIM_PRIVATE_KEY_PATH`：

```dotenv
DKIM_BACKEND=rspamd
RSPAMD_URL=http://127.0.0.1:11333/checkv2
RSPAMD_KEY_DIR=/var/lib/postoffice-dkim
RSPAMD_SELECTOR=rspamd20261019
RSPAMADM_PATH=/usr/bin/rspamadm
RSPAMD_TIMEOUT_MS=10000
```

`RSPAMD_SELECTOR` 必须与 `dkim_signing.conf` 的 `selector` 一致。执行 `systemctl daemon-reload`、`systemctl restart rspamd postoffice` 后，已有域名首次迁移到新选择器，新增域名使用 `rspamadm dkim_keygen` 生成 RSA 2048 位密钥。后台 DNS 面板显示新选择器的公钥，需在 DNS 发布。请先备份数据库；切换会替换当前签名密钥，旧 DNS 记录可保留以便验证在途邮件。

外部邮件交给本机 Rspamd HTTP 接口签名后才投递，Node.js 签名同时关闭。签名服务超时或未返回正确域名及选择器的签名时，邮件保留在队列重试，不能无签名继续投递。外部来信的转发不伪造原发件域名的签名。Rspamd 端口只监听回环地址；本次配置用于外发 DKIM，未启用入站反垃圾过滤。私钥以 640 权限保存在密钥目录，同时包含在受限数据库备份中；恢复时会从数据库恢复缺失密钥文件，重启不会重新生成密钥。

管理员在「域名列表 → DNS 配置」复制 A/AAAA、MX、SPF、DKIM、DMARC 记录，可下载指引并检测解析。新增域名成功后自动打开该面板。`MAIL_PUBLIC_IP` 用于预填服务器公网 IP；也可只在指引中填写，不会修改运行配置。直接投递默认生成 `v=spf1 ip4:服务器IP ~all`（IPv6 使用 `ip6`），未填写 IP 时使用 `v=spf1 a mx ~all`。`MAIL_SPF` 可覆盖完整 SPF；中继模式未提供该值时明确显示待配置，不猜测服务商的授权记录。已有 SPF 应合并授权来源，不可添加多条。

可选的 `DKIM_DOMAIN`、`DKIM_SELECTOR`、`DKIM_PRIVATE_KEY_PATH` 会覆盖对应单个域名的自动签名密钥；修改时需要同步更新 DNS 公钥。DNS 检测优先使用服务器解析器，网络错误时回退到 AliDNS 的 HTTPS JSON API；可通过 `DNS_DOH_URL` 更换兼容的 HTTPS 解析端点，或设置 `DNS_DOH_FALLBACK=false` 关闭备用查询。查询结果区分已解析、未查到、不匹配、待核对和查询失败，不会修改 DNS，不能替代端口、证书与实际收发验证。初始化前也可访问 `/getting-started.html` 阅读完整使用顺序。

SMTP 客户端发信：服务器 `mail.example.com`，端口 587，STARTTLS，用户名为完整邮箱地址，密码为网页邮箱密码。Envelope From 与邮件 From 均须与登录邮箱一致；25 端口禁止 AUTH 和任意外部中继。匿名邮件冒用本地域名 Envelope From 会被拒绝。

当前没有反垃圾打分、病毒扫描、入站 SPF/DKIM/DMARC 验证或转发 SRS。准备长期公网使用时，应在收信入口接入成熟邮件过滤网关；外部转发需考虑原邮件的认证对齐和中继的发件人策略。

## API

外部 AI 操作邮局的完整接入说明见 [AI 调用 API 文档](docs/api/README.md)，提供 [31 个操作的 OpenAPI](docs/api/openapi.json)、[8 个常用邮件操作的精简定义](docs/api/openapi-mail.json) 和 [Node.js 工具执行器示例](docs/api/examples/qingyou-tools.mjs)。接口直接连接服务器，不依赖桌面客户端；按实际 v1.3.0 权限、返回值和限制编写。

管理员在「邮件推送API」创建密钥。完整密钥仅显示一次，数据库只保存哈希。权限范围为：

- `mail:send`：以任意启用的本地邮箱发送邮件。
- `mail:read`：查询全部邮箱的邮件摘要列表。
- `codes:read`：查询全部邮箱最近验证码。
- `management`：允许另一台青邮管理账号、域名、转发和邮件；默认不勾选，应单独创建管理密钥。

每个发送密钥可单独设置默认/允许发件邮箱、允许收件域名、每日收件人数额度和 IP/CIDR 白名单。额度按 UTC 日累计，`to`、`cc`、`bcc` 都计入；额度为 0 表示不限。兼容接口 `/api/send_mail` 接受 JSON 中的 `apiKey`、`from`、`to`、`subject`、`content`、`subtype`。

### 发送邮件

```bash
curl https://mail.example.com/api/v1/send \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"from":"admin@example.com","to":["alice@example.com"],"subject":"你好","text":"测试邮件"}'
```

字段：`from` 可选，依次使用请求指定的邮箱、密钥配置的默认发件人、密钥所属管理员邮箱；`to` / `cc` / `bcc` 为地址数组或逗号分隔字符串；`subject`、`text` 为文本；`attachments` 为 `[{"filename":"hello.txt","content":"aGVsbG8="}]`，content 使用 Base64。最多 100 个收件人、20 个附件，MIME 编码后整体受 `MAX_MESSAGE_MB` 限制，Base64 编码会增加体积。

成功返回 HTTP 201 `{"id":123}`，表示已持久化接收。外部实际投递状态请查询发件箱或队列。外部投递按每个收件人持久化，临时错误从 1、2、4、8 分钟退避，单次间隔最多 4 小时，默认最多 48 次或 5 天；永久 SMTP 5xx 不自动重试。失败会在发件箱显示原因，向本地发件账号的收件箱写入通知；管理员可以手动重试。不向未认证的外部入站发件人发送退信，避免反向垃圾邮件。

### 查询邮件与验证码

```bash
curl 'https://mail.example.com/api/v1/messages?email=alice@example.com&folder=inbox&page=1&limit=30&q=hello' \
  -H 'Authorization: Bearer YOUR_API_KEY'
curl 'https://mail.example.com/api/v1/codes?email=alice@example.com' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

邮件列表返回 `{items,total,page,limit}`，默认 inbox，支持 inbox/sent/drafts/trash/archive/spam/starred，`limit` 最大 100。查询不返回附件内容、原始邮件或密码。接码返回 `{items:[{id,mailbox,from_email,subject,created_at,code}]}`。接码扫描最近 24 小时的最多 300 封邮件并返回最多 100 个结果，数字匹配可能产生误判。

### Webhook

管理员添加公共 HTTPS 接收地址后，每封成功入库的本地来信产生一个 `mail.received` 事件。失败最多尝试 5 次，队列落库，可在后台手动重试。默认拒绝私有网络地址，每次解析 DNS 并固定已校验地址，不跟随重定向。仅开发测试时可用 `WEBHOOK_ALLOW_PRIVATE=true`。

```json
{
  "id": "event-uuid",
  "event": "mail.received",
  "timestamp": "2026-10-18T12:00:00.000Z",
  "data": {
    "id": 123,
    "mailbox": "alice@example.com",
    "from": "sender@example.net",
    "to": [{ "address": "alice@example.com", "name": "" }],
    "subject": "验证码",
    "text": "您的验证码是 123456",
    "code": "123456",
    "attachments": []
  }
}
```

请求头 `X-PostOffice-Timestamp` 为 Unix 秒，`X-PostOffice-Signature` 为 `sha256=<hex>`。请以**原始请求体字节**验签，检查时间窗，并按事件 `id` 去重：

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verifyWebhook(rawBody, timestamp, signature, secret) {
  if (
    !/^\d+$/.test(timestamp || "") ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
  )
    return false;
  const expected = Buffer.from(
    "sha256=" +
      createHmac("sha256", secret)
        .update(timestamp + ".")
        .update(rawBody)
        .digest("hex"),
  );
  const actual = Buffer.from(signature || "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

Webhook 的正文最多发送 100000 字符。SMTP 与 Webhook 均为至少一次投递语义：在远端接收成功后、写回本地状态前宕机可能导致重复，请接收方按事件 ID / Message-ID 去重。

## 备份与恢复

```bash
npm run backup
# Docker，确保 backups 目录可由 UID 1000 写入：
docker compose exec postoffice node scripts/backup.js
```

使用 SQLite Online Backup，包含 WAL 中已提交数据；不要运行时只复制主 `.sqlite` 文件。备份包含邮件、附件、会话、各域名 DKIM 私钥与 Webhook 签名密钥，应加密保存并限制权限。本站 API 密钥和账号密码只保存哈希；连接其他邮局所需的远程凭据保存在受限数据库中，属于备份中的敏感内容。

全局管理员也可在「系统设置 → 平台设置 → 备份管理」创建并下载在线数据库备份。网页备份位于 `DATA_DIR/admin-backups`，与定时备份目录独立；每 5 分钟最多一次，最多保留 20 个文件，达到上限后请先在服务器归档处理。环境配置 `.env`、TLS 证书和程序文件需另行备份。

恢复时停止服务，保留旧数据的完整副本，将所选备份替换为 `DATA_DIR/postoffice.sqlite`，清理同目录旧的 `postoffice.sqlite-wal` 和 `postoffice.sqlite-shm` 后再启动。恢复旧备份可能重新激活旧会话与队列，请按实际情况撤销会话并检查任务。

当前面向单实例、小到中等规模使用；仅运行一个应用实例，避免多个工作进程竞争队列。账号空间统计按原始 MIME 大小计费，数据库还保存解析正文和附件，实际磁盘占用会更高。默认不自动清理永久邮箱邮件；管理员可在平台设置中启用按域名和天数清理，过期邮件先移入垃圾箱，另行设置垃圾箱保留期限才会永久删除。手动清理先预览准确的邮件 ID，5 分钟内输入确认文字执行；投递中的任务不参与清理。投递历史和审计日志继续保留。

## 扩展管理功能

功能对照与已验证范围见 [FEATURE-PARITY.md](FEATURE-PARITY.md)。升级启动时自动增补数据表和字段；升级前先在线备份数据库及旧程序。已有邮箱、密码和 DKIM 密钥继续使用。

- 邮箱账号支持搜索、多选、配额、备注、启停、批量生成/导入/改密及导出。域名支持 DNS 检测和邮件捕获，转发支持批量管理、保留副本与循环检查。
- 收发件可筛选多个邮箱、分页和批量整理；写信支持 HTML、纯文本、附件、草稿和个人模板。批量发送显示每个收件人的结果；已入队不等于对方已收到。
- 接码支持多邮箱链接、自定义 8 位 token、IP/CIDR、有效期、访问记录、规则详细测试；公开入口为 `/#/msg`，完整链接为 `/#/msg#TOKEN`。完整邮件正文需要在链接中另行授权。管理员链接秘密可轮换，公开管理员入口默认关闭。
- 临时邮箱默认关闭。在「临时邮箱页面」先启用，再创建独立页面并设置域名、访问密码、寿命和单 IP 每日额度，分享 `/#/temp/PAGE_TOKEN`。浏览器只能查看自身会话创建的邮箱，过期立即停止收件和访问；定时回收仅处理过期临时邮箱。
- 全局管理员可分配受限管理员及逐域名查询/新增/修改/删除权限；限制同时在接口执行。普通用户的菜单与数据维持自身邮箱范围。
- 平台设置支持品牌图片、背景、浅色/深色、横向/侧栏导航、公告、查询缓存、远程批量创建并发数、在线备份。功能管理可排序、隐藏或停用模块；收件箱和发件箱选项只控制页面入口，邮件保留和收发仍由邮件服务配置决定。

### Catch-all 转发

在「邮件转发 → 添加规则」选择 Catch-all 和所管理的域名，来源显示为 `*@example.com`，目标可填写本地或外部邮箱。规则只处理该域名下尚未创建地址的来信；已创建的邮箱仍按自己的转发规则收件，停用或过期的邮箱不会被 Catch-all 接管。

每个域名最多启用一种捕获方式：使用 Catch-all 转发或域名页面中的本地捕获邮箱。两种配置互相替换，界面显示当前方式。Catch-all 转发本身不保留副本；目标为本地邮箱时，邮件按目标邮箱规则保存。外部目标需要已配置外发服务。受限管理员和客户端域名用户还需拥有转发功能权限及对应域名的新增、修改或删除授权。

### 连接其他邮局（暂时停用）

当前版本隐藏「多邮局管理」入口和切换按钮，同时关闭连接管理及远程代理接口，所有操作使用本机邮局。旧连接、密钥和配置继续保存在原数据库，功能管理不能重新启用此暂停模块。

## 功能与权限

**客户端与后台独立登录：** 网站首页仅供管理员登录，普通用户使用 `/webmail/` 和完整邮箱地址登录。两个入口使用独立 Cookie、会话与 CSRF 校验，可同时登录不同账号，退出互不影响。客户端登录即使使用管理员邮箱也不能访问后台接口。升级到 v1.2.0 后需要分别重新登录，账号密码不变。

**普通用户域名管理：** 超级管理员在「权限管理」选择已有邮箱账号或新建账号，设为「客户端域名用户」，分配域名并勾选功能权限和域名的查看、新增、修改、删除权限。该用户在客户端切换「个人邮箱 / 域名管理」，可在授权范围内创建邮箱、重置密码、收发与整理邮件及管理转发。普通邮箱不会因地址后缀相同自动获得整个域名的权限；未授权的域名和其他管理账号始终不可访问。客户端不能修改系统、分配权限或删除域名。限制发件权限同时作用于网页和 SMTP；权限变更立即撤销该账号的旧登录会话。

超级管理员可配置域名管理员、运营管理员、只读审计员，或逐项选择 15 项自定义功能权限；功能权限必须同时满足所选域名的读、建、改、删范围。邮箱信息、密码重置、查看邮件及附件、代发、删除等权限独立检查。受限管理员不能修改其他管理员，也不能读取其邮件。只有超级管理员能分配管理员权限、配置系统及调整域名邮箱数量上限。权限变更撤销目标旧会话，执行中的创建、改密、代发在提交前再次校验权限；关键变更记录到审计日志。

「域名与容量」可为每个域名设置邮箱数量上限：不选限制表示不限，`0` 表示禁止新增。管理员邮箱、停用邮箱及临时邮箱均占用名额；无邮箱地址的独立管理账号不占用邮件域名名额。删除邮箱后释放名额；上限不能调低到当前已用数量以下。单个创建、批量导入、管理员新增、临时邮箱与旧 API 均受同一数据库约束，超额整批回滚，并发请求不能抢占同一个剩余名额。此处限制的是**邮箱账号数**；单个邮箱存储空间仍通过原有 MB 配额设置。

用户列表支持服务端分页（30 / 50 / 100 条）、搜索防抖、域名筛选与当前页导出。邮箱选择器按需搜索，读请求在执行期间合并，批量密码计算限制并发，并为域名、邮箱、附件和会话查询补充索引。旧 API 未传分页参数时仍保留最多 5000 条的兼容结果；新客户端使用明确的 `page` / `limit`。

升级会自动增加字段、索引和约束，现有域名默认为不限，不重置账号、邮件或 DKIM。升级前使用原备份入口或 `npm run backup` 保存数据库，并另外备份 `.env`、证书和 DKIM 私钥；替换程序后重启。新版本启动后不要直接回退旧代码继续写库，回退应同时恢复升级前的数据库备份。远程适配器的域名容量由目标邮局管理，本地数量限制不代替远程服务的配额。

管理员侧边栏包含下列基础功能及临时邮箱、邮件模板。权限管理整合到「用户列表 → 权限管理」；运行状态、平台设置、功能管理、程序信息整合到「系统设置」的页签中，原页面链接仍可访问。多邮局管理暂时停用，已有连接配置保留。**后台权限同时在服务端检查**，普通用户不能通过直接请求接口访问管理功能。

| 管理员功能  | 实现                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| 总览        | 邮箱、域名、收发邮件统计、7 天图表、最近操作、服务状态                  |
| 发邮件      | To / Cc / Bcc、附件、草稿、本地投递与外发队列                           |
| 收件箱      | 全局邮件查询、邮箱筛选、搜索、分页、阅读与附件下载                      |
| 发件箱      | 全局已发送邮件、按邮箱筛选、每封外发状态                                |
| 邮件转发    | 本地 / 外部转发、保留副本、循环检查                                     |
| 用户列表    | 创建账号、显示名称、配额、启停、重置密码                                |
| 批量注册    | 数量和域名、随机用户名/密码、长度与字符集、实时预览、账号导出、列表导入 |
| 批量群发    | 最多 100 人 / 次，每人独立邮件和处理结果                                |
| 批量改密    | 指定密码或每人独立随机密码，撤销全部旧会话                              |
| 域名列表    | 添加、启停、确认后删除、邮件捕获；独立 DKIM 密钥、DNS 生成与在线检测    |
| 接码        | 接码设置、8 位 token 链接管理、验证码规则、批量规则测试、自动刷新       |
| 邮件推送API | Bearer API Key、权限范围、HTTP 发信 / 查询、Webhook 签名与重试          |
| 邮局管理    | 运行配置、SMTP 队列、失败重试、审计日志                                 |

普通账号显示自己的写信、收件箱、星标、已发送、草稿、归档、垃圾邮件、垃圾箱、邮件模板与改密功能。全局管理员可以查看所有账号邮件；受限管理员按分配的域名和操作权限访问。

第三方邮件客户端使用完整邮箱地址和邮箱密码登录。生产环境提供 IMAP 993、POP3 995、SMTP 465（SSL/TLS）和 SMTP 587（STARTTLS）。在网页邮箱「账号设置 → 第三方客户端设置」可复制本账号的实际主机与端口。IMAP 同步收件箱、已发送、草稿、垃圾箱、归档和垃圾邮件。POP3 下载收件箱，客户端提交删除并正常退出后，邮件进入网页垃圾箱。接码功能从本邮局收到的邮件中提取验证码。

如需让一个指定邮箱兼容无加密客户端，在服务端 `.env` 设置 `MAIL_PLAINTEXT_ACCOUNT=user@example.com`，重启并放行 TCP 143。该邮箱使用原密码，收件选择 IMAP 143，发件选择 SMTP 25、开启身份验证，加密方式均选「无」。网络可见登录密码和邮件内容。此功能默认关闭，清空该配置并重启即可关闭。可用 `IMAP_PORT` 指定其他端口。Docker 可将宿主机 143 映射到容器 1143，并设置 `IMAP_PORT=1143`。

批量注册默认创建 50 个账号，每次最多 100 个。可选择用户名长度 4–32 位，是否包含数字和大写字母；关闭随机用户名后按前缀和起始序号生成。密码长度 12–64 位，可选择大写字母、数字和特殊字符，也可设置统一密码。服务端使用加密随机数并保证选中的每类字符实际出现，整批失败时不写入任何账号。邮箱登录不区分大小写，生成的大写格式在账号列表和导出结果中保留。密码只在本次响应及浏览器结果中显示，不保存明文。

「接码」包含四个页签。管理员可配置邮件范围、显示数量、自动刷新、历史范围、是否允许链接访问及默认有效期。每条链接可绑定多个已启用邮箱，使用自动生成或自定义的 8 位大小写字母和数字 token；访问 `/#/msg` 输入 token，或直接打开 `/#/msg#<token>`，无需邮箱账号密码。链接最多返回 100 条授权邮箱的验证码及主题、发件人和时间，完整正文需要管理员单独授权；开启正文授权后，未识别到验证码的普通邮件也会显示并可查看正文。仅验证码链接不会返回这些邮件的主题或正文，但会显示已检查邮件数和识别结果；可设置 IP/CIDR 限制并查看访问记录。链接可停用、删除及续期，停用的邮箱或域名不能通过链接访问。默认有效期 24 小时，最长 30 天；公开读取接口每 IP 每分钟最多 120 次，token 大小写敏感。

验证码规则支持发件人、主题筛选、顺序、启停和自定义正则表达式，优先取第一个捕获组。默认提供关键词规则及六位数字规则。管理员列表、API 和接码链接使用同一组设置与规则。批量测试支持每行一条文本，可填写测试发件人及主题。规则在独立工作线程执行，1 秒超时并限制内存，防止复杂表达式卡住邮件服务；每次扫描最近 300 封范围内的收件，每封最多读取 20000 字符。

## 源码与发行版

源码版和混淆发行版均无需激活码、离线授权文件或联系外部授权站。管理员、邮箱用户和 API 调用仍需有效凭据及相应权限。旧版客户端可能拒绝免激活服务端，请同步更新或重新构建 Windows / Android 客户端。使用仍须遵守 [LICENSE](LICENSE)；混淆版构建见 [PROTECTED-RELEASE.md](PROTECTED-RELEASE.md)。

## 目录

```text
src/          HTTP API、认证、数据库、SMTP、邮件服务、Webhook
public/       无构建步骤的中文响应式网页邮箱与后台
test/         HTTP + SMTP + Webhook 集成测试
deploy/       systemd 与 Nginx 示例
scripts/      在线备份
compose.yaml  Linux 容器部署
```

实现参考：[Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、[SMTP Server](https://nodemailer.com/extras/smtp-server)、[SMTP transport](https://nodemailer.com/smtp)、[MailParser](https://nodemailer.com/extras/mailparser)。
