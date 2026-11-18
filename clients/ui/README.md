# 青邮共享客户端界面

Windows Electron 和 Android WebView 使用同一套本地界面。客户端连接已有的远端邮局，不运行本地邮件服务器。默认服务器地址为 `https://210.16.166.94:24785`，用户可在登录时修改。

## 已实现

- 独立保存多个登录账号，切换时清空上一账号的界面与正文，并丢弃已过期的请求响应。
- 每次切换读取 `/auth/me` 刷新身份和权限；登录过期时直接提供重新登录入口。
- 收件箱、未读、标星、已发、草稿、归档、已删除和垃圾邮件目录。
- 每页 30 封邮件，搜索输入延迟 280 ms 再查询。前台每 60 秒刷新一次，后台或对话框打开时暂停轮询。
- 读信、标星、归档、未读标记、移入已删除、恢复、明确确认后永久删除。
- 写信、回复、正文转发、抄送、密送、附件、手动保存和继续编辑服务器草稿。
- 附件保存交给系统文件选择器。添加附件限制为 20 个、合计 14 MB，为 MIME 编码保留空间。
- Windows 管理员经服务器角色验证后使用独立管理窗口。普通用户保持邮箱界面。
- Windows AI 服务配置、总结、翻译和回复草稿。每次调用展示服务地址和确切文本，并要求用户确认；生成内容不会自动发出。
- 桌面三栏阅读区、移动文件夹抽屉与写信快捷按钮、系统深色主题、键盘焦点与减少动画支持。

## 本地界面与原生层的边界

`index.html` 先加载 `bridge.js`，再加载 `app.js`。Windows 通过 preload 提供 `window.postoffice`；Android 在打包时以原生桥接脚本替换 `bridge.js`。普通浏览器没有桥接时只显示登录说明，不模拟真实邮箱。

界面只发送 portal 相对路径，例如 `/messages`，不会自行拼接 `/api/client`。HTTP、CSRF、登录会话、证书校验、账号持久化和 AI 密钥均由原生层处理。界面不保存密码、令牌、AI 密钥或邮件到 localStorage。

使用的方法：

```text
listAccounts() -> [{ id, server, portal, user }]
login({ server, username, password }) -> account
request({ accountId, path, method?, body? }) -> { status, data }
removeAccount(accountId)
openAdmin(accountId)                      # Windows
download({ accountId, path, filename }) -> { saved?, cancelled? }
inspectCertificate({ server }) -> certificate
trustCertificate({ server, fingerprint })
getAIConfig() -> { baseUrl, model, hasApiKey }                 # Windows
setAIConfig({ baseUrl, model, apiKey })                       # Windows
runAI({ accountId, action, text, instruction, consent:true }) # Windows
```

`platform` 与 `capabilities` 为同步只读属性。AI action 为 `summary`、`translate`、`reply`。管理员判断同时要求 `portal === 'admin'` 和服务器返回的 `user.role === 'admin'`，不会按账号名称猜测。

## 内容安全与功能边界

默认显示纯文本；只有 HTML 的邮件会在不插入页面的 DOM 中移除活动元素，再提取可读文本。Windows 可选择在无脚本权限的 sandbox iframe 中查看排版，并禁止外部资源。Android 始终使用纯文本。邮件内容不会进入可执行脚本，用户内容插值统一转义。

证书信任需要先展示指纹供用户独立核对，再交由原生层二次确认。没有全局忽略证书错误的开关。

当前版本在线同步邮件，不提供离线邮件库、后台系统推送或自动保存草稿。正文转发不会自动复制原附件，编辑框会提示用户另行添加。AI 结果需要用户检查并主动发送。Android 不提供管理员后台或 AI 接入。

## 验证

```powershell
node --test clients/ui/test/model.test.js
node clients/ui/test/browser-smoke.cjs
```

第二条使用已安装的 Edge 无头浏览器，仅连接本机测试夹具；不读取真实邮箱、不发送外部邮件、不调用真实 AI。可用 `UI_TEST_BROWSER` 指定其他 Chromium 可执行文件。它检查桌面与移动布局、读信、附件、AI 明确同意、保存和发送草稿、跨账号过期响应、管理员切换、纯 HTML 降级和登录过期恢复，并生成 `test/.artifacts/` 截图及报告。

测试夹具位于 `test/`，不复制到 Windows 或 Android 安装包。截图中的邮箱和邮件均为测试数据。

## 设计记录

根据用户提供的桌面三栏、浅色移动邮箱和账号抽屉参考实现，沿用青邮蓝色与系统字体。使用 app-screen 设计规则检查密度、焦点、空状态和窄屏，方向记录位于 `design/direction.json`（seed `1460444789`）；参考图的蓝白配色优先于所抽取方向的默认配色。
