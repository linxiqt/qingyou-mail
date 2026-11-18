# 青邮源码保护发行版

保护版仅混淆 JavaScript，不绑定授权站、产品 ID 或设备，不要求激活、导入离线文件或定期联网。账号、邮箱权限和 API Key 仍由服务端验证。免激活不改变 [使用许可](LICENSE)。

在项目根目录使用 Node.js 24 和 Python 3 构建；输出目录和压缩包必须是全新路径，父目录需已存在：

    npm ci
    npm run build:protected -- --out ../qingyou-protected
    python scripts/package-protected.py --source ../qingyou-protected --out ../qingyou-protected.zip

打包器校验文件清单、哈希及免激活版本标记，不接受旧版绑定授权站的产物。部署及升级前备份见 [README](README.md)。升级不会自动修改已部署实例或历史安装包；客户端也需更新到支持免激活服务端的版本。
