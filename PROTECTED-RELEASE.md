# 源码保护与 KeyDock 授权发行

此文件用于维护者构建发行包。运行源码与源码保护版是两个独立目录；构建器不会修改 `src/`、`public/` 或已有部署资料。

源码保护版使用本地安装的 `javascript-obfuscator@5.9.0` 对前端、后端、Worker 和运行 JavaScript 脚本混淆，并对提取的字符串使用 RC4/Base64 编码。构建不向任何网站上传代码，不使用在线混淆服务，也不需要解密口令。这不是无法逆向的加密；拥有服务器文件与执行权限的人仍可能分析、修改程序。HTML、CSS 和配置模板保持可读，便于正常安装与排错。

浏览器脚本使用 `browser-no-eval`，兼容现有 CSP；不改属性名或跨文件全局接口，不注入 `debugger`，不禁用控制台，不添加域名跳转或格式自毁。ESM 导出、动态导入和模块 Worker 保留原路径。每个文件的辅助标识符使用独立前缀，避免多个前端脚本冲突。

## 正式版本

已核实原 KeyDock「青邮」程序 ID 为 `app_e7d64e0f0b6a`，授权服务器为 `https://authorize.lxya.cc`。正式 `src/edition.js` 在构建时写入并混淆固定的 `protected: true`、`required: true`、产品 ID 和服务器地址；运行环境变量不能关闭授权或切换产品。分发的是原授权系统的 Ed25519 公钥，不包含授权私钥、管理员密码或实际授权码。

在源码工作目录执行（Node.js 24，Python 3；构建前先 `npm ci`）：

```powershell
node scripts/build-protected.js --out test-results/protected-release-NEW --product app_e7d64e0f0b6a
python scripts/package-protected.py --source test-results/protected-release-NEW --out postoffice-protected-NEW.zip
```

输出目录的父目录必须已存在，输出目录必须是全新目录。不会覆盖已有构建；不能输出到源码、运行数据或密钥目录。正式打包工具会拒绝 QA 版、非正式授权地址、清单之外的文件、丢失文件、内容校验失败或与清单不符的嵌入授权绑定。完成后生成 ZIP 和同名 `.sha256`，并逐文件比对 ZIP 与构建目录的字节内容。

发行目录使用运行专用 `package.json` 和 npm lockfile，删除构建及格式化开发依赖，支持 `npm ci --omit=dev`。部署与启动方法见 README.md。发行包的 `test/` 只含冒烟检查；Docker 镜像包含授权验证公钥。

包中不含实际 `.env`、邮箱数据、数据库、备份、证书、DKIM 私钥、源码映射、测试结果、历史域名解析记录、维护业务测试、构建工具或构建原文。`deploy/` 仅保留通用服务配置、Node.js 运行时校验清单和 KeyDock 公开验证密钥。

## QA 验收

QA 仅连接本机假授权站，固定测试产品 `app_postoffice_qa`，必须明确指定测试公钥。示例（假授权站由测试夹具单独启动）：

```powershell
node scripts/build-protected.js --out test-results/protected-qa-NEW --qa --qa-server http://127.0.0.1:45123 --qa-public-key test-results/qa-public.pem
```

QA 公钥必须来自独立的临时 Ed25519 密钥对，不能替换原 KeyDock 正式公钥。QA 标记同时写入构建清单和嵌入 edition。**正式打包工具拒绝 QA 目录，不能将 QA 目录安装到正式服务器，也不能把伪造程序 ID 作为正式版发布。**

验证原始构建器：`node --test test/protection.test.js`。验证发行目录：安装运行依赖后执行 `npm test` 与 `npm run check`，再实际检查首次授权拦截、有效授权后的网页登录、邮箱收发、授权到期/禁用处理和重启后的授权状态。公网真实授权流程需要有效的「青邮」授权码；本地假授权通过不代表已经签发或验证过真实商业授权。
