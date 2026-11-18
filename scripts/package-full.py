"""Bundle verified server runtime, Windows app, Android APK and API docs.

The formal runtime bundle deliberately keeps maintenance source archives separate.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import zipfile

ROOT = Path(__file__).resolve().parent.parent
API_FILES = ('README.md', 'openapi.json', 'openapi-mail.json',
             'examples/qingyou-tools.mjs', 'examples/requests.http')
WINDOWS_ROOT_FILES = {
    '青邮.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'd3dcompiler_47.dll', 'dxcompiler.dll', 'electron_wer.dll', 'ffmpeg.dll',
    'icudtl.dat', 'LICENSE.electron.txt', 'LICENSES.chromium.html',
    'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version',
    'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll',
}
GUIDE = """# 青邮完整软件（客户端 v1.3.1 / 服务端 v1.3.0）

打包日期：2026-11-03。完整解压本包后使用。客户端侧栏「AI 接口文档」内置全部接口说明，可直接复制，无需打开 doc 文件。

## 包内内容

- server/：授权源码保护版服务端，包含网页管理后台、网页邮箱、SMTP 收发、Rspamd 配置、权限管理、域名数量配额、转发和 Catch-all。
- windows/：Windows x64 桌面客户端与管理员入口，包含完整运行环境，无需另外安装 Node.js。
- android/Qingyou-Android-1.3.1-test.apk：Android 8 及以上手机客户端安装包。
- docs/api/：AI 调用邮局的中文文档、31 个操作的 OpenAPI、8 个常用邮件操作的精简定义及 Node.js 示例。
- docs/client/：客户端使用说明和原生接口说明。
- bundle-manifest.json：包内文件清单及 SHA-256 校验值。

## Linux 服务器部署

将 `server/` 上传到专用目录，按 [服务端 README](server/README.md) 部署并启动。首次访问时创建管理员，再到「程序授权」激活。已有部署升级前应备份数据库、配置、证书和密钥。

## Windows 桌面端

完整解压后双击 windows/青邮.exe，保留该目录中的 DLL、resources、locales 等文件。不要只复制单个 EXE。

填服务器 HTTPS 地址和账号密码。角色由服务器判断：管理员账号打开后台界面，普通邮箱进入邮件界面。支持多账号登录和切换。自签名证书先查看并核对指纹，再由本人确认信任。

## 安卓端

将 android/Qingyou-Android-1.3.1-test.apk 复制到手机安装，输入服务器 HTTPS 地址和完整邮箱账号。支持多账号。Windows 和安卓都连接远程邮局，数据同步服务器，不在本机搭建 SMTP 邮局。

当前 Windows 应用未作商业代码签名；安卓为测试签名包，尚未完成真机验收。客户端前台刷新邮件，没有保证送达的后台推送或离线发件队列。

## 让 AI 调用邮局

登录客户端后点击「AI 接口文档」，可复制完整文档、邮件版或完整版 OpenAPI JSON，以及单个接口的 URL、JSON 和 cURL 示例。在具备 HTTP 工具能力的 AI 运行器中配置服务器 HTTPS 地址和青邮 API Key。

接口直接访问服务端，不要求桌面客户端保持打开。读取正文、管理账号/域名/转发需要 management 全局管理权限；仅查询摘要使用 mail:read，日常发信使用 mail:send。密钥范围与限制以 API 文档为准。

## 校验与版本

本包服务端为固定产品授权的正式源码保护构建；维护源码另存备份，不在本运行包内。客户端重新构建为 v1.3.1，保留远程服务器架构和多账号登录；服务端版本保持 v1.3.0。

服务端构建清单、文件哈希、发行冒烟和 JavaScript 语法检查通过；客户端界面交互、复制、账号隔离和原生剪贴板检查通过，APK v2/v3 签名验证通过。API 的 31 个操作在隔离环境覆盖 51 次请求响应；没有为此次打包向真实外部邮箱发信或调用真实 AI 服务。
"""


def sha256(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_files(base):
    base = base.resolve(strict=True)
    for file in sorted(base.rglob('*')):
        if file.is_symlink() or not file.resolve(strict=True).is_relative_to(base):
            raise ValueError('Unsafe artifact path: ' + str(file))
        if file.is_file():
            yield file.relative_to(base).as_posix(), file


def build(server, windows, apk, output, node):
    server, windows, apk = (Path(p).resolve(strict=True) for p in (server, windows, apk))
    output = Path(output).resolve()
    if output.exists() or output.with_suffix(output.suffix + '.sha256').exists():
        raise FileExistsError('Refusing to replace an existing release')
    module_spec = importlib.util.spec_from_file_location('formal_release', ROOT / 'scripts/package-protected.py')
    verifier = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(verifier)
    server_manifest, server_names = verifier.verify_release(server, node)
    inputs = {'server/' + name: server / name for name in server_names}
    inputs['LICENSE'] = ROOT / 'LICENSE'
    native_files = dict(safe_files(windows))
    if not WINDOWS_ROOT_FILES.issubset(native_files) or 'resources/app.asar' not in native_files:
        raise ValueError('Incomplete Windows application directory')
    for name, file in native_files.items():
        permitted = (name in WINDOWS_ROOT_FILES or name in {'resources/app.asar', 'resources/default_app.asar'} or
                     (name.startswith('locales/') and name.count('/') == 1 and name.endswith('.pak')))
        if not permitted:
            raise ValueError('Unexpected Windows runtime file: ' + name)
        if name == 'resources/default_app.asar' and file.read_bytes() != (ROOT / 'clients/windows/node_modules/electron/dist/resources/default_app.asar').read_bytes():
            raise ValueError('Unexpected Electron default app contents')
        inputs['windows/' + name] = file
    with zipfile.ZipFile(apk) as android:
        if android.testzip() is not None or not {'AndroidManifest.xml', 'classes.dex', 'assets/ui/index.html'}.issubset(android.namelist()):
            raise ValueError('Incomplete Android APK')
        for name in android.namelist():
            if name.startswith('assets/ui/'):
                expected = ROOT / 'clients/android/bridge.js' if name.endswith('/bridge.js') else ROOT / 'clients/ui' / Path(name).name
                if android.read(name) != expected.read_bytes():
                    raise ValueError('Stale Android runtime asset: ' + name)
    inputs['android/' + apk.name] = apk
    for name in API_FILES:
        inputs['docs/api/' + name] = ROOT / 'docs/api' / name
    # Preserve the relative links from clients/API.md to ../docs/api/README.md.
    inputs['clients/README.md'] = ROOT / 'clients/README.md'
    inputs['clients/API.md'] = ROOT / 'clients/API.md'
    inputs['clients/windows/API-native-Windows.md'] = ROOT / 'clients/windows/API-native-Windows.md'
    inline = {'开始使用.md': GUIDE.replace('docs/client/', 'clients/').encode('utf-8'),
              '开始使用.txt': ('\ufeff' + GUIDE.replace('docs/client/', 'clients/')).encode('utf-8')}
    manifest = {'kind': 'qingyou-complete-runtime', 'version': '1.3.1', 'serverVersion': '1.3.0', 'packagedAt': '2026-11-03',
                'serverBuild': server_manifest['buildId'], 'serverEdition': 'protected-licensed',
                'sourceArchivesIncluded': False, 'windowsCodeSigned': False,
                'androidSigning': 'development-test', 'androidDeviceTested': False, 'files': []}
    for name, file in inputs.items():
        manifest['files'].append({'path': name, 'bytes': file.stat().st_size, 'sha256': sha256(file)})
    for name, data in inline.items():
        manifest['files'].append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    manifest['files'].sort(key=lambda item: item['path'])
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for name, file in inputs.items():
            info = zipfile.ZipInfo.from_file(file, arcname=name)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if name.endswith('.sh') else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with file.open('rb') as src, bundle.open(info, 'w') as dest:
                while block := src.read(1024 * 1024):
                    dest.write(block)
        for name, data in inline.items():
            bundle.writestr(name, data)
        bundle.writestr('bundle-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(output) as bundle:
        assert set(bundle.namelist()) == {item['path'] for item in manifest['files']} | {'bundle-manifest.json'}
        for item in manifest['files']:
            with bundle.open(item['path']) as src:
                assert hashlib.file_digest(src, 'sha256').hexdigest() == item['sha256'], item['path']
    checksum = sha256(output)
    output.with_suffix(output.suffix + '.sha256').write_text(f'{checksum}  {output.name}\n', encoding='ascii')
    print(json.dumps({'archive': str(output), 'files': len(manifest['files']),
                      'bytes': output.stat().st_size, 'sha256': checksum, 'serverBuild': server_manifest['buildId']}, ensure_ascii=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--server', required=True)
    parser.add_argument('--windows', default='clients/windows/dist/win-unpacked')
    parser.add_argument('--android', default='clients/android/dist/Qingyou-Android-1.3.1-test.apk')
    parser.add_argument('--out', required=True)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    build(args.server, args.windows, args.android, args.out, args.node)
