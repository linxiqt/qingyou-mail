"""Package only the public API contract and examples, never runtime data/keys."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

FILES = ('README.md', 'openapi.json', 'openapi-mail.json',
         'examples/qingyou-tools.mjs', 'examples/requests.http')


def build(source, output):
    source = Path(source).resolve(strict=True)
    output = Path(output).resolve()
    files = {}
    for name in FILES:
        file = source / name
        if file.is_symlink() or not file.resolve(strict=True).is_relative_to(source):
            raise ValueError('Unsafe documentation path: ' + name)
        content = file.read_bytes()
        if b'PRIVATE KEY-----' in content:
            raise ValueError('Private key in public documentation')
        files[name] = content
    spec = json.loads(files['openapi.json'])
    manifest = {'kind': 'qingyou-ai-api-docs', 'serverVersion': spec['info']['version'],
                'operations': sum(len(methods) for methods in spec['paths'].values()),
                'files': [{'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
                          for name, data in files.items()]}
    if output.exists() or output.with_suffix(output.suffix + '.sha256').exists():
        raise FileExistsError('Output already exists; choose a new package name')
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in files.items():
            archive.writestr('qingyou-api/' + name, data)
        archive.writestr('qingyou-api/manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        for entry in manifest['files']:
            assert hashlib.sha256(archive.read('qingyou-api/' + entry['path'])).hexdigest() == entry['sha256']
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(f'{digest}  {output.name}\n', encoding='ascii')
    print(json.dumps({'archive': str(output), 'bytes': output.stat().st_size, 'sha256': digest}, ensure_ascii=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', default='docs/api')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    build(args.source, args.out)
