"""Package only native client source/docs; never include credentials or toolchains."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def build(source, output):
    source = Path(source).resolve(strict=True)
    output = Path(output).resolve()
    exact = {'README.md', 'API.md', 'windows/API-native-Windows.md',
             'windows/package.json', 'windows/package-lock.json',
             'windows/main.cjs', 'windows/preload.cjs', 'windows/core.cjs', 'windows/vault.cjs',
             'windows/scripts/prepare.cjs', 'windows/scripts/session-smoke.cjs',
             'android/build.ps1', 'android/AndroidManifest.xml', 'android/bridge.js', 'android/README.md'}
    for pattern in ('ui/*.html', 'ui/*.js', 'ui/*.css', 'ui/*.svg',
                    'android/src/**/*.java', 'android/res/**/*.xml',
                    'windows/test/*.cjs', 'ui/test/*.js', 'ui/test/*.cjs',
                    'android/test/*.java'):
        exact.update(p.relative_to(source).as_posix() for p in source.glob(pattern))
    files = {}
    documentation = {}
    api_root = source.parent / 'docs' / 'api'
    for name in ('README.md', 'openapi.json', 'openapi-mail.json',
                 'examples/qingyou-tools.mjs', 'examples/requests.http'):
        file = api_root / name
        if not file.is_file() or file.is_symlink() or not file.resolve(strict=True).is_relative_to(api_root.resolve(strict=True)):
            raise ValueError('Missing or unsafe API documentation: ' + name)
        documentation['docs/api/' + name] = file.read_bytes()
    for name in sorted(exact):
        path = source / name
        if not path.is_file() or path.is_symlink() or not path.resolve(strict=True).is_relative_to(source):
            raise ValueError('Missing or unsafe file: ' + name)
        data = path.read_bytes()
        if b'-----BEGIN PRIVATE KEY-----' in data or b'-----BEGIN RSA PRIVATE KEY-----' in data:
            raise ValueError('Private key found: ' + name)
        files[name] = data
    manifest = {'version': json.loads((source / 'windows/package.json').read_text(encoding='utf-8'))['version'], 'kind': 'qingyou-client-source', 'serverIncluded': False,
                'files': [{'path': n, 'bytes': len(d), 'sha256': hashlib.sha256(d).hexdigest()}
                          for n, d in files.items()],
                'documentation': [{'path': n, 'bytes': len(d), 'sha256': hashlib.sha256(d).hexdigest()}
                                  for n, d in documentation.items()]}
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in files.items():
            archive.writestr('clients/' + name, data)
        for name, data in documentation.items():
            if b'PRIVATE KEY-----' in data:
                raise ValueError('Private key found in documentation: ' + name)
            archive.writestr(name, data)
        archive.writestr('clients/source-manifest.json', json.dumps(manifest, indent=2, ensure_ascii=False))
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        for item in manifest['files']:
            assert hashlib.sha256(archive.read('clients/' + item['path'])).hexdigest() == item['sha256']
        for item in manifest['documentation']:
            assert hashlib.sha256(archive.read(item['path'])).hexdigest() == item['sha256']
    print(json.dumps({'archive': str(output), 'files': len(files), 'bytes': output.stat().st_size,
                      'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}, ensure_ascii=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', default='clients')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    build(args.source, args.out)
