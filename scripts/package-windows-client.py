"""Package a complete Windows runtime; enforce the same allowlist as the full bundle."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent

def build(source, output, node):
    source = Path(source).resolve(strict=True)
    output = Path(output).resolve()
    if output.exists():
        raise FileExistsError('Refusing to replace an existing release')
    module = importlib.util.spec_from_file_location('full_bundle', ROOT / 'scripts/package-full.py')
    bundle = importlib.util.module_from_spec(module)
    module.loader.exec_module(bundle)
    subprocess.run([node, str(ROOT / 'scripts/verify-windows-client.cjs'), str(source / 'resources/app.asar')], check=True)
    files = dict(bundle.safe_files(source))
    if not bundle.WINDOWS_ROOT_FILES.issubset(files) or 'resources/app.asar' not in files:
        raise ValueError('Incomplete Windows runtime')
    for name in files:
        if not (name in bundle.WINDOWS_ROOT_FILES or name in ('resources/app.asar', 'resources/default_app.asar') or
                (name.startswith('locales/') and name.count('/') == 1 and name.endswith('.pak'))):
            raise ValueError('Unexpected packaged file: ' + name)
    if 'resources/default_app.asar' in files:
        assert files['resources/default_app.asar'].read_bytes() == (ROOT/'clients/windows/node_modules/electron/dist/resources/default_app.asar').read_bytes()
    version = json.loads((ROOT/'clients/windows/package.json').read_text(encoding='utf-8'))['version']
    manifest = {'version': version, 'kind': 'windows-runtime', 'codeSigned': False, 'files': [
        {'path': name, 'sha256': bundle.sha256(file)} for name, file in files.items()]}
    note = f'青邮 Windows 客户端 v{version}\n\n退出旧客户端后完整解压本包，运行青邮.exe；保留全部 DLL、resources 和 locales 文件。\n登录后点击左下角「AI 接口文档」，可直接阅读和复制接口、示例、OpenAPI 或完整文档，无需打开 doc 文件。\n服务器及数据无需重新部署。账号按同一 Windows 用户的既有加密存储读取。\n本客户端未作商业代码签名。\n'
    with zipfile.ZipFile(output,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        for name, file in files.items(): archive.write(file, name)
        archive.writestr('开始使用.txt', ('\ufeff'+note).encode('utf-8'))
        archive.writestr('client-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        for item in manifest['files']:
            with archive.open(item['path']) as stream: assert hashlib.file_digest(stream,'sha256').hexdigest()==item['sha256']
    digest=bundle.sha256(output)
    output.with_suffix('.zip.sha256').write_text(f'{digest}  {output.name}\n',encoding='ascii')
    print(json.dumps({'archive':str(output),'files':len(files),'bytes':output.stat().st_size,'sha256':digest}))

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',required=True)
    parser.add_argument('--out',required=True)
    parser.add_argument('--node',default='node')
    args=parser.parse_args()
    build(args.source,args.out,args.node)
